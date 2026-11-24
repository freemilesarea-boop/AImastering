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

import { OfflineAudioContext } from './lib/offline-audio-context.js';

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
import {
  PATH_DEAD_END, addReturnChannel, deadEndBuses, describePath,
} from '../src/renderer/daw/model/routing.js';

/** Audible, asked the way the mix window asks it: through the readout. */
const heard = (s: DawSession, id: string): boolean =>
  !describePath(s, id).endsWith(PATH_DEAD_END);
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

// ── Dead ends: the warning this file's own opening asked for ───────────────
//
// "a track whose audio goes nowhere — silently, because there is nothing to
// warn about at the moment the sound should have been there."  That sentence
// is at the top of this file and it was a description of the app, not a
// complaint about one bug.  `deadEndBuses` is the warning.
//
// Each check below exists for one way the warning could be wrong, and a wrong
// warning is worse than none: the first one a user dismisses is the last one
// they read.

/** The fixture with the aux's input cleared — the return channel is gone. */
function noReturn(): Fixture {
  const f = fixture();
  return { ...f, session: updateTrack(f.session, f.aux.id, (t) => ({ ...t, input: null })) };
}

check('a send that works is not reported', () => {
  const dead = deadEndBuses(fixture().session);
  assert(dead.length === 0, `warned about a send that works: ${JSON.stringify(dead)}`);
});

check('a send into a bus no aux reads is reported, by track and by send', () => {
  const f = noReturn();
  const dead = deadEndBuses(f.session);
  assert(dead.length === 1, `expected one dead end, got ${dead.length}`);
  const d = dead[0]!;
  assert(d.busId === f.busId, 'named the wrong bus');
  assert(d.deadSends.length === 1, `expected the one send, got ${d.deadSends.length}`);
  assert(d.deadSends[0]![0] === f.src.id, 'named the wrong track');
  // The source itself is still heard — its own output goes to the master, and
  // only the send is lost.  Saying the track is silenced would be a lie.
  assert(d.silenced.length === 0, `claimed ${d.silenced.length} track(s) silenced`);
  assert(heard(f.session, f.src.id), 'called the source inaudible');
});

check('a chain of returns that ends nowhere is as silent as no return at all', () => {
  // One hop is not enough.  The aux DOES read the FX bus — and returns it
  // into a second bus that nothing reads.  A check asking only "does some
  // aux read this bus" passes here, and the reverb is still inaudible.
  const f = fixture();
  const dangling = createBus('Dangling');
  let s: DawSession = { ...f.session, buses: [...f.session.buses, dangling] };
  s = setOutput(s, f.aux.id, { kind: 'bus', busId: dangling.id });

  const dead = deadEndBuses(s);
  const named = dead.map((d) => s.buses.find((b) => b.id === d.busId)?.name).sort();
  assert(dead.length === 2, `expected both buses, got [${named.join(', ')}]`);
  const far = dead.find((d) => d.busId === dangling.id);
  assert(far?.silenced[0] === f.aux.id, 'did not name the aux as the silenced track');
  assert(!heard(s, f.aux.id), 'called the aux audible');
  assert(heard(s, f.src.id), 'the source still reaches the master by its own output');
});

check('a bus read only as a sidechain key is not a dead end', () => {
  // Feeding a compressor's key input is the normal use for a send whose
  // audio is never meant to be heard.
  const f = noReturn();
  const s = setInsert(f.session, f.aux.id, createInsert(0, 'comp', 'Comp', {
    params: defaultParams('comp'), sidechainSource: f.busId,
  }));
  const dead = deadEndBuses(s);
  assert(dead.length === 0, `warned about a key bus: ${JSON.stringify(dead)}`);
});

check('but a track whose main output lands in a key bus is still silenced', () => {
  // Nobody routes a channel's only output into a key bus on purpose, so the
  // key does not excuse this one — and the send into the same bus still is
  // not dead, which is the pair of answers a single flag could not give.
  const f = noReturn();
  let s = setInsert(f.session, f.aux.id, createInsert(0, 'comp', 'Comp', {
    params: defaultParams('comp'), sidechainSource: f.busId,
  }));
  s = setOutput(s, f.src.id, { kind: 'bus', busId: f.busId });
  const dead = deadEndBuses(s);
  assert(dead.length === 1, `expected the bus to be reported, got ${dead.length}`);
  const d = dead[0]!;
  assert(d.silenced[0] === f.src.id, 'did not name the silenced track');
  assert(d.deadSends.length === 0, 'called the send into a key bus dead');
  assert(d.keys.length === 1, 'did not record why the dead end can be right');
});

check('a bus the master itself reads is audible — the master is a sink too', () => {
  // Two sinks, not one.  A track routed to the master lands on the master
  // NODE; the master TRACK is wired straight to the destination and may read
  // a bus through `input` like any aux.  A walk that knows only the node
  // calls this silent, and it is the loudest thing in the session.
  const f = noReturn();
  const master = f.session.tracks.find((t) => t.kind === 'master');
  assert(master !== undefined, 'the fixture has no master track');
  const s = updateTrack(f.session, master!.id, (t) => ({ ...t, input: f.busId }));
  const dead = deadEndBuses(s);
  assert(dead.length === 0, `called a bus the master reads silent: ${JSON.stringify(dead)}`);
});

check('an empty bus is one waiting to be used, not a warning', () => {
  const f = fixture();
  const spare = createBus('Spare');
  const s: DawSession = { ...f.session, buses: [...f.session.buses, spare] };
  assert(deadEndBuses(s).every((d) => d.busId !== spare.id),
    'warned about the bus the user just created');
});

