// adaptive-defaults-selftest — the per-song settings react to the song.
//
// A feature that claims to analyse your track and tailor the settings is
// exactly the kind that can ship doing nothing: the analysis runs, numbers
// appear, and the same table gets applied regardless. The only way to know
// is to feed it materially different songs and check the settings actually
// diverge — in the right direction, by a sensible amount, and staying inside
// the ranges the UI can display.
//
// Each case is built to isolate one measurement, so a failure names the rule
// that broke rather than "something moved".
//
// Run:  pnpm --filter @aimaster/desktop test:adaptive

import {
  ALL_MODULE_PARAMETER_DEFS,
  MODULE_IDS,
  type ModuleId,
} from '../src/renderer/audio/parameters/index.js';
import {
  adaptRecommended,
  type SongProfile,
} from '../src/renderer/audio/presets/adaptive-defaults.js';
import { RECOMMENDED } from '../src/renderer/audio/presets/recommended-defaults.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

/** A neutral, unremarkable song. Every case is this with one thing changed. */
function baseProfile(): SongProfile {
  return {
    durationSec: 200,
    integratedLufs: -16,
    truePeakDbtp: -1.2,
    crestDb: 11,
    curveDb: Array.from({ length: 32 }, () => -60),
    tiltDbPerOct: -1.5,
    subVsLowDb: -12,
    harshDb: 0,
    airDb: -8,
    sibilanceDb: -11,
    topCutoffHz: null,
    quietHfFloorDbfs: -84,
    widthPct: 40,
    lowCorrelation: 0.95,
  };
}

function num(id: ModuleId, key: string, p: SongProfile): number {
  const v = adaptRecommended(p).entries[id].parameters[key];
  return typeof v === 'number' ? v : NaN;
}

console.log('\n=== WITHOUT A PROFILE, NOTHING CHANGES ===\n');

{
  const r = adaptRecommended(null);
  let same = true;
  for (const id of MODULE_IDS) {
    if (JSON.stringify(r.entries[id]) !== JSON.stringify({
      ...RECOMMENDED[id], parameters: { ...RECOMMENDED[id].parameters },
    })) same = false;
  }
  check(
    'no analysis means the common recommendation, untouched',
    same && r.notes.length === 0,
    'a failed or pending analysis must not silently produce different settings',
  );
}

console.log('\n=== THE NOISE FLOOR SETS THE GATE — THE MEASUREMENT THAT CANNOT BE GUESSED ===\n');

{
  const noisy = { ...baseProfile(), quietHfFloorDbfs: -70 };
  const clean = { ...baseProfile(), quietHfFloorDbfs: -88 };
  const a = num('hiss-gate', 'thresholdDb', noisy);
  const b = num('hiss-gate', 'thresholdDb', clean);
  check(
    'a noisier floor raises the gate threshold to meet it',
    a > b + 10,
    `floor -70 → ${a} dBFS, floor -88 → ${b} dBFS`,
  );
  check(
    'and the threshold sits just above the measured floor, not on it',
    a > -70 && a < -70 + 12,
    `${a} dBFS against a -70 dBFS floor — close enough to catch it, clear of the music`,
  );
}

{
  // A genuinely clean source should not run the module at all: it would
  // cost the spectral stage's latency to remove nothing.
  const pristine = { ...baseProfile(), quietHfFloorDbfs: -104 };
  const r = adaptRecommended(pristine);
  check(
    'a pristine source switches the gate off rather than running it idle',
    r.entries['hiss-gate'].bypass === true,
    'no noise to remove, so no latency spent looking for it',
  );
}

console.log('\n=== A HARD TOP CUTOFF IS THE AI SIGNATURE ===\n');

{
  const capped = { ...baseProfile(), topCutoffHz: 11_000 };
  const r = adaptRecommended(capped);
  const cross = r.entries['top-rebuild'].parameters.crossoverHz;
  const source = r.entries['top-rebuild'].parameters.sourceHz;
  check(
    'the rebuild crossover lands on the measured cutoff',
    cross === 11_000,
    `${String(cross)} Hz — a stock 9 kHz would rebuild a kilohertz of real audio`,
  );
  check(
    'and the source sits at half of it, so doubling lands exactly there',
    source === 5_500,
    `${String(source)} Hz × 2 = ${String(cross)} Hz`,
  );
}

