/**
 * instrument-presets-selftest.ts — the instrument preset set, checked for the
 * ways a set this size actually rots.
 *
 * Seven instruments × 36 devices is 252 parameter maps, and nobody reads 252
 * parameter maps.  What happens instead is that one gets pasted from its
 * neighbour and never corrected, so the 베이스 compressor and the 피아노
 * compressor turn out to be the same device and the menu is claiming thirteen
 * answers while holding four.
 *
 * So the checks are not "does it load".  They are:
 *
 *   · no two instruments share a map for the same device       (the paste)
 *   · and they do not merely differ by a rounding error        (the near-paste)
 *   · every parameter named exists on that device              (the typo)
 *   · every value is inside the device's own range             (the guess)
 *   · the numbers agree with the profiles in the header        (the drift)
 *
 * The last group is the interesting one.  The header claims things like "a
 * bass is mono, always" and "a drum loop's attack has to stay slow or it eats
 * the stick".  Those are testable, and if the prose and the numbers disagree
 * one of them is wrong.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:instrument-presets
 */

import { PLUGINS, findPlugin } from '../src/renderer/daw/engine/plugins.js';
import { PLUGIN_PRESETS } from '../src/renderer/daw/engine/plugin-presets.js';
import { allPresetGroups } from '../src/renderer/daw/engine/user-presets.js';
import {
  INSTRUMENT_PRESETS, INSTRUMENT_ORDER, INSTRUMENT_LABEL, INSTRUMENT_GROUP,
  NO_INSTRUMENT_PRESETS, SINGLE_AXIS_DEVICES, partitionInstrument, sharedInstrumentSource,
  type InstrumentId,
} from '../src/renderer/daw/engine/plugin-presets-instrument.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

/** The instrument preset for one device, or undefined. */
function P(pluginId: string, id: InstrumentId): Record<string, number> | undefined {
  return INSTRUMENT_PRESETS.find(
    (p) => p.pluginId === pluginId && p.name === INSTRUMENT_LABEL[id],
  )?.params;
}
/** A parameter's value, or the device default when the preset stays quiet. */
function V(pluginId: string, id: InstrumentId, param: string): number {
  const v = P(pluginId, id)?.[param];
  if (typeof v === 'number') return v;
  const d = findPlugin(pluginId)?.params.find((x) => x.id === param);
  assert(d, `${pluginId}.${param} does not exist`);
  return d!.default;
}
const devicesWithPresets = [...new Set(INSTRUMENT_PRESETS.map((p) => p.pluginId))];

// ── Coverage ────────────────────────────────────────────────────────────────

check('every device an instrument can change has all thirteen', () => {
  for (const pluginId of devicesWithPresets) {
    for (const id of INSTRUMENT_ORDER) {
      assert(P(pluginId, id), `${pluginId} has no ${INSTRUMENT_LABEL[id]}`);
    }
  }
});

check('the devices without instrument presets are exactly the five with a stated reason', () => {
  const covered = new Set(devicesWithPresets);
  const excused = new Set(Object.keys(NO_INSTRUMENT_PRESETS));
  for (const pl of PLUGINS) {
    if (covered.has(pl.id)) {
      assert(!excused.has(pl.id), `${pl.id} is both covered and excused`);
      continue;
    }
    assert(excused.has(pl.id),
      `${pl.id} has no instrument presets and no stated reason — add presets or say why not`);
  }
  for (const id of excused) {
    assert(PLUGINS.some((p) => p.id === id), `${id} is excused but is not a device`);
  }
});

// ── The typo and the guess ──────────────────────────────────────────────────

check('every parameter an instrument preset names exists on that device', () => {
  for (const p of INSTRUMENT_PRESETS) {
    const d = findPlugin(p.pluginId);
    assert(d, `${p.id}: no such device ${p.pluginId}`);
    for (const key of Object.keys(p.params)) {
      assert(d!.params.some((x) => x.id === key), `${p.id}: ${p.pluginId} has no parameter "${key}"`);
    }
  }
});

