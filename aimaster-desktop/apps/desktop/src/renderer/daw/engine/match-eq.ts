// match-eq — the difference between two spectra, as a filter.
//
// A reference track is already in this app: `analysis/reference.ts` drops a
// commercial master alongside the mix and lines up LUFS, true peak, dynamic
// range, width and three tonal bands.  What it cannot do is ACT, and the
// distance between "your mix is 1.7 dB darker up top" and a curve that fixes
// it is the whole of this device.
//
// So: take the reference's average spectrum and the mix's, subtract, and make
// the answer a filter.  Both spectra are level-normalised before they are
// compared — `averageSpectrum` offsets each one so its broadband level reads
// 0 dB — so a quieter mix is not a darker mix, and the difference is tonal
// balance rather than a restatement of the loudness gap.
//
// ── Why the correction is not just the difference ──────────────────────────
//
// A raw band-for-band difference is the wrong filter for three separate
// reasons, and all three have a control:
//
//   · it is NOISY.  Two different pieces of music never agree band to band,
//     and the disagreement at 0.3-octave resolution is mostly arrangement:
//     where this bass note sat, which cymbal was hit.  Smoothing decides how
//     much of the difference is tonality and how much is the tune.
//   · it is UNBOUNDED.  A reference with a sub the mix does not have asks for
//     twenty decibels at 30 Hz, which is not an EQ move, it is a fault.
//   · it is ALL OR NOTHING.  Matching a reference exactly makes your mix a
//     worse copy of theirs.  Amount is the control people actually live on,
//     and it belongs at less than 100.
//
// ── What it is applied by ──────────────────────────────────────────────────
//
// The linear-phase designer, for a reason specific to this job: a matching
// curve is a broad, gentle, many-band shape, and doing it in biquads would
// rotate the phase differently at every one of those bands.  The magnitude
// would match and the transients would not.  It costs what linear phase
// always costs — see `linear-phase.ts` — and the device declares it.

import { designLinearPhase, LINPHASE_LENGTHS } from './linear-phase.js';
import type { SpectrumCurve } from '../analysis/reference.js';

/** How many bands the stored curve has. */
export const MATCH_BANDS = 32;
const MATCH_MIN_HZ = 25;
const MATCH_MAX_HZ = 20_000;

/**
 * The band centres, geometric means of log-spaced edges.
 *
 * The same construction `averageSpectrum` uses, so a curve measured there
 * lands on these centres without being resampled twice.
 */
export const MATCH_HZ: readonly number[] = (() => {
  const out: number[] = [];
  const ratio = Math.log(MATCH_MAX_HZ / MATCH_MIN_HZ);
  const edge = (i: number): number => MATCH_MIN_HZ * Math.exp((ratio * i) / MATCH_BANDS);
  for (let b = 0; b < MATCH_BANDS; b++) out.push(Math.sqrt(edge(b) * edge(b + 1)));
  return out;
})();

/** The parameter id a band's gain is stored under. */
export const matchBandId = (b: number): string => `m${b}`;

/** Read a spectrum at a frequency, interpolated in log-frequency and dB. */
function sampleCurve(curve: SpectrumCurve, hz: number): number {
  const n = curve.hz.length;
  if (n === 0) return 0;
  if (hz <= (curve.hz[0] ?? 0)) return curve.db[0] ?? 0;
  if (hz >= (curve.hz[n - 1] ?? 0)) return curve.db[n - 1] ?? 0;
  for (let i = 1; i < n; i++) {
    const hi = curve.hz[i] ?? 0;
    if (hz > hi) continue;
    const lo = curve.hz[i - 1] ?? 0;
    const t = Math.log(hz / lo) / Math.log(hi / lo);
    return (curve.db[i - 1] ?? 0) + t * ((curve.db[i] ?? 0) - (curve.db[i - 1] ?? 0));
  }
  return curve.db[n - 1] ?? 0;
}

/**
 * The raw correction: what the mix would have to be given, band by band, to
 * have the reference's tonal balance.
 *
 * Stored unsmoothed, unscaled and unclamped, because the three controls that
 * do those things have to remain movable after the match has been taken.  A
 * curve baked at 40 % smoothed over an octave cannot be un-baked.
 */
export function matchCurve(
  reference: SpectrumCurve, mix: SpectrumCurve,
): number[] {
  return MATCH_HZ.map((hz) => sampleCurve(reference, hz) - sampleCurve(mix, hz));
}

export interface MatchShape {
  amount: number;
  /** Smoothing width, in octaves.  0 leaves the raw band difference. */
  smoothOct: number;
  /** The most the curve may boost or cut, in dB. */
  limitDb: number;
}

/**
 * The curve as it will actually be applied: smoothed, scaled, clamped.
 *
 * Smoothing is a Gaussian in LOG frequency, which is the only weighting that
 * means the same thing at 50 Hz and at 5 kHz — an octave is an octave.  It
 * runs over the stored bands rather than over the filter, so the controls
 * stay live: the curve in the session is always the raw measurement.
 */
