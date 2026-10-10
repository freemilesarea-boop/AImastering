/**
 * fm-selftest.ts — whether this is really FM, and not a waveshaper.
 *
 * The claim worth checking is not "it makes a sound".  It is that adding one
 * operator's output to another's PHASE produces sidebands at f_c ± n·f_m,
 * with amplitudes that follow Bessel functions of the index — because that,
 * and only that, is what lets six sine waves become a bell.  Anything that
 * merely gets brighter as a knob goes up would pass a loose test and be a
 * distortion pedal.
 *
 * So the checks here measure the SPECTRUM: where the partials land, that
 * inharmonic ratios give inharmonic partials, and that the fundamental dips
 * and returns as the index rises.  That last one is the signature — a
 * waveshaper cannot do it.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:fm
 */

import {
  FM_ALGORITHMS, FM_MOD_SCALE, FM_OPERATORS, FM_WAVES, algorithmAt, feedbackTap,
  fmEnv, fmSine, fmWave, keyScale, modulatorsOf,
} from '../src/renderer/daw/engine/fm-core.js';
import { fmTail, renderFmVoice } from '../src/renderer/daw/engine/fm-synth.js';
import { defaultInstrumentParams, findInstrument } from '../src/renderer/daw/engine/instruments.js';

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true }); } catch (err) {
    results.push({ name, pass: false, detail: (err as Error).message });
  }
}

const SR = 48000;
const BASE = defaultInstrumentParams('fm');

/** Goertzel: the amplitude of one frequency in a buffer. */
function tone(buf: Float32Array, hz: number, from: number, len: number): number {
  const n = Math.min(len, buf.length - from);
  const w = (2 * Math.PI * hz) / SR;
  const c = 2 * Math.cos(w);
  let s1 = 0; let s2 = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s0 = (buf[from + i] ?? 0) * win + c * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.hypot(s1 - s2 * Math.cos(w), s2 * Math.sin(w)) / n;
}

function render(over: Record<string, number>, seconds = 1.5, freq = 261.63, pitch = 60, vel = 0.8) {
  return renderFmVoice({
    sampleRate: SR, seconds, gateSec: seconds - 0.2, freqHz: freq, pitch, velocity: vel,
    params: { ...BASE, ...over }, beatsPerSec: 2,
  });
}

function mono(r: { left: Float32Array; right: Float32Array }): Float32Array {
  const out = new Float32Array(r.left.length);
  for (let i = 0; i < out.length; i++) out[i] = ((r.left[i] ?? 0) + (r.right[i] ?? 0)) / 2;
  return out;
}

/**
 * A patch with one carrier and one modulator and nothing else running.
 *
 * Algorithm 1 is the six-deep stack, so silencing operators 3 to 6 leaves
 * exactly op 2 modulating op 1 — the textbook two-operator case every
 * sideband claim below is about.
 */
function twoOp(modLevel: number, modRatio = 1): Record<string, number> {
  const o: Record<string, number> = {
    algo: 0, feedback: 0, unison: 1, spread: 0, width: 0, level: 0.7,
    lfoPitch: 0, lfoAmp: 0, pAmt: 0,
  };
  for (let i = 1; i <= FM_OPERATORS; i++) {
    o[`o${i}level`] = 0;
    o[`o${i}a`] = 0.001; o[`o${i}d`] = 8; o[`o${i}s`] = 1; o[`o${i}r`] = 0.05;
    o[`o${i}vel`] = 0; o[`o${i}key`] = 0; o[`o${i}ratio`] = 1;
    o[`o${i}fine`] = 0; o[`o${i}fixed`] = 0; o[`o${i}wave`] = 0;
  }
  o['o1level'] = 1;
  o['o2level'] = modLevel;
  o['o2ratio'] = modRatio;
  return o;
}

const FROM = Math.round(SR * 0.3);
const LEN = Math.round(SR * 0.9);
const dbAt = (buf: Float32Array, hz: number): number =>
  20 * Math.log10(Math.max(1e-12, tone(buf, hz, FROM, LEN)));

// ── The algorithms ──────────────────────────────────────────────────────────

