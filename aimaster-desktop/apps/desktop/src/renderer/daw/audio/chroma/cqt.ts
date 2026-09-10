// Constant-Q transform — the reason a chord detector can hear a bass note.
//
// ── Why the STFT this repo already has cannot do this ───────────────────────
//
// `stft.ts` is a linear-frequency transform, and music is logarithmic.  At the
// 2048-point size the spectral editor uses, the bins are 21.5 Hz apart at
// 44.1 kHz.  Down where a bass line lives:
//
//     E2 = 82.41 Hz    F2 = 87.31 Hz    →  4.9 Hz apart
//
// Two adjacent semitones land in the SAME BIN.  A transform that cannot tell
// E from F cannot tell Am from Dm, and no amount of cleverness downstream
// recovers information the transform threw away.
//
// Raising the FFT size does not fix it either, not really: resolving a
// semitone at C1 (32.7 Hz, 1.9 Hz to the next note) needs a window around
// 1.5 seconds long, and a 1.5-second window smears every chord change in the
// song.  The requirement is contradictory ONLY if the window has to be one
// length — which is exactly what the constant-Q transform stops assuming.
//
// ── What constant-Q means ───────────────────────────────────────────────────
//
// Q is centre frequency divided by bandwidth.  Holding it CONSTANT means every
// bin is the same number of cents wide, so a bin at 80 Hz is narrow in hertz
// and a bin at 3 kHz is wide — which is what a musician's ear does, and what
// "one bin per semitone" requires.  The price is that each bin needs its own
// window length: low bins integrate over a long time, high bins over a short
// one.
//
// ── How it is computed here ─────────────────────────────────────────────────
//
// Naively that is one filter per bin per frame, which is far too slow for a
// four-minute song.  Instead this uses Brown & Puckette's spectral-kernel
// trick: each constant-Q basis function is transformed ONCE, at build time,
// into the FFT domain, where it is nearly all zeros — a narrow bump.  Keeping
// only the bump gives a SPARSE matrix, and the whole transform becomes
//
//     one FFT per frame  →  one sparse matrix multiply
//
// The kernel is built once per (sampleRate, layout) and cached, because a song
// is thousands of frames and the kernel is the expensive part.

import { fft, hannWindow } from '../fft.js';

/** Where the analysis starts.  See `DEFAULT_CQT` for why C2 and not C1. */
export interface CqtLayout {
  /** Frequency of the lowest bin, in Hz. */
  minHz: number;
  /** How many bins per octave.  36 = three per semitone. */
  binsPerOctave: number;
  /** Total bins.  `octaves = bins / binsPerOctave`. */
  bins: number;
}

/**
 * Three bins per semitone from C2 to C7.
 *
 * C2 (65.4 Hz) rather than C1: a C1 bin needs a window of about 1.5 s at
 * this Q, which is longer than most chords, and almost nothing in a mix has
 * usable harmonic content down there that the bass stem does not carry
 * better.  The bass end of the chord is read from the bass stem instead.
 *
 * Three bins per semitone rather than one is what makes the TUNING estimate
 * possible — with one bin per semitone a track recorded 30 cents sharp just
 * looks like a quieter track, and every chroma value is wrong by a third of a
 * bin with nothing to notice it.
 */
export const DEFAULT_CQT: CqtLayout = {
  minHz: 65.406391,          // C2
  binsPerOctave: 36,
  bins: 36 * 5,              // C2 … C7
};

export interface CqtKernel {
  layout: CqtLayout;
  sampleRate: number;
  /** FFT size every frame is transformed at. */
  fftSize: number;
  /** Longest basis window, in samples — the frame must be at least this. */
  maxWindow: number;
  /** Per bin: the FFT bins it draws from, and the complex weights. */
  starts: Int32Array;
  lengths: Int32Array;
  re: Float64Array[];
  im: Float64Array[];
  /** Centre frequency of each bin. */
  centres: Float64Array;
}

/** Q for a given resolution: the classic 1/(2^(1/b) − 1). */
export function qFor(binsPerOctave: number): number {
  return 1 / (Math.pow(2, 1 / binsPerOctave) - 1);
}

export function centreHz(layout: CqtLayout, bin: number): number {
  return layout.minHz * Math.pow(2, bin / layout.binsPerOctave);
}

/**
 * Values below this fraction of a kernel's peak are dropped.
 *
 * The sparsity IS the speed: a full kernel is bins × fftSize complex weights,
 * and at the sizes here that is tens of millions of multiplies per frame.
 * The threshold has to be low enough not to distort the basis and high enough
 * to leave a narrow band — 0.0054 is the value Brown & Puckette used and it
 * holds up.
 */
const SPARSITY = 0.0054;

const kernelCache = new Map<string, CqtKernel>();

/**
 * Build (or fetch) the sparse spectral kernel.
 *
 * Expensive — one FFT per bin — so it is cached by sample rate and layout.  A
 * song is thousands of frames against one kernel.
 */
