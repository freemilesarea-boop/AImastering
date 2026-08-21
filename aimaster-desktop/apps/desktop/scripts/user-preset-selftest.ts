/**
 * user-preset-selftest — presets you made yourself.
 *
 * A saved preset is DATA: hand-editable, copied between machines, restored
 * from a backup, corrupted by a half-finished write.  So the interesting
 * checks are not "does save work" but what happens when the data is wrong:
 *
 *   A stored value outside the device's range is clamped, not applied.
 *   A parameter the device no longer has is dropped, not passed through.
 *   A file for a device this build does not ship is skipped, and SAYS so.
 *   A name that already exists is refused on save and renamed on import —
 *   the only two outcomes that keep both sounds.
 *
 * Run: pnpm --filter @aimaster/desktop test:user-presets
 */

import {
  EXPORT_KIND, USER_GROUP, USER_PREFIX,
  allPresetGroups, asPluginPreset, clearUserPresets, deleteUserPreset, describeImport,
  exportUserPresets, findUserPreset, importUserPresets, isUserPresetId, listUserPresets,
  overwriteUserPreset, renameUserPreset, resetUserPresetIds, sanitiseName, sanitiseNote,
  sanitiseParams, saveUserPreset, setUserPresetStore, canSaveUserPreset, type PresetStore,
} from '../src/renderer/daw/engine/user-presets.js';
import { presetGroups, resolvePreset } from '../src/renderer/daw/engine/plugin-presets.js';
import { PLUGINS, defaultParams, findPlugin } from '../src/renderer/daw/engine/plugins.js';

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

/** A store in memory, so nothing here touches a real browser. */
function memoryStore(seed: Record<string, string> = {}): PresetStore & { data: Record<string, string> } {
  const data: Record<string, string> = { ...seed };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => { data[key] = value; },
  };
}

function fresh(): ReturnType<typeof memoryStore> {
  const store = memoryStore();
  setUserPresetStore(store);
  resetUserPresetIds();
  clearUserPresets();
  return store;
}

/** A device that certainly exists, with a parameter that has real bounds. */
const DEVICE = 'comp';
const compDevice = findPlugin(DEVICE);
if (!compDevice) throw new Error('comp device missing — the fixture has to be a real device');

// ── 1. Round trip ─────────────────────────────────────────────────────────────

check('a saved preset comes back with the parameters it was given', () => {
  fresh();
  const params = { ...defaultParams(DEVICE) };
  const first = compDevice.params[0];
  if (!first) throw new Error('device has no parameters');
  params[first.id] = first.min;

  const saved = saveUserPreset({ pluginId: DEVICE, name: '  내  컴프  ', params });
  assert(saved.ok, `saved — ${saved.ok ? '' : saved.reason}`);
  if (!saved.ok) return;
  eq(saved.preset.name, '내 컴프', 'the name is trimmed and its whitespace collapsed');
  eq(saved.preset.pluginId, DEVICE, 'it belongs to the device it was saved from');
  eq(saved.preset.params[first.id], first.min, 'the value is what was on the knob');

  const back = findUserPreset(saved.preset.id);
  eq(back?.params[first.id], first.min, 'and it survives a read back from the store');
  eq(listUserPresets(DEVICE).length, 1, 'one preset for this device');
  eq(listUserPresets('eq3').length, 0, 'and none for another');
});

check('an id says which kind of preset it is', () => {
  fresh();
  const saved = saveUserPreset({ pluginId: DEVICE, name: 'A', params: defaultParams(DEVICE) });
  assert(saved.ok && saved.preset.id.startsWith(USER_PREFIX), 'user ids carry the prefix');
  assert(saved.ok && isUserPresetId(saved.preset.id), 'and are recognised');
  const factory = presetGroups('spacereverb')[0]?.presets[0];
  assert(factory !== undefined, 'there are factory presets to compare against');
  assert(!isUserPresetId(factory?.id ?? ''), 'a factory id is not a user id');
});

check('an empty name is refused rather than saved as a blank row', () => {
  fresh();
  const blank = saveUserPreset({ pluginId: DEVICE, name: '   ', params: defaultParams(DEVICE) });
  assert(!blank.ok, 'refused');
  eq(listUserPresets().length, 0, 'and nothing was written');
});