check('every algorithm is well formed, and no two are the same', () => {
  assert(FM_ALGORITHMS.length === 32, `there are ${FM_ALGORITHMS.length} algorithms, not 32`);
  const seen = new Map<string, string>();
  for (const a of FM_ALGORITHMS) {
    assert(a.carriers.length > 0, `${a.name} has no carrier — it would be silent`);
    // The rule the render loop depends on.  Breaking it would not crash: the
    // operator would read the PREVIOUS sample's value and sound almost right.
    for (const [from, to] of a.mods) {
      assert(from > to,
        `${a.name} routes operator ${from + 1} into ${to + 1}, which the single downward pass cannot serve`);
    }
    // No operator may be dead: one that is neither a carrier nor a modulator
    // is a page of knobs that does nothing.
    const used = new Set<number>(a.carriers);
    for (const [from, to] of a.mods) { used.add(from); used.add(to); }
    for (let i = 0; i < FM_OPERATORS; i++) {
      assert(used.has(i), `${a.name} never uses operator ${i + 1}`);
    }
    const key = JSON.stringify([[...a.carriers].sort(), a.mods.map((m) => m.join('>')).sort()]);
    assert(!seen.has(key), `${a.name} is the same wiring as ${seen.get(key)}`);
    seen.set(key, a.name);
  }
  // And the list has to span the range it claims to: one carrier at the top,
  // six at the bottom.
  assert(FM_ALGORITHMS[0]!.carriers.length === 1, 'the first algorithm is not a single carrier');
  assert(FM_ALGORITHMS[31]!.carriers.length === FM_OPERATORS,
    'the last algorithm is not fully additive');
  assert(FM_ALGORITHMS[31]!.mods.length === 0, 'the additive algorithm still modulates something');
  assert(algorithmAt(-5) === FM_ALGORITHMS[0], 'the index is not clamped below');
  assert(algorithmAt(999) === FM_ALGORITHMS[31], 'the index is not clamped above');
});

check('the modulator index is built once and matches the connection list', () => {
  for (const a of FM_ALGORITHMS) {
    const byOp = modulatorsOf(a);
    let count = 0;
    for (const list of byOp) count += list.length;
    assert(count === a.mods.length, `${a.name} indexes ${count} connections for ${a.mods.length}`);
    for (const [from, to] of a.mods) {
      assert(byOp[to]?.includes(from), `${a.name} lost the connection ${from + 1} → ${to + 1}`);
    }
  }
});

// ── Is it FM? ───────────────────────────────────────────────────────────────

check('a silent modulator leaves a pure sine', () => {
  const m = mono(render(twoOp(0)));
  const f = dbAt(m, 261.63);
  for (const h of [2, 3, 4, 5]) {
    const partial = dbAt(m, 261.63 * h);
    assert(f - partial > 80,
      `with no modulation the ${h}th harmonic is only ${(f - partial).toFixed(1)} dB down — `
      + 'the carrier is not a clean sine');
  }
});

check('modulation puts sidebands where the ratio says, and nowhere else', () => {
  // An INHARMONIC ratio is the real test.  At 1:1 the sidebands land on the
  // harmonic series and a distortion would look the same; at 1:3.5 they land
  // at |f_c ± n·f_m|, which is a comb no waveshaper can produce.
  const fc = 261.63;
  const fm = fc * 3.5;
  const m = mono(render(twoOp(0.35, 3.5)));
  const carrier = dbAt(m, fc);
  for (const n of [1, 2]) {
    for (const sign of [1, -1]) {
      const hz = Math.abs(fc + sign * n * fm);
      const side = dbAt(m, hz);
      assert(carrier - side < 40,
        `the sideband at ${hz.toFixed(0)} Hz (f_c ${sign > 0 ? '+' : '−'} ${n}·f_m) `
        + `is ${(carrier - side).toFixed(1)} dB down — it should be there`);
    }
  }
  // And the second harmonic of the carrier, which is NOT a sideband of this
  // ratio, must stay far below them.
  const notASideband = dbAt(m, fc * 2);
  const realSideband = dbAt(m, fc + fm);
  assert(realSideband - notASideband > 12,
    `an inharmonic ratio put ${(realSideband - notASideband).toFixed(1)} dB between a real `
    + 'sideband and the carrier\'s second harmonic — the partials are landing on the harmonic '
    + 'series, which means this is distortion and not phase modulation');
});

