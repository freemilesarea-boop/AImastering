/**
 * ableton-selftest — Device Chain, Racks and Session View (ABLETON-CORE-1).
 *
 * The three things worth stealing, each held to the behaviour that makes it
 * worth stealing:
 *
 *   Device Chain — a GRAPH, so a parallel branch and a send are first-class,
 *                  not a special case bolted onto a list of slots.
 *   Rack         — a chain folded into four knobs, where opening it shows the
 *                  real devices and every mapping.
 *   Session View — clips launched on a musical boundary, then printed to the
 *                  timeline as an actual arrangement.
 *
 * Run: pnpm --filter @aimaster/desktop test:ableton
 */

import {
  emptyGraph, linearGraph, createNode, connect, disconnect, insertOnEdge,
  removeNode, addParallelBranch, addSend, hasCycle, topoOrder, validateGraph,
  describeFlow, deviceOrder, findNode, edgesFrom, edgesTo, layout, splitPoints,
  mergePoints, reachableFrom, INPUT_ID, OUTPUT_ID, type DeviceGraph,
} from '../src/renderer/daw/model/device-graph.js';
import {
  buildRack, rackBlueprints, resolveRack, resolvedParams, setRackMacro,
  mapMacro, unmapMacro, macroFor, describeRack, validateRack, createRack,
} from '../src/renderer/daw/model/racks.js';
import { chainLatency } from '../src/renderer/daw/engine/device-chain.js';
import {
  emptyGrid, addScene, removeScene, renameScene, setSlotClip, clearSlot, slotAt,
  sceneSlots, trackSlots, nextBoundary, queueSlot, queueScene, queueStop, stopAll,
  advance, isPlaying, isQueued, convertToArrangement, defaultPlan, describePlan,
  barSeconds, EMPTY_LAUNCH, type SessionGrid, type LaunchState,
} from '../src/renderer/daw/model/session-view.js';
import {
  addTrack, createClip, createSession, createTrack, findTrack, trackClips,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import { findPlugin } from '../src/renderer/daw/engine/plugins.js';
import type { DawSession } from '../src/renderer/daw/model/types.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function eq<T>(a: T, b: T, m: string): void {
  if (a !== b) throw new Error(`${m} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}
function close(a: number, b: number, m: string, tol = 1e-9): void {
  if (Math.abs(a - b) > tol) throw new Error(`${m} — got ${a}, want ${b} ±${tol}`);
}

const labels = (graph: DeviceGraph): string =>
  topoOrder(graph).map((n) => n.label).join(' → ');

// ── Device Chain ──────────────────────────────────────────────────────────────

check('an empty chain is INPUT → OUTPUT and is valid', () => {
  resetIds();
  const graph = emptyGraph();
  eq(graph.nodes.length, 2, 'two nodes');
  eq(graph.edges.length, 1, 'one cable');
  eq(validateGraph(graph).length, 0, 'no problems');
  eq(labels(graph), 'INPUT → OUTPUT', 'order');
});

check('a linear chain runs in the order it was written', () => {
  resetIds();
  const graph = linearGraph([
    { pluginId: 'eq3', label: 'EQ' },
    { pluginId: 'comp', label: 'COMP' },
    { pluginId: 'saturation', label: 'SATURATION' },
    { pluginId: 'limiter', label: 'LIMIT' },
  ]);
  eq(labels(graph), 'INPUT → EQ → COMP → SATURATION → LIMIT → OUTPUT', 'signal order');
  eq(deviceOrder(graph).length, 4, 'four devices');
  eq(validateGraph(graph).length, 0, 'valid');
  eq(findNode(graph, INPUT_ID)?.kind, 'input', 'input node');
  eq(findNode(graph, OUTPUT_ID)?.kind, 'output', 'output node');
});

check('dropping a device on a cable splices it in', () => {
  resetIds();
  const graph = linearGraph([{ pluginId: 'eq3', label: 'EQ' }]);
  const cable = graph.edges.find((e) => e.from === INPUT_ID);
  assert(cable !== undefined, 'found the INPUT cable');
  const spliced = insertOnEdge(graph, cable!.id, createNode({
    kind: 'device', pluginId: 'denoise', label: 'DENOISE',
  }));
  eq(labels(spliced), 'INPUT → DENOISE → EQ → OUTPUT', 'spliced ahead of the EQ');
  eq(validateGraph(spliced).length, 0, 'still valid');
});

check('removing a device heals the path instead of muting the channel', () => {
  resetIds();
  const graph = linearGraph([
    { pluginId: 'eq3', label: 'EQ' },
    { pluginId: 'comp', label: 'COMP' },
  ]);
  const comp = deviceOrder(graph).find((n) => n.label === 'COMP');
  const healed = removeNode(graph, comp!.id);
  eq(labels(healed), 'INPUT → EQ → OUTPUT', 'EQ now feeds the output');
  eq(validateGraph(healed).length, 0, 'no dead ends');
  // The endpoints cannot be removed.
  eq(removeNode(healed, INPUT_ID), healed, 'input is protected');
  eq(removeNode(healed, OUTPUT_ID), healed, 'output is protected');
});

check('a parallel branch splits and merges — the diagram from the brief', () => {
  resetIds();
  let graph = linearGraph([
    { pluginId: 'denoise', label: 'DENOISE' },
    { pluginId: 'eq3', label: 'EQ' },
    { pluginId: 'comp', label: 'COMP' },
    { pluginId: 'limiter', label: 'LIMIT' },
  ]);
  const eq3 = deviceOrder(graph).find((n) => n.label === 'EQ')!;
  const comp = deviceOrder(graph).find((n) => n.label === 'COMP')!;

  graph = addParallelBranch(graph, eq3.id, comp.id, createNode({
    kind: 'device', pluginId: 'saturation', label: 'PARALLEL SAT',
  }), -6);
  graph = addSend(graph, comp.id, 'bus-reverb', 'REVERB SEND', -12);
  graph = layout(graph);

  // EQ now feeds two places; COMP is fed from two.
  eq(edgesFrom(graph, eq3.id).length, 2, 'EQ splits');
  eq(edgesTo(graph, comp.id).length, 2, 'COMP merges');
  assert(splitPoints(graph).some((n) => n.id === eq3.id), 'EQ is a split point');
  assert(mergePoints(graph).some((n) => n.id === comp.id), 'COMP is a merge point');

  const sat = graph.nodes.find((n) => n.label === 'PARALLEL SAT')!;
  const blend = graph.edges.find((e) => e.from === sat.id && e.to === comp.id)!;
  close(blend.gainDb, -6, 'the branch is blended, not replaced');

  // The send taps the path and stops there; the main path continues.
  const send = graph.nodes.find((n) => n.kind === 'send')!;
  eq(send.busId, 'bus-reverb', 'send target');
  eq(edgesFrom(graph, send.id).length, 0, 'a send is a leaf');
  assert(edgesFrom(graph, comp.id).some((e) => {
    const target = findNode(graph, e.to);
    return target?.label === 'LIMIT';
  }), 'COMP still feeds LIMIT');

  eq(validateGraph(graph).filter((p) => p.severity === 'error').length, 0, 'no errors');

  // Topological order must place the merge after BOTH of its sources.
  const order = topoOrder(graph).map((n) => n.label);
  assert(order.indexOf('COMP') > order.indexOf('EQ'), 'COMP after EQ');
  assert(order.indexOf('COMP') > order.indexOf('PARALLEL SAT'), 'COMP after the branch');
});

check('the chain renders as the ASCII diagram engineers draw', () => {
  resetIds();
  let graph = linearGraph([
    { pluginId: 'eq3', label: 'EQ' },
    { pluginId: 'comp', label: 'COMP' },
  ]);
  const eq3 = deviceOrder(graph).find((n) => n.label === 'EQ')!;
  const comp = deviceOrder(graph).find((n) => n.label === 'COMP')!;
  graph = addParallelBranch(graph, eq3.id, comp.id, createNode({
    kind: 'device', pluginId: 'saturation', label: 'PARALLEL SAT',
  }));
  graph = layout(graph);

  const text = describeFlow(graph);
  assert(text.includes('INPUT'), 'starts at the input');
  assert(text.includes('├────► PARALLEL SAT'), `branch is drawn — got:\n${text}`);
  assert(text.includes('▼'), 'flow arrows');
});

check('a cable that would feed back is refused', () => {
  resetIds();
  const graph = linearGraph([
    { pluginId: 'eq3', label: 'EQ' },
    { pluginId: 'comp', label: 'COMP' },
  ]);
  const eq3 = deviceOrder(graph).find((n) => n.label === 'EQ')!;
  const comp = deviceOrder(graph).find((n) => n.label === 'COMP')!;
  const looped = connect(graph, comp.id, eq3.id);
  eq(looped, graph, 'refused, graph unchanged');
  assert(!hasCycle(graph), 'still acyclic');
  eq(connect(graph, eq3.id, eq3.id), graph, 'self-connection refused');
});

check('validation catches the two ways a chain goes silent', () => {
  resetIds();
  const graph = linearGraph([{ pluginId: 'eq3', label: 'EQ' }]);
  // 1. The output is unreachable.
  const cut = disconnect(graph, graph.edges.find((e) => e.to === OUTPUT_ID)!.id);
  const cutProblems = validateGraph(cut);
  assert(cutProblems.some((p) => p.severity === 'error'), 'broken path is an error');

  // 2. A device that goes nowhere.
  const orphan = { ...graph, nodes: [...graph.nodes, createNode({
    kind: 'device', pluginId: 'comp', label: 'ORPHAN',
  })] };
  const orphanProblems = validateGraph(orphan);
  assert(orphanProblems.some((p) => p.message.includes('ORPHAN')), 'unreachable device is flagged');
});

check('layout places columns by signal depth', () => {
  resetIds();
  let graph = linearGraph([
    { pluginId: 'eq3', label: 'EQ' },
    { pluginId: 'comp', label: 'COMP' },
  ]);
  const eq3 = deviceOrder(graph).find((n) => n.label === 'EQ')!;
  const comp = deviceOrder(graph).find((n) => n.label === 'COMP')!;
  graph = layout(addParallelBranch(graph, eq3.id, comp.id, createNode({
    kind: 'device', pluginId: 'saturation', label: 'SAT',
  })));

  const col = (label: string): number => graph.nodes.find((n) => n.label === label)!.col;
  eq(col('INPUT'), 0, 'input first');
  assert(col('EQ') < col('SAT'), 'the branch sits after its source');
  assert(col('COMP') > col('SAT'), 'the merge is past the branch');
  eq(col('OUTPUT'), Math.max(...graph.nodes.map((n) => n.col)), 'output last');

  const sat = graph.nodes.find((n) => n.label === 'SAT')!;
  assert(sat.row > 0, 'the branch is drawn on its own lane');
  assert(reachableFrom(graph, INPUT_ID).has(OUTPUT_ID), 'still connected');
});

// ── Racks ─────────────────────────────────────────────────────────────────────

check('the vocal rack contains the chain from the brief', () => {
  resetIds();
  const rack = buildRack('loui-vocal');
  assert(rack !== null, 'built');
  eq(describeRack(rack!), 'DENOISE → PITCH → DYN EQ → COMP → DE-ESSER → SATURATION → AIR',
    'device order');
  eq(rack!.macros.map((m) => m.name).join(','), 'CLEAN,BODY,PRESENCE,AIR', 'four knobs');
  eq(validateRack(rack!).length, 0, 'every mapping points somewhere real');
  for (const node of deviceOrder(rack!.graph)) {
    assert(findPlugin(node.pluginId ?? '') !== undefined, `${node.label} has a plugin`);
  }
});

check('a rack macro moves its parameters from FROM to TO', () => {
  resetIds();
  const rack = buildRack('loui-vocal')!;
  const clean = rack.macros.find((m) => m.name === 'CLEAN')!;
  const denoise = deviceOrder(rack.graph)[0]!;

  const atZero = resolveRack(rack).get(denoise.id)!;
  close(atZero['amount'] ?? -1, 0, 'CLEAN 0 → denoise off');

  const full = resolveRack(setRackMacro(rack, clean.id, 1)).get(denoise.id)!;
  close(full['amount'] ?? -1, 0.85, 'CLEAN 1 → denoise 0.85');
  close(full['thresholdDb'] ?? 0, -42, 'threshold moves too');

  const half = resolveRack(setRackMacro(rack, clean.id, 0.5)).get(denoise.id)!;
  close(half['amount'] ?? -1, 0.425, 'halfway');

  // Out-of-range values clamp.
  const over = resolveRack(setRackMacro(rack, clean.id, 4)).get(denoise.id)!;
  close(over['amount'] ?? -1, 0.85, 'clamped at 1');
});

check('one macro can push one parameter up while pulling another down', () => {
  resetIds();
  const rack = buildRack('loui-vocal')!;
  const presence = rack.macros.find((m) => m.name === 'PRESENCE')!;
  const comp = deviceOrder(rack.graph).find((n) => n.label === 'COMP')!;

  const zero = resolveRack(rack).get(comp.id)!;
  const one = resolveRack(setRackMacro(rack, presence.id, 1)).get(comp.id)!;
  assert((one['ratio'] ?? 0) > (zero['ratio'] ?? 0), 'ratio rises');
  assert((one['attackMs'] ?? 0) < (zero['attackMs'] ?? 0), 'attack shortens at the same time');
});

check('the rack view can say which macro owns a parameter', () => {
  resetIds();
  const rack = buildRack('loui-vocal')!;
  const denoise = deviceOrder(rack.graph)[0]!;
  eq(macroFor(rack, denoise.id, 'amount')?.name, 'CLEAN', 'owned by CLEAN');
  eq(macroFor(rack, denoise.id, 'releaseMs'), undefined, 'unmapped parameter has no owner');

  const flat = resolvedParams(rack);
  const owned = flat.find((p) => p.nodeId === denoise.id && p.param === 'amount');
  assert(owned?.macroId !== null, 'flat list carries the owner too');
});

check('macros can be re-mapped and unmapped', () => {
  resetIds();
  const rack = buildRack('loui-vocal')!;
  const air = rack.macros.find((m) => m.name === 'AIR')!;
  const sat = deviceOrder(rack.graph).find((n) => n.label === 'SATURATION')!;

  const remapped = mapMacro(rack, air.id, { nodeId: sat.id, param: 'mix', from: 0, to: 0.9 });
  eq(macroFor(remapped, sat.id, 'mix')?.name, 'AIR', 'new mapping took');
  close(resolveRack(setRackMacro(remapped, air.id, 1)).get(sat.id)!['mix'] ?? -1, 0.9, 'applied');

  const removed = unmapMacro(remapped, air.id, sat.id, 'mix');
  eq(macroFor(removed, sat.id, 'mix'), undefined, 'unmapped');
});

check('a rack with a dangling mapping reports it', () => {
  resetIds();
  const rack = createRack('Broken', linearGraph([{ pluginId: 'eq3', label: 'EQ' }]), [
    { id: 'm1', name: 'X', label: 'x', targets: [{ nodeId: 'nope', param: 'lowDb', from: 0, to: 1 }] },
  ]);
  assert(validateRack(rack).length > 0, 'dangling target reported');
});

check('every blueprint builds and validates', () => {
  for (const blueprint of rackBlueprints()) {
    resetIds();
    const rack = buildRack(blueprint.id);
    assert(rack !== null, `${blueprint.id} builds`);
    eq(validateRack(rack!).length, 0, `${blueprint.id} is consistent`);
    assert(rack!.macros.length >= 3, `${blueprint.id} exposes knobs`);
  }
  eq(buildRack('nope'), null, 'unknown blueprint');
});

check('chain latency follows the longest path, through racks', () => {
  resetIds();
  // A look-ahead limiter on the main path and a clean parallel branch: the
  // chain's latency is the limiter's, not the sum of both branches.
  let graph = linearGraph([
    { pluginId: 'eq3', label: 'EQ' },
    { pluginId: 'limiter', label: 'LIMIT', params: { lookaheadMs: 5, ceilingDb: -1, releaseMs: 80 } },
  ]);
  const eq3 = deviceOrder(graph).find((n) => n.label === 'EQ')!;
  const limiter = deviceOrder(graph).find((n) => n.label === 'LIMIT')!;
  graph = addParallelBranch(graph, eq3.id, limiter.id, createNode({
    kind: 'device', pluginId: 'saturation', label: 'SAT',
  }));

  eq(chainLatency(graph, [], 48_000), Math.round(0.005 * 48_000), '5 ms look-ahead');

  // Bypassing it takes the latency away.
  const bypassed = {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === limiter.id ? { ...n, bypass: true } : n)),
  };
  eq(chainLatency(bypassed, [], 48_000), 0, 'bypass removes it');

  // An offline device reports nothing, because it does not run live.
  const offlineOnly = linearGraph([{ pluginId: 'pitchcorrect', label: 'PITCH' }]);
  eq(chainLatency(offlineOnly, [], 48_000), 0, 'offline devices add no latency');
});

// ── Session View ──────────────────────────────────────────────────────────────

function gridSession(): { session: DawSession; grid: SessionGrid; ids: string[] } {
  resetIds();
  let session = createSession('Session', 48_000);
  session = { ...session, tempoBpm: 120, timeSignature: [4, 4] };
  const ids: string[] = [];
  for (const name of ['Drum', 'Bass', 'Piano']) {
    const track = createTrack(name, 'audio');
    session = addTrack(session, track);
    ids.push(track.id);
  }

  let grid = emptyGrid();
  grid = addScene(grid, 'Scene A');
  grid = addScene(grid, 'Scene B');
  grid = addScene(grid, 'Scene C');

  const barSec = barSeconds(session);            // 2 s at 120 BPM, 4/4
  // Drum plays in every scene, Bass in A and B, Piano in A and C.
  grid = setSlotClip(grid, ids[0]!, 0, createClip('f-drum', 'Drum A', { durationSec: barSec }));
  grid = setSlotClip(grid, ids[0]!, 1, createClip('f-drum', 'Drum B', { durationSec: barSec }));
  grid = setSlotClip(grid, ids[0]!, 2, createClip('f-drum', 'Drum C', { durationSec: barSec }));
  grid = setSlotClip(grid, ids[1]!, 0, createClip('f-bass', 'Bass A', { durationSec: barSec * 2 }));
  grid = setSlotClip(grid, ids[1]!, 1, createClip('f-bass', 'Bass B', { durationSec: barSec * 2 }));
  grid = setSlotClip(grid, ids[2]!, 0, createClip('f-pno', 'Piano A', { durationSec: barSec * 4 }));
  grid = setSlotClip(grid, ids[2]!, 2, createClip('f-pno', 'Piano C', { durationSec: barSec * 4 }));
  return { session, grid, ids };
}

check('the grid holds clips per track and scene', () => {
  const { grid, ids } = gridSession();
  eq(grid.scenes.length, 3, 'three scenes');
  eq(sceneSlots(grid, 0).length, 3, 'scene A has three clips');
  eq(sceneSlots(grid, 1).length, 2, 'scene B has two');
  eq(trackSlots(grid, ids[2]!).length, 2, 'piano appears twice');
  eq(slotAt(grid, ids[2]!, 1), undefined, 'piano has nothing in scene B');

  const cleared = clearSlot(grid, ids[0]!, 1);
  eq(slotAt(cleared, ids[0]!, 1), undefined, 'cleared');
});

check('removing a scene re-indexes the ones after it', () => {
  const { grid, ids } = gridSession();
  const without = removeScene(grid, 0);
  eq(without.scenes.length, 2, 'two scenes left');
  eq(without.scenes[0]?.name, 'Scene B', 'B moved up');
  eq(slotAt(without, ids[0]!, 0)?.clip?.name, 'Drum B', 'its clips came with it');
  eq(slotAt(without, ids[2]!, 1)?.clip?.name, 'Piano C', 'C re-indexed to 1');
  eq(renameScene(without, 0, 'Intro').scenes[0]?.name, 'Intro', 'rename');
});

check('launches wait for the next musical boundary', () => {
  eq(nextBoundary(0, 1), 0, 'exactly on a bar fires now');
  eq(nextBoundary(0.3, 1), 1, 'mid-bar waits for the next');
  eq(nextBoundary(2.5, 4), 4, 'four-bar quantise');
  eq(nextBoundary(3.2, 0), 3.2, 'quantise off fires immediately');
  eq(nextBoundary(5, 4), 8, 'past a boundary waits for the following one');
});

check('a queued clip starts when the bar arrives, not before', () => {
  const { grid, ids } = gridSession();
  const slot = slotAt(grid, ids[0]!, 0)!;
  let state: LaunchState = queueSlot(EMPTY_LAUNCH, grid, slot.id, 0.4);
  assert(isQueued(state, slot), 'queued');
  assert(!isPlaying(state, slot), 'not playing yet');

  const early = advance(state, grid, 0.9);
  eq(early.started.length, 0, 'nothing at 0.9 bars');

  const onBar = advance(state, grid, 1);
  eq(onBar.started.length, 1, 'starts on bar 1');
  state = onBar.state;
  assert(isPlaying(state, slot), 'now playing');
  assert(!isQueued(state, slot), 'no longer queued');
});

check('one clip per track — a new launch replaces the old one', () => {
  const { grid, ids } = gridSession();
  const a = slotAt(grid, ids[0]!, 0)!;
  const b = slotAt(grid, ids[0]!, 1)!;
  let state = advance(queueSlot(EMPTY_LAUNCH, grid, a.id, 0), grid, 0).state;
  assert(isPlaying(state, a), 'A playing');

  state = queueSlot(state, grid, b.id, 0.2);
  eq(state.queued.length, 1, 'one pending launch for the track');
  state = advance(state, grid, 1).state;
  assert(isPlaying(state, b) && !isPlaying(state, a), 'B replaced A');
});

check('launching a scene fires its row and leaves other tracks alone', () => {
  const { grid, ids } = gridSession();
  // Start with scene A everywhere.
  let state = advance(queueScene(EMPTY_LAUNCH, grid, 0, 0), grid, 0).state;
  eq(Object.keys(state.playing).length, 3, 'three tracks playing');

  // Scene B has no piano clip: the piano keeps playing what it had.
  state = advance(queueScene(state, grid, 1, 0), grid, 0).state;
  eq(state.lastScene, 1, 'scene remembered for the highlight');
  eq(slotAt(grid, ids[2]!, 0)!.id, state.playing[ids[2]!], 'piano still on its scene A clip');
  eq(slotAt(grid, ids[0]!, 1)!.id, state.playing[ids[0]!], 'drums moved to scene B');
});

check('stop is quantised too, and stop-all clears the grid', () => {
  const { grid, ids } = gridSession();
  let state = advance(queueScene(EMPTY_LAUNCH, grid, 0, 0), grid, 0).state;

  state = queueStop(state, ids[1]!, 0.5, 1);
  const stillPlaying = advance(state, grid, 0.7);
  eq(stillPlaying.stopped.length, 0, 'not yet');
  const stopped = advance(state, grid, 1);
  eq(stopped.stopped.length, 1, 'stops on the bar');
  state = stopped.state;
  assert(state.playing[ids[1]!] === undefined, 'bass stopped');

  state = advance(stopAll(state, 1), grid, 2).state;
  eq(Object.keys(state.playing).length, 0, 'everything stopped');
});

// ── Convert to Arrangement ────────────────────────────────────────────────────

check('a scene order becomes real clips on the timeline', () => {
  const { session, grid, ids } = gridSession();
  const barSec = barSeconds(session);            // 2 s
  const arranged = convertToArrangement(session, grid, [
    { sceneIndex: 0, bars: 4 },
    { sceneIndex: 1, bars: 4 },
  ]);

  const drums = trackClips(findTrack(arranged, ids[0]!)!);
  // A one-bar loop fills four bars → four clips per scene, eight in total.
  eq(drums.length, 8, `drums repeat to fill — got ${drums.length}`);
  close(drums[0]!.startSec, 0, 'first clip at zero');
  close(drums[4]!.startSec, barSec * 4, 'scene B starts after four bars');
  eq(drums[4]!.name, 'Drum B', 'scene B clip is the one from that row');

  const piano = trackClips(findTrack(arranged, ids[2]!)!);
  // Piano only exists in scene A; its clip is four bars long, so one copy.
  eq(piano.length, 1, 'piano plays once');
  close(piano[0]!.durationSec, barSec * 4, 'not trimmed — it exactly fills');
});

check('a loop is trimmed so it never spills into the next section', () => {
  const { session, grid, ids } = gridSession();
  const barSec = barSeconds(session);
  // Bass is a two-bar loop; a three-bar section must cut the second pass.
  const arranged = convertToArrangement(session, grid, [{ sceneIndex: 0, bars: 3 }]);
  const bass = trackClips(findTrack(arranged, ids[1]!)!);
  eq(bass.length, 2, 'two passes');
  close(bass[1]!.startSec, barSec * 2, 'second pass starts at bar 2');
  close(bass[1]!.durationSec, barSec, 'and is trimmed to one bar');
  const end = bass[1]!.startSec + bass[1]!.durationSec;
  close(end, barSec * 3, 'nothing spills past the section');
});

check('convert can append after the timeline or replace it', () => {
  const { session, grid, ids } = gridSession();
  const barSec = barSeconds(session);
  const once = convertToArrangement(session, grid, [{ sceneIndex: 0, bars: 2 }]);
  const twice = convertToArrangement(once, grid, [{ sceneIndex: 1, bars: 2 }], {
    startSec: barSec * 2,
  });
  eq(trackClips(findTrack(twice, ids[0]!)!).length, 4, 'appended, not replaced');

  const replaced = convertToArrangement(twice, grid, [{ sceneIndex: 2, bars: 1 }], {
    replace: true,
  });
  eq(trackClips(findTrack(replaced, ids[0]!)!).length, 1, 'replace clears first');
  eq(trackClips(findTrack(replaced, ids[1]!)!).length, 0, 'bass has nothing in scene C');
});

check('the default plan sizes each scene to its longest clip', () => {
  const { session, grid } = gridSession();
  const plan = defaultPlan(session, grid);
  eq(plan.length, 3, 'one step per scene');
  eq(plan[0]?.bars, 4, 'scene A is four bars (the piano)');
  eq(plan[1]?.bars, 2, 'scene B is two (the bass)');
  eq(plan[2]?.bars, 4, 'scene C is four (the piano)');
  eq(describePlan(grid, plan), 'Scene A ×4 → Scene B ×2 → Scene C ×4', 'readable plan');
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Device Chain · Racks · Session View ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
