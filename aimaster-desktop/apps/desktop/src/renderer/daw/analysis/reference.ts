// Mastering Reference System.
//
// Drop a commercial track in as REFERENCE, and every number the mix engineer
// argues about lines up in one table:
//
//     REFERENCE      YOUR MIX
//     LUFS   -8.7      -11.2
//     TP     -1.0       -0.8
//     DR      7.2        9.8
//     WIDTH  118 %      92 %
//     LOW     +0       +2.1
//     MID     +0       -0.8
//     HIGH    +0       -1.7
//
// Two rules keep the comparison honest:
//
//   • Tonal numbers are level-normalised.  A quieter mix is not a darker
//     mix; every spectrum is offset so its broadband level reads 0 dB
//     before the bands are compared.  Otherwise LOW/MID/HIGH would just
//     restate the LUFS difference three times.
//   • Loudness comes from the existing BS.1770-4 engine, not a second
//     implementation.  One meter, one truth.

import { getLoudnessMetrics, LoudnessAnalyzer, type AudioBufferLike } from '../../audio/loudnessCore.js';
import { fft, hannWindow, magnitude, nextPow2 } from '../audio/fft.js';

// ── Spectrum ──────────────────────────────────────────────────────────────────

export interface SpectrumCurve {
  /** Band centre frequencies, log-spaced. */
  hz: Float32Array;
  /** Band level in dB.  Offset so the broadband level is 0 dB. */
  db: Float32Array;
}

export interface SpectrumOptions {
  fftSize?: number;
  /** Cap on analysed frames — a 4-minute track does not need every frame. */
  maxFrames?: number;
  /** Log-spaced output bands (the tonal balance resolution). */
  bandCount?: number;
  minHz?: number;
  maxHz?: number;
}

const SPECTRUM_DEFAULTS = {
  fftSize: 4096, maxFrames: 400, bandCount: 48, minHz: 20, maxHz: 20000,
} as const;

/** Log-spaced band edges: bandCount bands from minHz to maxHz. */
function bandEdges(count: number, minHz: number, maxHz: number): Float64Array {
  const edges = new Float64Array(count + 1);
  const ratio = Math.log(maxHz / minHz);
  for (let i = 0; i <= count; i++) edges[i] = minHz * Math.exp((ratio * i) / count);
  return edges;
}

/**
 * Average power spectrum, collapsed onto log-spaced bands.  Frames are taken
 * at a stride so cost is bounded by `maxFrames` regardless of track length.
 */
export function averageSpectrum(
  samples: ArrayLike<number>, sampleRate: number, options: SpectrumOptions = {},
): SpectrumCurve {
  const fftSize = nextPow2(options.fftSize ?? SPECTRUM_DEFAULTS.fftSize);
  const maxFrames = options.maxFrames ?? SPECTRUM_DEFAULTS.maxFrames;
  const bandCount = options.bandCount ?? SPECTRUM_DEFAULTS.bandCount;
  const minHz = options.minHz ?? SPECTRUM_DEFAULTS.minHz;
  const maxHz = Math.min(options.maxHz ?? SPECTRUM_DEFAULTS.maxHz, sampleRate / 2);

  const edges = bandEdges(bandCount, minHz, maxHz);
  const hz = new Float32Array(bandCount);
  for (let b = 0; b < bandCount; b++) {
    hz[b] = Math.sqrt((edges[b] ?? minHz) * (edges[b + 1] ?? maxHz));
  }

  const power = new Float64Array(bandCount);
  const counts = new Float64Array(bandCount);
  if (samples.length === 0) {
    return { hz, db: new Float32Array(bandCount).fill(-120) };
  }

  const usable = Math.max(1, samples.length - fftSize);
  const wanted = Math.min(maxFrames, Math.max(1, Math.floor(usable / (fftSize / 2))));
  const stride = Math.max(1, Math.floor(usable / wanted));
  const window = hannWindow(fftSize);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const binHz = sampleRate / fftSize;
  let frames = 0;

  for (let start = 0; start + fftSize <= samples.length && frames < wanted; start += stride, frames++) {
    im.fill(0);
    for (let i = 0; i < fftSize; i++) re[i] = (samples[start + i] ?? 0) * (window[i] ?? 0);
    fft(re, im, false);
    for (let bin = 1; bin < fftSize / 2; bin++) {
      const f = bin * binHz;
      if (f < minHz || f > maxHz) continue;
      // Log-spaced target band for this bin.
      const b = Math.floor((bandCount * Math.log(f / minHz)) / Math.log(maxHz / minHz));
      if (b < 0 || b >= bandCount) continue;
      const m = magnitude(re[bin] ?? 0, im[bin] ?? 0);
      power[b] = (power[b] ?? 0) + m * m;
      counts[b] = (counts[b] ?? 0) + 1;
    }
  }

  // Mean power per bin inside each band, then normalise so the whole curve
  // sits at 0 dB average — that is what makes tonal comparison level-blind.
  const db = new Float32Array(bandCount);
  let sum = 0;
  let filled = 0;
  const mean = new Float64Array(bandCount);
  for (let b = 0; b < bandCount; b++) {
    const c = counts[b] ?? 0;
    mean[b] = c > 0 ? (power[b] ?? 0) / c : 0;
    if (c > 0) { sum += mean[b] ?? 0; filled++; }
  }
  const reference = filled > 0 ? sum / filled : 1;
  for (let b = 0; b < bandCount; b++) {
    const m = mean[b] ?? 0;
    db[b] = m > 0 && reference > 0 ? 10 * Math.log10(m / reference) : -120;
  }
  return { hz, db };
}