export function cqtKernel(sampleRate: number, layout: CqtLayout = DEFAULT_CQT): CqtKernel {
  const key = `${sampleRate}|${layout.minHz}|${layout.binsPerOctave}|${layout.bins}`;
  const hit = kernelCache.get(key);
  if (hit) return hit;

  const q = qFor(layout.binsPerOctave);
  // The LOWEST bin needs the longest window, and the FFT has to hold it.
  const maxWindow = Math.ceil((q * sampleRate) / layout.minHz);
  let fftSize = 1;
  while (fftSize < maxWindow) fftSize *= 2;

  const starts = new Int32Array(layout.bins);
  const lengths = new Int32Array(layout.bins);
  const re: Float64Array[] = [];
  const im: Float64Array[] = [];
  const centres = new Float64Array(layout.bins);

  const workRe = new Float64Array(fftSize);
  const workIm = new Float64Array(fftSize);

  for (let k = 0; k < layout.bins; k++) {
    const hz = centreHz(layout, k);
    centres[k] = hz;
    // This bin's window: exactly Q cycles of its own frequency.  That is what
    // makes the transform constant-Q rather than a filterbank with a shared
    // window.
    const windowLength = Math.min(fftSize, Math.max(4, Math.round((q * sampleRate) / hz)));
    const window = hannWindow(windowLength);

    workRe.fill(0);
    workIm.fill(0);
    // Centred in the FFT frame, so every bin's basis is aligned in time.  Off
    // by half a window and the low bins would read the wrong part of the frame.
    const offset = ((fftSize - windowLength) >> 1);
    for (let n = 0; n < windowLength; n++) {
      const angle = (2 * Math.PI * q * n) / windowLength;
      const w = (window[n] ?? 0) / windowLength;
      workRe[offset + n] = w * Math.cos(angle);
      workIm[offset + n] = w * Math.sin(angle);
    }
    fft(workRe, workIm);

    // Keep the bump, drop the rest.
    let peak = 0;
    for (let i = 0; i < fftSize; i++) {
      const m = Math.hypot(workRe[i] ?? 0, workIm[i] ?? 0);
      if (m > peak) peak = m;
    }
    const floor = peak * SPARSITY;
    let first = -1;
    let last = -1;
    for (let i = 0; i < fftSize; i++) {
      const m = Math.hypot(workRe[i] ?? 0, workIm[i] ?? 0);
      if (m <= floor) continue;
      if (first < 0) first = i;
      last = i;
    }
    if (first < 0) { first = 0; last = 0; }

    const length = last - first + 1;
    starts[k] = first;
    lengths[k] = length;
    // Conjugated here rather than at every frame: the transform is a dot
    // product with the conjugate, and doing it once per kernel saves a sign
    // flip per weight per frame for the life of the song.
    const kr = new Float64Array(length);
    const ki = new Float64Array(length);
    for (let i = 0; i < length; i++) {
      kr[i] = workRe[first + i] ?? 0;
      ki[i] = -(workIm[first + i] ?? 0);
    }
    re.push(kr);
    im.push(ki);
  }

  const kernel: CqtKernel = {
    layout, sampleRate, fftSize, maxWindow, starts, lengths, re, im, centres,
  };
  kernelCache.set(key, kernel);
  return kernel;
}

/**
 * One frame's constant-Q magnitudes.
 *
 * `samples` is read starting at `from`; anything past the end reads as
 * silence, so the last frames of a file do not need a padded copy.
 */
export function cqtFrame(
  kernel: CqtKernel, samples: ArrayLike<number>, from: number,
  out = new Float32Array(kernel.layout.bins),
): Float32Array {
  const { fftSize } = kernel;
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    const j = from + i;
    re[i] = j >= 0 && j < samples.length ? (samples[j] ?? 0) : 0;
  }
  fft(re, im);

  for (let k = 0; k < kernel.layout.bins; k++) {
    const start = kernel.starts[k] ?? 0;
    const kr = kernel.re[k];
    const ki = kernel.im[k];
    if (!kr || !ki) { out[k] = 0; continue; }
    let sumRe = 0;
    let sumIm = 0;
    for (let i = 0; i < kr.length; i++) {
      const xr = re[start + i] ?? 0;
      const xi = im[start + i] ?? 0;
      const wr = kr[i] ?? 0;
      const wi = ki[i] ?? 0;
      sumRe += xr * wr - xi * wi;
      sumIm += xr * wi + xi * wr;
    }
    out[k] = Math.hypot(sumRe, sumIm);
  }
  return out;
}

export interface Cqtgram {
  /** One Float32Array of `layout.bins` magnitudes per frame. */
  frames: Float32Array[];
  layout: CqtLayout;
  sampleRate: number;
  hopSize: number;
}

/**
 * The whole signal, frame by frame.
 *
 * The hop is in SAMPLES and independent of the kernel's window: the frames
 * overlap heavily at the low end (a C2 basis is a third of a second long) and
 * barely at the top, which is the point of the transform.
 */
export function cqtgram(
  samples: ArrayLike<number>, sampleRate: number,
  hopSize: number, layout: CqtLayout = DEFAULT_CQT,
): Cqtgram {
  const kernel = cqtKernel(sampleRate, layout);
  const frames: Float32Array[] = [];
  if (samples.length === 0 || hopSize <= 0) {
    return { frames, layout, sampleRate, hopSize: Math.max(1, hopSize) };
  }
  // Frames are CENTRED on their timestamp, like every other analysis in this
  // repo, so a chord change at 12.0 s is read from audio around 12.0 s rather
  // than from the window that happens to start there.
  const half = kernel.fftSize >> 1;
  for (let centre = 0; centre < samples.length; centre += hopSize) {
    frames.push(cqtFrame(kernel, samples, centre - half));
  }
  return { frames, layout, sampleRate, hopSize };
}

/** Seconds of the frame at this index. */
export function cqtFrameSec(gram: Cqtgram, index: number): number {
  return (index * gram.hopSize) / gram.sampleRate;
}