check('the fundamental nulls exactly where the Bessel maths says', () => {
  // This is the check that says the phase is really being modulated, and it
  // is worth reading because the obvious version of it is WRONG.
  //
  // The textbook first null of the carrier is J₀(β) = 0 at β = 2.405.  That
  // is the null for a ratio whose lower sidebands stay above zero hertz.  At
  // a 1:1 ratio they do not: f_c − 2·f_m is −f_c, which folds back onto the
  // carrier with its sign flipped, so what is measured at the fundamental is
  //
  //     J₀(β) − J₂(β)  =  2·J₁′(β)
  //
  // whose first zero is at β = 1.8412.  Measured, sweeping the modulator's
  // level in steps of 0.002, the minimum lands at 1.84.  A distortion cannot
  // put a null anywhere, and a phase modulator that got its scaling wrong
  // would put it somewhere else.
  const BESSEL = 1.8412;
  const expected = BESSEL / (2 * Math.PI * FM_MOD_SCALE);
  let bestLevel = 0;
  let bestDb = 0;
  for (let lvl = 0.12; lvl <= 0.28; lvl += 0.002) {
    const db = dbAt(mono(render(twoOp(lvl), 0.9)), 261.63);
    if (bestLevel === 0 || db < bestDb) { bestLevel = lvl; bestDb = db; }
  }
  const beta = bestLevel * 2 * Math.PI * FM_MOD_SCALE;
  assert(Math.abs(beta - BESSEL) / BESSEL < 0.05,
    `the null is at index ${beta.toFixed(3)}; 2·J₁′ says ${BESSEL} `
    + `(level ${bestLevel.toFixed(3)} against an expected ${expected.toFixed(3)})`);

  // And it is a real null, with the fundamental coming back afterwards.
  const before = dbAt(mono(render(twoOp(0.05), 0.9)), 261.63);
  const after = dbAt(mono(render(twoOp(0.5), 0.9)), 261.63);
  assert(before - bestDb > 20,
    `the fundamental only fell ${(before - bestDb).toFixed(1)} dB into the null`);
  assert(after - bestDb > 15,
    `the fundamental only recovered ${(after - bestDb).toFixed(1)} dB past the null`);
});

check('the sine table is a sine', () => {
  // The table exists for speed and the algebra says its error is about −126 dB.
  // Algebra is not a measurement.
  let worst = 0;
  for (let i = 0; i < 200000; i++) {
    const ph = i * 0.00137 - 100;
    worst = Math.max(worst, Math.abs(fmSine(ph) - Math.sin(2 * Math.PI * (ph - Math.floor(ph)))));
  }
  assert(worst < 1e-5, `the sine table is off by ${worst.toExponential(2)} (${(20 * Math.log10(worst)).toFixed(0)} dB)`);
  // Negative and huge phases have to wrap, because modulation produces both.
  assert(Math.abs(fmSine(-0.25) - fmSine(0.75)) < 1e-12, 'a negative phase does not wrap');
  assert(Math.abs(fmSine(1000.5) - fmSine(0.5)) < 1e-9, 'a large phase does not wrap');
});

check('the eight operator waves are eight different waves', () => {
  const sample = (k: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < 256; i++) out.push(fmWave(k, i / 256, 7));
    return out;
  };
  for (let a = 0; a < FM_WAVES.length; a++) {
    const va = sample(a);
    let span = 0;
    for (const v of va) span = Math.max(span, Math.abs(v));
    assert(span > 0.3, `${FM_WAVES[a]} is nearly flat (${span.toFixed(3)})`);
    for (let b = a + 1; b < FM_WAVES.length; b++) {
      const vb = sample(b);
      let diff = 0;
      for (let i = 0; i < va.length; i++) diff = Math.max(diff, Math.abs((va[i] ?? 0) - (vb[i] ?? 0)));
      assert(diff > 0.05, `${FM_WAVES[a]} and ${FM_WAVES[b]} are the same wave`);
    }
  }
  // The noise wave is noise, and it is the SAME noise every time.
  const n1 = sample(7);
  const n2 = sample(7);
  for (let i = 0; i < n1.length; i++) {
    assert(n1[i] === n2[i], 'the noise wave is not deterministic — a bounce would not match a preview');
  }
});

// ── Brightness, not volume ──────────────────────────────────────────────────