/** Energy-weighted average of a curve over a frequency span, in dB. */
export function bandLevelDb(curve: SpectrumCurve, lowHz: number, highHz: number): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < curve.hz.length; i++) {
    const f = curve.hz[i] ?? 0;
    if (f < lowHz || f > highHz) continue;
    sum += Math.pow(10, (curve.db[i] ?? -120) / 10);
    n++;
  }
  return n > 0 ? 10 * Math.log10(sum / n) : -120;
}

export const TONAL_BANDS = {
  low: { lowHz: 20, highHz: 250 },
  mid: { lowHz: 250, highHz: 4000 },
  high: { lowHz: 4000, highHz: 20000 },
} as const;

// ── Stereo ────────────────────────────────────────────────────────────────────

export interface StereoBand {
  hz: number;
  correlation: number;
  widthPercent: number;
}

/**
 * Width from correlation: mono reads 0 %, fully decorrelated reads 100 %,
 * out-of-phase reads 200 %.  Commercial masters usually land 80–130 %.
 */
export const widthFromCorrelation = (correlation: number): number => 100 * (1 - correlation);

export function correlationOf(left: ArrayLike<number>, right: ArrayLike<number>): number {
  const n = Math.min(left.length, right.length);
  if (n === 0) return 1;
  let ll = 0, rr = 0, lr = 0;
  for (let i = 0; i < n; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    ll += l * l; rr += r * r; lr += l * r;
  }
  const denom = Math.sqrt(ll * rr);
  return denom > 1e-12 ? lr / denom : 1;
}

/** Per-band correlation, for the stereo overlay. */
export function stereoBands(
  left: Float32Array, right: Float32Array, sampleRate: number, bandCount = 12,
): StereoBand[] {
  const mid = new Float32Array(left.length);
  const side = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) {
    mid[i] = ((left[i] ?? 0) + (right[i] ?? 0)) * 0.5;
    side[i] = ((left[i] ?? 0) - (right[i] ?? 0)) * 0.5;
  }
  const opts: SpectrumOptions = { bandCount, fftSize: 2048 };
  const m = averageSpectrum(mid, sampleRate, opts);
  const s = averageSpectrum(side, sampleRate, opts);
  // Absolute levels were normalised away by averageSpectrum, so restore the
  // mid/side balance from the raw energies before comparing bands.
  const midGain = 10 * Math.log10(Math.max(1e-20, energyOf(mid)));
  const sideGain = 10 * Math.log10(Math.max(1e-20, energyOf(side)));

  const out: StereoBand[] = [];
  for (let b = 0; b < bandCount; b++) {
    const mDb = (m.db[b] ?? -120) + midGain;
    const sDb = (s.db[b] ?? -120) + sideGain;
    const ratio = Math.pow(10, (sDb - mDb) / 10);      // side / mid power
    // Correlation of a mid/side pair with power ratio k is (1−k)/(1+k).
    const correlation = (1 - ratio) / (1 + ratio);
    out.push({
      hz: m.hz[b] ?? 0,
      correlation,
      widthPercent: widthFromCorrelation(correlation),
    });
  }
  return out;
}

function energyOf(x: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += (x[i] ?? 0) * (x[i] ?? 0);
  return x.length > 0 ? sum / x.length : 0;
}

// ── Full analysis ─────────────────────────────────────────────────────────────

export interface ReferenceAnalysis {
  name: string;
  durationSec: number;
  sampleRate: number;
  channels: number;