check('a device this build does not have is refused', () => {
  fresh();
  const bad = saveUserPreset({ pluginId: 'no-such-device', name: 'X', params: { a: 1 } });
  assert(!bad.ok, 'refused');
  assert((bad.ok ? '' : bad.reason).includes('장치'), 'and says why');
});

check('the same name twice on one device is refused, not duplicated', () => {
  fresh();
  const params = defaultParams(DEVICE);
  assert(saveUserPreset({ pluginId: DEVICE, name: '보컬', params }).ok, 'first save');
  const again = saveUserPreset({ pluginId: DEVICE, name: '보컬', params });
  assert(!again.ok, 'second is refused');
  assert((again.ok ? '' : again.reason).includes('덮어쓰기'), 'and points at overwrite');
  eq(listUserPresets(DEVICE).length, 1, 'still one');

  // The SAME name on a DIFFERENT device is a different preset entirely.
  assert(saveUserPreset({ pluginId: 'eq3', name: '보컬', params: defaultParams('eq3') }).ok,
    'the name is only taken on the device it was saved for');
});

// ── 2. Editing ────────────────────────────────────────────────────────────────

check('overwrite replaces the parameters and keeps the identity', () => {
  fresh();
  const first = compDevice.params[0];
  if (!first) throw new Error('device has no parameters');
  const saved = saveUserPreset({
    pluginId: DEVICE, name: '눌러', params: { ...defaultParams(DEVICE), [first.id]: first.min },
  });
  if (!saved.ok) throw new Error('save failed');

  const next = overwriteUserPreset(saved.preset.id, { ...defaultParams(DEVICE), [first.id]: first.max });
  assert(next.ok, 'overwritten');
  if (!next.ok) return;
  eq(next.preset.id, saved.preset.id, 'the same preset, not a new one');
  eq(next.preset.name, '눌러', 'keeping its name');
  eq(next.preset.createdAt, saved.preset.createdAt, 'and when it was first made');
  eq(next.preset.params[first.id], first.max, 'with the new value');
  eq(listUserPresets(DEVICE).length, 1, 'still one preset');
});

check('overwriting something that is gone is an error, not a new preset', () => {
  fresh();
  const missing = overwriteUserPreset('user:nothing', defaultParams(DEVICE));
  assert(!missing.ok, 'refused');
  eq(listUserPresets().length, 0, 'and nothing appeared');
});

check('rename refuses a name that is already taken on the device', () => {
  fresh();
  const a = saveUserPreset({ pluginId: DEVICE, name: 'A', params: defaultParams(DEVICE) });
  saveUserPreset({ pluginId: DEVICE, name: 'B', params: defaultParams(DEVICE) });
  if (!a.ok) throw new Error('save failed');
  assert(!renameUserPreset(a.preset.id, 'B').ok, 'B is taken');
  const ok = renameUserPreset(a.preset.id, 'C', '설명');
  assert(ok.ok, 'C is free');
  if (!ok.ok) return;
  eq(ok.preset.name, 'C', 'renamed');
  eq(ok.preset.note, '설명', 'and the note came with it');
  assert(renameUserPreset(a.preset.id, 'C').ok, 'renaming to its own name is not a clash');
});

check('delete removes exactly one', () => {
  fresh();
  const a = saveUserPreset({ pluginId: DEVICE, name: 'A', params: defaultParams(DEVICE) });
  saveUserPreset({ pluginId: DEVICE, name: 'B', params: defaultParams(DEVICE) });
  if (!a.ok) throw new Error('save failed');
  assert(deleteUserPreset(a.preset.id), 'deleted');
  eq(listUserPresets(DEVICE).length, 1, 'one left');
  eq(listUserPresets(DEVICE)[0]?.name, 'B', 'and it is the other one');
  assert(!deleteUserPreset(a.preset.id), 'deleting it again does nothing and says so');
});

// ── 3. The data is not trusted ────────────────────────────────────────────────