/**
 * How much of the energy sits above the third harmonic.
 *
 * The brightness measure to reach for when two spectra are being COMPARED.
 * The centroid is not, and the reason is specific: an amplitude-weighted
 * centroid can go the wrong way when the fundamental lands in a Bessel null,
 * because losing energy at harmonic 1 moves the average up.  Measured on the
 * key-scaling check, the darker of two spectra had the HIGHER centroid —
 * 2.51 against 2.76 — while its energy above the third harmonic was fifteen
 * times smaller.
 */
function highEnergy(buf: Float32Array, from: number, len: number, f0: number, partials = 12): number {
  let low = 0;
  let high = 0;
  for (let h = 1; h <= partials; h++) {
    const hz = f0 * h;
    if (hz > SR / 2 - 100) break;
    const a = tone(buf, hz, from, len);
    if (h <= 3) low += a * a; else high += a * a;
  }
  return low > 0 ? high / low : 0;
}

/**
 * The spectral centroid, in Hz — where the energy sits.
 *
 * The window is explicit because the first version of this used the file's
 * shared `FROM`/`LEN` and was handed a slice shorter than `FROM`, so every
 * partial measured zero and every centroid came back as the fundamental.  A
 * helper with a hidden window is a helper that lies quietly.
 */
function centroid(buf: Float32Array, from: number, len: number, f0: number, partials = 32): number {
  let num = 0;
  let den = 0;
  for (let h = 1; h <= partials; h++) {
    const hz = f0 * h;
    if (hz > SR / 2 - 100) break;
    const a = tone(buf, hz, from, len);
    num += hz * a;
    den += a;
  }
  return den > 0 ? num / den : 0;
}

check('a modulator envelope moves the brightness, not the level', () => {
  // The whole argument for why this instrument has no filter.  A decaying
  // modulator makes the note get DARKER over its length while its fundamental
  // stays where it is — which is what a struck string does, and what a volume
  // envelope cannot imitate.
  const patch = { ...twoOp(0.4), o2d: 1, o2s: 0, o1d: 12, o1s: 1 };
  const m = mono(render(patch, 3));
  // A short head window and a late tail one, because the modulator decays
  // with a one-second time constant: a half-second window starting at the
  // attack is mostly the part where it has already gone, which is how the
  // first version of this measured 295 Hz against 262 and called it flat.
  const head = Math.round(SR * 0.02);
  const tail = Math.round(SR * 2.3);
  const span = Math.round(SR * 0.2);
  const cHead = centroid(m, head, span, 261.63);
  const cTail = centroid(m, tail, span, 261.63);
  assert(cHead > cTail * 2,
    `the centroid went ${cHead.toFixed(0)} Hz → ${cTail.toFixed(0)} Hz; a modulator decaying to `
    + 'nothing should darken the note far more than that');
  const fHead = 20 * Math.log10(Math.max(1e-12, tone(m, 261.63, head, span)));
  const fTail = 20 * Math.log10(Math.max(1e-12, tone(m, 261.63, tail, span)));
  assert(Math.abs(fHead - fTail) < 12,
    `the fundamental moved ${Math.abs(fHead - fTail).toFixed(1)} dB between head and tail — `
    + 'the modulator envelope is acting as a volume control');
});

check('velocity on a modulator is brightness; on a carrier it is level', () => {
  const patch = { ...twoOp(0.4), o2vel: 0.9, o1vel: 0 };
  const soft = mono(render(patch, 1.5, 261.63, 60, 0.25));
  const hard = mono(render(patch, 1.5, 261.63, 60, 1));
  const es = highEnergy(soft, FROM, LEN, 261.63);
  const eh = highEnergy(hard, FROM, LEN, 261.63);
  assert(eh > es * 3,
    `hitting it harder only moved the energy above the third harmonic ${es.toFixed(4)} → ${eh.toFixed(4)}`);
  const ls = 20 * Math.log10(Math.max(1e-12, tone(soft, 261.63, FROM, LEN)));
  const lh = 20 * Math.log10(Math.max(1e-12, tone(hard, 261.63, FROM, LEN)));
  assert(Math.abs(lh - ls) < 10,
    `velocity on a MODULATOR changed the fundamental by ${Math.abs(lh - ls).toFixed(1)} dB — it should barely move it`);

  // On a carrier it is the opposite.
  const cPatch = { ...twoOp(0.4), o1vel: 0.9, o2vel: 0 };
  const cSoft = mono(render(cPatch, 1.5, 261.63, 60, 0.25));
  const cHard = mono(render(cPatch, 1.5, 261.63, 60, 1));
  const cls = 20 * Math.log10(Math.max(1e-12, tone(cSoft, 261.63, FROM, LEN)));
  const clh = 20 * Math.log10(Math.max(1e-12, tone(cHard, 261.63, FROM, LEN)));
  assert(clh - cls > 6, `velocity on a CARRIER only changed the level ${(clh - cls).toFixed(1)} dB`);
});

