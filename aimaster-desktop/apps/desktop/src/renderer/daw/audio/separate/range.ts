// Where the singer actually is.
//
// `vocalPrior` in `separate.ts` is a fixed curve: nothing under 70 Hz, full
// credit from 110 Hz to 8 kHz, tapering above that.  It is a statement about
// singers in general and it is the only thing in the whole separator that never
// looks at the record.
//
// Measured on a real song, that costs more than it looks like it should.  That
// singer has NOTHING below 180 Hz — the truth's vocal stem is 0 % in every band
// under it — while the vocal stem the separator produced had 12 % of its energy
// at 125 Hz.  Band by band, 51 % of the arrangement's 125 Hz went to the vocal.
// The prior was not merely unhelpful there; it was holding the door open.
//
// A singer has a range, and a range is a thing you can MEASURE.  Pass one of
// the vocal mask already finds what is plainly centred and novel — the material
// nobody disputes is the singer — and where that material sits in the spectrum
// is the answer.  This narrows the fixed prior to it.
//
// ── Only ever narrower ───────────────────────────────────────────────────────
//
// The measured range multiplies the fixed prior rather than replacing it, so a
// bad measurement can throw the vocal away but can never hand it a region the
// prior had already ruled out.  And a measurement that is not credible — too
// little energy to be sure, or a band so narrow that it is one note rather than
// a range — is discarded, with the report saying so.  A guess that announces
// itself is a different thing from a guess that does not.

import { binHz } from './spectrum.js';

export interface RangeOptions {
  /**
   * Share of the confident vocal energy to cut off each end.
   *
   * Not zero: one loud frame of a cymbal that squeaked past pass one would
   * otherwise stretch the range to 16 kHz and the whole measurement would be
   * that one frame.
   */
  tail: number;
  /**
   * How far past each edge the window takes to close, in octaves.
   *
   * A hard edge would print itself on the vocal as a band-pass filter, and the
   * measurement is not accurate enough to deserve one.
   */
  fadeOctaves: number;
  /** What the prior is worth outside the measured range, rather than zero. */
  outside: number;
  /**
   * Narrowest range that counts as a range.
   *
   * Below this the measurement has found a note, not a singer, and is thrown
   * away.  Two and not three: at three it rejected measurements that were
   * plainly right — 237–1755 Hz on the test mix, which is a singer — and fell
   * back to the fixed prior, so the whole mechanism silently did nothing at
   * every setting but the loosest.  A guard that fires on the good case is
   * worse than no guard, because it fires quietly.
   */
  minOctaves: number;
}

export const DEFAULT_RANGE: RangeOptions = {
  tail: 0.05,
  fadeOctaves: 1,
  outside: 0.35,
  minOctaves: 2,
};

export interface LeadRange {
  /** Per-bin multiplier for the fixed prior, 1 inside the measured range. */
  weight: Float32Array;
  /** Edges of what was measured, in Hz.  Zero when nothing was. */
  lowHz: number;
  highHz: number;
  /** False when the measurement was not credible and `weight` is all ones. */
  informative: boolean;
}

/**
 * Measure where the confident part of the vocal mask lives.
 *
 * `vocalMask` is pass one's answer and `magnitude` the spectrogram it was
 * measured against; the product is the energy pass one assigned to the singer.
 */
export function leadRange(
  vocalMask: Float32Array, magnitude: Float32Array, frames: number, bins: number,
  fftSize: number, sampleRate: number, options: RangeOptions = DEFAULT_RANGE,
): LeadRange {
  const weight = new Float32Array(bins);
  weight.fill(1);
  const blank: LeadRange = { weight, lowHz: 0, highHz: 0, informative: false };

  const perBin = new Float32Array(bins);
  let total = 0;
  for (let f = 0; f < frames; f++) {
    const base = f * bins;
    for (let b = 0; b < bins; b++) {
      const e = ((vocalMask[base + b] ?? 0) * (magnitude[base + b] ?? 0)) ** 2;
      perBin[b] = (perBin[b] ?? 0) + e;
      total += e;
    }
  }
  if (total <= 0) return blank;

  // Walk in from both ends until the requested tail has been discarded.  This
  // is a percentile on the spectrum, not a peak-find: a singer is not one bin
  // and the loudest bin is as likely to be a vowel as the middle of the range.
  const cut = total * options.tail;
  let low = 1;
  let seen = 0;
  while (low < bins - 1 && seen + (perBin[low] ?? 0) < cut) { seen += perBin[low] ?? 0; low++; }
  let high = bins - 1;
  seen = 0;
  while (high > low && seen + (perBin[high] ?? 0) < cut) { seen += perBin[high] ?? 0; high--; }

  const lowHz = binHz(low, fftSize, sampleRate);
  const highHz = binHz(high, fftSize, sampleRate);
  if (lowHz <= 0 || highHz <= lowHz) return blank;
  if (Math.log2(highHz / lowHz) < options.minOctaves) return blank;

  const fade = Math.max(options.fadeOctaves, 1e-6);
  for (let b = 0; b < bins; b++) {
    const hz = binHz(b, fftSize, sampleRate);
    if (hz <= 0) { weight[b] = options.outside; continue; }
    // Distance outside the range, in octaves — zero inside it.
    const below = hz < lowHz ? Math.log2(lowHz / hz) : 0;
    const above = hz > highHz ? Math.log2(hz / highHz) : 0;
    const out = Math.min(1, Math.max(below, above) / fade);
    // Raised cosine from 1 at the edge to `outside` an octave past it.
    const taper = 0.5 * (1 + Math.cos(Math.PI * out));
    weight[b] = options.outside + (1 - options.outside) * taper;
  }
  return { weight, lowHz, highHz, informative: true };
}