check('every value is inside the range the device declares', () => {
  for (const p of INSTRUMENT_PRESETS) {
    const d = findPlugin(p.pluginId)!;
    for (const [key, value] of Object.entries(p.params)) {
      const spec = d.params.find((x) => x.id === key)!;
      assert(Number.isFinite(value), `${p.id}: ${key} is not finite`);
      assert(value >= spec.min && value <= spec.max,
        `${p.id}: ${key}=${value} outside [${spec.min}, ${spec.max}]`);
    }
  }
});

// ── The paste and the near-paste ────────────────────────────────────────────

/** Two instruments that are DECLARED to want the same answer on a device. */
function sharesAnswer(pluginId: string, a: InstrumentId, b: InstrumentId): boolean {
  const sa = sharedInstrumentSource(pluginId, a);
  const sb = sharedInstrumentSource(pluginId, b);
  return sa === b || sb === a || (sa !== null && sa === sb);
}

check('no two instruments share a parameter map on the same device', () => {
  for (const pluginId of devicesWithPresets) {
    const seen = new Map<string, InstrumentId>();
    for (const id of INSTRUMENT_ORDER) {
      const key = JSON.stringify(
        Object.entries(P(pluginId, id)!).sort(([a], [b]) => a.localeCompare(b)),
      );
      const twin = seen.get(key);
      assert(twin === undefined || sharesAnswer(pluginId, id, twin),
        `${pluginId}: ${INSTRUMENT_LABEL[id]} is a copy of ${INSTRUMENT_LABEL[twin!]}`);
      seen.set(key, id);
    }
  }
});

/** How far apart two values are, as a fraction of that parameter's range. */
function spread(pluginId: string, paramId: string, a: number, b: number): number {
  const def = findPlugin(pluginId)?.params.find((x) => x.id === paramId);
  if (!def) return 0;
  const range = def.max - def.min;
  return range > 0 ? Math.abs(a - b) / range : 0;
}

/**
 * The same calibration the genre suite uses, deliberately.
 *
 * Two presets have to differ in at least two parameters, and at least ONE of
 * those differences has to be worth more than 5% of that parameter's range.
 * The first written version of this check asked instead that two parameters
 * each clear a magnitude floor, and that is a different and worse rule: a
 * rate control declared 0.05–10 Hz has its whole musical life inside the
 * bottom fifth of that range, so demanding 2% of the FULL range on every
 * differing parameter starts rejecting values that are musically far apart
 * and forcing the authoring to move numbers for the test's benefit.  A test
 * that makes you write worse presets is not protecting anything.
 */
const MIN_SPREAD = 0.05;

check('no two instruments differ only by a rounding error', () => {
  for (const pluginId of devicesWithPresets) {
    // One-knob devices, and devices declared as moving one axis, are held
    // to the spread floor alone — see SINGLE_AXIS_DEVICES for why.
    const single = findPlugin(pluginId)!.params.length === 1
      || pluginId in SINGLE_AXIS_DEVICES;
    for (let i = 0; i < INSTRUMENT_ORDER.length; i++) {
      for (let j = i + 1; j < INSTRUMENT_ORDER.length; j++) {
        const a = INSTRUMENT_ORDER[i]!, b = INSTRUMENT_ORDER[j]!;
        // A declared share is not a copy-paste — see SHARED_INSTRUMENT_ANSWERS.
        if (sharesAnswer(pluginId, a, b)) continue;
        const pa = P(pluginId, a)!, pb = P(pluginId, b)!;
        const keys = new Set([...Object.keys(pa), ...Object.keys(pb)]);
        let differing = 0;
        let widest = 0;
        for (const key of keys) {
          const av = pa[key], bv = pb[key];
          if (av === undefined || bv === undefined) { differing++; widest = 1; continue; }
          if (av !== bv) { differing++; widest = Math.max(widest, spread(pluginId, key, av, bv)); }
        }
        assert(differing >= (single ? 1 : 2),
          `${pluginId}: ${INSTRUMENT_LABEL[a]} vs ${INSTRUMENT_LABEL[b]} differ in only ${differing} parameter(s)`);
        {
          assert(widest >= MIN_SPREAD,
            `${pluginId}: ${INSTRUMENT_LABEL[a]} vs ${INSTRUMENT_LABEL[b]} — widest difference is `
            + `${(widest * 100).toFixed(1)} % of range, under the ${MIN_SPREAD * 100} % floor`);
        }
      }
    }
  }
});

