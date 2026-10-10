// A plucked string, computed sample by sample.
//
// ── Why this is not built out of WebAudio nodes ─────────────────────────────
//
// A Karplus-Strong string is a delay line fed back through a damping filter,
// and the delay length IS the pitch.  Every other device in this engine is
// made of native nodes, so that was tried first.  It cannot work, and the
// measurement is worth keeping because it is not obvious:
//
//   Chromium clamps a DelayNode inside a FEEDBACK loop to one render quantum
//   — 128 samples, 2.67 ms at 48 kHz.  Every guitar note is shorter than that
//   (A4 is 109 samples), so the pitch is whatever the clamp says.  Measured,
//   asking for these and getting these:
//
//        82.4 Hz ->    67.3 Hz     440 Hz ->   200.0 Hz
//       146.8 Hz ->  1043.5 Hz     880 Hz ->   259.5 Hz
//
//   and the loop did not merely mistune, it exploded: peaks of 9.5e17 by the
//   top of the range.  There is no tuning of feedback gain that fixes it,
//   because the delay is not the length the maths assumes.
//
// So the string is computed here, into a buffer, and played through an
// `AudioBufferSourceNode`.  That is not a workaround — it is better: the loop
// is exact, the tuning is exact, and the result is bit-identical between the
// live preview and an offline bounce, which is this engine's rule.
//
// ── Getting it in tune ──────────────────────────────────────────────────────
//
// The loop delay has three parts and all three count:
//
//   · the delay line          L samples
//   · the fractional read     interpolating toward buf[idx+1] — which is one
//                             sample NEWER — SUBTRACTS `frac`, it does not add
//                             it.  Getting that sign backwards puts the whole
//                             instrument sharp, by more at higher pitches.
//   · the loop filter         a two-point average has a group delay of exactly
//                             half a sample
//
// so the period is `L - frac + 0.5`, and the tuning error measured across a
// guitar's range is:
//
//     82.41 Hz  0.0 cents      440 Hz  0.0 cents
//    164.81 Hz  0.0 cents   659.26 Hz  0.1 cents
//    329.63 Hz  0.0 cents     880 Hz  0.8 cents
//
// with 7.7 cents at E6, where a period is 36 samples and there is nowhere
// left to put the fraction.  That is the top of a guitar's range and the
// error is inherent to the sample rate, not to the model.
//
// ── Why the noise is seeded ─────────────────────────────────────────────────
//
// `Math.random()` would make every render of the same part different, and
// this engine's contract is that a bounce sounds like the preview.  A real
// string does vary from pluck to pluck, but that variation has to be a
// FUNCTION of the note — same note, same sound, every render.

/** A small deterministic PRNG.  Same seed, same string, every time. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The RMS the excitation is normalised to.
 *
 * Nothing rides on the value — the loop is linear and `INSTRUMENT_TRIM` absorbs
 * it exactly — so it is chosen to keep the four Karplus-Strong instruments near
 * the level they were at, and no further.  Unit RMS would have put them eleven
 * decibels up; 0.27, guessed from the peak-to-RMS ratio of filtered noise, left
 * them 1.6 to 2.9 dB down; 0.356 is what measuring the four and centring them
 * gave, which is as close as one constant gets when their pick positions and
 * brightnesses differ.
 */
export const EXCITE_RMS = 0.356;

/**
 * The rate the excitation's brightness corner is anchored to.
 *
 * Not a preference: it is the rate `INSTRUMENT_TRIM` was derived at, so anchoring
 * here is what makes the change inaudible on that rate and makes every other
 * rate match it rather than the other way round.
 */
export const EXCITE_REF_SR = 44_100;

/**
 * The highest harmonic the excitation bothers to put energy in.
 *
 * Bounded by hearing rather than by Nyquist on purpose: with a fixed ceiling the
 * harmonic set is identical at every rate a device is likely to offer, whereas
 * `sr/2` would add harmonics at 48 kHz that 44.1 does not have and reintroduce
 * exactly the dependence this excitation exists to remove.
 */
export const EXCITE_TOP_HZ = 20_000;