  integratedLufs: number;
  truePeakDbtp: number;
  /** Peak-to-loudness ratio — what the DR column shows. */
  dr: number;
  /** EBU loudness range, the slower companion to DR. */
  lra: number;

  correlation: number;
  widthPercent: number;

  lowDb: number;
  midDb: number;
  highDb: number;

  spectrum: SpectrumCurve;
  stereo: StereoBand[];
  /** Short-term LUFS every 100 ms — the dynamics overlay. */
  shortTerm: Float32Array;
}

export function analyzeForReference(
  buf: AudioBufferLike, name: string, options: SpectrumOptions = {},
): ReferenceAnalysis {
  const metrics = getLoudnessMetrics(buf);
  const left = buf.getChannelData(0);
  const right = buf.numberOfChannels > 1 ? buf.getChannelData(1) : left;

  const mono = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) mono[i] = ((left[i] ?? 0) + (right[i] ?? 0)) * 0.5;

  const spectrum = averageSpectrum(mono, buf.sampleRate, options);
  const correlation = buf.numberOfChannels > 1 ? correlationOf(left, right) : 1;

  // Re-run the meter to harvest the short-term series (getLoudnessMetrics
  // only returns the final reading).
  const analyzer = new LoudnessAnalyzer(buf.sampleRate, buf.numberOfChannels);
  const chans: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  const CHUNK = 8192;
  for (let pos = 0; pos < left.length; pos += CHUNK) {
    const len = Math.min(CHUNK, left.length - pos);
    analyzer.processBlock(chans.map((c) => c.subarray(pos, pos + len)));
  }

  const dr = Number.isFinite(metrics.integratedLufs) && Number.isFinite(metrics.truePeakDbtp)
    ? metrics.truePeakDbtp - metrics.integratedLufs
    : 0;

  return {
    name,
    durationSec: metrics.durationSec,
    sampleRate: buf.sampleRate,
    channels: buf.numberOfChannels,
    integratedLufs: metrics.integratedLufs,
    truePeakDbtp: metrics.truePeakDbtp,
    dr,
    lra: metrics.loudnessRange,
    correlation,
    widthPercent: widthFromCorrelation(correlation),
    lowDb: bandLevelDb(spectrum, TONAL_BANDS.low.lowHz, TONAL_BANDS.low.highHz),
    midDb: bandLevelDb(spectrum, TONAL_BANDS.mid.lowHz, TONAL_BANDS.mid.highHz),
    highDb: bandLevelDb(spectrum, TONAL_BANDS.high.lowHz, TONAL_BANDS.high.highHz),
    spectrum,
    stereo: buf.numberOfChannels > 1 ? stereoBands(left, right, buf.sampleRate) : [],
    shortTerm: Float32Array.from(analyzer.getShortTermLufsSeries()),
  };
}

// ── Comparison ────────────────────────────────────────────────────────────────

export type MetricId = 'lufs' | 'tp' | 'dr' | 'width' | 'low' | 'mid' | 'high';
export type Verdict = 'match' | 'over' | 'under';

export interface ComparisonRow {
  id: MetricId;
  label: string;
  unit: string;
  reference: number;
  mix: number;
  /** mix − reference, in the row's unit. */
  delta: number;
  /** Inside this, the row reads "match". */
  tolerance: number;
  verdict: Verdict;
  /** How the row should be read out loud. */
  hint: string;
}

export interface ReferenceComparison {
  referenceName: string;
  mixName: string;
  rows: ComparisonRow[];
  /** 0…100, how close the mix sits to the reference overall. */
  score: number;
}

/**
 * Tolerances are what a mastering engineer would shrug at.  ±0.5 LU on
 * loudness, ±1 dB on a tonal band, ±10 points of width.
 */
const TOLERANCE: Record<MetricId, number> = {
  lufs: 0.5, tp: 0.3, dr: 1, width: 10, low: 1, mid: 1, high: 1,
};

function verdictFor(delta: number, tolerance: number): Verdict {
  if (Math.abs(delta) <= tolerance) return 'match';
  return delta > 0 ? 'over' : 'under';
}