{
  const dead = { ...baseProfile(), airDb: -24 };
  const bright = { ...baseProfile(), airDb: -2 };
  const a = num('top-rebuild', 'amountPct', dead);
  const b = num('top-rebuild', 'amountPct', bright);
  check(
    'a collapsed top gets more rebuild than an already-bright one',
    a > b + 20,
    `air -24 dB → ${a}%, air -2 dB → ${b}%`,
  );
}

console.log('\n=== TONE FOLLOWS THE SPECTRUM ===\n');

{
  const harsh = { ...baseProfile(), harshDb: 6 };
  const dull = { ...baseProfile(), harshDb: -6 };
  const a = num('eq', 'presenceDb', harsh);
  const b = num('eq', 'presenceDb', dull);
  check(
    'a harsh record gets a cut and a dull one gets a lift',
    a < 0 && b > 0,
    `2-4 kHz +6 dB → ${a} dB, 2-4 kHz -6 dB → +${b} dB`,
  );
}

{
  const dark = { ...baseProfile(), airDb: -20 };
  const bright = { ...baseProfile(), airDb: -2 };
  const a = num('eq', 'airDb', dark);
  const b = num('eq', 'airDb', bright);
  check(
    'a dark record gets more air than a bright one',
    a > b,
    `air -20 dB → +${a} dB, air -2 dB → +${b} dB`,
  );
}

{
  const sub = { ...baseProfile(), subVsLowDb: -2 };
  const thin = { ...baseProfile(), subVsLowDb: -24 };
  const a = num('eq', 'lowCutHz', sub);
  const b = num('eq', 'lowCutHz', thin);
  check(
    'a track with real sub keeps it; one with only rumble loses it',
    a < b,
    `sub present → cut at ${a} Hz, no sub → cut at ${b} Hz`,
  );
}

{
  const sibilant = { ...baseProfile(), sibilanceDb: -3 };
  const smooth = { ...baseProfile(), sibilanceDb: -20 };
  const a = num('deess', 'rangeDb', sibilant);
  const b = num('deess', 'rangeDb', smooth);
  check(
    'de-essing follows measured sibilance',
    a > b + 2,
    `-3 dB → ${a} dB of range, -20 dB → ${b} dB`,
  );
}

console.log('\n=== COMPRESSOR THRESHOLDS FOLLOW THE MEASURED LEVEL ===\n');

{
  // The structural fix. A threshold in dBFS is a guess until the programme
  // level is known, which is exactly why the stock multiband starting point
  // does nothing to a quiet mix.
  const quiet = { ...baseProfile(), integratedLufs: -24 };
  const loud = { ...baseProfile(), integratedLufs: -8 };
  const a = num('dynamics', 'thresholdDb', quiet);
  const b = num('dynamics', 'thresholdDb', loud);
  check(
    'the glue threshold tracks the programme level',
    b > a + 12,
    `-24 LUFS → ${a} dB, -8 LUFS → ${b} dB`,
  );
  const ma = num('multiband', 'band0ThresholdDb', quiet);
  const mb = num('multiband', 'band0ThresholdDb', loud);
  check(
    'and so does every multiband band',
    mb > ma + 12,
    `-24 LUFS → ${ma} dB, -8 LUFS → ${mb} dB`,
  );
}

{
  const squashed = { ...baseProfile(), crestDb: 6 };
  const dynamic = { ...baseProfile(), crestDb: 16 };
  const a = num('dynamics', 'ratio', squashed);
  const b = num('dynamics', 'ratio', dynamic);
  check(
    'an already-squashed source gets a gentler ratio',
    a < b,
    `crest 6 dB → ${a}:1, crest 16 dB → ${b}:1`,
  );
  const ia = num('impact', 'band2Pct', squashed);
  const ib = num('impact', 'band2Pct', dynamic);
  check(
    'and more transient restoration, since that is what it lost',
    ia > ib + 5,
    `crest 6 dB → +${ia}%, crest 16 dB → +${ib}%`,
  );
}

console.log('\n=== THE IMAGE IS MEASURED, NOT ASSUMED ===\n');

{
  const wide = { ...baseProfile(), widthPct: 90 };
  const narrow = { ...baseProfile(), widthPct: 8 };
  const a = num('imager', 'widthPct', wide);
  const b = num('imager', 'widthPct', narrow);
  check(
    'an already-wide record is not widened further',
    a <= 100 && b > 100,
    `side 90% → ${a}%, side 8% → ${b}%`,
  );
}