check('a value outside the device’s range is clamped, not applied', () => {
  const def = compDevice.params.find((p) => p.max > p.min);
  if (!def) throw new Error('no bounded parameter');
  const high = sanitiseParams(DEVICE, { [def.id]: def.max + 1000 });
  eq(high.params[def.id], def.max, 'pulled back to the maximum');
  eq(high.clamped.join(','), def.id, 'and reported as clamped');

  const low = sanitiseParams(DEVICE, { [def.id]: def.min - 1000 });
  eq(low.params[def.id], def.min, 'and to the minimum the other way');
});

check('a parameter the device does not have is dropped and reported', () => {
  const result = sanitiseParams(DEVICE, { nonsense: 1, alsoNonsense: 2 });
  eq(Object.keys(result.params).length, 0, 'nothing got through');
  eq(result.unknown.join(','), 'alsoNonsense,nonsense', 'both named, sorted');
});

check('a non-number is not a parameter value', () => {
  const def = compDevice.params[0];
  if (!def) throw new Error('no parameter');
  const result = sanitiseParams(DEVICE, {
    [def.id]: 'loud' as unknown as number,
  });
  eq(Object.keys(result.params).length, 0, 'a string is dropped');
  const nan = sanitiseParams(DEVICE, { [def.id]: Number.NaN });
  eq(Object.keys(nan.params).length, 0, 'NaN is dropped — it would poison an AudioParam');
  const inf = sanitiseParams(DEVICE, { [def.id]: Infinity });
  eq(Object.keys(inf.params).length, 0, 'and so is Infinity');
});

check('a hand-edited store with an out-of-range value cannot reach a device', () => {
  const def = compDevice.params.find((p) => p.max > p.min);
  if (!def) throw new Error('no bounded parameter');
  const store = memoryStore({
    'loui.daw.presets.user': JSON.stringify({
      version: 1,
      items: [{
        id: 'user:hand-edited', pluginId: DEVICE, name: '손으로 고침', note: '',
        createdAt: 1, updatedAt: 1, params: { [def.id]: def.max * 100 },
      }],
    }),
  });
  setUserPresetStore(store);
  const asFactory = allPresetGroups(DEVICE)[0]?.presets[0];
  assert(asFactory !== undefined, 'it is listed');
  eq(asFactory?.params[def.id], def.max, 'but the value the picker hands out is in range');
});

check('a corrupted store reads as empty instead of throwing', () => {
  setUserPresetStore(memoryStore({ 'loui.daw.presets.user': '{ not json' }));
  eq(listUserPresets().length, 0, 'no presets');
  setUserPresetStore(memoryStore({ 'loui.daw.presets.user': '{"version":1,"items":"nope"}' }));
  eq(listUserPresets().length, 0, 'and a wrong-shaped envelope is the same');
  setUserPresetStore(memoryStore({
    'loui.daw.presets.user': JSON.stringify({ version: 1, items: [{ id: 'x' }, null, 5] }),
  }));
  eq(listUserPresets().length, 0, 'malformed entries are filtered out one by one');
});

check('a store that refuses to write reports failure rather than lying', () => {
  setUserPresetStore({
    getItem: () => null,
    setItem: () => { throw new Error('quota exceeded'); },
  });
  const result = saveUserPreset({ pluginId: DEVICE, name: 'A', params: defaultParams(DEVICE) });
  assert(!result.ok, 'the save is reported as failed');
  assert((result.ok ? '' : result.reason).includes('저장'), 'with a reason a user can act on');
});

check('with no store at all nothing throws', () => {
  setUserPresetStore(null);   // and there is no localStorage in node
  eq(listUserPresets().length, 0, 'reads are empty');
  assert(!saveUserPreset({ pluginId: DEVICE, name: 'A', params: {} }).ok, 'writes are refused');
});

// ── 4. The picker ─────────────────────────────────────────────────────────────

check('user presets sit above the factory ones, and only when there are any', () => {
  fresh();
  const before = allPresetGroups('spacereverb');
  eq(before.length, presetGroups('spacereverb').length, 'with none saved, the list is unchanged');
  assert(before[0]?.group !== USER_GROUP, 'and there is no empty user group');

  saveUserPreset({ pluginId: 'spacereverb', name: '내 홀', params: defaultParams('spacereverb') });
  const after = allPresetGroups('spacereverb');
  eq(after[0]?.group, USER_GROUP, 'once saved, yours are first');
  eq(after[0]?.presets[0]?.name, '내 홀', 'and named');
  eq(after.length, before.length + 1, 'the factory groups are all still there');
});

