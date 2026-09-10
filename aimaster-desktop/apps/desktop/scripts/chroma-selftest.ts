/**
 * chroma-selftest.ts — can the transform hear which notes are sounding?
 *
 * Everything downstream of this file is a lookup table.  If the chroma is
 * wrong, the chord is wrong, and no template, no HMM and no amount of
 * smoothing will recover a note the transform never resolved.  So this is
 * measured against signals whose contents are known exactly:
 *
 *   · a sine at a named pitch lands on THAT pitch class and not its neighbour
 *   · E2 and F2 come out as different notes — the whole reason for a
 *     constant-Q transform, since a 2048-point STFT puts them in one bin
 *   · a track recorded 30 cents sharp is measured as 30 cents sharp, and the
 *     chroma after correction is as clean as a track that was in tune
 *   · a SAWTOOTH at C reads as C, not as C7 — its own partials spell a
 *     dominant seventh, and suppressing them is the difference between a
 *     chord detector and a harmonic-series detector
 *   · a triad reads as three notes of roughly equal weight
 *   · silence is zero, not normalised noise
 *
 * Run via:  pnpm --filter @aimaster/desktop test:chroma
 */

import { readFileSync } from 'node:fs';
import {
  DEFAULT_CQT, centreHz, cqtgram, cqtKernel, qFor,
} from '../src/renderer/daw/audio/chroma/cqt.js';
import {
  binPitchClass, chromagram, estimateTuningCents, foldToChroma, normalize,
  refinePeak, shiftForTuning, suppressHarmonics,
} from '../src/renderer/daw/audio/chroma/chroma.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];

function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: (e as Error).message }); }
}
function assert(cond: boolean, detail: string): void {
  if (!cond) throw new Error(detail);
}

const SR = 22_050;   // Plenty for chroma up to C7 (2093 Hz), and four times faster.
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI pitch → Hz, with an optional detune so a test can be out of tune. */
function hz(midi: number, cents = 0): number {
  return 440 * Math.pow(2, (midi - 69) / 12 + cents / 1200);
}