check('every preset says something, and says something different', () => {
  const notes = new Map<string, string>();
  for (const p of INSTRUMENT_PRESETS) {
    assert(p.note.trim().length >= 10, `${p.id}: note is too short to be worth reading`);
    const twin = notes.get(p.note);
    assert(twin === undefined, `${p.id}: same note as ${twin}`);
    notes.set(p.note, p.id);
  }
});

check('ids are unique and do not collide with the genre or source presets', () => {
  const ids = new Set<string>();
  for (const p of PLUGIN_PRESETS) {
    assert(!ids.has(p.id), `duplicate preset id ${p.id}`);
    ids.add(p.id);
  }
  for (const p of INSTRUMENT_PRESETS) {
    assert(p.id.startsWith('inst-'), `${p.id}: instrument ids are prefixed inst-`);
    assert(p.group === INSTRUMENT_GROUP, `${p.id}: wrong group ${p.group}`);
  }
});

// ── The profiles in the header, as numbers ──────────────────────────────────

check('a bass is mono, and is the most mono thing here', () => {
  // "Mono, always, and the one instrument where that is not a stylistic
  // choice" — so it must not be widened at all, and its mono crossover must
  // sit above every other instrument's except the synth's sub.
  assert(V('widener', 'bass', 'width') <= 1,
    `bass widener width is ${V('widener', 'bass', 'width')} — a bass is not widened`);
  for (const id of INSTRUMENT_ORDER) {
    if (id === 'bass' || id === 'synth') continue;
    assert(V('monomaker', 'bass', 'freqHz') > V('monomaker', id, 'freqHz'),
      `bass monomaker (${V('monomaker', 'bass', 'freqHz')} Hz) is not above ${INSTRUMENT_LABEL[id]}`);
  }
  assert(V('haas', 'bass', 'amount') <= 0.15, 'a bass does not get a Haas spread');
});

check("the high-pass respects each instrument's bottom end", () => {
  // The header's claim: a bass cut at 80 like a guitar loses the instrument,
  // and an amped electric has nothing under 80 to keep.
  for (const eq of ['eq3', 'eq8']) {
    const bass = V(eq, 'bass', 'hpfHz'), egtr = V(eq, 'egtr', 'hpfHz');
    assert(bass < egtr, `${eq}: bass hpf ${bass} should sit below electric guitar's ${egtr}`);
    assert(bass <= 32, `${eq}: bass hpf ${bass} Hz is already inside the instrument`);
    assert(egtr >= 80, `${eq}: electric guitar hpf ${egtr} Hz keeps rumble the amp never made`);
    assert(V(eq, 'drumloop', 'hpfHz') <= 40, `${eq}: drum hpf must stay under the kick`);
    assert(V(eq, 'synth', 'hpfHz') >= 100, `${eq}: the synth preset is supposed to make room`);
  }
});

check('the slow sources get slow attacks and the loop gets the slowest of the transient ones', () => {
  // Strings have no transient to catch, so they are slowest of all.  The drum
  // loop is the interesting one: its attack must stay slow enough not to eat
  // the stick, which means slower than the guitars.
  const a = (id: InstrumentId) => V('comp', id, 'attackMs');
  assert(a('strings') > a('drumloop'), 'strings should have the slowest attack');
  assert(a('drumloop') > a('egtr') && a('drumloop') > a('synth'),
    `drum loop attack ${a('drumloop')} ms is fast enough to eat the stick`);
  assert(a('bass') >= 30, `bass attack ${a('bass')} ms would flatten the pluck`);
});