check('the list is ordered by when each preset was last touched', () => {
  fresh();
  const a = saveUserPreset({ pluginId: DEVICE, name: 'A', params: defaultParams(DEVICE) });
  saveUserPreset({ pluginId: DEVICE, name: 'B', params: defaultParams(DEVICE) });
  saveUserPreset({ pluginId: DEVICE, name: 'C', params: defaultParams(DEVICE) });
  if (!a.ok) throw new Error('save failed');
  overwriteUserPreset(a.preset.id, defaultParams(DEVICE));

  const listed = listUserPresets(DEVICE);
  eq(listed.length, 3, 'all three');
  // Three saves in the same millisecond are possible, so the contract that
  // can be asserted is the ORDER against the stamps, not which name wins.
  for (let i = 1; i < listed.length; i++) {
    const previous = listed[i - 1];
    const current = listed[i];
    if (!previous || !current) throw new Error('missing entry');
    assert(previous.updatedAt >= current.updatedAt,
      `newest first — ${previous.name}(${previous.updatedAt}) before ${current.name}(${current.updatedAt})`);
  }
  const touched = listed.find((p) => p.id === a.preset.id);
  assert(touched !== undefined && touched.updatedAt >= touched.createdAt,
    'an overwrite moves updatedAt forward, never back');
});

check('a user preset loads through the same path as a factory one', () => {
  fresh();
  const def = compDevice.params.find((p) => p.max > p.min);
  if (!def) throw new Error('no bounded parameter');
  saveUserPreset({
    pluginId: DEVICE, name: '내 세팅', note: '  한 줄  설명  ',
    params: { ...defaultParams(DEVICE), [def.id]: def.max },
  });
  const preset = allPresetGroups(DEVICE)[0]?.presets[0];
  assert(preset !== undefined, 'in the picker');
  if (!preset) return;
  eq(preset.note, '한 줄 설명', 'the note is tidied like the name');

  const loaded = resolvePreset(preset, defaultParams(DEVICE));
  eq(loaded[def.id], def.max, 'the saved value lands');
  for (const p of compDevice.params) {
    assert(loaded[p.id] !== undefined, `${p.id} has a value — defaults fill the rest`);
  }
});

check('a parameter added to a device after the preset was saved gets its default', () => {
  fresh();
  const def = compDevice.params[0];
  if (!def) throw new Error('no parameter');
  // A preset saved by an older build knows about one parameter only.
  const store = memoryStore({
    'loui.daw.presets.user': JSON.stringify({
      version: 1,
      items: [{
        id: 'user:old', pluginId: DEVICE, name: '옛날 프리셋', note: '',
        createdAt: 1, updatedAt: 1, params: { [def.id]: def.default },
      }],
    }),
  });
  setUserPresetStore(store);
  const preset = allPresetGroups(DEVICE)[0]?.presets[0];
  if (!preset) throw new Error('not listed');
  const loaded = resolvePreset(preset, defaultParams(DEVICE));

  eq(Object.keys(loaded).length, compDevice.params.length, 'exactly the device’s parameters');
  for (const p of compDevice.params) {
    if (p.id === def.id) continue;
    // Nothing the old preset knew about — so it has to be the device's own
    // default, not zero and not undefined.
    eq(loaded[p.id], p.default, `${p.id} falls back to its default`);
  }
  eq(loaded[def.id], def.default, 'and the one it did know about is what it stored');
});

// ── 5. Files ──────────────────────────────────────────────────────────────────

check('export writes a file that identifies itself', () => {
  fresh();
  saveUserPreset({ pluginId: DEVICE, name: 'A', params: defaultParams(DEVICE) });
  const parsed = JSON.parse(exportUserPresets()) as { kind: string; items: unknown[] };
  eq(parsed.kind, EXPORT_KIND, 'so an import can refuse someone else’s file');
  eq(parsed.items.length, 1, 'with the preset in it');

  saveUserPreset({ pluginId: 'eq3', name: 'B', params: defaultParams('eq3') });
  eq((JSON.parse(exportUserPresets()) as { items: unknown[] }).items.length, 2, 'everything');
  eq((JSON.parse(exportUserPresets(DEVICE)) as { items: unknown[] }).items.length, 1,
    'or one device’s worth');
});

