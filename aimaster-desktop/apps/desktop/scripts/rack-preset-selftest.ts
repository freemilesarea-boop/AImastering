/**
 * rack-preset-selftest — a whole channel strip, saved under one name.
 *
 * The single-device presets already prove that a stored parameter map is
 * validated on the way in and out.  What is new here is the CHAIN, and the
 * decisions that only exist because a chain is more than a bag of devices:
 *
 *   SLOTS ARE PART OF THE SOUND.  A rack saved with the compressor in C loads
 *   with the compressor in C, not packed from A.
 *
 *   A DEVICE THIS BUILD LACKS IS SKIPPED BY NAME.  Not silently dropped (a
 *   chain quietly missing its de-esser) and not fatal (losing the other six).
 *
 *   THE SIDECHAIN SOURCE DOES NOT TRAVEL.  It points at a bus in another
 *   session; carrying it would key a ducker off the wrong thing, which is the
 *   one failure here nobody would hear until the mix was wrong.
 *
 *   REPLACE AND MERGE ARE DIFFERENT ANSWERS.  Both are needed and both are
 *   provable: replace makes the chain exactly the rack, merge leaves the slots
 *   the rack does not mention alone.
 *
 * Run: pnpm --filter @aimaster/desktop test:rack-presets
 */

import {
  captureRack, createRackPreset, describeLoad, describeRack, isLoadable, loadRack,
  missingDevices, sanitiseName,
  type RackDevice, type RackPreset,
} from '../src/renderer/daw/model/rack-preset.js';
import {
  EXPORT_KIND, clearRacks, deleteRack, describeImport, exportRacks, findRack,
  importRacks, listRacks, overwriteRack, renameRack, resetRackIds, saveRack,
  setRackStore, type RackStore,
} from '../src/renderer/daw/engine/rack-store.js';
import {
  addTrack, createInsert, createSession, createTrack, findTrack, setInsert,
} from '../src/renderer/daw/model/session-ops.js';
import { defaultParams, findPlugin } from '../src/renderer/daw/engine/plugins.js';
import { setUserPresetStore } from '../src/renderer/daw/engine/user-presets.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { DawSession, Track } from '../src/renderer/daw/model/types.js';

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

