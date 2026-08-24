/**
 * genre-presets-selftest.ts — the genre preset set, checked for the two ways
 * a set like this normally rots.
 *
 * Ten genres × every device that genre can change is 370 parameter maps, and
 * nobody reads 370 parameter maps.  What actually happens is that one of them
 * gets pasted from its neighbour and never corrected — so the 재즈 compressor
 * and the K-POP compressor turn out to be the same device, and the menu is
 * lying about having ten answers when it has six.
 *
 * So the interesting checks here are not "does it load".  They are:
 *
 *   · no two genres share a map for the same device            (the paste)
 *   · and they do not merely differ by a rounding error        (the near-paste)
 *   · every parameter named exists on that device              (the typo)
 *   · every value is inside the device's own range             (the guess)
 *   · the loudness numbers match the profile in the header     (the drift)
 *
 * Run via:  pnpm --filter @aimaster/desktop test:genre-presets
 */

import { PLUGINS, findPlugin } from '../src/renderer/daw/engine/plugins.js';
import { presetsFor } from '../src/renderer/daw/engine/plugin-presets.js';
import {
  GENRE_PRESETS, GENRE_ORDER, GENRE_LABEL, GENRE_TARGET_LUFS, GENRE_GROUP,
  partitionGenre, type GenreId,
} from '../src/renderer/daw/engine/plugin-presets-genre.js';
import { allPresetGroups } from '../src/renderer/daw/engine/user-presets.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

/**
 * The four devices with no genre presets, and why.  Listed here rather than
 * inferred, so that adding a device without genre presets fails the coverage
 * check instead of quietly joining this list.
 */
const NO_GENRE: Record<string, string> = {
  dcblock: 'no parameters at all',
  phase:   'invert / swap / mono is a wiring decision, not a sound',
  trim:    'one gain in dB — a "genre gain" would be invented',
  dither:  'bit depth and TPDF amount are decided by the delivery format',
};

const covered = PLUGINS.filter((p) => !(p.id in NO_GENRE));

/** How far apart two values are, as a fraction of the parameter's own range. */
function spread(pluginId: string, paramId: string, a: number, b: number): number {
  const def = findPlugin(pluginId)?.params.find((p) => p.id === paramId);
  if (!def) return 0;
  const range = def.max - def.min;
  return range > 0 ? Math.abs(a - b) / range : 0;
}

// ─────────────────────────────────────────────────────────────────────────────

check('every device genre can change has all ten', () => {
  for (const plugin of covered) {
    const genre = presetsFor(plugin.id).filter((p) => p.group === GENRE_GROUP);
    assert(genre.length === 10,
      `${plugin.id}: ${genre.length} genre presets, expected 10`);
    const names = genre.map((p) => p.name);
    for (const g of GENRE_ORDER) {
      assert(names.includes(GENRE_LABEL[g]), `${plugin.id}: missing ${GENRE_LABEL[g]}`);
    }
  }
});

check('the devices without genre presets are exactly the four with a stated reason', () => {
  for (const id of Object.keys(NO_GENRE)) {
    assert(findPlugin(id) !== undefined, `${id} is in the exclusion list but not in the registry`);
    const genre = presetsFor(id).filter((p) => p.group === GENRE_GROUP);
    assert(genre.length === 0, `${id} is excluded but has ${genre.length} genre presets`);
  }
  const total = covered.length * 10;
  assert(GENRE_PRESETS.length === total,
    `${GENRE_PRESETS.length} genre presets for ${covered.length} devices, expected ${total}`);
});

check('every parameter a genre preset names exists on that device', () => {
  for (const preset of GENRE_PRESETS) {
    const plugin = findPlugin(preset.pluginId);
    assert(plugin, `${preset.id}: no such device ${preset.pluginId}`);
    for (const key of Object.keys(preset.params)) {
      assert(plugin!.params.some((p) => p.id === key),
        `${preset.id}: device ${preset.pluginId} has no parameter '${key}'`);
    }
  }
});

check('every value is inside the range the device declares', () => {
  for (const preset of GENRE_PRESETS) {
    const plugin = findPlugin(preset.pluginId)!;
    for (const [key, value] of Object.entries(preset.params)) {
      const def = plugin.params.find((p) => p.id === key)!;
      assert(Number.isFinite(value), `${preset.id}.${key} is ${value}`);
      assert(value >= def.min && value <= def.max,
        `${preset.id}.${key} = ${value}, outside ${def.min}…${def.max}`);
    }
  }
});

check('no two genres share a parameter map', () => {
  for (const plugin of covered) {
    const genre = presetsFor(plugin.id).filter((p) => p.group === GENRE_GROUP);
    for (let i = 0; i < genre.length; i++) {
      for (let j = i + 1; j < genre.length; j++) {
        const a = genre[i]!, b = genre[j]!;
        assert(JSON.stringify(a.params) !== JSON.stringify(b.params),
          `${plugin.id}: ${a.name} and ${b.name} are the same map`);
      }
    }
  }
});