check('export then import into an empty store round trips', () => {
  fresh();
  const def = compDevice.params.find((p) => p.max > p.min);
  if (!def) throw new Error('no bounded parameter');
  saveUserPreset({
    pluginId: DEVICE, name: '가져갈 것', note: '설명',
    params: { ...defaultParams(DEVICE), [def.id]: def.max },
  });
  const file = exportUserPresets();

  fresh();
  const report = importUserPresets(file);
  eq(report.added, 1, 'one added');
  eq(report.skipped, 0, 'none skipped');
  const back = listUserPresets(DEVICE)[0];
  eq(back?.name, '가져갈 것', 'name');
  eq(back?.note, '설명', 'note');
  eq(back?.params[def.id], def.max, 'and the sound itself');
});

check('importing over an existing name keeps BOTH, renamed', () => {
  fresh();
  saveUserPreset({ pluginId: DEVICE, name: '보컬', params: defaultParams(DEVICE) });
  const file = exportUserPresets();
  const report = importUserPresets(file);
  eq(report.added, 1, 'the incoming one is added');
  eq(report.renamed, 1, 'under a new name');
  const names = listUserPresets(DEVICE).map((p) => p.name).sort();
  eq(names.join(','), '보컬,보컬 (2)', 'both survive — the importer cannot know which was wanted');

  // A third copy does not collide with the second.
  importUserPresets(file);
  eq(listUserPresets(DEVICE).length, 3, 'three now');
  assert(listUserPresets(DEVICE).some((p) => p.name === '보컬 (3)'), 'numbered onward');
});

check('a preset for a device this build does not ship is skipped and named', () => {
  fresh();
  const file = JSON.stringify({
    kind: EXPORT_KIND, version: 1, exportedAt: 0,
    items: [
      { id: 'user:x', pluginId: 'tape-machine-9000', name: '미래 장치', note: '',
        createdAt: 1, updatedAt: 1, params: { drive: 5 } },
      { id: 'user:y', pluginId: DEVICE, name: '지금 장치', note: '',
        createdAt: 1, updatedAt: 1, params: defaultParams(DEVICE) },
    ],
  });
  const report = importUserPresets(file);
  eq(report.added, 1, 'the one that can work is imported');
  eq(report.skipped, 1, 'the other is skipped');
  assert(report.reasons.some((r) => r.includes('미래 장치')), 'and it is named in the reason');
  assert(report.reasons.some((r) => r.includes('tape-machine-9000')), 'with the device that is missing');
});

check('someone else’s JSON is refused rather than half-imported', () => {
  fresh();
  const notOurs = JSON.stringify({ kind: 'some.other.app', version: 1, items: [] });
  const report = importUserPresets(notOurs);
  eq(report.added, 0, 'nothing added');
  assert(report.reasons.some((r) => r.includes('다른')), 'and it says so');

  const garbage = importUserPresets('{{{');
  eq(garbage.added, 0, 'broken JSON adds nothing');
  assert(garbage.reasons.some((r) => r.includes('JSON')), 'and names the problem');

  const shapeless = importUserPresets(JSON.stringify({ hello: 'world' }));
  eq(shapeless.added, 0, 'a JSON object that is not a preset file adds nothing');
});

check('an out-of-range value in an imported file is clamped on the way in', () => {
  fresh();
  const def = compDevice.params.find((p) => p.max > p.min);
  if (!def) throw new Error('no bounded parameter');
  importUserPresets(JSON.stringify({
    kind: EXPORT_KIND, version: 1, exportedAt: 0,
    items: [{
      id: 'user:x', pluginId: DEVICE, name: '범위 밖', note: '',
      createdAt: 1, updatedAt: 1,
      params: { [def.id]: def.max + 9999, ghost: 1 },
    }],
  }));
  const stored = listUserPresets(DEVICE)[0];
  eq(stored?.params[def.id], def.max, 'clamped');
  eq(stored?.params['ghost'], undefined, 'and the parameter that does not exist is gone');
});

