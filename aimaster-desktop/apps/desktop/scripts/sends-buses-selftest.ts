/**
 * sends-buses-selftest — what a send does, and what a bus is.
 *
 * Two fields in the model did nothing, and both were found by rendering
 * rather than by reading:
 *
 *   · `Send.pan`.  Written by `createSend`, saved into every session file,
 *     carried through session import, offered as an automation TARGET — and
 *     hard left, centre and hard right rendered byte-identical, because the
 *     send was a bare GainNode with no panner behind it.
 *   · `BusDef.channels`.  Same story: stored, saved, imported, and a mono bus
 *     rendered identically to a stereo one.
 *
 * A third thing was reachable only from the engine: `Send.mute` was honoured
 * in `applyParams` and had no control anywhere in the app, so the only way to
 * silence one send was to pull its level down and lose the setting.
 *
 * And a bus could be created and never anything else — no rename, no delete.
 * Delete is the one destructive operation here and the one worth testing
 * hardest: a bus is referenced from four directions, and a session holding a
 * reference to a bus that is gone is not cosmetic.  The engine resolves those
 * references to nodes, so a track pointing at a missing bus is a track whose
 * audio goes nowhere — silently, because there is nothing to warn about at
 * the moment the sound should have been there.
 *
 * Run: pnpm --filter @aimaster/desktop test:sends-buses
 */

import { OfflineAudioContext } from 'node-web-audio-api';

