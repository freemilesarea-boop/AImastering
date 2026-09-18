// pitch-shift — an interval, out of delay lines and nothing else.
//
// The rule this engine is built on is native Web Audio nodes only: a live
// channel and an offline bounce have to be the same graph.  That rules out
// every good pitch shifter — phase vocoders and granular resynthesis both
// need a worklet — and leaves the one that was invented for exactly this
// constraint, because in 1975 it was a hardware constraint: a DELAY LINE
// whose length is swept.
//
// Read a delay whose length shrinks at rate r and the read pointer advances
// at 1 + r, so the pitch comes out multiplied by 1 + r.  The length cannot
// shrink forever, so it is swept over a window and jumped back — and a second
// line, half a window out of phase, is crossfaded in to cover the jump.
//
// ── What that costs, measured ──────────────────────────────────────────────
//
// The splice resets each line's phase, so during the crossfade the two lines
// are the same signal at two different moments: a comb, sweeping.  Measured
// as peak-to-trough level ripple, on a 440 Hz sine, which is the worst case
// because one frequency has nowhere to average:
//
//                      +3    +5    +7   +12    −5   −12  semitones
//     30 ms window    2.5   1.7   3.3   6.0   5.8   4.3  dB
//     50 ms           0.3   4.5  11.1   0.0   2.6  10.5
//     90 ms           3.1   7.7   0.8   1.8   0.0   0.4
//
// There is no window that is good everywhere, and that is not a tuning
// failure — the depth of a comb at one frequency is where that frequency
// happens to fall in it.  On NOISE, which is what music is more like, the
// same measurements are 1.2 to 3.6 dB at every interval and every window,
// because a comb that cancels one frequency reinforces its neighbour.
//
// So: this is a harmoniser, and it sounds like one.  A sustained sine through
// it warbles.  A voice, a guitar, a horn line does not, and the grain that is
// left is the sound the technique has always had.
//
// ── Why the crossfade adds to one rather than to one in power ──────────────
//
// An equal-power crossfade is the right answer for two uncorrelated signals
// and was measured too: it is better at some intervals, worse at others, the
// same on noise — and 2.2 dB worse at UNISON, where the amplitude-
// complementary pair is exact.  A harmoniser set to a unison has to be
// transparent, so the pair that sums to one wins.
//
// ── Why the modulators are BUFFERS and not oscillators ─────────────────────
//
// Because the pitch is a SLOPE, and no oscillator's slope is the same in two
// renderers.  This was found twice, the second time only by driving the app:
//
//   · a phase-shifted sawtooth needs a many-harmonic `PeriodicWave`, and
//     `node-web-audio-api` normalises those whatever `disableNormalization`
//     says while Chromium does not — the same coefficients, two amplitudes.
//   · so the second attempt used the BUILT-IN sawtooth, which is in the
//     specification and looked safe.  It is not.  Chromium band-limits it and
//     normalises the result to a peak of one, which flattens the straight
//     part; node generates the naive ramp, which is exact.  Measured through
//     the finished device at 880 Hz, Chromium against node: +4 semitones came
//     out 47 cents flat, +7 at 83, +12 at 132, and downwards 63, 136 and 230
//     sharp.  Every interval compressed toward a unison by the same 86 % —
//     which is Chromium's sawtooth slope, not a bug in the arithmetic.
//
// An `AudioBufferSourceNode` on loop has no such freedom: it plays the
// samples it was given.  So the ramp and the crossfade are both generated
// here, as buffers, and the half-window offset is a `start` offset into the
// same ramp rather than a phase-shifted wave or a later start time.  The
// window quantises to a whole number of samples, which is where
// `harmonyWindowSamples` comes from.

/** The lengths the window control offers, in milliseconds. */
export const HARMONY_WINDOW_MIN_MS = 20;
export const HARMONY_WINDOW_MAX_MS = 200;

/**
 * How far off the pitch lands, in cents, at an output frequency.
 *
 * The splice makes the output periodic at the window, so its spectrum is a
 * COMB at multiples of the window rate — and a shifted tone that does not
 * fall on a line of that comb is carried by the lines either side of it.  The
 * worst case is half a comb spacing, which is `1/(2·window)` hertz, and what
 * that is worth in cents depends entirely on where it lands:
 *
 *   worst centroid error, measured over the intervals −12 … +12
 *
 *              110 Hz   220 Hz   440 Hz   880 Hz   input
 *     30 ms      388      392      145       45    cents
 *     50 ms      388      163       52       26
 *     70 ms      179       65       51       19
 *     90 ms      151       58       20       16
 *    120 ms      134       45       24       11
 *    200 ms       52       26       12        6
 *
 * So this is a technique that is accurate above a few hundred hertz and
 * progressively is not below — which is exactly the reputation delay-line
 * harmonisers have always had, and it is arithmetic rather than a defect
 * anyone can tune out.  The worst entry in each row is the octave DOWN, whose
 * output is half the input: a 110 Hz bass an octave down lands at 55 Hz,
 * where even the longest window here is 52 cents out.  The default is 90 ms,
 * which is 20 cents at 440 and 16 at 880 — a voice or a guitar — and the
 * Window control is there because a bass needs more and a cymbal needs
 * less.
 *
 * The window is the only control over it, and it trades against smearing: a
 * long window splices less often but each splice covers more audio, so on a
 * transient it drags more of the previous moment along with it.
 */