check('a send the user muted is not a send that is broken', () => {
  const f = noReturn();
  const s = updateTrack(f.session, f.src.id, (t) => ({
    ...t, sends: t.sends.map((x) => ({ ...x, mute: true })),
  }));
  const dead = deadEndBuses(s);
  assert(dead.length === 0, `warned about a muted send: ${JSON.stringify(dead)}`);
});

check('a dead end can be fixed in one step, and then it is not one', () => {
  const f = noReturn();
  assert(deadEndBuses(f.session).length === 1, 'the fixture was not broken to begin with');
  const fixed = addReturnChannel(f.session, f.busId);
  assert(fixed !== null, 'refused a bus that exists');
  assert(deadEndBuses(fixed!.session).length === 0, 'still a dead end after the fix');
  const aux = fixed!.session.tracks.find((t) => t.id === fixed!.trackId);
  assert(aux?.input === f.busId, 'the return does not read the bus');
  assert(aux?.kind === 'aux', `the return is a ${aux?.kind} track`);
  assert(aux?.output.kind === 'master', `the return goes to ${aux?.output.kind}`);
  assert(aux?.name.includes('FX'), `the return is called ${aux?.name}, not after its bus`);
  assert(addReturnChannel(f.session, 'bus-nope') === null, 'invented a bus');
});

check('and the return lands under the track that feeds the bus', () => {
  // Not at the bottom of the session: a return that appears off-screen is a
  // second thing to go looking for.  `track-placement` has a sweep that
  // fails any add-track call with no row, and this is the behaviour behind
  // that rule.
  const f = noReturn();
  const rows = addReturnChannel(f.session, f.busId)!.session.tracks.map((t) => t.name);
  assert(rows.join(',') === 'Src,FX 리턴,Verb,Master', `got ${rows.join(',')}`);

  // Nothing feeds it: there is no row to be under, so the default stands —
  // above the master, which `addTrack` keeps last on its own.
  const bare = { ...f.session, buses: [...f.session.buses, createBus('Spare')] };
  const spare = bare.buses[bare.buses.length - 1]!;
  const bareRows = addReturnChannel(bare, spare.id)!.session.tracks.map((t) => t.name);
  assert(bareRows[bareRows.length - 1] === 'Master', `master moved: ${bareRows.join(',')}`);
  assert(bareRows.includes('Spare 리턴'), `got ${bareRows.join(',')}`);
});

check('the signal-path readout says where the signal stops', () => {
  // The readout is the one place the user was already looking.  Ending it on
  // the bus's name let them read "Verb → Plate" as a route to the master.
  const f = noReturn();
  const s = setOutput(f.session, f.src.id, { kind: 'bus', busId: f.busId });
  const path = describePath(s, f.src.id);
  assert(path.endsWith(PATH_DEAD_END), `the readout still reads as a route: ${path}`);
  assert(path.startsWith('Src → FX'), `lost the route itself: ${path}`);
});

check('and it does not say so when another return carries the bus', () => {
  // This walk follows the FIRST aux reading the bus.  With two returns, one
  // dangling and one reaching the master, the bus IS audible — and marking it
  // broken because of the order they happen to sit in would be a lie that
  // teaches the user to ignore the mark.
  const f = fixture();
  const dangling = createBus('Dangling');
  let s: DawSession = { ...f.session, buses: [...f.session.buses, dangling] };
  const extra = createTrack('Second return', 'aux', { input: f.busId });
  s = addTrack(s, extra);
  s = setOutput(s, extra.id, { kind: 'bus', busId: dangling.id });
  s = setOutput(s, f.src.id, { kind: 'bus', busId: f.busId });

  // `extra` is the dangling one and may be the one the walk follows.
  const path = describePath(s, f.src.id);
  assert(!path.includes(PATH_DEAD_END), `cried wolf on an audible bus: ${path}`);
  assert(heard(s, f.src.id), 'called an audible track inaudible');
});

// ── Rendered: what the audio actually does ──────────────────────────────────

interface Rendered { l: number; r: number }

async function render(f: Fixture): Promise<Rendered> {
  return renderSession(f.session, f.src.id);
}

/**
 * The same render, for a session the fixture helpers have taken apart.
 *
 * Split out for the dead-end checks: those need a session whose return
 * channel is gone, which is no longer a `Fixture` — and a silence that is
 * argued from the model instead of rendered is not evidence of anything.
 */
async function renderSession(session: DawSession, srcId: string): Promise<Rendered> {
  const ctx = new OfflineAudioContext(2, SR, SR);
  const engine = new MixerEngine(
    ctx as unknown as BaseAudioContext, ctx.destination as unknown as AudioNode,
  );
  engine.sync(session);
  const channel = engine.channel(srcId);
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
  await checkAsync('and the one-step fix renders the send it was losing', async () => {
    // The fix is the claim, so the fix is what gets rendered.  A repair that
    // satisfies `deadEndBuses` and makes no sound would pass every check
    // above this one.
    const f = noReturn();
    const fixed = addReturnChannel(f.session, f.busId);
    assert(fixed !== null, 'the fix refused the fixture');
    const out = await renderSession(fixed!.session, f.src.id);
    assert(db(out.l) > -40, `still silent at ${db(out.l).toFixed(1)} dB after the fix`);
  });

  await checkAsync('the send it reports really does render silence', async () => {
    // Measured, not argued: the same fixture and the same send level, with
    // the return channel and without it.
    const heard = await render(fixture());
    const f = noReturn();
    const lost = await renderSession(f.session, f.src.id);
    assert(db(heard.l) > -40,
      `the control render was already silent at ${db(heard.l).toFixed(1)} dB`);
    assert(db(lost.l) < -100 && db(lost.r) < -100,
      `expected silence, got ${db(lost.l).toFixed(1)} / ${db(lost.r).toFixed(1)} dB`);
    assert(deadEndBuses(f.session).length === 1, 'rendered silent and reported nothing');
  });

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
