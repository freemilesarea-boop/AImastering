// Where a sound is, bin by bin.
//
// A mixed record is not a soup: the lead vocal is almost always dead centre and
// almost always in phase between the two channels, because that is how records
// have been made since the sixties.  That is a cue no mono file has and no
// neural network needs — it is just there in the arithmetic.
//
// Two numbers per bin, both in [0,1]:
//
//   PAN BALANCE.  |L| against |R|.  1 when they are equal, 0 when the bin lives
//   entirely in one channel.  This is what separates a centred vocal from a
//   hard-panned guitar.
//
//   COHERENCE.  How aligned L and R are in PHASE.  A centred mono source has
//   the same waveform in both channels, so its bins are collinear; a wide
//   synth pad, a reverb tail or a doubled guitar are not.  Balance alone would
//   call a wide pad "centred", because a pad IS equal in both channels — it is
//   the phase that gives it away.
//
// Multiplied, they are "how much does this bin behave like one source sitting
// in the middle".  Not "is this a voice" — a centred kick scores just as high,
// which is exactly why `repet.ts` exists.
//
// ── Mono ─────────────────────────────────────────────────────────────────────
//
// On a mono file both numbers are 1 everywhere, and they carry no information
// at all.  That is not a failure to hide: `centreness()` says so through
// `informative`, and the separator tells the user, because a mono file is a
// file where the vocal separation has lost one of its two cues.

import type { HalfSpectrum } from './spectrum.js';

export interface Centreness {
  /** Frame-major gains in [0,1]. */
  value: Float32Array;
  /**
   * False when the two channels are the same signal, so this cue told us
   * nothing.  The caller is expected to say so out loud rather than quietly
   * scoring every bin as perfectly centred.
   */
  informative: boolean;
}

export interface CentrenessOptions {
  /**
   * How sharply a bin has to be centred before it counts.  Higher rejects more
   * of the mix and keeps a narrower, cleaner vocal.
   */
  sharpness: number;
}

/**
 * 1: `centreness` returns balance × coherence as it stands.
 *
 * The separator raises this to its own power (`VocalOptions.centreWeight`), and
 * two exponents on one number is one exponent too many — the pair of them were
 * silently cubing the cue and losing the top of the voice.
 */
export const DEFAULT_CENTRENESS: CentrenessOptions = { sharpness: 1 };

/**
 * `left` and `right` must be the same chunk of the same file.
 *
 * Passing the same spectrum twice — which is what a mono file gives — returns
 * all ones with `informative: false`.
 */
export function centreness(
  left: HalfSpectrum, right: HalfSpectrum, options: Partial<CentrenessOptions> = {},
): Centreness {
  const { sharpness } = { ...DEFAULT_CENTRENESS, ...options };
  const n = left.frames * left.bins;
  const value = new Float32Array(n);

  let identical = true;
  for (let i = 0; i < n; i++) {
    const lr = left.data[i * 2] ?? 0;
    const li = left.data[i * 2 + 1] ?? 0;
    const rr = right.data[i * 2] ?? 0;
    const ri = right.data[i * 2 + 1] ?? 0;
    if (identical && (lr !== rr || li !== ri)) identical = false;

    const lm = Math.hypot(lr, li);
    const rm = Math.hypot(rr, ri);
    const sum = lm + rm;
    if (sum <= 0) { value[i] = 0; continue; }

    // 1 when |L| == |R|, 0 when all the energy is on one side.
    const balance = 1 - Math.abs(lm - rm) / sum;
    // |L·conj(R)| / (|L||R|) is 1 for collinear bins, less for anything
    // smeared in phase.  The product is taken before the magnitude so a
    // constant delay between the channels reads as incoherent, which is what
    // a wide, time-smeared source is.
    const dot = Math.abs(lr * rr + li * ri);
    const cross = Math.abs(li * rr - lr * ri);
    const coherence = lm * rm > 0 ? dot / Math.hypot(dot, cross) : 0;

    value[i] = Math.pow(balance * coherence, sharpness);
  }

  // There is deliberately no `if (identical) value.fill(1)` here.  It was
  // written, and a mutation test showed removing it changed nothing: when the
  // two channels are the same signal the balance is 1 and the phase is
  // collinear, so every bin already scores 1 on its own.  The only bins it
  // touched were silent ones, and it made them read "perfectly centred", which
  // is worse than the 0 they get now.
  return { value, informative: !identical };
}

/**
 * The mid channel's magnitude — what a centred source contributes.
 *
 * Used as the reference the repetition model works on, so that the two vocal
 * cues are looking at the same signal.
 */
export function midMagnitude(left: HalfSpectrum, right: HalfSpectrum): Float32Array {
  const n = left.frames * left.bins;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const re = ((left.data[i * 2] ?? 0) + (right.data[i * 2] ?? 0)) * 0.5;
    const im = ((left.data[i * 2 + 1] ?? 0) + (right.data[i * 2 + 1] ?? 0)) * 0.5;
    out[i] = Math.hypot(re, im);
  }
  return out;
}