check('the dynamic instruments are compressed least', () => {
  // "Piano dynamics ARE the performance" and an acoustic guitar squashed goes
  // plastic — so those two must sit below the sources that get squeezed.
  const r = (id: InstrumentId) => V('comp', id, 'ratio');
  for (const soft of ['piano', 'agtr', 'strings'] as InstrumentId[]) {
    for (const hard of ['bass', 'drumloop'] as InstrumentId[]) {
      assert(r(soft) < r(hard),
        `${INSTRUMENT_LABEL[soft]} (${r(soft)}:1) is compressed harder than ${INSTRUMENT_LABEL[hard]} (${r(hard)}:1)`);
    }
  }
  assert(r('piano') <= 2.5, `piano ratio ${r('piano')}:1 is too much for the performance`);
});

check('reverb length follows the profiles, and a bass stays dry', () => {
  const d = (id: InstrumentId) => V('reverb', id, 'decaySec');
  const m = (id: InstrumentId) => V('reverb', id, 'mix');
  assert(d('strings') > d('piano'), 'strings should be the longest of the acoustic sources');
  assert(d('piano') > d('agtr'), 'a piano lives in a bigger room than an acoustic guitar');
  assert(d('drumloop') < 1.2, `drum reverb ${d('drumloop')}s would smear the groove`);
  for (const id of INSTRUMENT_ORDER) {
    if (id === 'bass') continue;
    assert(m('bass') < m(id), `bass reverb mix is not drier than ${INSTRUMENT_LABEL[id]}`);
  }
});

check('the spring belongs to the electric guitar', () => {
  // The device exists for one instrument; the numbers should say so.
  const boing = (id: InstrumentId) => V('spring', id, 'boing');
  const mix = (id: InstrumentId) => V('spring', id, 'mixPct');
  for (const id of INSTRUMENT_ORDER) {
    if (id === 'egtr') continue;
    assert(mix('egtr') >= mix(id), `spring mix on ${INSTRUMENT_LABEL[id]} is not below the electric guitar's`);
  }
  assert(boing('egtr') > boing('agtr'), 'the electric should carry more boing than the acoustic');
  assert(mix('bass') <= 10, 'a spring on a bass is a mistake; the preset should barely engage');
});

check('saturation is loudest where the header says it matters most', () => {
  // "Not an effect here; it is how the part stays audible on a speaker with
  // no low end at all."
  const drive = (id: InstrumentId) => V('saturation', id, 'driveDb');
  for (const id of ['agtr', 'piano', 'strings'] as InstrumentId[]) {
    assert(drive('bass') > drive(id),
      `bass drive ${drive('bass')} dB is not above ${INSTRUMENT_LABEL[id]}`);
  }
  assert(drive('strings') <= 3, 'strings should get the least saturation');
});

