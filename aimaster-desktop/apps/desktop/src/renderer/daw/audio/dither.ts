// dither.ts — the noise you add so the quantiser stops lying.
//
// Dropping 32-bit float to 16-bit PCM throws away everything below about
// −96 dBFS.  Doing that by rounding alone does not just lose the quiet part;
// it CORRELATES the error with the signal.  A reverb tail decaying through the
// last few bits does not fade — it steps, then breaks into a buzz that tracks
// the note, because the rounding error is a function of the note.  That is the
// grainy, gritty tail every mastering engineer recognises.
//
// Dither fixes it by adding a small amount of noise BEFORE the rounding.  The
// error stops being a function of the signal and becomes plain noise, and the
// signal below one bit survives — as noise-modulated amplitude rather than as
// steps.  You trade a correlated distortion you can hear for an uncorrelated
// hiss you mostly cannot.
//
// TPDF (triangular probability density) is the standard choice: two independent
// uniform draws summed, ±1 LSB.  Unlike rectangular dither it makes both the
// mean AND the variance of the error independent of the signal, which is what
// "no noise modulation" actually means.
//
// Noise shaping goes one step further.  The quantiser's error is fed back
// through a filter so the noise is pushed OUT of the band the ear is most
// sensitive to (2–5 kHz) and up towards Nyquist.  Total noise power goes UP;
// audible noise goes down.  It is not free — at 44.1 kHz there is not much
// room above the ear — which is why it is a choice here and not the default.
//
// Reproducibility: the noise is seeded, not `Math.random`.  Bouncing the same
// session twice has to give the same file, or "is this the master I approved?"
// stops being answerable.  See engine/reverb-spaces.ts, which made the same
// call for the same reason.

export type DitherMode = 'none' | 'tpdf' | 'shaped' | 'shaped-strong';

export const DITHER_MODES: readonly DitherMode[] = ['none', 'tpdf', 'shaped', 'shaped-strong'];

export const DITHER_LABELS: Record<DitherMode, string> = {
  'none':          '없음 (반올림)',
  'tpdf':          'TPDF',
  'shaped':        '노이즈 셰이핑',
  'shaped-strong': '노이즈 셰이핑 (강)',
};

export const DITHER_NOTES: Record<DitherMode, string> = {
  'none':          '디더 없이 반올림 — 조용한 꼬리에서 오차가 신호를 따라다닙니다',
  'tpdf':          '표준 삼각 분포 디더 — 오차의 평균과 분산이 신호와 무관해집니다',
  'shaped':        'TPDF + 2차 셰이핑 — 노이즈를 귀가 둔한 고역으로 밀어 올립니다',
  'shaped-strong': 'TPDF + 3차 셰이핑 — 더 세게 밀지만 44.1 kHz 에서는 위쪽 여유가 적습니다',
};

/**
 * Error-feedback coefficients per mode.
 *
 * The noise transfer function is `1 - H(z)`, so `h = [2, -1]` gives
 * `(1 - z⁻¹)²` — a second-order high-pass on the error.  `[3, -3, 1]` gives
 * the cube.  Both are the textbook difference-of-differences shapers rather
 * than a fitted psychoacoustic curve: they are simple enough to reason about,
 * and their tilt is something a test can measure.
 */
const SHAPERS: Record<DitherMode, readonly number[]> = {
  'none':          [],
  'tpdf':          [],
  'shaped':        [2, -1],
  'shaped-strong': [3, -3, 1],
};

/** Integer bit depths a quantiser can target.  32 is float and never quantised. */
export type QuantBitDepth = 16 | 24;

/**
 * Full-scale integer magnitude for a depth.
 *
 * Symmetric (`0x7fff`, not `0x8000`) so +1.0 and −1.0 map to codes the same
 * distance from zero.  This matches what the encoder already did, so turning
 * dither off reproduces the old bytes exactly.
 */
export function fullScale(bitDepth: QuantBitDepth): number {
  return bitDepth === 16 ? 0x7fff : 0x7fffff;
}

/** One LSB, in the normalised [-1, 1] domain. */
export function lsbOf(bitDepth: QuantBitDepth): number {
  return 1 / fullScale(bitDepth);
}