import {
  busUsage, busUsageCount, nextBusName, removeBus, renameBus, setBusChannels,
} from '../src/renderer/daw/model/buses.js';
import {
  addTrack, createBus, createInsert, createSend, createSession, createTrack,
  setInsert, setOutput, setSend, updateTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { availableTargets, isPlayable } from '../src/renderer/daw/edit/automation-lanes.js';
import { defaultParams } from '../src/renderer/daw/engine/plugins.js';
import { MixerEngine } from '../src/renderer/daw/engine/mixer-engine.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { DawSession, Send, Track } from '../src/renderer/daw/model/types.js';

const SR = 48_000;

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); } catch (e: unknown) {
    results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
  }
}
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); results.push({ name, pass: true, detail: '' }); } catch (e: unknown) {
    results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
  }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function close(a: number, b: number, m: string, tol: number): void {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${m} — got ${a.toFixed(5)}, want ${b.toFixed(5)} ±${tol}`);
}
const db = (x: number): number => (x > 1e-9 ? 20 * Math.log10(x) : -120);

// ── Model: naming, folding, removing ────────────────────────────────────────

interface Fixture { session: DawSession; src: Track; aux: Track; busId: string }

/**
 * Source → send → bus → aux → master, with the source's own output muted.
 *
 * Muted on purpose: whatever reaches the master came down the send path, so
 * the measurement is of the send and not of the channel underneath it.
 */
function fixture(over: Partial<Send> = {}, channels: 1 | 2 = 2): Fixture {
  resetIds();
  const src = createTrack('Src', 'audio');
  const aux = createTrack('Verb', 'aux');
  const bus = createBus('FX', channels);
  let session: DawSession = addTrack(addTrack(createSession('sends', SR), src), aux);
  session = { ...session, buses: [bus] };
  session = updateTrack(session, src.id, (t) => ({ ...t, mute: true }));
  session = setSend(session, src.id,
    createSend(0, bus.id, { levelDb: 0, preFader: true, ...over }));
  session = updateTrack(session, aux.id, (t) => ({ ...t, input: bus.id }));
  return { session, src, aux, busId: bus.id };
}

check('a bus can be renamed, and an empty name is not a rename', () => {
  const { session, busId } = fixture();
  const named = renameBus(session, busId, '  Plate  ');
  assert(named.buses[0]?.name === 'Plate', `got ${named.buses[0]?.name}`);
  assert(renameBus(named, busId, '   ') === named, 'blanking the field wiped the name');
  assert(renameBus(named, busId, 'Plate') === named, 'a no-op rename made a new session');
});

check('the next bus name is one nobody is using, not one past the count', () => {
  // The button used to name a bus `Bus ${buses.length + 1}`, which is not a
  // free name, it is an arithmetic coincidence.  One bus called `Bus 2` — the
  // state after a single rename — makes counting hand out `Bus 2` again.
  const session: DawSession = { ...fixture().session, buses: [createBus('Bus 2')] };
  const counted = `Bus ${session.buses.length + 1}`;
  assert(counted === 'Bus 2', 'the counting rule being compared against has changed');
  const picked = nextBusName(session);
  assert(picked !== counted, `counting collided and so did this: ${picked}`);
  assert(picked === 'Bus 1', `expected the free slot below it, got ${picked}`);

  // And it keeps skipping upward past however many are taken.
  const many: DawSession = {
    ...session,
    buses: ['Bus 1', 'Bus 2', 'Bus 3', 'Bus 5'].map((n) => createBus(n)),
  };
  assert(nextBusName(many) === 'Bus 4', `expected the gap, got ${nextBusName(many)}`);
});

check('usage counts every direction a bus is referenced from', () => {
  const { session, src, aux, busId } = fixture();
  let s = setOutput(session, aux.id, { kind: 'bus', busId });
  s = setInsert(s, src.id, createInsert(0, 'comp', 'Comp', {
    params: defaultParams('comp'), sidechainSource: busId,
  }));
  const usage = busUsage(s, busId);
  assert(usage.sends.length === 1, `sends ${usage.sends.length}`);
  assert(usage.inputs.length === 1, `aux inputs ${usage.inputs.length}`);
  assert(usage.outputs.length === 1, `track outputs ${usage.outputs.length}`);
  assert(usage.sidechains.length === 1, `sidechains ${usage.sidechains.length}`);
  assert(busUsageCount(usage) === 4, `total ${busUsageCount(usage)}`);
});

check('removing a bus takes every reference with it, in one session', () => {
  // One step, not two: with undo recording every apply, a half-cleaned
  // session is a state a user can press Ctrl+Z back into.
  const { session, src, aux, busId } = fixture();
  let s = setOutput(session, aux.id, { kind: 'bus', busId });
  s = setInsert(s, src.id, createInsert(0, 'comp', 'Comp', {
    params: defaultParams('comp'), sidechainSource: busId,
  }));
  const after = removeBus(s, busId);

  assert(after.buses.length === 0, 'the bus is gone');
  assert(busUsageCount(busUsage(after, busId)) === 0, 'and so is every reference to it');
  const auxAfter = after.tracks.find((t) => t.id === aux.id)!;
  assert(auxAfter.input === null, 'the aux input was cleared');
  assert(auxAfter.output.kind === 'master', 'and its output fell back to the master, not to silence');
  const srcAfter = after.tracks.find((t) => t.id === src.id)!;
  assert(srcAfter.sends.length === 0, 'the send was deleted — a send with no target is not a send');
  assert(srcAfter.inserts[0]?.sidechainSource === null, 'and the sidechain key fell back to its own input');
});

check('removing one bus leaves the others alone', () => {
  const { session, src, busId } = fixture();
  const other = createBus('Keep');
  let s: DawSession = { ...session, buses: [...session.buses, other] };
  s = setSend(s, src.id, createSend(1, other.id, { levelDb: -6 }));
  const after = removeBus(s, busId);
  assert(after.buses.length === 1 && after.buses[0]?.id === other.id, 'the wrong bus went');
  const srcAfter = after.tracks.find((t) => t.id === src.id)!;
  assert(srcAfter.sends.length === 1 && srcAfter.sends[0]?.target === other.id,
    'the unrelated send was collateral damage');
});

check('removing a bus that is not there changes nothing at all', () => {
  const { session } = fixture();
  assert(removeBus(session, 'bus-that-never-was') === session, 'a new session object was made');
});

check('setBusChannels is a no-op when it would not change anything', () => {
  const { session, busId } = fixture();
  assert(setBusChannels(session, busId, 2) === session, 'stereo to stereo rebuilt the session');
  const mono = setBusChannels(session, busId, 1);
  assert(mono.buses[0]?.channels === 1, 'the fold was not stored');
  assert(setBusChannels(mono, busId, 1) === mono, 'mono to mono rebuilt the session');
});

check('a send pan lane is offered and is playable', () => {
  // It was excluded from the menu, correctly, for as long as `Send.pan` was
  // read by nothing.  Now that the send has a panner it has to be both.
  const { session, src } = fixture();
  const track = session.tracks.find((t) => t.id === src.id)!;
  const targets = availableTargets(track);
  const pan = targets.find((t) => t.kind === 'sendPan');
  assert(pan !== undefined, 'no send pan target');
  assert(isPlayable(pan!, track), 'offered but not playable, which is the worst of both');
});

// ── Rendered: what the audio actually does ──────────────────────────────────

interface Rendered { l: number; r: number }

async function render(f: Fixture): Promise<Rendered> {
  const ctx = new OfflineAudioContext(2, SR, SR);
  const engine = new MixerEngine(
    ctx as unknown as BaseAudioContext, ctx.destination as unknown as AudioNode,
  );
  engine.sync(f.session);
  const channel = engine.channel(f.src.id);
  assert(channel !== undefined, 'the source channel was not built');

  const buffer = ctx.createBuffer(1, SR, SR);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < SR; i++) data[i] = Math.sin((2 * Math.PI * 1000 * i) / SR);
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.connect(channel!.input as unknown as AudioNode);
  node.start(0);
  const out = await ctx.startRendering();
  const peak = (c: number): number => {
    const x = out.getChannelData(c);
    let p = 0;
    for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]!); if (a > p) p = a; }
    return p;
  };
  return { l: peak(0), r: peak(1) };
}

async function main(): Promise<void> {
  await checkAsync('a send pan moves the send, and the two sides disagree', async () => {
    // The measurement that found the bug: before the send had a panner these
    // three renders came out identical, to the sample.
    const left = await render(fixture({ pan: -1 }));
    const centre = await render(fixture({ pan: 0 }));
    const right = await render(fixture({ pan: 1 }));

    assert(db(left.l) - db(left.r) > 40, `hard left kept ${db(left.r).toFixed(1)} dB on the right`);
    assert(db(right.r) - db(right.l) > 40, `hard right kept ${db(right.l).toFixed(1)} dB on the left`);
    close(db(centre.l), db(centre.r), 'centre is even', 0.01);
    assert(Math.abs(db(left.l) - db(centre.l)) > 0.5,
      'hard left and centre put the same level on the left — the pan is doing nothing');
  });

  await checkAsync('and it is equal power, so centring does not make a hole', async () => {
    // A mono source through one panner: each side is -3.01 dB at centre and
    // the pair sums to the same power as hard over.  A linear law would drop
    // 6 dB in the middle, which is the classic way a send pan sounds broken.
    const centre = await render(fixture({ pan: 0 }));
    const left = await render(fixture({ pan: -1 }));
    close(db(left.l) - db(centre.l), 3.0103, 'the law is not equal power', 0.05);
  });

  await checkAsync('a muted send is silent, and a level of -12 dB is -12 dB', async () => {
    const muted = await render(fixture({ mute: true }));
    assert(db(muted.l) < -100 && db(muted.r) < -100, `mute left ${db(muted.l).toFixed(1)} dB`);
    const unity = await render(fixture({ levelDb: 0 }));
    const down = await render(fixture({ levelDb: -12 }));
    close(db(unity.l) - db(down.l), 12, 'the send level is not decibels', 0.05);
  });

  await checkAsync('a mono bus folds, and a stereo one does not', async () => {
    // Hard-panned INTO the bus, so there is something for a fold to do.  A
    // stereo bus keeps the side; a mono bus sums to (L+R)/2, which halves a
    // signal that is only on one side — correctly, because that is what
    // folding it does.
    const stereo = await render(fixture({ pan: -1 }, 2));
    const mono = await render(fixture({ pan: -1 }, 1));
    close(db(mono.l), db(mono.r), 'a mono bus still had two different sides', 0.01);
    assert(db(stereo.l) - db(stereo.r) > 40, 'the stereo control was not actually panned');
    close(db(mono.l) - db(stereo.l), -6.0206, 'the fold is not a half-sum', 0.05);
  });

  await checkAsync('and a centred signal keeps its level through the fold', async () => {
    // The other half of the halving: it must not quietly cost 6 dB on
    // everything.  A centred source arrives at both sides already, so
    // (L+R)/2 is the level it came in at.
    const stereo = await render(fixture({ pan: 0 }, 2));
    const mono = await render(fixture({ pan: 0 }, 1));
    close(db(mono.l), db(stereo.l), 'the mono fold cost level on a centred source', 0.05);
  });

  await checkAsync('a session with a removed bus still renders, and loses only that path', async () => {
    // The reason removal cleans up rather than just dropping the bus: the
    // engine resolves references to nodes, so a dangling one is silence with
    // nothing to warn about.
    const f = fixture({ pan: 0 });
    const before = await render(f);
    assert(db(before.l) > -40, 'the fixture was not making sound to begin with');
    const after = await render({ ...f, session: removeBus(f.session, f.busId) });
    assert(db(after.l) < -100, `the send survived its bus, at ${db(after.l).toFixed(1)} dB`);
  });

  await checkAsync('the source itself is unaffected by any of this', async () => {
    // Guards every render above from being vacuous: the source is muted, so
    // if it were leaking to the master the numbers would be measuring the
    // channel rather than the send.
    const f = fixture({ mute: true });
    const out = await render(f);
    assert(db(out.l) < -100, 'the muted source reached the master on its own');
  });

  const failed = results.filter((r) => !r.pass);
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`${r.pass ? '[PASS]' : '[FAIL]'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

void main();
