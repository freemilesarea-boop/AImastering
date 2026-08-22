// The spectral core the separator masks.
//
// ── Why not just use stft() ───────────────────────────────────────────────────
//
// `audio/stft.ts` keeps every frame as a Float64Array of 2·fftSize — the full
// complex spectrum including the conjugate mirror.  That is right for spectral
// repair, where the user selects a second or two.  It is impossible for a song:
// four minutes at 48 kHz with a 4096-point window and a 1024 hop is ~11 250
// frames per channel, and 11 250 × 64 KB is 720 MB per channel before a single
// mask exists.
//
// So this stores the HALF spectrum (bins 0…fftSize/2, the only ones a real
// signal has independent information in) as Float32, interleaved re/im, in ONE
// flat array per channel.  Same four minutes: 92 MB per channel, and every bin
// is one indexed read away.
//
// ── Chunking without changing the answer ─────────────────────────────────────
//
// Even 92 MB × 2 channels × the masks is more than a renderer should hold, so
// the separator works a window at a time.  That is only acceptable if a chunked
// run and a whole-file run produce the SAME samples, and here they do, because
// the overlap-add is split into a numerator and a denominator that are
// ACCUMULATED across chunks and divided once at the end.  There is no per-chunk
// normalisation to disagree about, and no cross-fade to tune: a sample in the
// middle of a chunk and the same sample at a chunk edge go through identical
// arithmetic.  `scripts/separate-selftest.ts` asserts it bit for bit.
//
// The one thing that is NOT chunk-invariant is anything with a long memory —
// the repetition model in `repet.ts` — and that is why its window is a stated
// parameter rather than an accident of the chunk size.

import { fft, hannWindow, isPow2 } from '../fft.js';

export interface SpectrumOptions {
  fftSize: number;
  hopSize: number;
}

/**
 * 4096 / 1024 at 44.1–48 kHz: an 85–93 ms window and a 21–23 ms hop.
 *
 * The window has to be long enough to resolve a bass note's harmonics (a 41 Hz
 * low E needs > 25 ms just for one cycle) and short enough that a snare is not
 * smeared across half a beat.  This is the usual compromise, and it is the one
 * every published median-filter separator uses.
 */
export const SEPARATION_STFT: SpectrumOptions = { fftSize: 4096, hopSize: 1024 };

/** Half-spectrum frames for one channel, flat and interleaved. */
export interface HalfSpectrum {
  /** `[re, im]` per bin, frame-major: bin b of frame f is at `(f*bins + b)*2`. */
  data: Float32Array;
  frames: number;
  bins: number;
  fftSize: number;
  hopSize: number;
  sampleRate: number;
  /** Sample index in the source that frame 0 is centred on. */
  originSample: number;
}

export const binsFor = (fftSize: number): number => (fftSize >> 1) + 1;

export function binHz(bin: number, fftSize: number, sampleRate: number): number {
  return (bin * sampleRate) / fftSize;
}

/**
 * How many frames of context a chunk needs on each side so its interior is
 * indistinguishable from a whole-file run.
 *
 * Two things reach across frames: the overlap-add (a sample is touched by every
 * frame within half a window) and whatever the masks smooth over.  Give it both
 * and the interior is exact.
 */
export function contextFrames(options: SpectrumOptions, maskFrames: number): number {
  return Math.ceil(options.fftSize / options.hopSize) + Math.max(0, maskFrames);
}

/**
 * Analyse `[fromFrame, toFrame)` of a signal.
 *
 * Frame f is centred on sample `f * hopSize`, matching `audio/stft.ts`, so the
 * two agree about where in the file a frame is.
 */
export function analyse(
  samples: ArrayLike<number>, sampleRate: number,
  fromFrame: number, toFrame: number, options: SpectrumOptions = SEPARATION_STFT,
): HalfSpectrum {
  const { fftSize, hopSize } = options;
  if (!isPow2(fftSize)) throw new Error('fftSize must be a power of two');
  const frames = Math.max(0, toFrame - fromFrame);
  const bins = binsFor(fftSize);
  const data = new Float32Array(frames * bins * 2);

  const window = hannWindow(fftSize);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const half = fftSize >> 1;

  for (let f = 0; f < frames; f++) {
    const offset = (fromFrame + f) * hopSize - half;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < fftSize; i++) {
      const index = offset + i;
      if (index < 0 || index >= samples.length) continue;
      re[i] = (samples[index] ?? 0) * (window[i] ?? 0);
    }
    fft(re, im, false);
    const base = f * bins * 2;
    for (let b = 0; b < bins; b++) {
      data[base + b * 2] = re[b] ?? 0;
      data[base + b * 2 + 1] = im[b] ?? 0;
    }
  }

  return {
    data, frames, bins, fftSize, hopSize, sampleRate,
    originSample: fromFrame * hopSize,
  };
}