function memoryStore(seed: Record<string, string> = {}): RackStore {
  const data: Record<string, string> = { ...seed };
  return { getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
}

function fresh(): void {
  setRackStore(memoryStore());
  resetRackIds();
  clearRacks();
}

/** A track with a real three-device chain: trim in A, comp in C, EQ in E. */
function channel(): { session: DawSession; track: Track } {
  resetIds();
  let session = createSession('rack test');
  const track = createTrack('Vox', 'audio');
  session = addTrack(session, track);
  session = setInsert(session, track.id,
    { ...createInsert(0, 'trim', 'Trim'), params: { ...defaultParams('trim'), gainDb: -3 } });
  session = setInsert(session, track.id,
    { ...createInsert(2, 'comp', 'Compressor'),
      params: { ...defaultParams('comp'), thresholdDb: -30 }, bypass: true });
  session = setInsert(session, track.id,
    { ...createInsert(4, 'eq8', 'Parametric EQ'),
      params: { ...defaultParams('eq8'), lpfHz: 12000 } });
  return { session, track: findTrack(session, track.id)! };
}

function emptyChannel(name = 'Gtr'): { session: DawSession; track: Track } {
  resetIds();
  const base = createSession('rack test');
  const track = createTrack(name, 'audio');
  return { session: addTrack(base, track), track };
}

// The rack model validates through the preset sanitiser, which reads its own
// store; point it somewhere harmless so nothing here touches a browser.
setUserPresetStore(memoryStore());

// ── 1. Capture ────────────────────────────────────────────────────────────────

check('a chain is captured with its slots, settings and bypasses', () => {
  const { track } = channel();
  const captured = captureRack(track);
  eq(captured.devices.length, 3, 'three devices');
  eq(captured.skipped.length, 0, 'nothing skipped');
  eq(captured.devices.map((d) => d.slot).join(','), '0,2,4', 'in their own slots, not packed');
  eq(captured.devices[0]?.params['gainDb'], -3, 'the trim setting');
  eq(captured.devices[1]?.bypass, true, 'the compressor was bypassed and stays so');
  eq(captured.devices[2]?.params['lpfHz'], 12000, 'and the EQ setting');
});

check('a third-party plugin is not captured, and is named', () => {
  const { session, track } = emptyChannel();
  const withExternal = setInsert(session, track.id, {
    ...createInsert(1, 'some-vst3-uid', 'Fancy Reverb'),
    external: { format: 'vst3', name: 'Fancy Reverb', path: '/x', uid: 'u', vendor: 'Test' },
  });
  const captured = captureRack(findTrack(withExternal, track.id)!);
  eq(captured.devices.length, 0, 'nothing to save');
  eq(captured.skipped.join(','), 'Fancy Reverb', 'and it is named, not silently dropped');
});

check('an empty chain captures as nothing rather than throwing', () => {
  const { track } = emptyChannel();
  const captured = captureRack(track);
  eq(captured.devices.length, 0, 'no devices');
  eq(captured.skipped.length, 0, 'and nothing was skipped either');
});

// ── 2. Load ───────────────────────────────────────────────────────────────────

check('a rack loads back into the slots it was saved from', () => {
  const source = channel();
  const preset = createRackPreset('r1', '보컬 체인', captureRack(source.track).devices);

  const target = emptyChannel();
  const result = loadRack(target.session, target.track.id, preset);
  eq(result.problems.length, 0, 'nothing went wrong');
  eq(result.loaded.length, 3, 'three devices landed');

  const inserts = findTrack(result.session, target.track.id)?.inserts ?? [];
  eq(inserts.map((i) => i.slot).join(','), '0,2,4', 'the compressor is still in C');
  eq(inserts.map((i) => i.pluginId).join(','), 'trim,comp,eq8', 'in chain order');
  eq(inserts[0]?.params['gainDb'], -3, 'with its setting');
  eq(inserts[1]?.bypass, true, 'and its bypass');
});

check('the reported latency is recomputed for the receiving session', () => {
  const source = emptyChannel();
  const withLimiter = setInsert(source.session, source.track.id, {
    ...createInsert(0, 'limiter', 'Limiter'),
    params: { ...defaultParams('limiter'), lookaheadMs: 4 },
  });
  const preset = createRackPreset('r', '리미터',
    captureRack(findTrack(withLimiter, source.track.id)!).devices);

  const target = emptyChannel('Bus');
  const result = loadRack(target.session, target.track.id, preset);
  const insert = findTrack(result.session, target.track.id)?.inserts[0];
  const expected = findPlugin('limiter')!.latencyFor(
    { ...defaultParams('limiter'), lookaheadMs: 4 }, target.session.sampleRate);
  eq(insert?.latencySamples, expected,
    'delay compensation lines up against a number that was computed here');
  assert((insert?.latencySamples ?? 0) > 0, 'and it is a real look-ahead');
});

check('the sidechain source is dropped rather than pointed at a stranger', () => {
  const source = emptyChannel();
  const withDucker = setInsert(source.session, source.track.id, {
    ...createInsert(0, 'ducker', 'Ducker'),
    params: defaultParams('ducker'),
    sidechainSource: 'bus-from-another-session',
  });
  const preset = createRackPreset('r', '더커',
    captureRack(findTrack(withDucker, source.track.id)!).devices);

  const target = emptyChannel('Bass');
  const result = loadRack(target.session, target.track.id, preset);
  eq(findTrack(result.session, target.track.id)?.inserts[0]?.sidechainSource, null,
    'a key input that would point at a bus that does not exist is not carried');
});

check('replace makes the chain exactly the rack', () => {
  const source = channel();
  const preset = createRackPreset('r', '체인', captureRack(source.track).devices);

  // A target that already has something in a slot the rack does not use.
  const target = emptyChannel();
  const busy = setInsert(target.session, target.track.id,
    { ...createInsert(9, 'trim', 'Trim'), params: defaultParams('trim') });

  const result = loadRack(busy, target.track.id, preset, 'replace');
  const slots = findTrack(result.session, target.track.id)?.inserts.map((i) => i.slot) ?? [];
  eq(slots.join(','), '0,2,4', 'slot J is gone — replace means replace');
});

check('merge leaves the slots the rack does not mention alone', () => {
  const source = channel();
  const preset = createRackPreset('r', '체인', captureRack(source.track).devices);

  const target = emptyChannel();
  const busy = setInsert(target.session, target.track.id,
    { ...createInsert(9, 'dither', 'Dither'), params: defaultParams('dither') });

  const result = loadRack(busy, target.track.id, preset, 'merge');
  const inserts = findTrack(result.session, target.track.id)?.inserts ?? [];
  eq(inserts.map((i) => i.slot).join(','), '0,2,4,9', 'the dither in J survives');
  eq(inserts[3]?.pluginId, 'dither', 'and it is still the dither');
});

check('merge overwrites a slot the rack DOES mention', () => {
  const source = channel();
  const preset = createRackPreset('r', '체인', captureRack(source.track).devices);

  const target = emptyChannel();
  const busy = setInsert(target.session, target.track.id,
    { ...createInsert(2, 'dither', 'Dither'), params: defaultParams('dither') });

  const result = loadRack(busy, target.track.id, preset, 'merge');
  const inserts = findTrack(result.session, target.track.id)?.inserts ?? [];
  eq(inserts.length, 3, 'no doubled slot — two devices cannot share one');
  eq(inserts.find((i) => i.slot === 2)?.pluginId, 'comp', 'the rack won that slot');
});

check('a device this build lacks is skipped by name, and the rest still load', () => {
  const source = channel();
  const devices: RackDevice[] = [
    ...captureRack(source.track).devices,
    { slot: 6, pluginId: 'tape-machine-9000', label: '미래 장치', bypass: false, params: {} },
  ];
  const preset = createRackPreset('r', '미래 체인', devices);

  assert(!isLoadable(preset), 'the rack knows it is not fully loadable');
  eq(missingDevices(preset).join(','), '미래 장치', 'and names what is missing');

  const target = emptyChannel();
  const result = loadRack(target.session, target.track.id, preset);
  eq(result.loaded.length, 3, 'the three that exist landed');
  eq(result.problems.length, 1, 'one problem');
  assert(result.problems[0]?.includes('미래 장치'), `naming it — ${result.problems[0]}`);
  eq(findTrack(result.session, target.track.id)?.inserts.length, 3, 'and the chain is the rest');
});

check('a slot outside the rack is refused rather than clamped', () => {
  const preset = createRackPreset('r', '이상한 랙', [
    { slot: 42, pluginId: 'trim', label: 'Trim', bypass: false, params: {} },
  ]);
  const target = emptyChannel();
  const result = loadRack(target.session, target.track.id, preset);
  eq(result.loaded.length, 0, 'nothing landed');
  eq(result.problems.length, 1, 'and it is reported');
  assert(result.problems[0]?.includes('42'), `naming the slot — ${result.problems[0]}`);
  eq(result.session, target.session, 'the session is untouched');
});

check('an out-of-range stored value is clamped on the way in', () => {
  const def = findPlugin('trim')!.params.find((p) => p.id === 'gainDb')!;
  const preset = createRackPreset('r', '범위 밖', [
    { slot: 0, pluginId: 'trim', label: 'Trim', bypass: false,
      params: { gainDb: def.max + 500, ghost: 1 } },
  ]);
  const target = emptyChannel();
  const result = loadRack(target.session, target.track.id, preset);
  const insert = findTrack(result.session, target.track.id)?.inserts[0];
  eq(insert?.params['gainDb'], def.max, 'clamped to what the device can do');
  eq(insert?.params['ghost'], undefined, 'and the parameter that does not exist is gone');
});

check('loading onto a track that is not there does nothing, and says so', () => {
  const preset = createRackPreset('r', '체인', [
    { slot: 0, pluginId: 'trim', label: 'Trim', bypass: false, params: {} },
  ]);
  const target = emptyChannel();
  const result = loadRack(target.session, 'gone', preset);
  eq(result.loaded.length, 0, 'nothing landed');
  eq(result.session, target.session, 'the session is untouched');
  assert(result.problems[0]?.includes('트랙'), `and it says which — ${result.problems[0]}`);
});

check('an empty rack loads as an empty chain, deliberately', () => {
  const source = channel();
  const preset = createRackPreset('r', '빈 랙', []);
  const result = loadRack(source.session, source.track.id, preset, 'replace');
  eq(findTrack(result.session, source.track.id)?.inserts.length, 0,
    'replace with nothing empties the chain — the one way to clear a rack');
  eq(result.problems.length, 0, 'and that is not an error');
});

check('the chain describes itself by slot', () => {
  const source = channel();
  const preset = createRackPreset('r', '체인', captureRack(source.track).devices);
  const text = describeRack(preset);
  assert(text.startsWith('A Trim'), `slots are named A–J — ${text}`);
  assert(text.includes('C Compressor'), `in their own letters — ${text}`);
  assert(text.includes('바이패스'), `and a bypassed device says so — ${text}`);
  eq(describeRack(createRackPreset('r', 'x', [])), '빈 랙', 'an empty rack says so');

  const target = emptyChannel();
  const loaded = loadRack(target.session, target.track.id, preset);
  assert(describeLoad(loaded).includes('3개 로드'), 'and a load reports what it did');
});

// ── 3. Storage ────────────────────────────────────────────────────────────────

check('a saved rack survives a read back', () => {
  fresh();
  const source = channel();
  const captured = captureRack(source.track);
  const result = saveRack('  내  보컬 체인  ',
    createRackPreset('', '', captured.devices, '  설명  '));
  assert(result.ok, `saved — ${result.ok ? '' : result.reason}`);
  if (!result.ok) return;
  eq(result.rack.name, '내 보컬 체인', 'the name is tidied');
  eq(result.rack.note, '설명', 'and so is the note');

  const back = findRack(result.rack.id);
  eq(back?.devices.length, 3, 'the whole chain came back');
  eq(back?.devices[1]?.params['thresholdDb'], -30, 'with its settings');
  eq(listRacks().length, 1, 'one rack');
});

check('an empty rack is refused, and so is an empty name', () => {
  fresh();
  const empty = saveRack('빈 것', createRackPreset('', '', []));
  assert(!empty.ok, 'an empty chain is not a rack somebody meant to save');
  const source = channel();
  const unnamed = saveRack('   ', createRackPreset('', '', captureRack(source.track).devices));
  assert(!unnamed.ok, 'and a blank name is refused');
  eq(listRacks().length, 0, 'nothing was written');
});

check('the same name twice is refused, not duplicated', () => {
  fresh();
  const source = channel();
  const devices = captureRack(source.track).devices;
  assert(saveRack('보컬', createRackPreset('', '', devices)).ok, 'first');
  const again = saveRack('보컬', createRackPreset('', '', devices));
  assert(!again.ok, 'second is refused');
  assert((again.ok ? '' : again.reason).includes('덮어쓰기'), 'and points at overwrite');
  eq(listRacks().length, 1, 'still one');
});

check('overwrite keeps the identity and takes the new chain', () => {
  fresh();
  const source = channel();
  const saved = saveRack('보컬', createRackPreset('', '', captureRack(source.track).devices));
  if (!saved.ok) throw new Error('save failed');

  const smaller = emptyChannel();
  const oneDevice = setInsert(smaller.session, smaller.track.id,
    { ...createInsert(0, 'trim', 'Trim'), params: defaultParams('trim') });
  const next = overwriteRack(saved.rack.id,
    captureRack(findTrack(oneDevice, smaller.track.id)!).devices);

  assert(next.ok, 'overwritten');
  if (!next.ok) return;
  eq(next.rack.id, saved.rack.id, 'the same rack');
  eq(next.rack.name, '보컬', 'keeping its name');
  eq(next.rack.createdAt, saved.rack.createdAt, 'and when it was made');
  eq(next.rack.devices.length, 1, 'with the new chain');
  assert(!overwriteRack(saved.rack.id, []).ok, 'but not with an empty one');
});

check('rename refuses a taken name and keeps the chain', () => {
  fresh();
  const source = channel();
  const devices = captureRack(source.track).devices;
  const a = saveRack('A', createRackPreset('', '', devices));
  saveRack('B', createRackPreset('', '', devices));
  if (!a.ok) throw new Error('save failed');
  assert(!renameRack(a.rack.id, 'B').ok, 'B is taken');
  const ok = renameRack(a.rack.id, 'C', '새 설명');
  assert(ok.ok, 'C is free');
  if (!ok.ok) return;
  eq(ok.rack.name, 'C', 'renamed');
  eq(ok.rack.note, '새 설명', 'with a new note');
  eq(ok.rack.devices.length, 3, 'and the chain is untouched');
});

check('delete removes exactly one', () => {
  fresh();
  const source = channel();
  const devices = captureRack(source.track).devices;
  const a = saveRack('A', createRackPreset('', '', devices));
  saveRack('B', createRackPreset('', '', devices));
  if (!a.ok) throw new Error('save failed');
  assert(deleteRack(a.rack.id), 'deleted');
  eq(listRacks().length, 1, 'one left');
  eq(listRacks()[0]?.name, 'B', 'and it is the other');
  assert(!deleteRack(a.rack.id), 'deleting it again does nothing and says so');
});

check('a corrupted store reads as empty instead of throwing', () => {
  setRackStore(memoryStore({ 'loui.daw.racks.user': '{ not json' }));
  eq(listRacks().length, 0, 'no racks');
  setRackStore(memoryStore({ 'loui.daw.racks.user': '{"version":1,"racks":"nope"}' }));
  eq(listRacks().length, 0, 'a wrong-shaped envelope is the same');
  setRackStore(memoryStore({
    'loui.daw.racks.user': JSON.stringify({ version: 1, racks: [{ id: 'x' }, null, 5] }),
  }));
  eq(listRacks().length, 0, 'malformed racks are filtered one by one');
});

check('a hand-edited rack keeps only the devices that make sense', () => {
  setRackStore(memoryStore({
    'loui.daw.racks.user': JSON.stringify({
      version: 1,
      racks: [{
        id: 'hand', name: '손으로 고침', createdAt: 1, updatedAt: 1,
        devices: [
          { slot: 0, pluginId: 'trim' },                    // no label / params
          { slot: 'two', pluginId: 'comp' },                // slot is not a number
          { pluginId: 'eq8' },                              // no slot at all
          null,
        ],
      }],
    }),
  }));
  const rack = listRacks()[0];
  eq(rack?.devices.length, 1, 'one device survives');
  eq(rack?.devices[0]?.pluginId, 'trim', 'the one that was well-formed');
  eq(rack?.devices[0]?.label, '', 'with the missing fields filled in');
  eq(Object.keys(rack?.devices[0]?.params ?? {}).length, 0, 'and an empty parameter map');
});

check('a store that refuses to write reports failure rather than lying', () => {
  setRackStore({ getItem: () => null, setItem: () => { throw new Error('quota'); } });
  const source = channel();
  const result = saveRack('X', createRackPreset('', '', captureRack(source.track).devices));
  assert(!result.ok, 'the save is reported as failed');
  assert((result.ok ? '' : result.reason).includes('저장'), 'with a reason');
});

check('with no store at all nothing throws', () => {
  setRackStore(null);
  eq(listRacks().length, 0, 'reads are empty');
  const source = channel();
  assert(!saveRack('X', createRackPreset('', '', captureRack(source.track).devices)).ok,
    'writes are refused');
});

// ── 4. Files ──────────────────────────────────────────────────────────────────

check('export then import round trips a whole chain', () => {
  fresh();
  const source = channel();
  saveRack('보컬 체인', createRackPreset('', '', captureRack(source.track).devices, '설명'));
  const file = exportRacks();
  eq((JSON.parse(file) as { kind: string }).kind, EXPORT_KIND, 'the file says what it is');

  fresh();
  const report = importRacks(file);
  eq(report.added, 1, 'one rack came back');
  eq(report.missingDevices.length, 0, 'with every device present');
  const back = listRacks()[0];
  eq(back?.name, '보컬 체인', 'its name');
  eq(back?.note, '설명', 'its note');
  eq(back?.devices.length, 3, 'and the chain');
  eq(back?.devices[1]?.params['thresholdDb'], -30, 'settings and all');
});

check('a name clash on import is RENAMED — two racks are both useful', () => {
  fresh();
  const source = channel();
  saveRack('보컬', createRackPreset('', '', captureRack(source.track).devices));
  const file = exportRacks();
  const report = importRacks(file);
  eq(report.added, 1, 'the incoming one is added');
  eq(report.renamed, 1, 'under a new name');
  eq(listRacks().map((r) => r.name).sort().join(','), '보컬,보컬 (2)', 'both survive');
});

check('a rack containing a missing device still imports, and warns', () => {
  fresh();
  const file = JSON.stringify({
    kind: EXPORT_KIND, version: 1, racks: [{
      id: 'x', name: '미래 체인', note: '', createdAt: 1, updatedAt: 1,
      devices: [
        { slot: 0, pluginId: 'trim', label: 'Trim', bypass: false, params: {} },
        { slot: 1, pluginId: 'tape-machine-9000', label: '미래 장치', bypass: false, params: {} },
      ],
    }],
  });
  const report = importRacks(file);
  eq(report.added, 1, 'imported — losing the whole chain over one device is worse');
  eq(report.missingDevices.join(','), '미래 장치', 'and the missing one is named');
  assert(describeImport(report).includes('미래 장치'), 'in the summary too');
});

check('someone else’s JSON is refused rather than half-imported', () => {
  fresh();
  eq(importRacks(JSON.stringify({ kind: 'some.other.app', racks: [] })).added, 0, 'a different kind');
  eq(importRacks('{{{').added, 0, 'broken JSON');
  eq(importRacks(JSON.stringify({ hello: 'world' })).added, 0, 'a stray object');
  eq(listRacks().length, 0, 'nothing landed');
});

check('names are trimmed, collapsed and capped', () => {
  eq(sanitiseName('  두   칸  '), '두 칸', 'collapsed');
  eq(sanitiseName('x'.repeat(200)).length, 60, 'capped');
  eq(sanitiseName(''), '', 'and empty stays empty so the caller can refuse it');
});

// ── 5. Round trip through the session ────────────────────────────────────────

check('save on one track, load on another, and the chains match', () => {
  fresh();
  // ONE session with two tracks, so the id counter is shared — which is what
  // makes "the loaded inserts got their own ids" a real claim rather than an
  // artefact of resetting the counter between fixtures.
  resetIds();
  let session = createSession('two tracks');
  const from = createTrack('Vox', 'audio');
  const to = createTrack('Gtr', 'audio');
  session = addTrack(addTrack(session, from), to);
  session = setInsert(session, from.id,
    { ...createInsert(0, 'trim', 'Trim'), params: { ...defaultParams('trim'), gainDb: -3 } });
  session = setInsert(session, from.id,
    { ...createInsert(2, 'comp', 'Compressor'),
      params: { ...defaultParams('comp'), thresholdDb: -30 }, bypass: true });
  session = setInsert(session, from.id,
    { ...createInsert(4, 'eq8', 'Parametric EQ'),
      params: { ...defaultParams('eq8'), lpfHz: 12000 } });

  const source = findTrack(session, from.id)!;
  const saved = saveRack('보컬 체인', createRackPreset('', '', captureRack(source).devices));
  if (!saved.ok) throw new Error('save failed');

  const result = loadRack(session, to.id, findRack(saved.rack.id)!);
  const before = [...source.inserts].sort((a, b) => a.slot - b.slot);
  const after = findTrack(result.session, to.id)?.inserts ?? [];

  eq(after.length, before.length, 'the same number of devices');
  for (let i = 0; i < before.length; i++) {
    eq(after[i]?.slot, before[i]?.slot, `device ${i} slot`);
    eq(after[i]?.pluginId, before[i]?.pluginId, `device ${i} device`);
    eq(after[i]?.bypass, before[i]?.bypass, `device ${i} bypass`);
    for (const [id, value] of Object.entries(before[i]?.params ?? {})) {
      eq(after[i]?.params[id], value, `device ${i} ${id}`);
    }
  }

  // Two tracks cannot share an insert id — the engine keys its plugin
  // instances by it, so a copied id would make one channel's knob move the
  // other channel's device.
  const sourceIds = new Set(before.map((i) => i.id));
  for (const insert of after) {
    assert(!sourceIds.has(insert.id), `${insert.pluginId} got its own id, not the source's`);
  }
  // And the source is untouched.
  eq(findTrack(result.session, from.id)?.inserts.length, 3, 'the track it came from still has it');
});

// ── Report ────────────────────────────────────────────────────────────────────

setRackStore(null);
setUserPresetStore(null);
const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Rack presets: capture · load · slots · files ===');
for (const r of results) {
  console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