/**
 * xorshift32 — small, fast, and good enough for dither.
 *
 * Dither does not need cryptographic randomness; it needs a flat spectrum and
 * no short period.  xorshift32's period is 2³² − 1, which at 48 kHz is a day
 * and a half before it repeats.
 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9;      // a zero seed would lock the generator at zero
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 0x100000000;          // [0, 1)
  };
}

export interface Quantizer {
  readonly mode: DitherMode;
  readonly bitDepth: QuantBitDepth;
  /** Full-scale integer magnitude — the caller writes codes in ±this. */
  readonly peak: number;
  /**
   * The integer code for one sample on one channel.
   *
   * Stateful per channel: noise shaping remembers the last few errors, so the
   * samples of a channel MUST be fed in order and channels must not be
   * interleaved into one another's state.
   */
  code(sample: number, channel: number): number;
}

/** A fixed seed, so two bounces of the same session are the same file. */
export const DEFAULT_DITHER_SEED = 0x10715EA;

/**
 * A quantiser for `channels` channels at `bitDepth`.
 *
 * Each channel gets its own noise stream.  Sharing one would put identical
 * noise in both sides, which images dead centre and is audible as a hiss
 * sitting on the vocal instead of spread across the stereo field.
 */
export function createQuantizer(
  bitDepth: QuantBitDepth,
  mode: DitherMode = 'tpdf',
  channels = 2,
  seed: number = DEFAULT_DITHER_SEED,
): Quantizer {
  const peak = fullScale(bitDepth);
  const lsb = 1 / peak;
  const shaper = SHAPERS[mode];
  const order = shaper.length;
  const count = Math.max(1, channels);

  // Per channel: its own RNG, and its own error history for the shaper.
  const rngs = Array.from({ length: count }, (_, c) => makeRng((seed + c * 0x9e3779b9) >>> 0));
  const errors = Array.from({ length: count }, () => new Float64Array(order));

  const code = (sample: number, channel: number): number => {
    const c = channel >= 0 && channel < count ? channel : 0;

    if (mode === 'none') {
      const clamped = Math.max(-1, Math.min(1, sample));
      return Math.round(clamped * peak);
    }

    // Shaped input: subtract the filtered history of past errors, so what the
    // quantiser adds this time cancels what it added before, band by band.
    let v = sample;
    if (order > 0) {
      const history = errors[c] as Float64Array;
      for (let k = 0; k < order; k++) v -= (shaper[k] as number) * (history[k] as number);
    }

    // TPDF: two independent uniform draws on [-0.5, 0.5) LSB, summed.
    const rng = rngs[c] as () => number;
    const d = (rng() - 0.5 + rng() - 0.5) * lsb;
    const w = v + d;

    // Clamp the CODE, not the input.  A sample already at full scale plus a
    // positive dither would round past the integer range and wrap — a click at
    // the loudest moment, which is the worst possible place for one.
    const raw = Math.round(w * peak);
    const out = raw > peak ? peak : raw < -peak ? -peak : raw;

    if (order > 0) {
      // The error is measured against `v`, the value BEFORE the dither was
      // added — so the dither is inside the feedback loop and gets shaped
      // along with the rounding error.
      //
      // Measuring against `w` instead (the obvious reading of "quantiser
      // error") leaves the dither flat and unshaped, and then the dither
      // alone sets the noise floor at low frequencies — which is the floor
      // shaping exists to lower.  A test of the 2–5 kHz band caught this:
      // the shaper was moving the rounding error up and leaving the dither
      // sitting exactly where it was.
      //
      // The clamp is inside this too: if it moved the sample, that IS error,
      // and the shaper should see it rather than pretend it did not happen.
      const history = errors[c] as Float64Array;
      for (let k = order - 1; k > 0; k--) history[k] = history[k - 1] as number;
      history[0] = out * lsb - v;
    }
    return out;
  };

  return { mode, bitDepth, peak, code };
}

/** The mode a depth should use when the caller has no opinion. */
export function defaultDither(bitDepth: number): DitherMode {
  // Any reduction to a fixed-point depth deserves dither; 32-bit float is not
  // a reduction at all and must never have noise added to it.
  return bitDepth === 16 || bitDepth === 24 ? 'tpdf' : 'none';
}

export function describeDither(mode: DitherMode, bitDepth: number): string {
  if (bitDepth === 32) return '32비트 float — 양자화가 없어 디더도 없습니다';
  return `${bitDepth}비트 · ${DITHER_LABELS[mode]} — ${DITHER_NOTES[mode]}`;
}