export function harmonyErrorCents(outputHz: number, windowSec: number): number {
  const half = 1 / (2 * Math.max(1e-4, windowSec));
  return 1200 * Math.log2(1 + half / Math.max(1, outputHz));
}

/**
 * The shortest window that holds the pitch error at `outputHz` under
 * `centsAllowed`, clamped to what the control offers.
 *
 * Shortest rather than longest because the window costs smearing at the other
 * end: there is no reason to take 200 ms to shift a cymbal.
 */
export function harmonyWindowForMs(outputHz: number, centsAllowed = 25): number {
  const ratio = Math.pow(2, centsAllowed / 1200) - 1;
  const seconds = 1 / (2 * Math.max(1e-6, ratio) * Math.max(1, outputHz));
  return Math.max(HARMONY_WINDOW_MIN_MS, Math.min(HARMONY_WINDOW_MAX_MS, seconds * 1000));
}

/** Semitones and cents as a frequency ratio. */
export function harmonyRatio(semitones: number, cents = 0): number {
  const st = Number.isFinite(semitones) ? semitones : 0;
  const c = Number.isFinite(cents) ? cents : 0;
  return Math.pow(2, st / 12 + c / 1200);
}

/**
 * How far the delay travels in one window, in seconds.
 *
 * `|1 − ratio| · window`, because the delay has to change at rate `1 − ratio`
 * for the read pointer to advance at `ratio`, and it does that for one window
 * before it jumps back.
 */
export function harmonySpanSec(ratio: number, windowSec: number): number {
  return Math.abs(1 - ratio) * Math.max(0, windowSec);
}

/**
 * The sweep's amplitude, signed.
 *
 * Negative shifts UP: the read pointer only outruns the write pointer when
 * the delay between them is shrinking.  The magnitude is half the span
 * because the sawtooth swings from −1 to +1, which is two.
 */
export function harmonySweepGain(ratio: number, windowSec: number): number {
  const span = harmonySpanSec(ratio, windowSec);
  return (ratio > 1 ? -1 : 1) * (span / 2);
}

/** Where the delay sits at the middle of its sweep — half the span. */
export function harmonyBaseSec(ratio: number, windowSec: number): number {
  return harmonySpanSec(ratio, windowSec) / 2;
}

/**
 * The longest delay a line will ever be asked for, at any setting.
 *
 * `createDelay` takes a maximum and silently clamps past it, so this is what
 * the node is built with: the widest interval over the longest window.  An
 * octave down over 120 ms travels 120 ms, and the base sits at half of it.
 */
export function harmonyMaxDelaySec(): number {
  const widest = Math.max(
    harmonySpanSec(harmonyRatio(12, 50), HARMONY_WINDOW_MAX_MS / 1000),
    harmonySpanSec(harmonyRatio(-12, -50), HARMONY_WINDOW_MAX_MS / 1000),
  );
  return widest * 1.05;
}

/** The window, rounded to the whole samples a looping buffer can hold. */
export function harmonyWindowSamples(windowSec: number, sampleRate: number): number {
  return Math.max(8, Math.round(windowSec * sampleRate));
}

/**
 * The sweep, as samples: one window of a ramp from −1 to +1.
 *
 * Exactly the shape an ideal sawtooth has and exactly the shape no built-in
 * oscillator guarantees.  Looped, it jumps back at the start of each window,
 * which is where the crossfade below is zero.
 */
export function harmonyRampSamples(frames: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = (i / frames) * 2 - 1;
  return out;
}

/**
 * The crossfade, as samples: one window of a cosine.
 *
 * Written as `−cos`, so it is ZERO where the ramp jumps and one in the middle
 * of the sweep.  The second line reads the same buffer half a window along,
 * which inverts it, so the two windows sum to exactly one — which is what
 * makes a unison transparent.
 */
export function harmonyFadeSamples(frames: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = -Math.cos((2 * Math.PI * i) / frames);
  return out;
}