check('key scaling takes the index down as the keyboard goes up', () => {
  assert(Math.abs(keyScale(60, -1) - 1) < 1e-12, 'key scaling is not neutral at middle C');
  assert(keyScale(84, -1) < keyScale(60, -1), 'a negative amount does not fall going up');
  assert(keyScale(36, -1) > keyScale(60, -1), 'a negative amount does not rise going down');
  assert(keyScale(84, 0) === 1, 'zero is not zero');
  // Two octaves up at −1 halves the level, which is the documented slope.
  assert(Math.abs(keyScale(84, -1) - 0.5) < 1e-9,
    `two octaves up at −1 gives ${keyScale(84, -1).toFixed(4)}, not 0.5`);
  // And it reaches the sound.  Compared at the SAME high note with the
  // scaling on and off, rather than at two different pitches — two pitches
  // differ for several reasons at once and the first version of this check
  // could not tell which one it was measuring.
  const flat = mono(render({ ...twoOp(0.4), o2key: 0 }, 1.5, 1046.5, 84));
  const scaled = mono(render({ ...twoOp(0.4), o2key: -1 }, 1.5, 1046.5, 84));
  const eFlat = highEnergy(flat, FROM, LEN, 1046.5);
  const eScaled = highEnergy(scaled, FROM, LEN, 1046.5);
  assert(eFlat > eScaled * 4,
    `key scaling barely changed the brightness of the same note `
    + `(${eFlat.toFixed(4)} vs ${eScaled.toFixed(4)} of the energy above the third harmonic)`);
});

// ── The pieces that are easy to get subtly wrong ────────────────────────────

check('feedback averages two samples, and that is what keeps it from buzzing', () => {
  assert(feedbackTap(1, -1) === 0, 'the tap does not null at Nyquist');
  assert(feedbackTap(0.5, 0.5) === 0.5, 'the tap changes a steady value');

  // The claim is comparative, so the check is comparative: the same
  // self-modulating loop run with the two-sample average and with the raw
  // last sample, and the difference measured at the top of the band.  A loop
  // that fed back one sample oscillates at exactly Nyquist, which is
  // inaudible as pitch and audible as a rasp on everything else.
  const hf = (average: boolean): number => {
    const n = 24000;
    const buf = new Float32Array(n);
    let ph = 0;
    let p1 = 0;
    let p2 = 0;
    const step = 261.63 / SR;
    for (let i = 0; i < n; i++) {
      const fb = (average ? feedbackTap(p1, p2) : p1) * 0.85;
      const v = fmSine(ph + fb);
      p2 = p1; p1 = v;
      ph += step;
      buf[i] = v;
    }
    const top = 20 * Math.log10(Math.max(1e-12, tone(buf, SR / 2 - 300, 4000, 16000)));
    const fund = 20 * Math.log10(Math.max(1e-12, tone(buf, 261.63, 4000, 16000)));
    return fund - top;
  };
  const averaged = hf(true);
  const raw = hf(false);
  assert(averaged - raw > 20,
    `averaging only bought ${(averaged - raw).toFixed(1)} dB at the top of the band `
    + `(${averaged.toFixed(1)} dB below the fundamental with it, ${raw.toFixed(1)} without)`);

  // And through the engine, feedback has to actually produce a harmonic
  // series rather than a louder sine.
  const m = mono(render({ ...twoOp(0), feedback: 0.7, fbOp: 1 }));
  const f = dbAt(m, 261.63);
  assert(f - dbAt(m, 523.26) < 24 && f - dbAt(m, 784.9) < 30,
    `feedback produced no harmonic series (2nd ${(f - dbAt(m, 523.26)).toFixed(1)} dB down, `
    + `3rd ${(f - dbAt(m, 784.9)).toFixed(1)})`);
});