export interface PluckOptions {
  freqHz: number;
  sampleRate: number;
  /** How much to compute.  The tail is silence once the string has died. */
  seconds: number;
  /**
   * Loop gain per round trip, just under 1.  This is what "sustain" means on
   * a string: 0.996 is a damped acoustic, 0.9995 rings like an electric with
   * the amp on.  At 1.0 or above the string never stops, so it is clamped.
   */
  damping: number;
  /** 0 = dark and woolly, 1 = a bright new string.  Rolls off the excitation. */
  brightness: number;
  /**
   * Where the string was plucked, 0.02 (right at the bridge, nasal) to 0.5
   * (over the middle of the string, round and hollow).  A pluck cancels the
   * harmonics with a node at that point, which is why bridge pickups sound
   * thin — it is a comb, not an EQ.
   */
  pickPosition: number;
  /** Same note, same seed, same waveform — see the note above. */
  seed: number;
}

/**
 * The delay line for one pitch: whole samples, and an allpass for the rest.
 *
 * Exported because it is the whole tuning argument, and a test that cannot see
 * it can only check the pitch it hears, which is a slower way to find out that
 * a sign is wrong.
 *
 * ── Why an allpass and not the interpolation that was here ─────────────────
 *
 * A delay line is a whole number of samples and a pitch is not, so something
 * has to supply the fraction.  This read the next sample and interpolated
 * towards it, which is a lowpass whose loss depends on WHERE THE ROUNDING
 * LANDED — maximal at half a sample, none at zero or one.  That loss is inside
 * the feedback loop, so it does not tint the tone once, it sets how fast the
 * top of the string dies.  Measured over one chromatic octave at 44.1 kHz, the
 * high band's T60 swung between 0.84 s and 1.77 s and it tracked the fraction:
 * the three notes nearest half a sample were the three shortest.  A string
 * whose brightness is decided by a rounding remainder.
 *
 * It is a sample-rate bug for the same reason.  The fraction for a given pitch
 * is a different number at a different rate — at 110 Hz it is 0.59 at 44.1 kHz
 * and 0.14 at 48 — so the same note rang 53 per cent longer up top at 48.
 * Working it through at 6 kHz: the interpolator passes 0.913 per round trip at
 * 44.1 and 0.964 at 48, the loop's averager 0.910 and 0.924, which predicts a
 * T60 ratio of 1.59 against 1.53 measured — and puts about four fifths of it on
 * the interpolator.
 *
 * A first-order allpass has unity magnitude at every frequency.  It delays by
 * the fraction and takes nothing, so the loop's losses are the loop's business
 * again.  What it does instead is disperse — its delay is slightly shorter for
 * high partials — which stretches them a little, the way a real string's
 * stiffness does.
 *
 * The fraction is kept in [0.5, 1.5) by borrowing a sample from the integer
 * part, because an allpass asked for a delay near zero needs a coefficient near
 * 1, and that is a pole laid against the unit circle.
 */
export function stringDelay(freqHz: number, sampleRate: number): {
  length: number; frac: number; allpass: number;
} {
  const total = sampleRate / Math.max(1, freqHz) - 0.5;   // minus the loop filter
  const length = Math.max(2, Math.floor(total - 0.5));
  const frac = total - length;                            // in [0.5, 1.5)
  return { length, frac, allpass: (1 - frac) / (1 + frac) };
}

