/**
 * macro-stack-selftest — Macro Control System + Track Stacks (UX-CORE-1).
 *
 * The macro layer is the part a beginner touches and an engineer audits, so
 * both halves are pinned down here: that one knob moves the documented set of
 * parameters by the documented amounts, that two macros touching the same
 * parameter ADD instead of fighting, and that a manual override always wins
 * and is visibly marked.
 *
 * Track Stacks are checked for the things that break large sessions: routing,
 * ordering, collapse, and mute/solo reaching through the folder.
 *
 * Run: pnpm --filter @aimaster/desktop test:macro
 */

import {
  MACROS, MACRO_PRESETS, RACK_MODULES, RACK_NEUTRAL, EMPTY_RACK,
  materializeRack, moduleParams, setMacro, setOverride, clearOverride,
  explainMacro, activeMacros, findMacro, overrideKey,
  type MacroRack,
} from '../src/renderer/daw/model/macros.js';
import {
  createStack, unpackStack, stackChildren, stackDescendants, stackAncestors,
  stackDepth, wouldNest, setParent, toggleCollapsed, isHidden, visibleTracks,
  collapsedOverviewClips, stackSummary, isSummingStack, reorderStack,
} from '../src/renderer/daw/model/stacks.js';
import {
  addTrack, createSession, createTrack, createClip, findTrack, updateClips,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import {
  isAudible, effectiveFaderDb, toggleMute, toggleSolo, stackGainDb,
} from '../src/renderer/daw/model/mixer-math.js';
import { computeDelayCompensation, insertLatency } from '../src/renderer/daw/model/routing.js';
import { findPlugin, defaultParams } from '../src/renderer/daw/engine/plugins.js';
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

const rackWith = (values: Partial<Record<string, number>>): MacroRack =>
  ({ enabled: true, values: values as MacroRack['values'], overrides: {} });

function paramOf(rack: MacroRack, moduleId: string, param: string): number {
  const module = materializeRack(rack).find((m) => m.module.id === moduleId);
  const found = module?.params.find((p) => p.param === param);
  if (!found) throw new Error(`no param ${moduleId}.${param}`);
  return found.value;
}

// ── Macro definitions ─────────────────────────────────────────────────────────

check('every macro targets modules and parameters that exist', () => {
  for (const macro of MACROS) {
    assert(macro.targets.length > 0, `${macro.id} has targets`);
    for (const target of macro.targets) {
      const module = RACK_MODULES.find((m) => m.id === target.module);
      assert(module !== undefined, `${macro.id} → unknown module ${target.module}`);
      const neutral = RACK_NEUTRAL[target.module];
      assert(neutral[target.param] !== undefined,
        `${macro.id} → ${target.module}.${target.param} is not a parameter`);
      // The plugin implementing the module must accept the parameter too.
      const plugin = findPlugin(module!.pluginId);
      assert(plugin !== undefined, `${module!.pluginId} plugin exists`);
      assert(plugin!.params.some((p) => p.id === target.param),
        `${module!.pluginId} accepts ${target.param}`);
    }
  }
});

check('the rack covers the five processors the pitch promises', () => {
  const ids = RACK_MODULES.map((m) => m.id);
  for (const needed of ['eq', 'compressor', 'saturation', 'transient', 'exciter']) {
    assert(ids.includes(needed as never), `${needed} is in the rack`);
  }
  eq(new Set(RACK_MODULES.map((m) => m.slot)).size, RACK_MODULES.length, 'slots are unique');
});

check('every rack parameter maps onto its plugin', () => {
  for (const module of RACK_MODULES) {
    const plugin = findPlugin(module.pluginId);
    assert(plugin !== undefined, `${module.pluginId} exists`);
    for (const param of Object.keys(RACK_NEUTRAL[module.id])) {
      assert(plugin!.params.some((p) => p.id === param),
        `${module.pluginId} has ${param}`);
    }
  }
});

// ── Materialisation ───────────────────────────────────────────────────────────

check('all macros at zero is a transparent chain', () => {
  const resolved = materializeRack({ ...EMPTY_RACK, enabled: true });
  for (const module of resolved) {
    assert(!module.active, `${module.module.id} is inactive`);
    for (const param of module.params) {
      close(param.value, RACK_NEUTRAL[module.module.id][param.param] ?? 0,
        `${module.module.id}.${param.param} is neutral`);
      eq(param.drivenBy.length, 0, 'nothing drives it');
      eq(param.overridden, false, 'not overridden');
    }
  }
});

check('PUNCH moves seven parameters across three modules', () => {
  const rack = rackWith({ punch: 1 });
  const resolved = materializeRack(rack);
  const touched = resolved.flatMap((m) => m.params.filter((p) => p.drivenBy.includes('punch')));
  eq(touched.length, 7, 'seven parameters');
  eq(new Set(touched.map((p) => p.module)).size, 3, 'three modules — transient, compressor, EQ');

  // The documented amounts, at full macro.
  close(paramOf(rack, 'transient', 'attack'), 0.7, 'transient attack');
  close(paramOf(rack, 'compressor', 'thresholdDb'), -16, 'compressor threshold');
  close(paramOf(rack, 'compressor', 'ratio'), 1 + 2.6, 'ratio from neutral 1');
  close(paramOf(rack, 'compressor', 'makeupDb'), 3.2, 'makeup');
  // fastStart curve: sqrt(1) = 1, so attack lands at 20 − 16 = 4 ms.
  close(paramOf(rack, 'compressor', 'attackMs'), 4, 'compressor attack');
});

check('a macro at half strength moves half as far — except where a curve says otherwise', () => {
  const half = rackWith({ punch: 0.5 });
  close(paramOf(half, 'transient', 'attack'), 0.35, 'linear target halves');
  // fastStart = sqrt(0.5) ≈ 0.7071 of the move: 20 − 16·0.7071 ≈ 8.69 ms.
  close(paramOf(half, 'compressor', 'attackMs'), 20 - 16 * Math.SQRT1_2, 'fastStart curve', 1e-9);

  const clarityHalf = rackWith({ clarity: 0.5 });
  // slowStart = 0.5² = 0.25 of the move on the HPF.
  close(paramOf(clarityHalf, 'eq', 'hpfHz'), 20 + 45 * 0.25, 'slowStart curve');
});

check('two macros on the same parameter add instead of overwriting', () => {
  const both = rackWith({ warmth: 1, air: 1 });
  // WARMTH pulls the high shelf down 1.8 dB, AIR pushes it up 2.2 dB.
  close(paramOf(both, 'eq', 'highDb'), -1.8 + 2.2, 'summed high shelf');
  const resolved = materializeRack(both);
  const highDb = resolved.find((m) => m.module.id === 'eq')!
    .params.find((p) => p.param === 'highDb')!;
  eq(highDb.drivenBy.sort().join(','), 'air,warmth', 'both macros are credited');
});

check('WIDTH is bipolar: it narrows as well as widens', () => {
  close(paramOf(rackWith({ width: 1 }), 'width', 'width'), 1 + 0.85, 'wide');
  close(paramOf(rackWith({ width: -1 }), 'width', 'width'), 1 - 0.85, 'narrow');
  close(paramOf(rackWith({ width: 0 }), 'width', 'width'), 1, 'neutral is unity');
  // The bass-mono filter only engages when widening.
  close(paramOf(rackWith({ width: -1 }), 'width', 'lowMonoHz'), 20, 'untouched when narrowing');
  close(paramOf(rackWith({ width: 1 }), 'width', 'lowMonoHz'), 120, 'engaged when widening');
});

check('macro values are clamped to their range', () => {
  close(paramOf(rackWith({ punch: 5 }), 'transient', 'attack'), 0.7, 'over 1 clamps');
  close(paramOf(rackWith({ punch: -3 }), 'transient', 'attack'), 0, 'unipolar clamps at 0');
  close(paramOf(rackWith({ width: -9 }), 'width', 'width'), 1 - 0.85, 'bipolar clamps at −1');
});

check('every macro combination stays inside the plugins\' ranges', () => {
  // Everything at once — the worst case a user can reach with the knobs.
  const extreme = rackWith({
    warmth: 1, clarity: 1, punch: 1, air: 1, width: 1, depth: 1, loudness: 1,
  });
  for (const module of materializeRack(extreme)) {
    const plugin = findPlugin(module.module.pluginId)!;
    for (const param of module.params) {
      const def = plugin.params.find((p) => p.id === param.param)!;
      assert(param.value >= def.min - 1e-9 && param.value <= def.max + 1e-9,
        `${module.module.id}.${param.param} = ${param.value} outside [${def.min}, ${def.max}]`);
    }
  }
  // And the opposite extreme.
  const inverse = rackWith({ width: -1 });
  for (const module of materializeRack(inverse)) {
    const plugin = findPlugin(module.module.pluginId)!;
    for (const param of module.params) {
      const def = plugin.params.find((p) => p.id === param.param)!;
      assert(param.value >= def.min - 1e-9 && param.value <= def.max + 1e-9,
        `${module.module.id}.${param.param} out of range when narrowing`);
    }
  }
});

check('an override is clamped to the plugin range too', () => {
  const rack = setOverride({ ...EMPTY_RACK, enabled: true }, 'compressor', 'ratio', 999);
  const ratio = materializeRack(rack).find((m) => m.module.id === 'compressor')!
    .params.find((p) => p.param === 'ratio')!;
  eq(ratio.value, findPlugin('comp')!.params.find((p) => p.id === 'ratio')!.max, 'clamped');
});

check('only touched modules become active', () => {
  const resolved = materializeRack(rackWith({ air: 0.5 }));
  const active = resolved.filter((m) => m.active).map((m) => m.module.id).sort();
  eq(active.join(','), 'eq,exciter', 'AIR only lights EQ and the exciter');
});

// ── Advanced view / overrides ─────────────────────────────────────────────────

check('an override wins, is marked, and can be reset', () => {
  let rack = rackWith({ punch: 1 });
  const before = paramOf(rack, 'compressor', 'ratio');
  close(before, 3.6, 'macro value');

  rack = setOverride(rack, 'compressor', 'ratio', 8);
  close(paramOf(rack, 'compressor', 'ratio'), 8, 'override applied');

  const resolved = materializeRack(rack).find((m) => m.module.id === 'compressor')!;
  const ratio = resolved.params.find((p) => p.param === 'ratio')!;
  eq(ratio.overridden, true, 'flagged as overridden');
  close(ratio.macroValue, 3.6, 'the macro value is still reported for the reset arrow');
  assert(ratio.drivenBy.includes('punch'), 'still credited to PUNCH');

  rack = clearOverride(rack, 'compressor', 'ratio');
  close(paramOf(rack, 'compressor', 'ratio'), 3.6, 'reset returns to the macro');
  eq(clearOverride(rack, 'compressor', 'ratio'), rack, 'clearing nothing is identity');
});

check('an override on an untouched module still activates it', () => {
  const rack = setOverride({ ...EMPTY_RACK, enabled: true }, 'saturation', 'mix', 0.4);
  const saturation = materializeRack(rack).find((m) => m.module.id === 'saturation')!;
  assert(saturation.active, 'engineer-set parameter turns the module on');
  close(moduleParams(saturation)['mix'] ?? 0, 0.4, 'value applied');
});

check('macros explain themselves in plain language', () => {
  const punch = findMacro('punch')!;
  const lines = explainMacro(punch, 0.6);
  eq(lines.length, punch.targets.length, 'one line per target');
  assert(lines.some((l) => l.includes('Compressor')), 'names the module');
  assert(lines.some((l) => l.includes('dB')), 'carries units');
  eq(explainMacro(punch, 0).length, 0, 'nothing to say at zero');
});

check('activeMacros reports only what is doing something', () => {
  const rack = rackWith({ punch: 0.4, air: 0, width: -0.2 });
  const active = activeMacros(rack).map((a) => a.macro.id).sort();
  eq(active.join(','), 'punch,width', 'zero-valued macros are omitted');
});

check('presets are valid macro states', () => {
  for (const preset of MACRO_PRESETS) {
    const rack: MacroRack = { enabled: true, values: preset.values, overrides: {} };
    const resolved = materializeRack(rack);
    assert(resolved.some((m) => m.active), `${preset.id} does something`);
    for (const [id, value] of Object.entries(preset.values)) {
      const def = findMacro(id as never);
      assert(def !== undefined, `${preset.id} → macro ${id} exists`);
      const lo = def!.bipolar ? -1 : 0;
      assert((value ?? 0) >= lo && (value ?? 0) <= 1, `${preset.id}.${id} in range`);
    }
  }
});

check('setMacro clamps and keeps the rest of the rack', () => {
  let rack = setMacro({ ...EMPTY_RACK, enabled: true }, 'punch', 0.5);
  rack = setMacro(rack, 'air', 2);
  eq(rack.values.punch, 0.5, 'first value kept');
  eq(rack.values.air, 1, 'second clamped');
  eq(overrideKey('eq', 'lowDb'), 'eq.lowDb', 'override key format');
});

check('the rack adds its look-ahead latency to delay compensation', () => {
  resetIds();
  let session = createSession('Macro', 48_000);
  const track = createTrack('Bus', 'audio');
  session = addTrack(session, track);
  const plain = insertLatency(findTrack(session, track.id)!, 48_000);
  eq(plain, 0, 'no rack, no latency');

  session = {
    ...session,
    tracks: session.tracks.map((t) => (t.id === track.id
      ? { ...t, macros: rackWith({ loudness: 1 }) }
      : t)),
  };
  const withRack = insertLatency(findTrack(session, track.id)!, 48_000);
  // The rack's limiter runs a 2 ms look-ahead by default.
  eq(withRack, Math.round(0.002 * 48_000), 'limiter look-ahead counted');
  const adc = computeDelayCompensation(session);
  assert((adc.maxSamples ?? 0) >= withRack, 'ADC sees it');
  void defaultParams;
});

// ── Track Stacks ──────────────────────────────────────────────────────────────

function vocalSession(): { session: DawSession; ids: string[] } {
  resetIds();
  let session = createSession('Stacks', 48_000);
  const names = ['Lead', 'Double L', 'Double R', 'Harmony', 'Adlib'];
  const ids: string[] = [];
  for (const name of names) {
    const track = createTrack(name, 'audio');
    session = addTrack(session, track);
    session = updateClips(session, track.id, () => [
      createClip('file-x', name, { startSec: 0, durationSec: 4 }),
    ]);
    ids.push(track.id);
  }
  return { session, ids };
}

check('a summing stack creates a bus and routes its members into it', () => {
  const { session, ids } = vocalSession();
  const { session: stacked, folderId, busId } = createStack(session, 'VOCALS', ids, 'summing');
  assert(busId !== null, 'bus created');
  const folder = findTrack(stacked, folderId)!;
  eq(folder.kind, 'folder', 'folder track');
  assert(isSummingStack(folder), 'sums its children');
  eq(folder.input, busId, 'folder reads the bus');
  eq(folder.output.kind, 'master', 'folder feeds the master');

  for (const id of ids) {
    const member = findTrack(stacked, id)!;
    eq(member.parentId, folderId, `${member.name} is inside the stack`);
    assert(member.output.kind === 'bus' && member.output.busId === busId,
      `${member.name} outputs to the stack bus`);
  }
  eq(stackChildren(stacked, folderId).length, 5, 'five children');
});

check('a folder stack organises without changing the routing', () => {
  const { session, ids } = vocalSession();
  const { session: stacked, folderId, busId } = createStack(session, 'VOCALS', ids, 'folder');
  eq(busId, null, 'no bus');
  const folder = findTrack(stacked, folderId)!;
  assert(!isSummingStack(folder), 'not summing');
  for (const id of ids) {
    eq(findTrack(stacked, id)!.output.kind, 'master', 'members still go to the master');
    eq(findTrack(stacked, id)!.parentId, folderId, 'but they belong to the stack');
  }
});

check('the folder sits directly above its members', () => {
  const { session, ids } = vocalSession();
  const { session: stacked, folderId } = createStack(session, 'VOCALS', ids, 'summing');
  const order = stacked.tracks.map((t) => t.name);
  const folderIndex = order.indexOf('VOCALS');
  assert(folderIndex !== -1, 'folder present');
  eq(order.slice(folderIndex + 1, folderIndex + 6).join(','),
    'Lead,Double L,Double R,Harmony,Adlib', 'members follow in order');
  eq(order[order.length - 1], 'Master', 'master stays last');
});

check('stacks nest, and a cycle is refused', () => {
  const { session, ids } = vocalSession();
  const inner = createStack(session, 'DOUBLES', ids.slice(1, 3), 'summing');
  const outer = createStack(inner.session, 'VOCALS', [ids[0]!, inner.folderId], 'summing');

  eq(stackDepth(outer.session, ids[1]!), 2, 'two levels deep');
  eq(stackAncestors(outer.session, ids[1]!).map((t) => t.name).join(','), 'DOUBLES,VOCALS',
    'ancestors nearest first');
  eq(stackDescendants(outer.session, outer.folderId).length, 4, 'lead + folder + 2 doubles');

  assert(wouldNest(outer.session, outer.folderId, inner.folderId), 'a parent cannot go inside its child');
  eq(setParent(outer.session, outer.folderId, inner.folderId), outer.session, 'refused, unchanged');
});

check('collapsing a stack hides its members', () => {
  const { session, ids } = vocalSession();
  const { session: stacked, folderId } = createStack(session, 'VOCALS', ids, 'summing');
  eq(visibleTracks(stacked).length, stacked.tracks.length, 'everything visible');

  const collapsed = toggleCollapsed(stacked, folderId);
  assert(isHidden(collapsed, ids[0]!), 'member hidden');
  assert(!isHidden(collapsed, folderId), 'the folder itself stays');
  eq(visibleTracks(collapsed).length, stacked.tracks.length - 5, 'five rows folded away');

  const overview = collapsedOverviewClips(collapsed, folderId);
  eq(overview.length, 5, 'the collapsed row still shows the children clips');
  assert(stackSummary(collapsed, folderId).includes('5개 트랙'), 'summary counts them');
});

check('muting a stack silences everything inside it', () => {
  const { session, ids } = vocalSession();
  const { session: stacked, folderId } = createStack(session, 'VOCALS', ids, 'summing');
  assert(isAudible(stacked, findTrack(stacked, ids[0]!)!), 'audible to start');

  const muted = toggleMute(stacked, folderId);
  for (const id of ids) {
    assert(!isAudible(muted, findTrack(muted, id)!), 'member silenced by the stack mute');
  }
});

check('soloing a stack keeps its members, soloing a member keeps the stack', () => {
  const { session, ids } = vocalSession();
  const { session: stacked, folderId } = createStack(session, 'VOCALS', ids, 'summing');
  let other = createTrack('Drums', 'audio');
  const withOther = addTrack(stacked, other);
  other = findTrack(withOther, other.id)!;

  const stackSoloed = toggleSolo(withOther, folderId);
  for (const id of ids) {
    assert(isAudible(stackSoloed, findTrack(stackSoloed, id)!), 'members follow the stack solo');
  }
  assert(!isAudible(stackSoloed, findTrack(stackSoloed, other.id)!), 'everything else is muted');

  const memberSoloed = toggleSolo(withOther, ids[0]!);
  assert(isAudible(memberSoloed, findTrack(memberSoloed, ids[0]!)!), 'the soloed member plays');
  assert(isAudible(memberSoloed, findTrack(memberSoloed, folderId)!),
    'its stack must pass audio or the solo would be inaudible');
  assert(!isAudible(memberSoloed, findTrack(memberSoloed, ids[1]!)!), 'siblings are muted');
});

check('a folder stack fader governs its members like a VCA', () => {
  const { session, ids } = vocalSession();
  const { session: stacked, folderId } = createStack(session, 'VOCALS', ids, 'folder');
  const lowered = {
    ...stacked,
    tracks: stacked.tracks.map((t) => (t.id === folderId ? { ...t, volumeDb: -6 } : t)),
  };
  const member = findTrack(lowered, ids[0]!)!;
  close(stackGainDb(lowered, member), -6, 'stack gain reaches the member');
  close(effectiveFaderDb(lowered, member), -6, 'folded into the fader');
});

check('a summing stack fader does NOT double-count on its members', () => {
  const { session, ids } = vocalSession();
  const { session: stacked, folderId } = createStack(session, 'VOCALS', ids, 'summing');
  const lowered = {
    ...stacked,
    tracks: stacked.tracks.map((t) => (t.id === folderId ? { ...t, volumeDb: -6 } : t)),
  };
  const member = findTrack(lowered, ids[0]!)!;
  // The members already flow THROUGH the stack channel, so applying the
  // stack fader to them as well would attenuate twice.
  close(stackGainDb(lowered, member), 0, 'no extra gain on the member');
  close(effectiveFaderDb(lowered, findTrack(lowered, folderId)!), -6, 'the stack itself is lowered');
});

check('unpacking a stack keeps the audio flowing', () => {
  const { session, ids } = vocalSession();
  const { session: stacked, folderId, busId } = createStack(session, 'VOCALS', ids, 'summing');
  const unpacked = unpackStack(stacked, folderId);
  eq(findTrack(unpacked, folderId), undefined, 'folder gone');
  assert(!unpacked.buses.some((b) => b.id === busId), 'its bus is gone too');
  for (const id of ids) {
    const member = findTrack(unpacked, id)!;
    eq(member.parentId, null, 'no longer nested');
    eq(member.output.kind, 'master', 'routed back to the master, not to a dead bus');
  }
});

check('reorderStack is idempotent', () => {
  const { session, ids } = vocalSession();
  const { session: stacked, folderId } = createStack(session, 'VOCALS', ids, 'summing');
  const once = reorderStack(stacked, folderId);
  const twice = reorderStack(once, folderId);
  eq(once.tracks.map((t) => t.id).join(','), twice.tracks.map((t) => t.id).join(','), 'stable');
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Macro Control System + Track Stacks ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