check('a fixed operator ignores the note, and a ratio operator does not', () => {
  const patch = { ...twoOp(0.35), o2fixed: 1, o2hz: 1200 };
  const low = mono(render(patch, 1.5, 261.63, 60));
  const high = mono(render(patch, 1.5, 523.26, 72));
  // The sideband at |f_c − 1200| moves with the carrier but the SPACING is
  // 1200 Hz in both, which is the thing a fixed operator is for: a formant
  // or a metallic clang that does not transpose.
  assert(dbAt(low, 261.63 + 1200) - dbAt(low, 261.63) < 40, 'the fixed sideband is missing at C4');
  assert(dbAt(high, 523.26 + 1200) - dbAt(high, 523.26) < 40, 'the fixed sideband is missing at C5');
  // With the operator on a ratio instead, the spacing follows the note.
  const rat = { ...twoOp(0.35), o2ratio: 2 };
  const r1 = mono(render(rat, 1.5, 261.63, 60));
  assert(dbAt(r1, 261.63 * 3) - dbAt(r1, 261.63) < 40, 'a ratio-2 modulator produced no third harmonic');
});

check('the tail is the longest carrier release and not the longest release', () => {
  // Algorithm 1: op 1 is the only carrier, 2 to 6 are modulators.
  const base = { ...twoOp(0.4), o1r: 0.5, o2r: 9 };
  assert(Math.abs(fmTail(base) - 0.55) < 1e-9,
    `a 9-second modulator release stretched the tail to ${fmTail(base).toFixed(2)} s`);
  // Algorithm 32 is all carriers, so there the longest release IS the tail.
  const additive: Record<string, number> = { ...base, algo: 31 };
  assert(fmTail(additive) > 8, `with six carriers the tail is only ${fmTail(additive).toFixed(2)} s`);
});

check('an operator at level zero cannot be heard, whatever else is set on it', () => {
  // The render loop skips operators at level 0 as an optimisation, and the
  // claim that makes it safe is that such an operator contributes nothing —
  // not as a carrier and not as a modulator.  So changing everything else
  // about it must change nothing at all.
  const quiet = { ...twoOp(0.4), o3level: 0 };
  const a = render(quiet);
  const b = render({ ...quiet, o3ratio: 7.31, o3wave: 5, o3d: 0.01, o3a: 2 });
  for (let i = 0; i < a.left.length; i += 97) {
    assert(a.left[i] === b.left[i],
      `a silent operator changed the output at sample ${i} (${a.left[i]} vs ${b.left[i]})`);
  }
});

check('the same note twice is the same samples', () => {
  const a = render({});
  const b = render({});
  for (let i = 0; i < a.left.length; i += 53) {
    assert(a.left[i] === b.left[i] && a.right[i] === b.right[i],
      `two renders differ at sample ${i} — a bounce would not match its preview`);
  }
});

check('unison is not a volume knob, and spread needs carriers to spread', () => {
  const rms = (r: { left: Float32Array; right: Float32Array }): number => {
    let s = 0;
    const from = FROM;
    for (let i = from; i < from + LEN; i++) s += ((r.left[i] ?? 0) ** 2 + (r.right[i] ?? 0) ** 2) / 2;
    return Math.sqrt(s / LEN);
  };
  const one = rms(render({ unison: 1 }));
  const three = rms(render({ unison: 3, detune: 14 }));
  const db = 20 * Math.log10(three / one);
  assert(Math.abs(db) < 4, `three voices came out ${db.toFixed(1)} dB from one — unison is a level control`);

  // Spread pans the CARRIERS, so a one-carrier algorithm has nothing to
  // spread and must stay mono however far the knob goes.
  const solo = render({ algo: 0, unison: 1, width: 0, spread: 1 });
  let diff = 0;
  for (let i = 0; i < solo.left.length; i += 11) {
    diff = Math.max(diff, Math.abs((solo.left[i] ?? 0) - (solo.right[i] ?? 0)));
  }
  assert(diff < 1e-6, `a single-carrier patch came out stereo (max L−R ${diff.toExponential(2)})`);

  const many = render({ algo: 12, unison: 1, width: 0, spread: 1 });
  let wide = 0;
  for (let i = 0; i < many.left.length; i += 11) {
    wide = Math.max(wide, Math.abs((many.left[i] ?? 0) - (many.right[i] ?? 0)));
  }
  assert(wide > 0.01, `a three-carrier patch at full spread is still mono (max L−R ${wide.toExponential(2)})`);
});

