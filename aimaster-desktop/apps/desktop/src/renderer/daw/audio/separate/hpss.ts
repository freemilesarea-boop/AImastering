// Harmonic/percussive separation by median filtering.
//
// The observation is Fitzgerald's, and it is almost embarrassingly simple: in a
// magnitude spectrogram a sustained note is a horizontal ridge and a drum hit is
// a vertical one.  Median-filter ALONG TIME and the verticals vanish, leaving an
// estimate of the harmonic part; median-filter ALONG FREQUENCY and the
// horizontals vanish, leaving the percussive part.  Nothing here is learned and
// nothing is trained — it is a statement about what music looks like.
//
// The two estimates are turned into masks that sum to exactly one:
//
//     h = H^p / (H^p + P^p)          p = 1 − h
//
// Computing `m` as `1 − h` rather than `P^p/(H^p+P^p)` is not a shortcut; it is
// the reason the four stems add back up to the input with no residue.  Two
// divisions would agree to about seven digits, and seven digits of error times
// eleven thousand frames is an audible hiss.
//
// `power` is the softness.  1 splits energy in proportion; 2 is the Wiener-ish
// setting that most implementations use and the one that leaves the fewest
// artefacts; a very large value approaches a binary mask, which is louder but
// rings.

import { runningMedian } from './median.js';

export interface HpssOptions {
  /** Median length along time, in frames.  Longer = only true sustains survive. */
  harmonicFrames: number;
  /** Median length along frequency, in bins.  Longer = only true broadband hits. */
  percussiveBins: number;
  power: number;
}

/**
 * At 4096/1024 and 48 kHz a frame is 21 ms and a bin is 11.7 Hz, so these are
 * about 0.4 s of time and 400 Hz of frequency — a note has to hold for most of
 * a beat to read as harmonic, and a hit has to cross a third of an octave at
 * 1 kHz to read as percussive.
 */
export const DEFAULT_HPSS: HpssOptions = {
  harmonicFrames: 19,
  percussiveBins: 35,
  power: 2,
};

/**
 * The harmonic mask, frame-major, in [0,1].
 *
 * Only one array comes back, and the percussive mask is `1 − harmonic` —
 * written that way at the point of use.  Two arrays would be two chances to
 * disagree, and 2049 bins by two thousand frames by two channels is 36 MB of
 * agreeing to keep alive for no reason.
 *
 * `magnitude` is frame-major: bin b of frame f at `f * bins + b`.
 */
export function hpssHarmonic(
  magnitude: Float32Array, frames: number, bins: number,
  options: Partial<HpssOptions> = {},
): Float32Array {
  const { harmonicFrames, percussiveBins, power } = { ...DEFAULT_HPSS, ...options };
  const n = frames * bins;
  const harmonicEstimate = new Float32Array(n);
  const percussiveEstimate = new Float32Array(n);
  const scratch = new Float32Array(Math.max(harmonicFrames, percussiveBins) + 2);

  // Along time, one bin at a time: stride is `bins`, count is `frames`.
  for (let b = 0; b < bins; b++) {
    runningMedian(magnitude, harmonicEstimate, b, frames, bins, harmonicFrames, scratch);
  }
  // Along frequency, one frame at a time: stride 1, count `bins`.
  for (let f = 0; f < frames; f++) {
    runningMedian(magnitude, percussiveEstimate, f * bins, bins, 1, percussiveBins, scratch);
  }

  const harmonic = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const h = Math.pow(harmonicEstimate[i] ?? 0, power);
    const p = Math.pow(percussiveEstimate[i] ?? 0, power);
    const sum = h + p;
    // Silence is not evidence either way, so it is split down the middle —
    // and it is silence, so it does not matter which stem it lands in.
    harmonic[i] = sum > 0 ? h / sum : 0.5;
  }
  return harmonic;
}