check('describeImport says what actually happened', () => {
  const text = describeImport({ added: 3, renamed: 1, skipped: 2, reasons: [] });
  assert(text.includes('3개 추가'), `added — ${text}`);
  assert(text.includes('1개 이름 변경'), `renamed — ${text}`);
  assert(text.includes('2개 건너뜀'), `skipped — ${text}`);
  const clean = describeImport({ added: 2, renamed: 0, skipped: 0, reasons: [] });
  eq(clean, '2개 추가', 'and stays quiet when nothing went wrong');
});

// ── 6. Every device ───────────────────────────────────────────────────────────

check('every shipped device can save, list and load its own preset', () => {
  // A sweep, because a device with an odd parameter set is exactly the one
  // that would break saving and nobody would notice until they tried it.
  const failures: string[] = [];
  for (const device of PLUGINS) {
    fresh();
    const params = defaultParams(device.id);
    const saved = saveUserPreset({ pluginId: device.id, name: '테스트', params });
    if (!saved.ok) { failures.push(`${device.id}: ${saved.reason}`); continue; }

    const group = allPresetGroups(device.id).find((g) => g.group === USER_GROUP);
    const listed = group?.presets[0];
    if (!listed) { failures.push(`${device.id}: not in the picker`); continue; }

    const loaded = resolvePreset(listed, defaultParams(device.id));
    for (const def of device.params) {
      const value = loaded[def.id];
      if (value === undefined || !Number.isFinite(value)) {
        failures.push(`${device.id}.${def.id}: ${String(value)}`);
      } else if (value < def.min || value > def.max) {
        failures.push(`${device.id}.${def.id}: ${value} outside ${def.min}…${def.max}`);
      }
    }
  }
  eq(failures.length, 0, `every device round trips — ${failures.slice(0, 5).join(' | ')}`);
  assert(PLUGINS.length > 30, `and there are ${PLUGINS.length} of them`);
});

check('a preset saved from one device never appears on another', () => {
  fresh();
  saveUserPreset({ pluginId: DEVICE, name: '컴프 것', params: defaultParams(DEVICE) });
  for (const device of PLUGINS) {
    if (device.id === DEVICE) continue;
    const mine = allPresetGroups(device.id).find((g) => g.group === USER_GROUP);
    eq(mine, undefined, `${device.id} shows none of the comp's presets`);
  }
});

check('a device with no declared parameters here cannot be saved', () => {
  // A third-party plugin reached through the external host has no parameter
  // list in this build, so there is nothing to validate a preset against —
  // and the window is told NOT to draw a save button for it.
  assert(!canSaveUserPreset('some-vst3-uid'), 'refused up front');
  assert(canSaveUserPreset(DEVICE), 'a built-in device can be saved');
  for (const device of PLUGINS) {
    assert(canSaveUserPreset(device.id), `${device.id} can be saved`);
  }
});

// ── 7. Text hygiene ───────────────────────────────────────────────────────────

check('names and notes are trimmed, collapsed and capped', () => {
  eq(sanitiseName('  두   칸  '), '두 칸', 'collapsed');
  eq(sanitiseName('\n\ttab\n'), 'tab', 'newlines and tabs count as whitespace');
  eq(sanitiseName('x'.repeat(200)).length, 60, 'names cap at 60');
  eq(sanitiseNote('y'.repeat(400)).length, 160, 'notes cap at 160');
  eq(sanitiseName(''), '', 'and empty stays empty so the caller can refuse it');
});

check('asPluginPreset produces something the picker can use directly', () => {
  fresh();
  const saved = saveUserPreset({ pluginId: DEVICE, name: '변환', params: defaultParams(DEVICE) });
  if (!saved.ok) throw new Error('save failed');
  const asFactory = asPluginPreset(saved.preset);
  eq(asFactory.group, USER_GROUP, 'grouped as yours');
  eq(asFactory.id, saved.preset.id, 'keeping its id, so loading finds it again');
  eq(asFactory.pluginId, DEVICE, 'and its device');
});

// ── Report ────────────────────────────────────────────────────────────────────

setUserPresetStore(null);
const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== User presets: save · load · files · every device ===');
for (const r of results) {
  console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