// The near-paste is the one worth spending effort on: two presets that differ
// only in the last decimal of one knob are two names for one sound, which is
// exactly what a menu of ten is supposed to rule out.
//
// Two rules, because a device with one parameter cannot obey the first:
//
//   · they must differ in at least two parameters — or, on a one-parameter
//     device, in that one;
//   · and at least one of those differences must be at least 5 % of the
//     parameter's own range, which is the point at which a knob has visibly
//     moved.  The single exception is the loudness meter: −9.5 and −9 LUFS
//     is 2.8 % of its range and is a real, audible half-LU difference, so a
//     one-parameter device only has to be distinct.
const MIN_SPREAD = 0.05;

check('no two genres differ only by a rounding error', () => {
  for (const plugin of covered) {
    const genre = presetsFor(plugin.id).filter((p) => p.group === GENRE_GROUP);
    const single = plugin.params.length === 1;
    for (let i = 0; i < genre.length; i++) {
      for (let j = i + 1; j < genre.length; j++) {
        const a = genre[i]!, b = genre[j]!;
        const keys = new Set([...Object.keys(a.params), ...Object.keys(b.params)]);
        let differing = 0;
        let widest = 0;
        for (const key of keys) {
          const av = a.params[key], bv = b.params[key];
          if (av === undefined || bv === undefined) { differing++; widest = 1; continue; }
          if (av !== bv) {
            differing++;
            widest = Math.max(widest, spread(plugin.id, key, av, bv));
          }
        }
        assert(differing >= (single ? 1 : 2),
          `${plugin.id}: ${a.name} vs ${b.name} differ in only ${differing} parameter(s)`);
        if (!single) {
          assert(widest >= MIN_SPREAD,
            `${plugin.id}: ${a.name} vs ${b.name} — widest difference is `
            + `${(widest * 100).toFixed(1)} % of range, under the ${MIN_SPREAD * 100} % floor`);
        }
      }
    }
  }
});

check('every genre preset says something, and says something different', () => {
  const seen = new Map<string, string>();
  for (const preset of GENRE_PRESETS) {
    assert(preset.note.trim().length >= 8, `${preset.id}: note is too short to be useful`);
    const previous = seen.get(preset.note);
    assert(previous === undefined,
      `${preset.id} and ${previous} carry the same note — one of them was pasted`);
    seen.set(preset.note, preset.id);
  }
});

check('ids are unique and do not collide with the source presets', () => {
  const ids = new Set<string>();
  for (const preset of GENRE_PRESETS) {
    assert(!ids.has(preset.id), `duplicate id ${preset.id}`);
    ids.add(preset.id);
  }
  for (const plugin of PLUGINS) {
    const all = presetsFor(plugin.id);
    const unique = new Set(all.map((p) => p.id));
    assert(unique.size === all.length, `${plugin.id}: duplicate preset id in the merged list`);
  }
});

// ── The profile is the thing driving the numbers ─────────────────────────────
//
// These are the claims the header makes in prose.  If a preset is edited
// without the profile being edited too, one of these fails.

check('the loudness presets are the profile, not a second opinion', () => {
  const genre = presetsFor('loudness').filter((p) => p.group === GENRE_GROUP);
  for (const g of GENRE_ORDER) {
    const preset = genre.find((p) => p.name === GENRE_LABEL[g])!;
    assert(preset.params['targetLufs'] === GENRE_TARGET_LUFS[g],
      `loudness ${GENRE_LABEL[g]}: preset says ${preset.params['targetLufs']}, `
      + `profile says ${GENRE_TARGET_LUFS[g]}`);
  }
});

/** The preset for one genre on one device. */
function got(pluginId: string, genre: GenreId): Record<string, number> {
  const preset = presetsFor(pluginId)
    .filter((p) => p.group === GENRE_GROUP)
    .find((p) => p.name === GENRE_LABEL[genre]);
  assert(preset, `${pluginId}: no preset for ${GENRE_LABEL[genre]}`);
  return preset!.params;
}

/** `order` must hold, loudest/brightest/… first. */
function descending(label: string, values: Array<[GenreId, number]>): void {
  for (let i = 1; i < values.length; i++) {
    const [prevG, prev] = values[i - 1]!;
    const [thisG, here] = values[i]!;
    assert(prev > here,
      `${label}: ${GENRE_LABEL[prevG]} (${prev}) should be above ${GENRE_LABEL[thisG]} (${here})`);
  }
}

check('the loud four are louder than the quiet four, in the stated order', () => {
  descending('targetLufs', ([
    'edm', 'kpop', 'jpop', 'hiphop', 'pop', 'rnb', 'lofi', 'jazz', 'ambient', 'classic',
  ] as GenreId[]).map((g) => [g, GENRE_TARGET_LUFS[g]]));
});