export function compareToReference(
  reference: ReferenceAnalysis, mix: ReferenceAnalysis,
): ReferenceComparison {
  const make = (
    id: MetricId, label: string, unit: string, refValue: number, mixValue: number, hint: string,
  ): ComparisonRow => {
    const delta = mixValue - refValue;
    const tolerance = TOLERANCE[id];
    return {
      id, label, unit,
      reference: refValue, mix: mixValue, delta, tolerance,
      verdict: verdictFor(delta, tolerance),
      hint,
    };
  };

  // Tonal rows read as deltas: the reference is +0 by definition and the mix
  // is stated relative to it, which is exactly how the table is drawn.
  const rows: ComparisonRow[] = [
    make('lufs', 'LUFS', 'LUFS', reference.integratedLufs, mix.integratedLufs,
      'Integrated loudness, BS.1770-4 gated.'),
    make('tp', 'TP', 'dBTP', reference.truePeakDbtp, mix.truePeakDbtp,
      'True peak after 4× oversampling.'),
    make('dr', 'DR', 'dB', reference.dr, mix.dr,
      'Peak-to-loudness ratio — higher means more dynamic.'),
    make('width', 'WIDTH', '%', reference.widthPercent, mix.widthPercent,
      '100 % = fully decorrelated sides, 0 % = mono.'),
    make('low', 'LOW', 'dB', 0, mix.lowDb - reference.lowDb,
      `${TONAL_BANDS.low.lowHz}–${TONAL_BANDS.low.highHz} Hz, level-normalised.`),
    make('mid', 'MID', 'dB', 0, mix.midDb - reference.midDb,
      `${TONAL_BANDS.mid.lowHz}–${TONAL_BANDS.mid.highHz} Hz, level-normalised.`),
    make('high', 'HIGH', 'dB', 0, mix.highDb - reference.highDb,
      `${TONAL_BANDS.high.lowHz} Hz and up, level-normalised.`),
  ];

  // Score: every row scores 1 inside tolerance and decays from there.  Four
  // tolerances out is a zero for that row.
  let total = 0;
  for (const row of rows) {
    const excess = Math.max(0, Math.abs(row.delta) - row.tolerance);
    total += Math.max(0, 1 - excess / (row.tolerance * 3));
  }
  return {
    referenceName: reference.name,
    mixName: mix.name,
    rows,
    score: Math.round((total / rows.length) * 100),
  };
}

// ── Match suggestions ─────────────────────────────────────────────────────────

export interface MatchSuggestion {
  metric: MetricId;
  text: string;
  /** Signed correction the mix needs, in the row's unit. */
  amount: number;
}

/** Turn the deltas into the sentences the user actually acts on. */
export function matchSuggestions(comparison: ReferenceComparison): MatchSuggestion[] {
  const out: MatchSuggestion[] = [];
  for (const row of comparison.rows) {
    if (row.verdict === 'match') continue;
    const amount = -row.delta;
    const abs = Math.abs(amount).toFixed(1);
    switch (row.id) {
      case 'lufs':
        out.push({ metric: row.id, amount, text: `${amount > 0 ? 'Push' : 'Pull'} the master ${abs} LU ${amount > 0 ? 'louder' : 'quieter'} to sit with the reference.` });
        break;
      case 'tp':
        out.push({ metric: row.id, amount, text: amount < 0
          ? `Lower the ceiling ${abs} dB — the mix peaks above the reference.`
          : `You have ${abs} dB of headroom left against the reference ceiling.` });
        break;
      case 'dr':
        out.push({ metric: row.id, amount, text: amount < 0
          ? `The mix is ${abs} dB more dynamic; more compression or limiting would match the reference.`
          : `The mix is ${abs} dB flatter; back off the limiter to open it up.` });
        break;
      case 'width':
        out.push({ metric: row.id, amount, text: amount > 0
          ? `Widen the sides — the mix is ${abs} points narrower than the reference.`
          : `Narrow the sides — the mix is ${abs} points wider than the reference.` });
        break;
      default: {
        const band = row.id === 'low' ? TONAL_BANDS.low : row.id === 'mid' ? TONAL_BANDS.mid : TONAL_BANDS.high;
        out.push({ metric: row.id, amount, text: `${amount > 0 ? 'Add' : 'Cut'} ${abs} dB around ${Math.round(Math.sqrt(band.lowHz * band.highHz))} Hz.` });
        break;
      }
    }
  }
  return out;
}

/** Difference curve for the frequency overlay: mix − reference, per band. */
export function spectrumDelta(
  reference: SpectrumCurve, mix: SpectrumCurve,
): SpectrumCurve {
  const n = Math.min(reference.hz.length, mix.hz.length);
  const hz = reference.hz.slice(0, n);
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) db[i] = (mix.db[i] ?? 0) - (reference.db[i] ?? 0);
  return { hz, db };
}

export function formatMetric(row: ComparisonRow, value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (row.id === 'width') return `${Math.round(value)} %`;
  if (row.id === 'low' || row.id === 'mid' || row.id === 'high') {
    return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
  }
  return value.toFixed(1);
}
