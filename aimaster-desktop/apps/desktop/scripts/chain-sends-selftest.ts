/**
 * chain-sends-selftest — the tail on an aux, checked against the tail in the
 * channel.
 *
 * `chain-sends.ts` moves an instrument chain's reverb and delay out of the
 * channel and onto shared auxes.  Three things about that can be wrong
 * quietly, and all three sound like "the reverb is a bit off" rather than
 * like a bug:
 *
 *   · THE LEVEL.  It is derived from the preset's mix fraction, and the
 *     fraction is read off a parameter whose range is 0…1 on some devices and
 *     0…100 on others — both called `mix`.  Reading it by NAME puts the synth
 *     chain's ping-pong 100× too hot, which clamps to the top of the slider,
 *     which sounds like a delay with no dry signal.  So the wet/dry ratio is
 *     asserted against the ratio the insert version would have had.
 *   · THE AUX'S MIX.  An aux whose reverb is at 20 % returns 80 % dry signal
 *     through a second path — a comb filter, not a reverb.  `fullyWet` exists
 *     to prevent that and this file checks that it was actually applied.
 *   · THE SHARING.  The entire point is that six voices share one plate.  A
 *     reuse check that misses builds six, which does not fail, does not warn,
 *     and is six times the CPU.
 *
 * The invariant that ties it together: routing a chain to sends must deliver
 * the SAME wet/dry ratio the insert chain delivered, within the 0.5 dB the
 * send slider steps in.  Everything else here is about the wiring arriving
 * intact.
 */
export {};

import { readFileSync } from 'node:fs';

