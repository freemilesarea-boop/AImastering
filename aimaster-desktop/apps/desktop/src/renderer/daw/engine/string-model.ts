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
 * The integer and fractional parts of the delay line for one pitch.
 *
 * Exported because it is the whole tuning argument, and a test that cannot
 * see it can only check the pitch it hears, which is a slower way to find out
 * that the sign of `frac` is wrong.
 */
export function stringDelay(freqHz: number, sampleRate: number): { length: number; frac: number } {
  const total = sampleRate / Math.max(1, freqHz) - 0.5;   // minus the loop filter
  const length = Math.max(2, Math.ceil(total));
  return { length, frac: length - total };                // in [0, 1)
}

/** One plucked note, as samples. */
export function pluckedString(o: PluckOptions): Float32Array {
  const sr = o.sampleRate;
  const n = Math.max(1, Math.round(sr * Math.max(0.01, o.seconds)));
  const out = new Float32Array(n);
  const { length: L, frac } = stringDelay(o.freqHz, sr);

  // Excitation: noise, low-passed by `brightness`, then comb-filtered at the
  // pick position.  Filling the delay line IS the pluck — there is no separate
  // exciter, which is the whole idea of the algorithm.
  const rnd = mulberry32(o.seed);
  const line = new Float32Array(L);
  const tone = 0.05 + 0.95 * Math.min(1, Math.max(0, o.brightness));
  let lp = 0;
  for (let i = 0; i < L; i++) {
    lp += tone * ((rnd() * 2 - 1) - lp);
    line[i] = lp;
  }
  const pick = Math.round(L * Math.min(0.5, Math.max(0.02, o.pickPosition)));
  if (pick > 0 && pick < L) {
    const copy = Float32Array.from(line);
    for (let i = 0; i < L; i++) line[i] = copy[i]! - copy[(i + pick) % L]!;
  }
  // Normalise: the comb and the low-pass both change the level, and a string
  // that arrives at wildly different amplitudes per pitch is unplayable.
  let peak = 0;
  for (let i = 0; i < L; i++) peak = Math.max(peak, Math.abs(line[i]!));
  if (peak > 0) for (let i = 0; i < L; i++) line[i]! /= peak;

  const damp = Math.min(0.99995, Math.max(0.5, o.damping));
  let idx = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const s0 = line[idx]!;
    const s1 = line[(idx + 1) % L]!;
    const cur = s0 + frac * (s1 - s0);
    const filtered = (cur + prev) * 0.5 * damp;
    prev = cur;
    line[idx] = filtered;
    out[i] = cur;
    idx = (idx + 1) % L;
  }
  return out;
}
