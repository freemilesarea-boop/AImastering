// Measurement helpers for the M1 equivalence harness.
//
// Apples-to-apples policy:
//   - LUFS-I / TP / LRA are measured by spawning the system `ffmpeg` and
//     parsing loudnorm pass-1 JSON.  This guarantees the same numbers
//     Python's test produces on the same WAV.
//   - RMS / crest / 1/3-octave spectrum are computed in TS using the
//     same arithmetic as tests/test_engine_preset_render.py.  Audited
//     numerically by feeding both sides the same WAV — drift would
//     surface as Python_RMS ≠ TS_RMS on an unmastered fixture.

import { spawnSync } from 'node:child_process';

export interface LoudnessMeasurement {
  lufsI: number;
  tpDb: number;
  lra: number;
  threshDb: number;
}

export function measureLoudness(path: string, ffmpegBin = 'ffmpeg'): LoudnessMeasurement {
  // loudnorm pass-1 prints a JSON block to stderr.  We must capture stderr
  // regardless of ffmpeg's exit code (it sometimes returns non-zero on
  // null sinks even when the measurement succeeded).
  const r = spawnSync(
    ffmpegBin,
    [
      '-hide_banner',
      '-i', path,
      '-af', 'loudnorm=I=-14:TP=-1:LRA=11:print_format=json',
      '-f', 'null', '-',
    ],
    { encoding: 'utf-8' },
  );
  const stderr = r.stderr ?? '';
  const m = stderr.match(/\{[^{}]*"input_i"[\s\S]*?\}/);
  if (!m) {
    throw new Error(
      `loudnorm JSON not found in ffmpeg stderr for ${path} (exit=${r.status})\n--- stderr (tail) ---\n${stderr.slice(-2000)}`,
    );
  }
  const j = JSON.parse(m[0]);
  return {
    lufsI: Number(j.input_i),
    tpDb:  Number(j.input_tp),
    lra:   Number(j.input_lra),
    threshDb: Number(j.input_thresh),
  };
}

export function rmsDb(channels: Float32Array[]): number {
  if (channels.length === 0) return -Infinity;
  let sum = 0;
  let n = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) sum += ch[i]! * ch[i]!;
    n += ch.length;
  }
  if (n === 0) return -Infinity;
  const rms = Math.sqrt(sum / n);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

export function crestDb(channels: Float32Array[]): number {
  let peak = 0;
  let sum = 0;
  let n = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]!);
      if (a > peak) peak = a;
      sum += a * a;
      n++;
    }
  }
  if (n === 0 || peak <= 0) return 0;
  const rms = Math.sqrt(sum / n);
  if (rms <= 0) return 0;
  return 20 * Math.log10(peak / rms);
}

// ANSI S1.11 1/3-oct centres (must match Python side).
export const THIRD_OCT_CENTRES = [
  25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630,
  800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000,
  12500, 16000, 20000,
];

/** Mix planar to mono, Hann window, |FFT|, bin into 1/3-oct. */
export function thirdOctaveSpectrumDb(
  channels: Float32Array[],
  sampleRate: number,
): Record<string, number> {
  const n = channels[0]?.length ?? 0;
  if (n === 0) {
    const out: Record<string, number> = {};
    for (const c of THIRD_OCT_CENTRES) out[String(c)] = -Infinity;
    return out;
  }
  // Mix to mono.
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const ch of channels) s += ch[i]!;
    mono[i] = s / channels.length;
  }
  // Hann window.
  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  let winSum = 0;
  for (let i = 0; i < n; i++) winSum += win[i]!;

  // Naive DFT is O(n²) — for 20s @ 44.1k = ~3e11 ops, far too slow.
  // We use a hand-rolled iterative power-of-two FFT (Cooley-Tukey).
  const N = nextPow2(n);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < n; i++) re[i] = mono[i]! * win[i]!;
  fftRadix2(re, im);

  const freqs: number[] = new Array(N / 2 + 1);
  for (let k = 0; k <= N / 2; k++) freqs[k] = (k * sampleRate) / N;

  const mag: number[] = new Array(N / 2 + 1);
  // Magnitude normalization to match Python (np.fft.rfft, dividing by sum(win)/2)
  const norm = winSum / 2;
  for (let k = 0; k <= N / 2; k++) {
    const r = re[k]!, ii = im[k]!;
    mag[k] = Math.sqrt(r * r + ii * ii) / norm;
  }

  const out: Record<string, number> = {};
  for (const cf of THIRD_OCT_CENTRES) {
    const lo = cf / Math.pow(2, 1 / 6);
    const hi = cf * Math.pow(2, 1 / 6);
    let bandSum = 0;
    let bandN = 0;
    for (let k = 0; k <= N / 2; k++) {
      const f = freqs[k]!;
      if (f >= lo && f < hi) {
        bandSum += mag[k]! * mag[k]!;
        bandN++;
      }
    }
    if (bandN === 0) {
      out[String(cf)] = -Infinity;
    } else {
      const rms = Math.sqrt(bandSum / bandN);
      out[String(cf)] = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    }
  }
  return out;
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// In-place iterative Cooley-Tukey radix-2 FFT (Float64).
function fftRadix2(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('fftRadix2: n must be power of 2');
  // Bit-reversal permutation.
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  // Butterflies.
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1.0;
      let curIm = 0.0;
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k]!,            aIm = im[i + k]!;
        const bRe = re[i + k + half]! * curRe - im[i + k + half]! * curIm;
        const bIm = re[i + k + half]! * curIm + im[i + k + half]! * curRe;
        re[i + k]        = aRe + bRe;
        im[i + k]        = aIm + bIm;
        re[i + k + half] = aRe - bRe;
        im[i + k + half] = aIm - bIm;
        const newRe = curRe * wRe - curIm * wIm;
        const newIm = curRe * wIm + curIm * wRe;
        curRe = newRe;
        curIm = newIm;
      }
    }
  }
}
