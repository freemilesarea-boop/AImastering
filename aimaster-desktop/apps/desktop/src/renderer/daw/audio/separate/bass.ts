// Which bins belong to the bass.
//
// A shelf at 200 Hz is the obvious answer and the wrong one: a bass guitar's
// second harmonic sits at 160 Hz, its fifth at 400, and the note a listener
// hears as "the bass line" is spread up to a kilohertz.  Cut at a fixed
// frequency and the bass stem is a dull thud while the actual instrument is
// still audible in "other".
//
// So two things are combined:
//
//   A SHELF, for the region nothing else lives in.  Below 90 Hz there is
//   almost never anything but bass and kick, and the kick has already been
//   taken by the percussive mask.
//
//   A COMB THAT FOLLOWS THE NOTE.  Each frame's bass fundamental is found by
//   scoring every candidate in 30–250 Hz on the sum of its first harmonics —
//   the classic harmonic-sum pitch estimate — and the bins at multiples of the
//   winner are claimed for the bass, weighted by how convincing the winner was.
//   When nothing convincing is playing, the comb contributes nothing and the
//   shelf is all that is left, which is the right behaviour for a passage with
//   no bass in it.
//
// The comb runs on the HARMONIC magnitude and after the vocal share has been
// taken, so a male vocal fundamental at 120 Hz is mostly gone before the bass
// tracker ever sees it.

import { binHz } from './spectrum.js';

export interface BassOptions {
  /** Everything below this is bass, whatever else it might be. */
  shelfHz: number;
  /** The shelf fades to nothing by here. */
  shelfFadeHz: number;
  /** Fundamentals are looked for in this range. */
  lowHz: number;
  highHz: number;
  /** Harmonics of the found note that the comb claims. */
  harmonics: number;
  /** The comb stops here — above it, bass is not what anyone is listening to. */
  ceilingHz: number;
  /** Half-width of each comb tooth, in bins. */
  toothBins: number;
}

// A note on something that is NOT here.  The shelf was once gated on how
// convincing the tracked note was, so that a bass-free intro of kick and hats
// would not come back as a bass stem going thump.  It reads well and it does
// nothing: measured on a mix whose first six seconds have no bass, the bass
// stem's level in that stretch was −10.8 dB gated and −10.8 dB ungated, while
// the gate cost four points of bass accuracy everywhere else.  The kick alone
// is convincing enough to open any gate loose enough to be safe.  It was
// removed rather than kept as a knob nobody could set usefully.

export const DEFAULT_BASS: BassOptions = {
  shelfHz: 90,
  shelfFadeHz: 260,
  lowHz: 30,
  highHz: 250,
  harmonics: 8,
  ceilingHz: 1200,
  toothBins: 2,
};

/** Raised-cosine shelf: 1 up to `shelfHz`, 0 from `shelfFadeHz`. */
export function bassShelf(bins: number, fftSize: number, sampleRate: number,
                          options: BassOptions): Float32Array {
  const shelf = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    const hz = binHz(b, fftSize, sampleRate);
    if (hz <= options.shelfHz) { shelf[b] = 1; continue; }
    if (hz >= options.shelfFadeHz) { shelf[b] = 0; continue; }
    const t = (hz - options.shelfHz) / (options.shelfFadeHz - options.shelfHz);
    shelf[b] = 0.5 * (1 + Math.cos(Math.PI * t));
  }
  return shelf;
}

export interface BassTrack {
  /** Fundamental in Hz per frame, 0 where nothing convincing was playing. */
  hz: Float32Array;
  /** How much of the low-mid energy that fundamental explains, per frame. */
  strength: Float32Array;
}

/** Harmonic-sum pitch estimate over the low band, one answer per frame. */
export function trackBass(
  harmonicMagnitude: Float32Array, frames: number, bins: number,
  fftSize: number, sampleRate: number, options: BassOptions = DEFAULT_BASS,
): BassTrack {
  const hz = new Float32Array(frames);
  const strength = new Float32Array(frames);
  const lowBin = Math.max(1, Math.round((options.lowHz * fftSize) / sampleRate));
  const highBin = Math.min(bins - 1, Math.round((options.highHz * fftSize) / sampleRate));
  const ceilingBin = Math.min(bins - 1, Math.round((options.ceilingHz * fftSize) / sampleRate));

  for (let f = 0; f < frames; f++) {
    const base = f * bins;
    let reference = 0;
    for (let b = lowBin; b <= ceilingBin; b++) reference += harmonicMagnitude[base + b] ?? 0;
    if (reference <= 0) continue;

    let bestScore = 0;
    let bestBin = 0;
    for (let candidate = lowBin; candidate <= highBin; candidate++) {
      let score = 0;
      for (let k = 1; k <= options.harmonics; k++) {
        const bin = candidate * k;
        if (bin > ceilingBin) break;
        // Peak-pick around the exact multiple: a real note is never exactly on
        // a bin centre, and insisting that it is loses half its energy.
        let peak = 0;
        for (let d = -1; d <= 1; d++) {
          const at = bin + d;
          if (at < 1 || at >= bins) continue;
          const v = harmonicMagnitude[base + at] ?? 0;
          if (v > peak) peak = v;
        }
        score += peak / k;          // upper harmonics are weaker evidence
      }
      if (score > bestScore) { bestScore = score; bestBin = candidate; }
    }

    if (bestBin === 0) continue;
    hz[f] = binHz(bestBin, fftSize, sampleRate);
    strength[f] = Math.min(1, bestScore / reference);
  }
  return { hz, strength };
}

/**
 * The per-frame, per-bin bass weight in [0,1].
 *
 * Written into `out` (frame-major) rather than returned, because this runs
 * once per chunk over a few million bins and the caller already has a buffer.
 */
export function bassWeight(
  out: Float32Array, track: BassTrack, shelf: Float32Array,
  frames: number, bins: number, fftSize: number, sampleRate: number,
  options: BassOptions = DEFAULT_BASS,
): void {
  const ceilingBin = Math.min(bins - 1, Math.round((options.ceilingHz * fftSize) / sampleRate));
  for (let f = 0; f < frames; f++) {
    const base = f * bins;
    for (let b = 0; b < bins; b++) out[base + b] = shelf[b] ?? 0;

    const f0 = track.hz[f] ?? 0;
    const gain = track.strength[f] ?? 0;
    if (f0 <= 0 || gain <= 0) continue;

    const f0Bin = (f0 * fftSize) / sampleRate;
    for (let k = 1; k <= options.harmonics; k++) {
      const centre = f0Bin * k;
      if (centre > ceilingBin) break;
      const from = Math.max(1, Math.floor(centre - options.toothBins));
      const to = Math.min(bins - 1, Math.ceil(centre + options.toothBins));
      for (let b = from; b <= to; b++) {
        // A tooth is a raised cosine too — a rectangular one would put a
        // comb-shaped colouration on whatever is left behind.
        const d = Math.abs(b - centre) / (options.toothBins + 1);
        const tooth = d >= 1 ? 0 : 0.5 * (1 + Math.cos(Math.PI * d));
        const value = gain * tooth;
        if (value > (out[base + b] ?? 0)) out[base + b] = value;
      }
    }
  }
}
