// Where in the spectrum a leak lives.
//
// "The bass stem took 58 % of the drums" does not say whether that is all
// sub-100 Hz — the shelf claiming a kick — or spread across the whole
// spectrum, which would be a different fault with a different fix.  So the
// leak is measured again, band by band.
//
// This lives in its own file because BOTH the benchmark and the self-test need
// it, and they need it to be the SAME measurement.  Every band-shaped defect
// the real song has shown so far was invisible to the suite: the summary
// number a test asserts on is a sum over the spectrum, and a stem can lose an
// entire octave without moving it much.  Twice now the real run has found
// something the fixture could not — a kick tail under the bass, and a notch at
// a kilohertz where no drum template reached.  A test can only catch the next
// one if it can ask the same question.

import {
  SEPARATION_STFT, analyse, frameCount, magnitudes,
} from '../src/renderer/daw/audio/separate/spectrum.js';

export const BAND_EDGES = [0, 45, 90, 180, 355, 710, 1400, 2800, 5600, 11200, 1e9];
export const BAND_NAMES = ['<45', '63', '125', '250', '500', '1k', '2k', '4k', '8k', '16k+'];

/** Magnitude spectrogram of the mono sum, and which band each bin is in. */
function spectrum(channels: readonly Float32Array[], rate: number): {
  mag: Float32Array; frames: number; bins: number; band: Int32Array;
} {
  const mono = new Float32Array(channels[0]!.length);
  for (const ch of channels) for (let i = 0; i < mono.length; i++) mono[i] = (mono[i] ?? 0) + (ch[i] ?? 0);
  const spec = analyse(mono, rate, 0, frameCount(mono.length));
  const band = new Int32Array(spec.bins);
  for (let b = 0; b < spec.bins; b++) {
    const hz = (b * rate) / SEPARATION_STFT.fftSize;
    let k = BAND_EDGES.length - 2;
    for (let e = 0; e < BAND_EDGES.length - 1; e++) {
      if (hz >= (BAND_EDGES[e] ?? 0) && hz < (BAND_EDGES[e + 1] ?? 0)) { k = e; break; }
    }
    band[b] = k;
  }
  return { mag: magnitudes(spec), frames: spec.frames, bins: spec.bins, band };
}

export function bandShare(bands: number[]): string {
  const total = bands.reduce((a, b) => a + b, 0);
  return bands.map((v) => (total > 0 ? Math.round((100 * v) / total) : 0).toString().padStart(5)).join('');
}

/** Energy per band. */
export function energyByBand(channels: readonly Float32Array[], rate: number): number[] {
  const { mag, frames, bins, band } = spectrum(channels, rate);
  const out = new Array<number>(BAND_NAMES.length).fill(0);
  for (let f = 0; f < frames; f++) {
    const base = f * bins;
    for (let b = 1; b < bins; b++) {
      const k = band[b] ?? 0;
      out[k] = (out[k] ?? 0) + (mag[base + b] ?? 0) ** 2;
    }
  }
  return out;
}

/**
 * How much of `truth` is inside `estimate`, measured within each band.
 *
 * The same ratio the summary reports, restricted to the bins of one band —
 * `Σ|S||T| / Σ|T|²` — so a band where the leak lives reads high and a band
 * where it does not reads near zero, regardless of how loud the band is.
 */
export function leakByBand(
  estimate: readonly Float32Array[], truth: readonly Float32Array[], rate: number,
): Array<number | null> {
  const e = spectrum(estimate, rate);
  const t = spectrum(truth, rate);
  const frames = Math.min(e.frames, t.frames);
  const num = new Array<number>(BAND_NAMES.length).fill(0);
  const den = new Array<number>(BAND_NAMES.length).fill(0);
  for (let f = 0; f < frames; f++) {
    const eb = f * e.bins;
    const tb = f * t.bins;
    for (let b = 1; b < Math.min(e.bins, t.bins); b++) {
      const k = e.band[b] ?? 0;
      const ev = e.mag[eb + b] ?? 0;
      const tv = t.mag[tb + b] ?? 0;
      num[k] = (num[k] ?? 0) + ev * tv;
      den[k] = (den[k] ?? 0) + tv * tv;
    }
  }
  // A band the truth barely occupies gives a ratio with almost nothing on the
  // bottom of it, and the answer comes out in the hundreds — which reads like
  // catastrophic leakage and is actually a division by silence.  Those bands
  // get a dot: there is no truth there to have leaked.
  const total = den.reduce((a, b) => a + b, 0);
  return num.map((v, k) => {
    const bottom = den[k] ?? 0;
    if (total <= 0 || bottom / total < 0.01) return null;
    return (100 * v) / bottom;
  });
}