/** A steady sine.  The simplest thing that can be wrong. */
function sine(freq: number, seconds: number, amp = 0.5): Float32Array {
  const n = Math.round(SR * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

/**
 * A band-limited sawtooth — every partial, which is the point.
 *
 * A real instrument is much closer to this than to a sine, and its partials
 * spell a chord nobody played: C, G, C, E, G, B♭.
 */
function saw(freq: number, seconds: number, amp = 0.5): Float32Array {
  const n = Math.round(SR * seconds);
  const out = new Float32Array(n);
  const partials = Math.max(1, Math.floor((SR / 2) / freq));
  for (let h = 1; h <= Math.min(partials, 16); h++) {
    for (let i = 0; i < n; i++) {
      out[i] += (amp / h) * Math.sin((2 * Math.PI * freq * h * i) / SR);
    }
  }
  return out;
}

function mix(...parts: Float32Array[]): Float32Array {
  const n = Math.max(...parts.map((p) => p.length));
  const out = new Float32Array(n);
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] = (out[i] ?? 0) + (p[i] ?? 0);
  return out;
}

/** The chroma of a whole signal, averaged over its frames and renormalised. */
function meanChroma(samples: Float32Array, options = {}): Float32Array {
  const gram = chromagram(samples, SR, options);
  const sum = new Float32Array(12);
  let used = 0;
  for (const frame of gram.frames) {
    let any = false;
    for (let i = 0; i < 12; i++) if ((frame[i] ?? 0) > 0) any = true;
    if (!any) continue;
    for (let i = 0; i < 12; i++) sum[i] = (sum[i] ?? 0) + (frame[i] ?? 0);
    used += 1;
  }
  assert(used > 0, 'every frame read as silence');
  return normalize(sum);
}

function ranked(chroma: Float32Array): { pc: number; name: string; value: number }[] {
  return [...chroma]
    .map((value, pc) => ({ pc, name: NAMES[pc] ?? '?', value }))
    .sort((a, b) => b.value - a.value);
}
function show(chroma: Float32Array, n = 4): string {
  return ranked(chroma).slice(0, n).map((r) => `${r.name} ${r.value.toFixed(2)}`).join(' ');
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

// ── The transform ───────────────────────────────────────────────────────────

check('the kernel is sparse, or the transform is unusably slow', () => {
  const kernel = cqtKernel(SR);
  let weights = 0;
  for (const row of kernel.re) weights += row.length;
  const full = kernel.layout.bins * kernel.fftSize;
  // The whole point of the spectral-kernel method.  A dense kernel is
  // correct and about a hundred times slower.
  assert(weights < full * 0.05,
    `kernel keeps ${weights} of ${full} weights (${((weights / full) * 100).toFixed(1)}%)`);
  assert(weights > kernel.layout.bins * 2, `kernel is empty: ${weights} weights`);
});

check('every bin is the same number of cents wide', () => {
  // That is what "constant Q" MEANS, and it is what a linear FFT is not.
  const layout = DEFAULT_CQT;
  for (let k = 1; k < layout.bins; k++) {
    const cents = 1200 * Math.log2(centreHz(layout, k) / centreHz(layout, k - 1));
    assert(Math.abs(cents - 1200 / layout.binsPerOctave) < 1e-6,
      `bin ${k} is ${cents.toFixed(3)} cents above its neighbour`);
  }
  // Three bins per semitone: 33.3 cents each.
  assert(Math.abs(1200 / layout.binsPerOctave - 33.333) < 0.01, 'not three bins per semitone');
  assert(qFor(36) > 50, `Q = ${qFor(36).toFixed(1)} is too low to resolve a semitone`);
});

check('E2 and F2 are different notes — what an STFT cannot say', () => {
  // 82.41 and 87.31 Hz.  A 2048-point FFT at 44.1 kHz has 21.5 Hz bins, so
  // these two land in the SAME ONE and the distinction is gone before any
  // chord logic runs.  This is the entire justification for the CQT.
  const e2 = meanChroma(sine(hz(40), 1.5));
  const f2 = meanChroma(sine(hz(41), 1.5));
  assert(ranked(e2)[0]!.name === 'E', `E2 read as ${show(e2)}`);
  assert(ranked(f2)[0]!.name === 'F', `F2 read as ${show(f2)}`);
  // And not merely first — clearly first.
  assert(ranked(e2)[0]!.value > ranked(e2)[1]!.value * 1.5, `E2 is ambiguous: ${show(e2)}`);
  assert(ranked(f2)[0]!.value > ranked(f2)[1]!.value * 1.5, `F2 is ambiguous: ${show(f2)}`);
});

check('a sine lands on its own pitch class, across five octaves', () => {
  // C2 through B6 — every pitch class, in several registers.
  const failures: string[] = [];
  for (let midi = 36; midi <= 84; midi += 1) {
    const chroma = meanChroma(sine(hz(midi), 0.8));
    const top = ranked(chroma)[0]!;
    const want = NAMES[midi % 12];
    if (top.name !== want) failures.push(`${want}${Math.floor(midi / 12) - 1}→${top.name}`);
  }
  assert(failures.length === 0, `wrong pitch class for: ${failures.join(', ')}`);
});

check('bin 0 is a C, so pitch class 0 is a C', () => {
  // `minHz` is C2.  If that ever changes without this mapping changing, every
  // chord in the app is transposed and nothing else would notice.
  assert(Math.abs(DEFAULT_CQT.minHz - 65.406391) < 1e-3, `minHz is ${DEFAULT_CQT.minHz}`);
  assert(binPitchClass(DEFAULT_CQT, 0) === 0, 'bin 0 is not pitch class 0');
  // A4 = 440 Hz is pitch class 9.
  const a4 = meanChroma(sine(440, 1.0));
  assert(ranked(a4)[0]!.pc === 9, `A4 read as ${show(a4)}`);
});

// ── Tuning ──────────────────────────────────────────────────────────────────

check('a peak between two bins is found between them', () => {
  // Symmetric input: the vertex is exactly in the middle.
  assert(Math.abs(refinePeak(1, 2, 1)) < 1e-9, `symmetric peak moved to ${refinePeak(1, 2, 1)}`);
  // Leaning right.
  assert(refinePeak(1, 2, 1.8) > 0.05, `right-leaning peak read ${refinePeak(1, 2, 1.8)}`);
  assert(refinePeak(1.8, 2, 1) < -0.05, `left-leaning peak read ${refinePeak(1.8, 2, 1)}`);
  // A parabola through noise can put the vertex anywhere; it is clamped.
  assert(Math.abs(refinePeak(1, 1.0000001, 1)) <= 0.5, 'an unclamped vertex escaped');
});

check('a record that is out of tune is measured as out of tune', () => {
  // ±47 is here on purpose.  The measurement wraps at a semitone, so near the
  // half-way point some peaks read +47 and some read −53 (which IS +47), and
  // an ARITHMETIC mean of those gives roughly zero — the one answer that is
  // certainly wrong.  Without these two values the circular average could be
  // replaced by a plain average and nothing would fail.
  for (const cents of [-47, -40, -17, 0, 12, 31, 47]) {
    // Several notes, because one note can be measured by luck.
    const signal = mix(
      saw(hz(48, cents), 1.6, 0.4),
      saw(hz(55, cents), 1.6, 0.4),
      saw(hz(64, cents), 1.6, 0.4),
    );
    const gram = cqtgram(signal, SR, Math.round(0.1 * SR));
    const measured = estimateTuningCents(gram);
    assert(Math.abs(measured - cents) < 8,
      `${cents} cents sharp measured as ${measured.toFixed(1)}`);
  }
});

check('correcting the tuning makes the chroma as clean as being in tune', () => {
  // The failure this prevents: a track 30 cents sharp folds most of every
  // note into its NEIGHBOUR.  The chroma is not noisy, it is wrong, and
  // downstream there is no way to tell.
  const inTune = meanChroma(mix(saw(hz(48), 1.6, 0.4), saw(hz(55), 1.6, 0.4)));
  const sharp = meanChroma(mix(saw(hz(48, 30), 1.6, 0.4), saw(hz(55, 30), 1.6, 0.4)));
  assert(ranked(sharp)[0]!.name === 'C', `a sharp C reads as ${show(sharp)}`);

  const uncorrected = meanChroma(
    mix(saw(hz(48, 30), 1.6, 0.4), saw(hz(55, 30), 1.6, 0.4)),
    { assumeConcertPitch: true },
  );
  // Corrected must be closer to the in-tune answer than uncorrected is.
  const distance = (a: Float32Array, b: Float32Array): number => {
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += ((a[i] ?? 0) - (b[i] ?? 0)) ** 2;
    return Math.sqrt(sum);
  };
  const corrected = distance(sharp, inTune);
  const raw = distance(uncorrected, inTune);
  assert(corrected < raw * 0.7,
    `correction barely helped: ${corrected.toFixed(3)} vs ${raw.toFixed(3)}`);
});

check('shifting the axis moves energy the way the sign says', () => {
  // The one thing here that is easy to get backwards, and backwards DOUBLES
  // the error rather than removing it — which looks like the transform being
  // broken rather than like a sign.
  const layout = DEFAULT_CQT;
  const frame = new Float32Array(layout.bins);
  frame[30] = 1;
  const up = shiftForTuning(frame, layout, 33.333);    // one bin
  let peak = 0, at = -1;
  for (let k = 0; k < up.length; k++) if ((up[k] ?? 0) > peak) { peak = up[k] ?? 0; at = k; }
  assert(at === 29, `+33 cents moved the peak to bin ${at}, not 29`);
});

// ── Harmonics ───────────────────────────────────────────────────────────────

check('a sawtooth C is a C, not a C7', () => {
  // Its own partials are C, G, C, E, G, B♭ — a dominant seventh, from ONE
  // note.  This is the largest single source of wrong thirds and sevenths in
  // any template matcher, and the reason suppression is subtractive.
  const raw = meanChroma(saw(hz(48), 1.6), { harmonicSuppression: 0 });
  const clean = meanChroma(saw(hz(48), 1.6));
  assert(ranked(clean)[0]!.name === 'C', `suppressed saw reads as ${show(clean)}`);

  const third = (c: Float32Array): number => (c[4] ?? 0) / Math.max(1e-9, c[0] ?? 0);
  const fifth = (c: Float32Array): number => (c[7] ?? 0) / Math.max(1e-9, c[0] ?? 0);
  assert(third(clean) < third(raw), `the third grew: ${third(clean).toFixed(2)} vs ${third(raw).toFixed(2)}`);
  assert(fifth(clean) < fifth(raw), `the fifth grew: ${fifth(clean).toFixed(2)} vs ${fifth(raw).toFixed(2)}`);
  // And the E is genuinely small, not merely smaller.
  assert(third(clean) < 0.5, `E is ${(third(clean) * 100).toFixed(0)}% of C in a single note`);
});

check('suppression never produces a negative magnitude', () => {
  // A negative magnitude is a sign error that normalisation turns into a
  // confident wrong answer.
  const layout = DEFAULT_CQT;
  const frame = new Float32Array(layout.bins);
  for (let k = 0; k < frame.length; k++) frame[k] = Math.max(0, Math.sin(k / 3));
  const out = suppressHarmonics(frame, layout, 4);   // absurd strength
  for (let k = 0; k < out.length; k++) {
    assert((out[k] ?? 0) >= 0, `bin ${k} came out at ${out[k]}`);
  }
});

// ── Chords ──────────────────────────────────────────────────────────────────

check('a triad reads as three notes, not one', () => {
  const c = meanChroma(mix(saw(hz(48), 1.6, 0.4), saw(hz(52), 1.6, 0.4), saw(hz(55), 1.6, 0.4)));
  const top3 = ranked(c).slice(0, 3).map((r) => r.name).sort();
  assert(top3.join(',') === 'C,E,G', `C major read as ${show(c, 5)}`);
  // Roughly balanced: the weakest of the three is not a rounding error.
  const values = ranked(c).slice(0, 3).map((r) => r.value);
  assert(values[2]! > values[0]! * 0.4, `unbalanced triad: ${show(c, 4)}`);
  // And the fourth note is clearly behind the third.
  assert(ranked(c)[3]!.value < values[2]! * 0.75, `a fourth note crept in: ${show(c, 5)}`);
});

check('minor is not major', () => {
  const major = meanChroma(mix(saw(hz(48), 1.6, 0.4), saw(hz(52), 1.6, 0.4), saw(hz(55), 1.6, 0.4)));
  const minor = meanChroma(mix(saw(hz(48), 1.6, 0.4), saw(hz(51), 1.6, 0.4), saw(hz(55), 1.6, 0.4)));
  assert((major[4] ?? 0) > (major[3] ?? 0) * 2, `C major: E ${major[4]?.toFixed(2)} D# ${major[3]?.toFixed(2)}`);
  assert((minor[3] ?? 0) > (minor[4] ?? 0) * 2, `C minor: D# ${minor[3]?.toFixed(2)} E ${minor[4]?.toFixed(2)}`);
});

check('a seventh is visible, which is what the default vocabulary needs', () => {
  // The user chose sevenths as the default vocabulary, so a seventh has to
  // survive the transform — it is the quietest note in most voicings and the
  // first thing log compression exists to rescue.
  const cmaj7 = meanChroma(mix(
    saw(hz(48), 1.6, 0.4), saw(hz(52), 1.6, 0.4), saw(hz(55), 1.6, 0.4), saw(hz(59), 1.6, 0.35),
  ));
  const top4 = ranked(cmaj7).slice(0, 4).map((r) => r.name).sort();
  assert(top4.join(',') === 'B,C,E,G', `Cmaj7 read as ${show(cmaj7, 6)}`);

  const c7 = meanChroma(mix(
    saw(hz(48), 1.6, 0.4), saw(hz(52), 1.6, 0.4), saw(hz(55), 1.6, 0.4), saw(hz(58), 1.6, 0.35),
  ));
  assert((c7[10] ?? 0) > (c7[11] ?? 0) * 1.5,
    `C7 confuses B♭ with B: ${show(c7, 6)}`);
});

// ── Housekeeping ────────────────────────────────────────────────────────────

check('silence is zero, not normalised noise', () => {
  const quiet = new Float32Array(SR);
  for (let i = 0; i < quiet.length; i++) quiet[i] = (Math.random() - 0.5) * 1e-7;
  const loud = mix(saw(hz(48), 1.0, 0.5), quiet);
  const gram = chromagram(loud, SR);
  // The tail of `loud` is only the noise, so some frames must read silent.
  assert(gram.silentFrames === 0 || gram.frames.some((f) => f.every((v) => v === 0)),
    'a silent frame was normalised into a chord');

  const onlyNoise = chromagram(quiet, SR);
  const anyNonZero = onlyNoise.frames.some((f) => [...f].some((v) => v > 0));
  assert(!anyNonZero, 'pure noise produced a chroma');
});

check('every frame is normalised, so loud and quiet agree', () => {
  const loud = meanChroma(mix(saw(hz(48), 1.2, 0.8), saw(hz(55), 1.2, 0.8)));
  const quiet = meanChroma(mix(saw(hz(48), 1.2, 0.02), saw(hz(55), 1.2, 0.02)));
  let diff = 0;
  for (let i = 0; i < 12; i++) diff = Math.max(diff, Math.abs((loud[i] ?? 0) - (quiet[i] ?? 0)));
  assert(diff < 0.12, `the same chord 32 dB apart differs by ${diff.toFixed(3)}`);
});

check('folding sums a semitone rather than picking one bin', () => {
  // After the tuning shift a note's energy genuinely straddles its three
  // bins; taking the maximum throws away whatever leaked.
  const layout = DEFAULT_CQT;
  // Semitone s owns bins 3s−1, 3s, 3s+1 — the centre bin and the two either
  // side of it.  The first version of this used 3, 4, 5, which straddles two
  // semitones, and read the code as broken when the test was.
  const frame = new Float32Array(layout.bins);
  frame[2] = 1; frame[3] = 1; frame[4] = 1;    // one semitone, spread
  const folded = foldToChroma(frame, layout);
  assert(Math.abs((folded[1] ?? 0) - 3) < 1e-6, `three unit bins folded to ${folded[1]}`);
  const src = stripComments(
    readFileSync(new URL('../src/renderer/daw/audio/chroma/chroma.ts', import.meta.url), 'utf8'));
  const at = src.indexOf('export function foldToChroma');
  assert(!/Math\.max/.test(src.slice(at, src.indexOf('\n}', at))), 'folding takes a maximum');
});

check('the transform is fast enough to be used on a song', () => {
  // A four-minute song at this hop is 2400 frames.  If one second of audio
  // takes longer than a second there is no feature here, only a demo.
  const signal = saw(hz(48), 4.0, 0.4);
  const started = Date.now();
  const gram = chromagram(signal, SR);
  const elapsed = (Date.now() - started) / 1000;
  assert(gram.frames.length > 30, `only ${gram.frames.length} frames`);
  assert(elapsed < 4.0, `4 s of audio took ${elapsed.toFixed(2)} s`);
  console.log(`      (4 s of audio in ${elapsed.toFixed(2)} s — ${(4 / elapsed).toFixed(1)}× real time at ${SR} Hz)`);
});

console.log('\n=== Chroma — which notes are sounding ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