check('the vocal profile says what the header says it says', () => {
  // The paragraph added with 보컬 makes five claims about numbers.  They are
  // the reason the preset exists, so they are asserted rather than trusted.
  //
  //   "the de-esser on this source is the deepest in the file"
  for (const id of INSTRUMENT_ORDER) {
    if (id === 'vocal') continue;
    assert(V('deesser', 'vocal', 'amount') > V('deesser', id, 'amount'),
      `de-esser on 보컬 (${V('deesser', 'vocal', 'amount')}) is not deeper than ${INSTRUMENT_LABEL[id]}`);
  }
  //   "the compression is the heaviest of the melodic sources"
  for (const soft of ['piano', 'agtr', 'strings'] as InstrumentId[]) {
    assert(V('comp', 'vocal', 'ratio') > V('comp', soft, 'ratio'),
      `보컬 (${V('comp', 'vocal', 'ratio')}:1) is not compressed harder than ${INSTRUMENT_LABEL[soft]}`);
  }
  //   "fast enough to catch a consonant (6 ms) without eating it"
  assert(V('comp', 'vocal', 'attackMs') <= 8,
    `보컬 attack ${V('comp', 'vocal', 'attackMs')} ms is too slow for a consonant`);
  //   "the high-pass is at 85 — high enough to lose the rumble and the
  //   plosive, low enough to leave a male chest voice intact"
  for (const eq of ['eq3', 'eq8']) {
    const hpf = V(eq, 'vocal', 'hpfHz');
    assert(hpf >= 80 && hpf <= 100, `${eq}: 보컬 hpf ${hpf} Hz is outside 80–100`);
    assert(hpf > V(eq, 'bass', 'hpfHz'), `${eq}: 보컬 hpf is not above the bass`);
  }
  //   "it stays in the CENTRE"
  for (const id of INSTRUMENT_ORDER) {
    if (id === 'vocal' || id === 'bass') continue;
    assert(V('widener', 'vocal', 'width') <= V('widener', id, 'width'),
      `보컬 width ${V('widener', 'vocal', 'width')} is wider than ${INSTRUMENT_LABEL[id]}`);
  }
  //   and the breath survives: a vocal gate that closes hard is a vocal that
  //   stops breathing between lines.
  assert(V('gate', 'vocal', 'rangeDb') <= 20,
    `a vocal gated by ${V('gate', 'vocal', 'rangeDb')} dB loses its breaths`);
  //   reverb is kept off the lyric by pre-delay rather than by being short
  assert(V('reverb', 'vocal', 'preDelayMs') > V('reverb', 'drumloop', 'preDelayMs')
    && V('reverb', 'vocal', 'preDelayMs') > V('reverb', 'agtr', 'preDelayMs'),
    'the vocal pre-delay is not what keeps the lyric clear');
});

check('the five sources added last say what their paragraphs say', () => {
  // 백킹 보컬 — everything that makes the LEAD clear, done the other way.
  for (const eq of ['eq3', 'eq8']) {
    assert(V(eq, 'backing', 'hpfHz') > V(eq, 'vocal', 'hpfHz'),
      `${eq}: 백킹 보컬 is not high-passed above the lead`);
  }
  assert(V('comp', 'backing', 'ratio') > V('comp', 'vocal', 'ratio'),
    'the backing stack is not compressed harder than the lead');
  assert(V('widener', 'backing', 'width') > V('widener', 'vocal', 'width'),
    'the lead is supposed to be the centre and the backing the sides');
  for (const id of INSTRUMENT_ORDER) {
    if (id === 'backing' || id === 'vocal') continue;
    assert(V('deesser', 'backing', 'amount') > V('deesser', id, 'amount'),
      `백킹 보컬 de-essing is not second only to the lead (${INSTRUMENT_LABEL[id]})`);
  }

  // 퍼커션 — nothing under 200 Hz, and the transient is the whole point.
  for (const eq of ['eq3', 'eq8']) {
    for (const id of INSTRUMENT_ORDER) {
      if (id === 'perc') continue;
      assert(V(eq, 'perc', 'hpfHz') >= V(eq, id, 'hpfHz'),
        `${eq}: 퍼커션 should have the highest high-pass, ${INSTRUMENT_LABEL[id]} is higher`);
    }
  }
  for (const id of INSTRUMENT_ORDER) {
    if (id === 'perc') continue;
    assert(V('transient', 'perc', 'attack') >= V('transient', id, 'attack'),
      `퍼커션 is not the strongest attack in the file (${INSTRUMENT_LABEL[id]})`);
  }
  assert(V('gate', 'perc', 'rangeDb') > V('gate', 'drumloop', 'rangeDb'),
    'an overdubbed percussion track has no bleed to protect — it should gate deeper than a loop');

  // 브라스 — restrained compression, and the 3 kHz sting taken out while the
  // top is given back.
  for (const hard of ['drumloop', 'bass'] as InstrumentId[]) {
    assert(V('comp', 'brass', 'ratio') < V('comp', hard, 'ratio'),
      `브라스 (${V('comp', 'brass', 'ratio')}:1) is compressed as hard as ${INSTRUMENT_LABEL[hard]}`);
  }
  assert(V('eq8', 'brass', 'b2Db') < 0 && V('eq8', 'brass', 'highDb') > 0,
    'the brass EQ is supposed to dip the sting and lift the shine');

  // 목관 — soft transients, so the slowest attack of the wind and string
  // sources, and a smaller room than the strings.
  assert(V('comp', 'winds', 'attackMs') > V('comp', 'brass', 'attackMs'),
    'woodwinds have softer transients than brass and should be slower to react');
  assert(V('reverb', 'winds', 'decaySec') < V('reverb', 'strings', 'decaySec'),
    'woodwinds that sit as far back as the violins disappear behind them');
  // Shallower than the sources that HAVE an attack to gate — the strings,
  // which the file already calls "mostly a mistake" to gate, stay the
  // shallowest of all and are not the comparison.
  for (const louder of ['brass', 'perc', 'drumloop'] as InstrumentId[]) {
    assert(V('gate', 'winds', 'rangeDb') < V('gate', louder, 'rangeDb'),
      `gating a flute as deep as ${INSTRUMENT_LABEL[louder]} loses the start of every phrase`);
  }

  // FX — the widest, the longest, the most saturated column in the file.
  for (const id of INSTRUMENT_ORDER) {
    if (id === 'fx') continue;
    assert(V('reverb', 'fx', 'decaySec') > V('reverb', id, 'decaySec'),
      `FX should be the longest reverb, ${INSTRUMENT_LABEL[id]} is longer`);
    assert(V('widener', 'fx', 'width') > V('widener', id, 'width'),
      `FX should be the widest, ${INSTRUMENT_LABEL[id]} is wider`);
    assert(V('saturation', 'fx', 'driveDb') > V('saturation', id, 'driveDb'),
      `FX should be the most saturated, ${INSTRUMENT_LABEL[id]} is more`);
  }
  assert(V('eq8', 'fx', 'hpfHz') >= 150 && V('monomaker', 'fx', 'freqHz') >= 220,
    'an FX that fights the kick is an FX that has to be turned down');
});