check('every algorithm makes a finite sound, even with the feedback all the way up', () => {
  for (let a = 0; a < FM_ALGORITHMS.length; a++) {
    for (const fb of [0, 1]) {
      const r = render({ algo: a, feedback: fb, fbOp: 6 }, 0.5);
      let peak = 0;
      for (let i = 0; i < r.left.length; i += 7) {
        const v = r.left[i] ?? 0;
        assert(Number.isFinite(v), `${FM_ALGORITHMS[a]!.name} at feedback ${fb} produced ${v}`);
        peak = Math.max(peak, Math.abs(v));
      }
      assert(peak > 1e-5, `${FM_ALGORITHMS[a]!.name} at feedback ${fb} is silent`);
      assert(peak < 4, `${FM_ALGORITHMS[a]!.name} at feedback ${fb} peaks at ${peak.toFixed(2)}`);
    }
  }
});

check('the envelope is exponential, ends at zero, and survives a zero-length stage', () => {
  // A 63% rise in one time constant is what makes it exponential rather than
  // a straight line with a curve drawn on it.
  const a = 0.4;
  const one = fmEnv(a / 4.6, 10, a, 1, 1, 0.1);
  assert(Math.abs(one - 0.632) < 0.01, `one time constant reached ${one.toFixed(3)}, not 0.632`);
  assert(fmEnv(-1, 1, 0.1, 0.1, 0.5, 0.1) === 0, 'the envelope is alive before the note');
  assert(fmEnv(2.001, 1, 0.01, 0.1, 0.5, 1) === 0, 'the release does not reach zero');
  for (const v of [fmEnv(0.5, 1, 0, 0, 0.4, 0), fmEnv(1.5, 1, 0, 0, 0.4, 0)]) {
    assert(Number.isFinite(v), 'a zero-length stage produced a non-finite value');
  }
  // Sustain is held, exactly.
  assert(Math.abs(fmEnv(0.9, 1, 0.01, 0.05, 0.42, 0.1) - 0.42) < 0.001, 'the sustain is not the sustain');
});

check('the instrument is registered, and its defaults are a patch rather than a sine', () => {
  const inst = findInstrument('fm');
  assert(inst, 'there is no fm instrument');
  assert(inst.params.length > 80, `the FM synth only has ${inst.params.length} parameters`);
  // Twelve per operator, and every one of them reachable by id.
  for (let i = 1; i <= FM_OPERATORS; i++) {
    for (const k of ['ratio', 'fine', 'fixed', 'hz', 'wave', 'level', 'a', 'd', 's', 'r', 'vel', 'key']) {
      assert(inst.params.some((d) => d.id === `o${i}${k}`), `operator ${i} has no ${k}`);
    }
  }
  // The default patch has to be an instrument, not a test tone: more than one
  // operator running, and a spectrum with something in it.
  let live = 0;
  for (let i = 1; i <= FM_OPERATORS; i++) if ((BASE[`o${i}level`] ?? 0) > 0) live++;
  assert(live >= 4, `the default patch only runs ${live} operators`);
  // And it has to be an instrument rather than a test tone.  The default is
  // a tine electric piano: a modulator at ratio 14 on the first carrier, so
  // the energy is at the fundamental AND in a pair of partials up around the
  // thirteenth and fifteenth harmonic — which is what a tine ping is, and is
  // the reason checking the third harmonic here would be checking the wrong
  // place entirely.  Measured: h13 and h15 at −6.5 dB, h3 at −24.
  const m = mono(render({}, 2.5));
  const head = Math.round(SR * 0.05);
  const span = Math.round(SR * 0.45);
  const at = (h: number): number =>
    20 * Math.log10(Math.max(1e-12, tone(m, 261.63 * h, head, span)));
  const f = at(1);
  const ping = Math.max(at(13), at(15));
  assert(f - ping < 20,
    `the default patch's tine partials are ${(f - ping).toFixed(1)} dB down — it is a sine`);
  const cHead = centroid(m, head, span, 261.63);
  const cTail = centroid(m, Math.round(SR * 1.4), Math.round(SR * 0.6), 261.63);
  assert(cHead > cTail * 3,
    `the default patch does not darken as it decays (${cHead.toFixed(0)} → ${cTail.toFixed(0)} Hz)`);
});

console.log('');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