check('클래식 compresses least and EDM most, on every compressor here', () => {
  for (const id of ['comp', 'ducker']) {
    const classic = got(id, 'classic')['ratio']!;
    const jazz = got(id, 'jazz')['ratio']!;
    const edm = got(id, 'edm')['ratio']!;
    assert(classic < jazz, `${id}: 클래식 ratio ${classic} should be under 재즈 ${jazz}`);
    assert(edm > 5, `${id}: EDM ratio ${edm} should be the aggressive end`);
    for (const g of GENRE_ORDER) {
      assert(got(id, g)['ratio']! <= edm, `${id}: ${GENRE_LABEL[g]} out-compresses EDM`);
      assert(got(id, g)['ratio']! >= classic, `${id}: ${GENRE_LABEL[g]} under-compresses 클래식`);
    }
  }
});

check('로파이 is the dark one and the bright genres are bright', () => {
  // The profile says 로파이 has no air at all and K-POP / J-POP are the top.
  const lofi = got('eq3', 'lofi')['highDb']!;
  assert(lofi < 0, `eq3: 로파이 high shelf is ${lofi}, should cut`);
  for (const g of ['kpop', 'jpop', 'edm', 'pop'] as GenreId[]) {
    assert(got('eq3', g)['highDb']! >= 3, `eq3: ${GENRE_LABEL[g]} should be bright`);
  }
  // And 로파이 is the only one that low-passes.
  assert(got('eq8', 'lofi')['lpfHz']! < 12000, 'eq8: 로파이 should low-pass');
  for (const g of GENRE_ORDER) {
    if (g === 'lofi') continue;
    assert(got('eq8', g)['lpfHz']! >= 19000, `eq8: ${GENRE_LABEL[g]} should not low-pass`);
  }
});

check('the low end goes mono where the profile says it does', () => {
  // EDM highest, 클래식 lowest — the two ends of the same decision.
  const edm = got('monomaker', 'edm')['freqHz']!;
  const classic = got('monomaker', 'classic')['freqHz']!;
  assert(classic <= 20, `monomaker: 클래식 should barely fold, got ${classic} Hz`);
  for (const g of GENRE_ORDER) {
    assert(got('monomaker', g)['freqHz']! <= edm, `monomaker: ${GENRE_LABEL[g]} folds above EDM`);
  }
  assert(got('widener', 'lofi')['width']! < 1, 'widener: 로파이 should narrow, not widen');
  assert(got('widener', 'ambient')['width']! > 1.5, 'widener: 앰비언트 should be the widest');
});

check('앰비언트 has the longest tails and 힙합 the shortest', () => {
  for (const [id, key] of [['reverb', 'decaySec'], ['plate', 'decaySec']] as const) {
    const ambient = got(id, key === 'decaySec' ? 'ambient' : 'ambient')[key]!;
    const hiphop = got(id, 'hiphop')[key]!;
    for (const g of GENRE_ORDER) {
      const v = got(id, g)[key]!;
      assert(v <= ambient, `${id}: ${GENRE_LABEL[g]} (${v}) outlasts 앰비언트 (${ambient})`);
      assert(v >= hiphop, `${id}: ${GENRE_LABEL[g]} (${v}) is drier than 힙합 (${hiphop})`);
    }
  }
});

// ── What the window actually draws ───────────────────────────────────────────
//
// The window splits the genre group out and draws it as chips.  If that split
// silently returned nothing, every device would look exactly as it did before
// these 370 presets existed — the failure would be invisible.

check('the chip row gets all ten, in the declared order', () => {
  for (const plugin of covered) {
    const { genre } = partitionGenre(allPresetGroups(plugin.id));
    assert(genre.length === 10, `${plugin.id}: chip row has ${genre.length}, expected 10`);
    for (let i = 0; i < GENRE_ORDER.length; i++) {
      assert(genre[i]!.name === GENRE_LABEL[GENRE_ORDER[i]!],
        `${plugin.id}: chip ${i} is ${genre[i]!.name}, expected ${GENRE_LABEL[GENRE_ORDER[i]!]}`);
    }
  }
});

check('the dropdown does not list the same ten again', () => {
  for (const plugin of PLUGINS) {
    const { rest } = partitionGenre(allPresetGroups(plugin.id));
    assert(!rest.some((g) => g.group === GENRE_GROUP),
      `${plugin.id}: the genre group is still in the dropdown`);
  }
});

check('the four devices without genre presets get no chip row', () => {
  for (const id of Object.keys(NO_GENRE)) {
    const { genre } = partitionGenre(allPresetGroups(id));
    assert(genre.length === 0, `${id}: has ${genre.length} chips but should have none`);
  }
});

check('every chip carries the note it will show on hover', () => {
  for (const plugin of covered) {
    const { genre } = partitionGenre(allPresetGroups(plugin.id));
    for (const preset of genre) {
      assert(preset.note.trim().length > 0, `${plugin.id}/${preset.name}: chip has no tooltip`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Genre presets ===');
console.log(`${covered.length} devices × ${GENRE_ORDER.length} genres = ${GENRE_PRESETS.length} presets\n`);
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