check('the gate is shallow on a loop and deep on a high-gain guitar', () => {
  const range = (id: InstrumentId) => V('gate', id, 'rangeDb');
  assert(range('egtr') > range('drumloop'),
    'a high-gain guitar needs a deeper gate than a loop, which is already glued together');
  assert(range('drumloop') <= 20, `a loop gated by ${range('drumloop')} dB loses its bleed`);
  assert(range('strings') <= 8, 'gating strings is mostly a mistake');
});

// ── The menu ────────────────────────────────────────────────────────────────

check('the chip row gets all thirteen, in the declared order', () => {
  for (const pluginId of devicesWithPresets) {
    const { instrument } = partitionInstrument(allPresetGroups(pluginId));
    assert(instrument.length === INSTRUMENT_ORDER.length,
      `${pluginId}: chip row has ${instrument.length} of ${INSTRUMENT_ORDER.length}`);
    instrument.forEach((p, i) => {
      assert(p.name === INSTRUMENT_LABEL[INSTRUMENT_ORDER[i]!],
        `${pluginId}: chip ${i} is ${p.name}`);
    });
  }
});

check('the dropdown does not list the same thirteen again', () => {
  for (const pluginId of devicesWithPresets) {
    const { rest } = partitionInstrument(allPresetGroups(pluginId));
    assert(!rest.some((g) => g.group === INSTRUMENT_GROUP),
      `${pluginId}: the instrument group is still in the dropdown`);
  }
});

check('the five devices without instrument presets get no chip row', () => {
  for (const id of Object.keys(NO_INSTRUMENT_PRESETS)) {
    const { instrument } = partitionInstrument(allPresetGroups(id));
    assert(instrument.length === 0, `${id} has a chip row it should not have`);
  }
});

console.log('\n=== Instrument presets — thirteen sources, every device ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
console.log(`${INSTRUMENT_PRESETS.length} presets across ${devicesWithPresets.length} devices`);
if (bad) process.exit(1);