{
  const outOfPhase = { ...baseProfile(), lowCorrelation: 0.1 };
  const solid = { ...baseProfile(), lowCorrelation: 0.98 };
  const a = num('imager', 'lowMonoHz', outOfPhase);
  const b = num('imager', 'lowMonoHz', solid);
  check(
    'bass that would cancel in mono is summed higher up',
    a > b,
    `correlation 0.10 → mono below ${a} Hz, correlation 0.98 → ${b} Hz`,
  );
}

console.log('\n=== EVERY ADAPTED VALUE IS STILL LEGAL AND EXPLAINED ===\n');

{
  // The whole surface, swept: any rule producing a value outside its own
  // slider's range gives the user a setting the UI cannot show and they
  // cannot return to.
  const cases: SongProfile[] = [];
  for (const lufs of [-40, -24, -16, -8, -3]) {
    for (const crest of [4, 8, 12, 20]) {
      for (const air of [-30, -8, 0]) {
        for (const harsh of [-10, 0, 10]) {
          for (const floor of [-110, -84, -60]) {
            cases.push({
              ...baseProfile(), integratedLufs: lufs, crestDb: crest,
              airDb: air, harshDb: harsh, quietHfFloorDbfs: floor,
              sibilanceDb: harsh - 8, subVsLowDb: air,
              tiltDbPerOct: air / 6, widthPct: crest * 6,
              lowCorrelation: crest / 20 - 0.2,
              topCutoffHz: air < -20 ? 9_500 : null,
            });
          }
        }
      }
    }
  }
  const bad: string[] = [];
  for (const p of cases) {
    const r = adaptRecommended(p);
    for (const id of MODULE_IDS) {
      for (const def of ALL_MODULE_PARAMETER_DEFS[id].parameters) {
        const v = r.entries[id].parameters[def.id];
        if (v === undefined) continue;
        if (def.kind === 'number') {
          if (typeof v !== 'number' || !Number.isFinite(v) || v < def.min || v > def.max) {
            bad.push(`${id}.${def.id}=${String(v)} outside [${def.min}..${def.max}]`);
          }
        } else if (def.kind === 'enum') {
          if (typeof v !== 'string' || !def.values.includes(v)) {
            bad.push(`${id}.${def.id}=${String(v)}`);
          }
        }
      }
    }
  }
  check(
    'every value stays inside its own range across the whole sweep',
    bad.length === 0,
    bad.length === 0 ? `${cases.length} synthetic songs checked` : [...new Set(bad)].slice(0, 4).join(' · '),
  );
}

{
  const r = adaptRecommended({ ...baseProfile(), harshDb: 8, integratedLufs: -22 });
  const thin = r.notes.filter((n) => n.measured.length < 8 || n.action.length < 8);
  check(
    'every adjustment says what was measured and what it changed',
    r.notes.length > 3 && thin.length === 0,
    `${r.notes.length} notes, all substantive`,
  );
  check(
    'and the summary carries the numbers rather than a verdict',
    /LUFS/.test(r.summary) && /dBFS/.test(r.summary),
    r.summary,
  );
}

{
  // Hostile input: a profile full of nonsense must not produce nonsense
  // settings. Analysis can fail in ways nobody predicted.
  const nasty: SongProfile = {
    durationSec: 0, integratedLufs: NaN, truePeakDbtp: Infinity, crestDb: -Infinity,
    curveDb: [], tiltDbPerOct: NaN, subVsLowDb: 1e9, harshDb: -1e9, airDb: NaN,
    sibilanceDb: Infinity, topCutoffHz: -5, quietHfFloorDbfs: NaN,
    widthPct: 1e9, lowCorrelation: NaN,
  };
  const r = adaptRecommended(nasty);
  const bad: string[] = [];
  for (const id of MODULE_IDS) {
    for (const def of ALL_MODULE_PARAMETER_DEFS[id].parameters) {
      const v = r.entries[id].parameters[def.id];
      if (def.kind === 'number' && v !== undefined) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < def.min || v > def.max) {
          bad.push(`${id}.${def.id}=${String(v)}`);
        }
      }
    }
  }
  check(
    'a nonsense profile still produces legal settings',
    bad.length === 0,
    bad.length === 0 ? 'all clamped' : bad.slice(0, 4).join(' · '),
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