export function matchShapeDb(
  stored: readonly number[], shape: MatchShape,
): number[] {
  const n = MATCH_BANDS;
  const perBand = Math.log2(MATCH_MAX_HZ / MATCH_MIN_HZ) / n;   // octaves per band
  const sigma = Math.max(1e-6, shape.smoothOct) / perBand;
  const out: number[] = [];
  for (let b = 0; b < n; b++) {
    let sum = 0;
    let weight = 0;
    // Three sigma either side: past that the weight is under a thousandth.
    const reach = Math.min(n, Math.ceil(sigma * 3));
    for (let k = -reach; k <= reach; k++) {
      const i = b + k;
      if (i < 0 || i >= n) continue;
      const w = Math.exp(-(k * k) / (2 * sigma * sigma));
      sum += (stored[i] ?? 0) * w;
      weight += w;
    }
    const smoothed = weight > 0 ? sum / weight : 0;
    const scaled = smoothed * shape.amount;
    out.push(Math.max(-shape.limitDb, Math.min(shape.limitDb, scaled)));
  }
  return out;
}

/** The applied curve as a function of frequency, for the designer and the picture. */
export function matchMagnitudeAt(applied: readonly number[], hz: number): number {
  const n = MATCH_BANDS;
  if (hz <= MATCH_HZ[0]!) return applied[0] ?? 0;
  if (hz >= MATCH_HZ[n - 1]!) return applied[n - 1] ?? 0;
  for (let b = 1; b < n; b++) {
    const hi = MATCH_HZ[b]!;
    if (hz > hi) continue;
    const lo = MATCH_HZ[b - 1]!;
    const t = Math.log(hz / lo) / Math.log(hi / lo);
    return (applied[b - 1] ?? 0) + t * ((applied[b] ?? 0) - (applied[b - 1] ?? 0));
  }
  return applied[n - 1] ?? 0;
}

/** The stored bands out of a parameter set. */
export function matchStored(params: Record<string, number>): number[] {
  const out: number[] = [];
  for (let b = 0; b < MATCH_BANDS; b++) {
    const v = params[matchBandId(b)];
    out.push(typeof v === 'number' && Number.isFinite(v) ? v : 0);
  }
  return out;
}

/** The shape controls out of a parameter set. */
export function matchShapeOf(params: Record<string, number>): MatchShape {
  const num = (id: string, fallback: number): number => {
    const v = params[id];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  return {
    amount: Math.max(0, Math.min(1, num('amount', 0.7))),
    smoothOct: Math.max(0, Math.min(2, num('smoothOct', 0.5))),
    limitDb: Math.max(0, Math.min(18, num('limitDb', 6))),
  };
}

/** The curve a parameter set will apply, band by band. */
export function matchApplied(params: Record<string, number>): number[] {
  return matchShapeDb(matchStored(params), matchShapeOf(params));
}

/** The length in taps a parameter set selects. */
export function matchTaps(params: Record<string, number>): number {
  const raw = params['length'];
  const i = Math.round(typeof raw === 'number' && Number.isFinite(raw) ? raw : 1);
  return LINPHASE_LENGTHS[Math.max(0, Math.min(LINPHASE_LENGTHS.length - 1, i))]!.taps;
}

/** How late the device is — half the response, as linear phase always is. */
export function matchLatency(params: Record<string, number>): number {
  return (matchTaps(params) - 1) / 2;
}

/**
 * The impulse response a parameter set describes.
 *
 * How long a response the curve needs is a question this file got wrong.
 *
 * "A match curve is broad, so the shortest response holds it" is the obvious
 * argument and it is false.  A band is 0.31 octaves, which at 785 Hz is 164 Hz
 * wide, and the shortest length only builds features down to 1478 Hz — so the
 * short response is too coarse for the curve across almost the whole band,
 * and the two only cross around 7 kHz.  Measured end to end, on a 5.5 dB gap:
 *
 *                    255 taps   1023 taps   4095 taps
 *   smooth 0.2        1.81 dB     1.30 dB     1.22 dB
 *   smooth 0.5        1.75        1.24        1.16
 *   smooth 1.0        1.94        1.58        1.52
 *
 * The middle length closes a third more of the gap than the short one for
 * 8 ms more delay, and the long one adds almost nothing for four times that.
 * So the default is the middle one, and the same table says something about
 * Smooth as well: an octave of it is WORSE than half an octave at every
 * length, because past a point it is no longer removing the arrangement, it
 * is removing the tonality too.
 */
export function matchImpulse(
  params: Record<string, number>, sampleRate: number,
): Float32Array<ArrayBuffer> {
  const applied = matchApplied(params);
  return designLinearPhase(
    (hz) => matchMagnitudeAt(applied, hz), matchTaps(params), sampleRate,
  );
}

/** The narrowest feature the stored curve can contain, in Hz, at a frequency. */
export function matchFeatureHz(hz: number, smoothOct: number): number {
  const perBand = Math.log2(MATCH_MAX_HZ / MATCH_MIN_HZ) / MATCH_BANDS;
  const octaves = Math.max(perBand, smoothOct);
  return hz * (Math.pow(2, octaves / 2) - Math.pow(2, -octaves / 2));
}