/** One plucked note, as samples. */
export function pluckedString(o: PluckOptions): Float32Array {
  const sr = o.sampleRate;
  const n = Math.max(1, Math.round(sr * Math.max(0.01, o.seconds)));
  const out = new Float32Array(n);
  const { length: L, allpass: ap } = stringDelay(o.freqHz, sr);

  // ── The excitation, built one HARMONIC at a time ─────────────────────────
  //
  // Filling the delay line IS the pluck — there is no separate exciter, which is
  // the whole idea of the algorithm.  What goes in it is the string's initial
  // shape, and the line is one period long, so a sinusoid with `k` cycles across
  // it is harmonic `k` of the note.  Building it there rather than in the time
  // domain is what makes the note the same note on every device.
  //
  // It was `L` samples of a seeded noise stream, low-passed and then comb-
  // filtered by subtracting a copy shifted by a rounded number of samples.  All
  // three of those depend on `L`, and `L` is proportional to the sample rate:
  //
  //   · the noise was a different DRAW at a different rate, because the stream
  //     was read a different number of times
  //   · the low-pass coefficient was fixed, so its corner sat at a fixed
  //     fraction of the rate — 351 Hz on one device and 382 on another
  //   · the comb's shift was `round(L·pickPosition)`, so which harmonics it
  //     notched moved with the rounding
  //
  // Measured at seven pitches, worst gap between 44.1 and 48 kHz / how much that
  // gap swung from note to note / how far a chromatic octave spanned at one rate:
  //
  //     as it was                 1.59 dB   2.68 dB   2.87 dB
  //     normalising by RMS        0.73      1.17      2.05
  //     + the corner in hertz     0.92      1.18      2.05
  //     + the harmonic domain     0.44      0.29      1.50
  //
  // Anchoring the corner made the worst gap slightly WORSE on its own, because
  // the filter's error had been partly cancelling the draw's — one error hiding
  // another is not a reason to keep both, and in the harmonic domain neither is
  // there to cancel anything.
  //
  // What is left is not scatter.  Both remaining figures are MONOTONE in pitch —
  // the gap runs 0.16, 0.18, 0.20, 0.24, 0.26, 0.29, 0.44 dB from the bottom of
  // the range to the top, and the octave's 1.50 dB is a smooth slope rather than
  // a jumble — which is the shape the loop's two-point averager has to make,
  // since a high note takes more round trips per second through it.  That filter
  // is the one rate-dependent thing left in this engine and it is left on
  // purpose; see `RATE_GAP_LU` in the level suite.
  //
  // In the harmonic domain all three go away at once.  Harmonic `k` gets its
  // amplitude from the rolloff at `k·f₀` in hertz, its notch from the exact comb
  // `|sin(πk·p)|` instead of a rounded sample shift, and its phase from the
  // `k`-th draw of the stream — so every harmonic that exists at two rates is
  // identical at both, and the pick position stops being quantised.
  const rnd = mulberry32(o.seed);
  const line = new Float32Array(L);
  const shape = Math.min(0.999, 0.05 + 0.95 * Math.min(1, Math.max(0, o.brightness)));
  // The corner the old fixed coefficient produced at the reference rate, so
  // nothing moves on the rate the trims were derived at.
  const cornerHz = (-Math.log(1 - shape) * EXCITE_REF_SR) / (2 * Math.PI);
  const pickFrac = Math.min(0.5, Math.max(0.02, o.pickPosition));
  // Bounded by hearing rather than by Nyquist, so the harmonic set is the same
  // on every rate a device offers instead of being one harmonic longer at 48.
  const top = Math.min(Math.floor(L / 2), Math.floor(EXCITE_TOP_HZ / Math.max(1, o.freqHz)));
  for (let k = 1; k <= top; k++) {
    const fk = k * o.freqHz;
    const amp = Math.abs(Math.sin(Math.PI * k * pickFrac))
      / Math.sqrt(1 + (fk / cornerHz) * (fk / cornerHz));
    const phase = rnd() * 2 * Math.PI;
    if (amp < 1e-7) continue;
    // A rotating phasor rather than a sine per sample: `L` can be a couple of
    // thousand and `top` a thousand, and two multiplies beat a transcendental.
    const step = (2 * Math.PI * k) / L;
    const cs = Math.cos(step);
    const sn = Math.sin(step);
    let zr = Math.cos(phase);
    let zi = Math.sin(phase);
    for (let i = 0; i < L; i++) {
      line[i]! += amp * zi;
      const nr = zr * cs - zi * sn;
      zi = zr * sn + zi * cs;
      zr = nr;
    }
  }
  // Normalise: the comb and the rolloff both change the level, and a string that
  // arrives at wildly different amplitudes per pitch is unplayable.  By RMS,
  // which for a sum of random-phase sinusoids is a settled number rather than
  // the coin toss the peak was.
  let sum = 0;
  for (let i = 0; i < L; i++) sum += line[i]! * line[i]!;
  const level = Math.sqrt(sum / L);
  if (level > 0) for (let i = 0; i < L; i++) line[i]! *= EXCITE_RMS / level;

  const damp = Math.min(0.99995, Math.max(0.5, o.damping));
  let idx = 0;
  let prev = 0;
  // The allpass's one state, as `y[n] = a·x[n] + x[n−1] − a·y[n−1]` folded into
  // a single carry.  Round the loop: L whole samples, then the fraction, then
  // the averager's half — which is the period `stringDelay` was asked for.
  let apz = 0;
  for (let i = 0; i < n; i++) {
    const x = line[idx]!;
    const y = ap * x + apz;
    apz = x - ap * y;
    const filtered = (y + prev) * 0.5 * damp;
    prev = y;
    line[idx] = filtered;
    out[i] = y;
    idx = (idx + 1) % L;
  }
  return out;
}