import { INSTRUMENT_CHAINS, chainDeviceParams, findInstrumentChain } from '../src/renderer/daw/model/instrument-chains.js';
import { chainSendPlan, loadChainWithSends } from '../src/renderer/daw/model/chain-sends.js';
import { findPlugin } from '../src/renderer/daw/engine/plugins.js';
import {
  addTrack, createBus, createSession, createTrack, findTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { detectFeedback, computeDelayCompensation } from '../src/renderer/daw/model/routing.js';
import { serializeDawSession, deserializeDawSession } from '../src/renderer/daw/model/session-io.js';
import { SEND_SLOTS } from '../src/renderer/daw/model/types.js';
import type { DawSession, Track, TrackId } from '../src/renderer/daw/model/types.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

/** A session with one audio track, which is what a chain is loaded onto. */
function sessionWithTrack(name = 'Vox'): { session: DawSession; trackId: TrackId } {
  const track = createTrack(name, 'audio');
  return { session: addTrack(createSession('send-test'), track), trackId: track.id };
}

function auxTracks(session: DawSession): Track[] {
  return session.tracks.filter((t) => t.kind === 'aux');
}

/** The mix fraction a device is actually holding, read off the descriptor. */
function wetOf(pluginId: string, params: Record<string, number>): number | null {
  const def = findPlugin(pluginId)?.params.find((p) => p.id === 'mix' || p.id === 'mixPct');
  if (!def) return null;
  const raw = params[def.id];
  if (typeof raw !== 'number') return null;
  return (raw - def.min) / (def.max - def.min);
}

console.log('\n=== 악기 체인 센드 라우팅 ===\n');

// ── What leaves the channel ──────────────────────────────────────────────
{
  const TIME_CATEGORIES = new Set(['reverb', 'delay']);
  const wrong: string[] = [];
  let sendCount = 0;
  for (const chain of INSTRUMENT_CHAINS) {
    const plan = chainSendPlan(chain);
    sendCount += plan.sends.length;
    for (const d of plan.inserts) {
      const cat = findPlugin(d.pluginId)?.category;
      if (cat !== undefined && TIME_CATEGORIES.has(cat)) {
        wrong.push(`${chain.id}: ${d.pluginId} stayed in the channel`);
      }
    }
    for (const s of plan.sends) {
      const cat = findPlugin(s.device.pluginId)?.category;
      if (cat === undefined || !TIME_CATEGORIES.has(cat)) {
        wrong.push(`${chain.id}: ${s.device.pluginId} was thrown and is not a reverb or a delay`);
      }
    }
    if (plan.inserts.length + plan.sends.length !== chain.devices.length) {
      wrong.push(`${chain.id}: ${chain.devices.length} devices in, ${plan.inserts.length + plan.sends.length} out`);
    }
  }
  check(
    'every reverb and delay leaves the channel, and nothing else does',
    wrong.length === 0,
    wrong.length === 0 ? `${sendCount} sends planned across ${INSTRUMENT_CHAINS.length} chains`
      : wrong.slice(0, 4).join(' | '),
  );
  check(
    'the bass chain has nothing to throw, and the plan says so rather than inventing one',
    chainSendPlan(findInstrumentChain('bass')!).sends.length === 0,
    'a bass stays dry — the one chain with no time-based device',
  );
  const everyChainKeepsSomething = INSTRUMENT_CHAINS.every((c) => chainSendPlan(c).inserts.length > 0);
  check(
    'and no chain is emptied into its auxes',
    everyChainKeepsSomething,
    'every chain still has an EQ and a dynamics device in the channel',
  );
}

// ── The 100× trap ────────────────────────────────────────────────────────
{
  // `pingpong.mix` and `tapedelay.mix` run 0…100; `reverb.mix` and
  // `delay.mix` run 0…1.  Same parameter name, 100× apart.
  const synth = chainSendPlan(findInstrumentChain('synth')!);
  const ping = synth.sends.find((s) => s.device.pluginId === 'pingpong');
  const verb = synth.sends.find((s) => s.device.pluginId === 'reverb');
  const fx = chainSendPlan(findInstrumentChain('fx')!);
  const tape = fx.sends.find((s) => s.device.pluginId === 'tapedelay');
  const ok = ping !== undefined && verb !== undefined && tape !== undefined
    && Math.abs(ping.wet - 0.35) < 1e-9
    && Math.abs(verb.wet - 0.38) < 1e-9
    && Math.abs(tape.wet - 0.40) < 1e-9;
  check(
    'the mix fraction comes from the declared range, not from the parameter name',
    ok,
    ok ? 'pingpong mix=35 of 0..100 → 0.35, reverb mix=0.38 of 0..1 → 0.38, tapedelay mix=40 → 0.40'
      : `pingpong ${ping?.wet ?? '?'} reverb ${verb?.wet ?? '?'} tapedelay ${tape?.wet ?? '?'}`,
  );
  // Read by name as a fraction, 35 would clamp to 1.0 and the level to the
  // slider's ceiling.  This is the assertion that separates the two readings.
  const notPinned = ping !== undefined && ping.levelDb < 0;
  check(
    'so a 0..100 delay is not thrown at the top of the slider',
    notPinned,
    `pingpong at ${ping?.levelDb.toFixed(1) ?? '?'} dB, not +12`,
  );
}

// ── The invariant: the same wet/dry ratio ────────────────────────────────
{
  const off: string[] = [];
  let compared = 0;
  for (const chain of INSTRUMENT_CHAINS) {
    for (const s of chainSendPlan(chain).sends) {
      compared++;
      // What the insert version delivered: wet m against dry (1 − m).
      const wanted = 20 * Math.log10(s.wet / (1 - s.wet));
      // The send feeds a fully wet aux summed with an unchanged dry channel,
      // so its gain IS the ratio.
      if (Math.abs(wanted - s.levelDb) > 0.26) {
        off.push(`${chain.id}/${s.device.pluginId}: wanted ${wanted.toFixed(2)} got ${s.levelDb.toFixed(2)}`);
      }
    }
  }
  check(
    'every derived send level carries the ratio the insert chain had',
    off.length === 0,
    off.length === 0 ? `${compared} sends within half the slider's 0.5 dB step`
      : off.slice(0, 4).join(' | '),
  );
  const plate = chainSendPlan(findInstrumentChain('vocal')!).sends
    .find((s) => s.device.pluginId === 'plate');
  check(
    'and a 20 % vocal plate lands on the number the module documents',
    // 0.20 / 0.80 = 0.25 → −12.04 dB, stepped to −12.0.  Unity is at 50 %:
    // the send is summed with the whole dry channel, not blended against it.
    plate !== undefined && Math.abs(plate.levelDb - (-12)) < 1e-9,
    `plate at ${plate?.levelDb.toFixed(1) ?? '?'} dB from mixPct 20`,
  );
  const stepped = INSTRUMENT_CHAINS.flatMap((c) => chainSendPlan(c).sends)
    .every((s) => Math.abs(s.levelDb / 0.5 - Math.round(s.levelDb / 0.5)) < 1e-9);
  check(
    'and lands on a step the send slider can actually show',
    stepped,
    'every level is a multiple of 0.5 dB',
  );
}

// ── The channel half ─────────────────────────────────────────────────────
{
  const { session, trackId } = sessionWithTrack();
  const vocal = findInstrumentChain('vocal')!;
  const result = loadChainWithSends(session, trackId, vocal);
  const track = findTrack(result.session, trackId)!;
  const ids = [...track.inserts].sort((a, b) => a.slot - b.slot).map((i) => i.pluginId);
  check(
    'the channel keeps the chain in order and packs it from A with no gaps',
    JSON.stringify(ids) === JSON.stringify(['eq8', 'comp', 'deesser', 'tube'])
      && track.inserts.every((i, n) => i.slot === n),
    `vocal channel → ${ids.join(' → ')} in slots A–${String.fromCharCode(65 + ids.length - 1)}`,
  );
  const changed: string[] = [];
  for (const device of chainSendPlan(vocal).inserts) {
    const wanted = chainDeviceParams(vocal, device);
    const got = track.inserts.find((i) => i.pluginId === device.pluginId)?.params ?? {};
    for (const [k, v] of Object.entries(wanted)) {
      if (got[k] !== v) changed.push(`${device.pluginId}.${k}: ${v} → ${got[k] ?? '(dropped)'}`);
    }
  }
  check(
    'and the settings that stay are the ones the instrument preset gave',
    changed.length === 0,
    changed.length === 0 ? 'no parameter changed on the way into the channel'
      : changed.slice(0, 4).join(' | '),
  );
  check(
    'nothing was reported as missing from this build',
    result.problems.length === 0,
    result.problems.length === 0 ? 'no problems' : result.problems.join(' | '),
  );
}

// ── The aux half ─────────────────────────────────────────────────────────
{
  const { session, trackId } = sessionWithTrack();
  const vocal = findInstrumentChain('vocal')!;
  const result = loadChainWithSends(session, trackId, vocal);
  const auxes = auxTracks(result.session);
  check(
    'one aux per thrown device, each with exactly that device on it',
    auxes.length === 2
      && auxes.every((a) => a.inserts.length === 1)
      && new Set(auxes.map((a) => a.inserts[0]?.pluginId)).size === 2,
    `${auxes.length} auxes → ${auxes.map((a) => `${a.name}[${a.inserts[0]?.pluginId ?? '?'}]`).join(', ')}`,
  );
  const wets = auxes.map((a) => {
    const only = a.inserts[0];
    return only ? wetOf(only.pluginId, only.params) : null;
  });
  check(
    'and every one of them is pinned fully wet',
    wets.length === 2 && wets.every((w) => w !== null && Math.abs(w - 1) < 1e-9),
    `aux mix → ${wets.map((w) => (w === null ? 'no mix control' : `${(w * 100).toFixed(0)}%`)).join(', ')}`,
  );
  const wired = auxes.every((a) =>
    a.input !== null
    && result.session.buses.some((b) => b.id === a.input)
    && a.output.kind === 'master');
  check(
    'each aux reads a real bus and returns to the master',
    wired,
    `${result.session.buses.length} buses, every aux input matched, outputs to master`,
  );
  const track = findTrack(result.session, trackId)!;
  const targets = new Set(track.sends.map((s) => s.target));
  const auxBuses = new Set(auxes.map((a) => a.input));
  check(
    'and the track sends to exactly those buses, post-fader',
    track.sends.length === 2
      && [...targets].every((t) => auxBuses.has(t))
      && track.sends.every((s) => !s.preFader && !s.mute),
    `${track.sends.length} sends at ${track.sends.map((s) => `${s.levelDb.toFixed(1)}dB`).join(', ')}, post-fader`,
  );
  check(
    'the send levels are the ones the plan derived',
    chainSendPlan(vocal).sends.every((p) => {
      const aux = auxes.find((a) => a.inserts[0]?.pluginId === p.device.pluginId);
      return track.sends.some((s) => s.target === aux?.input && s.levelDb === p.levelDb);
    }),
    'plan level == session level for every thrown device',
  );
  check(
    'and routing the tail does not build a feedback loop',
    detectFeedback(result.session).length === 0,
    'no cycle in the route graph',
  );
  check(
    'delay compensation still resolves with the sends in place',
    (() => { try { computeDelayCompensation(result.session); return true; } catch { return false; } })(),
    'computeDelayCompensation did not throw',
  );
}

// ── Sharing, which is the whole point ────────────────────────────────────
{
  const a = createTrack('Vox 1', 'audio');
  const b = createTrack('Vox 2', 'audio');
  let session = addTrack(addTrack(createSession('share'), a), b);
  const vocal = findInstrumentChain('vocal')!;
  const first = loadChainWithSends(session, a.id, vocal);
  session = first.session;
  const second = loadChainWithSends(session, b.id, vocal);
  session = second.session;
  check(
    'the second voice shares the first one\'s auxes instead of building its own',
    auxTracks(session).length === 2 && session.buses.length === 2,
    `two vocals → ${auxTracks(session).length} auxes, ${session.buses.length} buses`,
  );
  check(
    'and the result says which were built and which were shared',
    first.created.length === 2 && first.reused.length === 0
      && second.created.length === 0 && second.reused.length === 2,
    `first built [${first.created.join(', ')}], second shared [${second.reused.join(', ')}]`,
  );
  const sends = [a.id, b.id].map((id) => findTrack(session, id)?.sends.length ?? -1);
  check(
    'both voices feed them',
    JSON.stringify(sends) === JSON.stringify([2, 2]),
    `sends per track → ${sends.join(', ')}`,
  );
  // A different instrument whose plate is the same device: still one plate.
  const c = createTrack('Keys', 'audio');
  session = addTrack(session, c);
  const third = loadChainWithSends(session, c.id, findInstrumentChain('keyboard')!);
  session = third.session;
  check(
    'and a keyboard reuses the vocal\'s plate rather than opening a second room',
    auxTracks(session).filter((t) => t.inserts[0]?.pluginId === 'plate').length === 1,
    `one plate aux shared by vocal, vocal and keyboard; ${auxTracks(session).length} auxes in total`,
  );
}

// ── Pressing it twice ────────────────────────────────────────────────────
{
  const { session, trackId } = sessionWithTrack();
  const vocal = findInstrumentChain('vocal')!;
  const once = loadChainWithSends(session, trackId, vocal);
  const twice = loadChainWithSends(once.session, trackId, vocal);
  const track = findTrack(twice.session, trackId)!;
  check(
    'loading the same chain again does not stack a second send or a second aux',
    track.sends.length === 2 && auxTracks(twice.session).length === 2
      && twice.session.buses.length === 2,
    `${track.sends.length} sends, ${auxTracks(twice.session).length} auxes after two loads`,
  );
  // A send the user muted, then asked for again, should be open: they just
  // pressed the button that means "put the reverb on this".
  const muted = {
    ...twice.session,
    tracks: twice.session.tracks.map((t) => (t.id === trackId
      ? { ...t, sends: t.sends.map((s) => ({ ...s, mute: true, levelDb: -60 })) }
      : t)),
  };
  const third = loadChainWithSends(muted, trackId, vocal);
  const after = findTrack(third.session, trackId)!;
  check(
    'and re-deriving a muted send opens it at the level the plan wants',
    after.sends.every((s) => !s.mute)
      && chainSendPlan(vocal).sends.every((p) => after.sends.some((s) => s.levelDb === p.levelDb)),
    `levels back to ${after.sends.map((s) => s.levelDb.toFixed(1)).join(', ')} dB, unmuted`,
  );
}

// ── An aux somebody built by hand ────────────────────────────────────────
{
  const track = createTrack('Vox', 'audio');
  const bus = createBus('내 플레이트');
  let session = addTrack({ ...createSession('handmade'), buses: [bus] }, track);
  const aux = createTrack('내 플레이트', 'aux', { input: bus.id });
  session = addTrack(session, aux);
  // One plate on it, at whatever the user left it at.
  const loaded = loadChainWithSends(session, track.id, findInstrumentChain('keyboard')!);
  // The hand-built aux has no inserts, so it is NOT a match: a plate aux is
  // an aux with a plate on it.
  check(
    'an empty aux is not mistaken for a plate aux',
    auxTracks(loaded.session).length === 2,
    'the chain built its own rather than putting a plate on an unrelated aux',
  );

  // Now the same thing with the device actually on it.
  let real = addTrack({ ...createSession('handmade2'), buses: [bus] }, track);
  const withPlate = createTrack('내 플레이트', 'aux', {
    input: bus.id,
    inserts: [{
      id: 'ins-hand', slot: 0, pluginId: 'plate', label: 'Plate Reverb',
      bypass: false, latencySamples: 0, params: { mixPct: 44 }, sidechainSource: null,
    }],
  });
  real = addTrack(real, withPlate);
  const reused = loadChainWithSends(real, track.id, findInstrumentChain('keyboard')!);
  const stillThere = findTrack(reused.session, withPlate.id);
  check(
    'but an aux already carrying that device is reused, settings untouched',
    auxTracks(reused.session).length === 1
      && stillThere?.inserts[0]?.params['mixPct'] === 44
      && reused.reused.includes('Plate Reverb'),
    `reused "${stillThere?.name ?? '?'}" at mixPct ${stillThere?.inserts[0]?.params['mixPct'] ?? '?'} — not re-pinned, not duplicated`,
  );
  check(
    'and the send points at the bus that aux reads',
    findTrack(reused.session, track.id)?.sends.some((s) => s.target === bus.id) === true,
    'send target == the hand-built aux\'s input bus',
  );
}

// ── When there is no room ────────────────────────────────────────────────
{
  const track = createTrack('Full', 'audio');
  const buses = Array.from({ length: SEND_SLOTS }, (_, n) => createBus(`B${n}`));
  const full = {
    ...createSession('full'),
    buses,
    tracks: [...createSession('full').tracks, {
      ...track,
      sends: buses.map((b, slot) => ({
        id: `snd-${slot}`, slot, target: b.id, levelDb: -12, pan: 0,
        preFader: false, mute: false,
      })),
    }],
  };
  const result = loadChainWithSends(full, track.id, findInstrumentChain('vocal')!);
  check(
    'a track with all ten send slots taken is told so, not silently half-wired',
    result.problems.length === 2
      && result.problems.every((p) => p.includes('센드 슬롯이 모두 찼습니다')),
    result.problems.join(' | ') || '(no problems reported)',
  );
  check(
    'and its channel still got the chain',
    (findTrack(result.session, track.id)?.inserts.length ?? 0) === 4,
    'the insert half does not depend on the send half succeeding',
  );
}

// ── The kinds that cannot be routed from ─────────────────────────────────
{
  // The mixer hides the chain picker on the master strip, but the insert rack
  // opens on every row the edit window lists and the master is one of them.
  // An aux fed from the master returns to the master.
  const session = createSession('master-route');
  const master = session.tracks.find((t) => t.kind === 'master');
  const vocal = findInstrumentChain('vocal')!;
  const onMaster = loadChainWithSends(session, master!.id, vocal);
  check(
    'the master is refused rather than wired into a loop with itself',
    onMaster.problems.length === 1
      && onMaster.problems[0]!.includes('피드백')
      && auxTracks(onMaster.session).length === 0
      && onMaster.session === session,
    onMaster.problems[0] ?? '(nothing refused)',
  );

  const vca = createTrack('VCA 1', 'vca');
  const folder = createTrack('Folder 1', 'folder');
  const withBoth = addTrack(addTrack(session, vca), folder);
  const onVca = loadChainWithSends(withBoth, vca.id, vocal);
  const onFolder = loadChainWithSends(withBoth, folder.id, vocal);
  check(
    'and a VCA and a folder are told what they are, not half-wired',
    onVca.problems.length === 1 && onFolder.problems.length === 1
      && onVca.session === withBoth && onFolder.session === withBoth,
    `VCA: ${onVca.problems[0] ?? '?'} | 폴더: ${onFolder.problems[0] ?? '?'}`,
  );

  // An aux IS routable — a reverb aux that wants its own delay is ordinary.
  const host = createTrack('Reverb Aux', 'aux', { input: null });
  const routable = loadChainWithSends(addTrack(session, host), host.id, vocal);
  check(
    'but an aux is routable, because an aux carrying a chain is ordinary',
    routable.problems.length === 0 && auxTracks(routable.session).length === 3,
    `${auxTracks(routable.session).length} auxes — the host plus the two it threw to`,
  );
}

// ── A send that would close a loop ───────────────────────────────────────
{
  // Aux A already sends to the bus Aux B reads, and B outputs to the bus A
  // reads.  Routing a chain FROM B toward A's bus would close the ring, and
  // reusing an existing aux is how that becomes reachable.
  const busA = createBus('A');
  const busB = createBus('B');
  let session: DawSession = { ...createSession('ring'), buses: [busA, busB] };
  const auxA = createTrack('A', 'aux', {
    input: busA.id,
    output: { kind: 'bus', busId: busB.id },
    inserts: [{
      id: 'ins-a', slot: 0, pluginId: 'plate', label: 'Plate Reverb',
      bypass: false, latencySamples: 0, params: { mixPct: 30 }, sidechainSource: null,
    }],
  });
  const auxB = createTrack('B', 'aux', { input: busB.id, output: { kind: 'bus', busId: busA.id } });
  session = addTrack(addTrack(session, auxA), auxB);
  const result = loadChainWithSends(session, auxB.id, findInstrumentChain('keyboard')!);
  const refused = result.problems.some((x) => x.includes('피드백'));
  check(
    'a send into an aux that already feeds back is refused, not added',
    refused && detectFeedback(result.session).length === detectFeedback(session).length,
    refused ? result.problems.filter((x) => x.includes('피드백')).join(' | ')
      : '(the send was added)',
  );
}

// ── Where the auxes land ─────────────────────────────────────────────────
{
  const { session, trackId } = sessionWithTrack();
  const routed = loadChainWithSends(session, trackId, findInstrumentChain('vocal')!).session;
  const at = routed.tracks.findIndex((t) => t.id === trackId);
  const below = routed.tracks.slice(at + 1, at + 3).map((t) => t.inserts[0]?.pluginId ?? '?');
  check(
    'the auxes sit under the track that threw to them, in chain order',
    JSON.stringify(below) === JSON.stringify(['delay', 'plate']),
    `rows below the vocal → ${below.join(', ')} (the chain's own order)`,
  );
}

// ── A bus already using the name ─────────────────────────────────────────
{
  const track = createTrack('Vox', 'audio');
  // A bus called Plate Reverb with no aux carrying a plate — somebody renamed
  // a bus, or deleted the aux and left the bus behind.
  const squatter = createBus('Plate Reverb');
  const session = addTrack({ ...createSession('name'), buses: [squatter] }, track);
  const result = loadChainWithSends(session, track.id, findInstrumentChain('keyboard')!);
  const names = result.session.buses.map((b) => b.name);
  check(
    'a bus already holding the name does not get a second bus with the same one',
    new Set(names).size === names.length && names.length === 2,
    `buses → ${names.join(', ')}`,
  );
}

// ── Through a save and back ──────────────────────────────────────────────
{
  const { session, trackId } = sessionWithTrack();
  const routed = loadChainWithSends(session, trackId, findInstrumentChain('vocal')!).session;
  const parsed = deserializeDawSession(serializeDawSession(routed));
  const back = parsed.ok ? parsed.session : null;
  const track = back ? findTrack(back, trackId) : null;
  check(
    'the routing survives a save and a reload',
    back !== null
      && auxTracks(back).length === 2
      && back.buses.length === 2
      && track?.sends.length === 2
      && track.sends.every((s) => back.buses.some((b) => b.id === s.target)),
    back === null ? `parse failed: ${parsed.ok ? '' : parsed.error}`
      : `${auxTracks(back).length} auxes, ${back.buses.length} buses, ${track?.sends.length ?? 0} sends restored`,
  );
}

// ── Both doors, and one flag ─────────────────────────────────────────────
{
  const rack = readFileSync('src/renderer/components/daw/plugin/InsertRack.tsx', 'utf8');
  const mixer = readFileSync('src/renderer/components/daw/mix/MixWindow.tsx', 'utf8');
  const store = readFileSync('src/renderer/stores/workspaceStore.ts', 'utf8');
  check(
    'both pickers can route, through the same function',
    /loadChainWithSends\(/.test(rack) && /loadChainWithSends\(/.test(mixer),
    'the insert rack and the mixer strip both call it',
  );
  check(
    'and both read the same flag, so the two cannot disagree',
    /useWorkspaceStore\(\(s\) => s\.chainSendRouting\)/.test(rack)
      && /useWorkspaceStore\(\(s\) => s\.chainSendRouting\)/.test(mixer)
      && /chainSendRouting: false,/.test(store),
    'one workspace boolean, off by default',
  );
  check(
    'the insert chain is still what loads with the flag off',
    /if \(sendRouted\) \{ loadInstrumentChainToSends\(chain\); return; \}/.test(rack)
      && /if \(sendRouted\) \{/.test(mixer),
    'routing is the branch, not the default',
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