/** Total frames needed to cover `length` samples. */
export function frameCount(length: number, options: SpectrumOptions = SEPARATION_STFT): number {
  return Math.max(1, Math.ceil(length / options.hopSize) + 1);
}

export function magnitudeAt(spec: HalfSpectrum, frame: number, bin: number): number {
  const i = (frame * spec.bins + bin) * 2;
  const re = spec.data[i] ?? 0;
  const im = spec.data[i + 1] ?? 0;
  return Math.hypot(re, im);
}

/** Magnitudes for a whole chunk, frame-major.  One pass, reused everywhere. */
export function magnitudes(spec: HalfSpectrum, out?: Float32Array): Float32Array {
  const n = spec.frames * spec.bins;
  const result = out && out.length >= n ? out : new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const re = spec.data[i * 2] ?? 0;
    const im = spec.data[i * 2 + 1] ?? 0;
    result[i] = Math.hypot(re, im);
  }
  return result;
}

/**
 * The overlap-add accumulator.
 *
 * Numerator and denominator are kept apart and divided in `finish()`, which is
 * what makes a chunked run identical to a whole-file one — see the header.
 * The denominator is the same for every stem and every channel, so it is
 * counted once, by the first writer, and shared.
 */
export class Overlap {
  /**
   * Float32, not Float64, and the difference is not academic.
   *
   * There is one of these per stem per channel: four stems of a four-minute
   * stereo song is eight of them, and at eight bytes a sample that is 736 MB
   * of accumulator before the output buffers exist.  At four bytes it is 368,
   * which a renderer can hold alongside the 368 MB the finished stems occupy.
   *
   * The cost is precision, and it was measured rather than assumed: a sample
   * is the sum of four overlapping windows, so the rounding is four adds deep,
   * and the reconstruction error the self-test measures moved from −152 dB to
   * −146 dB.  Both are far below anything audible and far below the −100 dB
   * the test demands; 736 MB is not far below anything.
   */
  readonly numerator: Float32Array;
  constructor(readonly length: number, readonly fftSize: number,
              private readonly denominator: Float32Array | null = null) {
    this.numerator = new Float32Array(length + fftSize);
  }

  /**
   * Inverse-transform `spec` after `mask` has been applied and add it in.
   *
   * `mask` is one gain per (frame, bin); pass null for an unmasked pass.
   * `countDenominator` must be true for exactly one writer per output.
   */
  add(spec: HalfSpectrum, mask: Float32Array | null, countDenominator: boolean): void {
    const { fftSize, hopSize, frames, bins, originSample } = spec;
    const window = hannWindow(fftSize);
    const re = new Float64Array(fftSize);
    const im = new Float64Array(fftSize);
    const half = fftSize >> 1;
    const den = this.denominator;

    for (let f = 0; f < frames; f++) {
      const base = f * bins * 2;
      const mbase = f * bins;
      re.fill(0);
      im.fill(0);
      for (let b = 0; b < bins; b++) {
        const g = mask === null ? 1 : (mask[mbase + b] ?? 0);
        const rv = (spec.data[base + b * 2] ?? 0) * g;
        const iv = (spec.data[base + b * 2 + 1] ?? 0) * g;
        re[b] = rv;
        im[b] = iv;
        // A real signal's spectrum mirrors around Nyquist.  The half spectrum
        // does not store the mirror, so it is rebuilt here — without it the
        // inverse transform is complex, i.e. wrong.
        const mirror = fftSize - b;
        if (b > 0 && mirror < fftSize) {
          re[mirror] = rv;
          im[mirror] = -iv;
        }
      }
      fft(re, im, true);

      const offset = originSample + f * hopSize - half;
      for (let i = 0; i < fftSize; i++) {
        const index = offset + i + half;
        if (index < 0 || index >= this.numerator.length) continue;
        const w = window[i] ?? 0;
        this.numerator[index] = (this.numerator[index] ?? 0) + (re[i] ?? 0) * w;
        if (countDenominator && den) den[index] = (den[index] ?? 0) + w * w;
      }
    }
  }

  /** Divide through and trim.  `denominator` must have seen every frame. */
  finish(denominator: Float32Array): Float32Array {
    const half = this.fftSize >> 1;
    const out = new Float32Array(this.length);
    for (let i = 0; i < this.length; i++) {
      const w = denominator[i + half] ?? 0;
      out[i] = w > 1e-8 ? (this.numerator[i + half] ?? 0) / w : 0;
    }
    return out;
  }
}

/**
 * A denominator buffer sized to match an `Overlap` of the same length.
 *
 * One of these is shared by every stem and every channel, because the window
 * sum does not depend on what is being windowed.
 */
export function denominatorFor(length: number, fftSize: number): Float32Array {
  return new Float32Array(length + fftSize);
}
