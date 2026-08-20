// What the audio actually is, in the terms a device's knobs are in.
//
// The Intelligence Layer already measures a mix: three bands, loudness, width.
// That is the right vocabulary for "is the mix too dark" and the wrong one for
// "where should the de-esser sit" — you cannot set a frequency from a band
// called `high`.  So this file measures the same audio again, in the units the
// devices are calibrated in:
//
//   a de-esser wants a FREQUENCY          → where 5–10 kHz actually peaks
//   a gate wants a THRESHOLD in dB        → the level the noise floor sits at
//   a compressor wants an ATTACK in ms    → how fast this source's hits rise
//   a high-pass wants a CORNER            → where the energy really starts
//   a mono maker wants a CROSSOVER        → where the stereo stops correlating
//
// Every field here exists because some knob needs it, and every advisor is
// forbidden from inventing a number that is not in this struct.  That is the
// rule that keeps "AI recommendation" from meaning "a preset with a story".
//
// Pure: buffer in, numbers out.  No session, no engine, no I/O.

import {
  averageSpectrum, bandLevelDb, correlationOf, widthFromCorrelation,
  type SpectrumCurve,
} from '../analysis/reference.js';
import { getLoudnessMetrics, type AudioBufferLike } from '../../audio/loudnessCore.js';
import { guessRole, refineRole, type RoleGuess } from './roles.js';
import { shapeOf } from './analysis.js';

export interface BandLevel {
  name: string;
  lowHz: number;
  highHz: number;
  /** Level in this band, relative to the loudest band. 0 = the loudest. */
  relDb: number;
}

export interface Resonance {
  hz: number;
  /** How far it stands above its neighbours. */
  excessDb: number;
}

export interface SourceProfile {
  sampleRate: number;
  durationSec: number;
  /** Nothing audible — every advisor refuses rather than guessing. */
  silent: boolean;

  // ── Level ────────────────────────────────────────────────────────────────
  integratedLufs: number;
  truePeakDbtp: number;
  peakDb: number;
  rmsDb: number;
  /** Peak minus RMS.  Under 10 dB is squashed, over 18 dB is percussive. */
  crestDb: number;
  /** Spread between the loud and quiet parts — what a compressor is aimed at. */
  dynamicRangeDb: number;
  /** The level the quiet parts sit at.  A gate threshold lives just above it. */
  noiseFloorDb: number;

  // ── Spectrum ─────────────────────────────────────────────────────────────
  spectrum: SpectrumCurve;
  bands: BandLevel[];
  /** The spectrum's balance point.  Bright sources sit high. */
  centroidHz: number;
  /** Where the bottom 3 % of the energy is below — a high-pass corner. */
  lowRolloffHz: number;
  /** Where 97 % of the energy is below — how much air there is to lift. */
  highRolloffHz: number;
  /** The narrowest, loudest thing sticking out of the curve. */
  resonance: Resonance | null;
  /** 180–350 Hz against the 1 kHz reference.  Positive is mud. */
  mudDb: number;
  /** 350–700 Hz.  Positive is box. */
  boxDb: number;
  /** 2–5 kHz.  Positive is harsh. */
  harshDb: number;
  /** Where the sibilance actually is on THIS voice, 4–12 kHz. */
  sibilanceHz: number;
  /** How far that peak stands above the mids. */
  sibilanceDb: number;
  /** 10 kHz and up, against the mids.  Negative wants air. */
  airDb: number;
  /** Mains hum, when a strong 50 or 60 Hz line with harmonics is present. */
  humHz: number | null;

  // ── Time ─────────────────────────────────────────────────────────────────
  /** Detected onsets per second — how busy the front of the sound is. */
  transientRate: number;
  /** Median time from onset to peak.  A compressor's attack is read off this. */
  attackMs: number;
  /** Median time to fall 20 dB after a hit.  A gate's release is read off this. */
  decayMs: number;

  // ── Stereo ───────────────────────────────────────────────────────────────
  channels: number;
  correlation: number;
  widthPercent: number;
  /** Correlation below 120 Hz.  Negative means the bass fights itself in mono. */
  bassCorrelation: number;

  // ── Identity ─────────────────────────────────────────────────────────────
  role: RoleGuess;
  /** The session tempo where this was measured — delay and modulation need it. */
  tempoBpm: number;
}

const DB_FLOOR = -120;
const toDb = (x: number): number => (x > 1e-12 ? 20 * Math.log10(x) : DB_FLOOR);

/** Bands wide enough to mean something and narrow enough to point at. */
const BANDS: ReadonlyArray<{ name: string; lowHz: number; highHz: number }> = [
  { name: 'sub',     lowHz: 20,    highHz: 60 },
  { name: 'bass',    lowHz: 60,    highHz: 180 },
  { name: 'mud',     lowHz: 180,   highHz: 350 },
  { name: 'box',     lowHz: 350,   highHz: 700 },
  { name: 'body',    lowHz: 700,   highHz: 1500 },
  { name: 'presence', lowHz: 1500, highHz: 2500 },
  { name: 'harsh',   lowHz: 2500,  highHz: 5000 },
  { name: 'sibilance', lowHz: 5000, highHz: 10000 },
  { name: 'air',     lowHz: 10000, highHz: 20000 },
];

export interface ProfileOptions {
  name?: string;
  kind?: string;
  tempoBpm?: number;
}

export function profileBuffer(
  buffer: AudioBufferLike, options: ProfileOptions = {},
): SourceProfile {
  const sampleRate = buffer.sampleRate;
  const left = buffer.getChannelData(0);
  const channels = buffer.numberOfChannels;
  const right = channels > 1 ? buffer.getChannelData(1) : left;
  const length = left.length;

  const mono = new Float32Array(length);
  for (let i = 0; i < length; i++) mono[i] = ((left[i] ?? 0) + (right[i] ?? 0)) * 0.5;

  const metrics = getLoudnessMetrics(buffer);
  const spectrum = averageSpectrum(mono, sampleRate);

  // ── Level ──────────────────────────────────────────────────────────────
  let peak = 0;
  let square = 0;
  for (let i = 0; i < length; i++) {
    const v = Math.abs(mono[i] ?? 0);
    if (v > peak) peak = v;
    square += v * v;
  }
  const peakDb = toDb(peak);
  const rmsDb = toDb(Math.sqrt(square / Math.max(1, length)));

  // Short-window levels, which is what "how quiet does it get" means.  One
  // sample can be silent in the middle of a loud note; 20 ms cannot.
  const windowSamples = Math.max(64, Math.round(sampleRate * 0.02));
  const windows: number[] = [];
  for (let start = 0; start + windowSamples <= length; start += windowSamples) {
    let sum = 0;
    for (let i = start; i < start + windowSamples; i++) {
      const v = mono[i] ?? 0;
      sum += v * v;
    }
    windows.push(toDb(Math.sqrt(sum / windowSamples)));
  }
  const sorted = [...windows].sort((a, b) => a - b);
  const at = (p: number): number => sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))] ?? DB_FLOOR;

  // The quiet end is read at the 10th percentile rather than the minimum: the
  // minimum is whatever silence happens to be in the take, and a gate set to
  // digital silence never opens or never closes.
  const noiseFloorDb = sorted.length > 4 ? at(0.10) : rmsDb - 30;
  const loudDb = sorted.length > 4 ? at(0.95) : rmsDb;
  const dynamicRangeDb = Math.max(0, loudDb - (sorted.length > 4 ? at(0.30) : rmsDb));

  const silent = peakDb < -70 || !Number.isFinite(rmsDb) || rmsDb < -70;

  // ── Spectrum ───────────────────────────────────────────────────────────
  const bandDb = BANDS.map((b) => bandLevelDb(spectrum, b.lowHz, b.highHz));
  const loudest = Math.max(...bandDb.filter((v) => Number.isFinite(v)), DB_FLOOR);
  const bands: BandLevel[] = BANDS.map((b, i) => ({
    name: b.name, lowHz: b.lowHz, highHz: b.highHz,
    relDb: (bandDb[i] ?? DB_FLOOR) - loudest,
  }));

  // The mid band is the reference every "too much X" is measured against,
  // because it is the part of the spectrum a listener calls "the sound".
  const referenceDb = bandLevelDb(spectrum, 700, 2000);
  const rel = (lowHz: number, highHz: number): number =>
    bandLevelDb(spectrum, lowHz, highHz) - referenceDb;

  const centroidHz = spectralCentroid(spectrum);
  const lowRolloffHz = rolloffHz(spectrum, 0.03);
  const highRolloffHz = rolloffHz(spectrum, 0.97);
  const sibilance = peakIn(spectrum, 4000, 12000);

  // ── Time ───────────────────────────────────────────────────────────────
  const timing = onsetTiming(mono, sampleRate, windows, windowSamples);

  // ── Stereo ─────────────────────────────────────────────────────────────
  const correlation = channels > 1 ? correlationOf(left, right) : 1;
  const bassCorrelation = channels > 1
    ? correlationOf(lowpassed(left, sampleRate, 120), lowpassed(right, sampleRate, 120))
    : 1;

  const crestDb = peakDb - rmsDb;
  const shape = shapeOf(spectrum, crestDb);

  return {
    sampleRate,
    durationSec: length / sampleRate,
    silent,

    integratedLufs: Number.isFinite(metrics.integratedLufs) ? metrics.integratedLufs : rmsDb,
    truePeakDbtp: Number.isFinite(metrics.truePeakDbtp) ? metrics.truePeakDbtp : peakDb,
    peakDb,
    rmsDb,
    crestDb,
    dynamicRangeDb,
    noiseFloorDb,

    spectrum,
    bands,
    centroidHz,
    lowRolloffHz,
    highRolloffHz,
    resonance: findResonance(spectrum),
    mudDb: rel(180, 350),
    boxDb: rel(350, 700),
    harshDb: rel(2000, 5000),
    sibilanceHz: sibilance.hz,
    sibilanceDb: sibilance.db - referenceDb,
    airDb: rel(10000, 20000),
    humHz: findHum(mono, sampleRate),

    transientRate: timing.rate,
    attackMs: timing.attackMs,
    decayMs: timing.decayMs,

    channels,
    correlation,
    widthPercent: widthFromCorrelation(correlation),
    bassCorrelation,

    role: refineRole(guessRole(options.name ?? '', options.kind ?? 'audio'), shape),
    tempoBpm: options.tempoBpm ?? 120,
  };
}

// ── Spectral helpers ────────────────────────────────────────────────────────

function spectralCentroid(curve: SpectrumCurve): number {
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < curve.hz.length; i++) {
    const hz = curve.hz[i] ?? 0;
    if (hz < 20 || hz > 20000) continue;
    const power = Math.pow(10, (curve.db[i] ?? DB_FLOOR) / 10);
    weighted += hz * power;
    total += power;
  }
  return total > 0 ? weighted / total : 1000;
}

/** The frequency below which `fraction` of the energy sits. */
function rolloffHz(curve: SpectrumCurve, fraction: number): number {
  const powers: number[] = [];
  let total = 0;
  for (let i = 0; i < curve.hz.length; i++) {
    const hz = curve.hz[i] ?? 0;
    const p = hz >= 20 && hz <= 20000 ? Math.pow(10, (curve.db[i] ?? DB_FLOOR) / 10) : 0;
    powers.push(p);
    total += p;
  }
  if (total <= 0) return fraction < 0.5 ? 20 : 20000;
  let running = 0;
  for (let i = 0; i < powers.length; i++) {
    running += powers[i] ?? 0;
    if (running >= total * fraction) return curve.hz[i] ?? 20;
  }
  return curve.hz[curve.hz.length - 1] ?? 20000;
}

/** The loudest bin in a range, and its level. */
function peakIn(curve: SpectrumCurve, lowHz: number, highHz: number): { hz: number; db: number } {
  let bestHz = (lowHz + highHz) / 2;
  let bestDb = DB_FLOOR;
  for (let i = 0; i < curve.hz.length; i++) {
    const hz = curve.hz[i] ?? 0;
    if (hz < lowHz || hz > highHz) continue;
    const db = curve.db[i] ?? DB_FLOOR;
    if (db > bestDb) { bestDb = db; bestHz = hz; }
  }
  return { hz: bestHz, db: bestDb };
}

/**
 * The narrowest loud thing in the curve.
 *
 * Compared against a smoothed version of itself rather than against a flat
 * line: a bright source is not a resonance, and subtracting the trend is what
 * separates "this instrument is bright" from "this room rings at 240 Hz".
 */
function findResonance(curve: SpectrumCurve): Resonance | null {
  const n = curve.hz.length;
  if (n < 12) return null;

  const smooth: number[] = [];
  const span = Math.max(2, Math.round(n / 24));
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - span); j <= Math.min(n - 1, i + span); j++) {
      sum += curve.db[j] ?? DB_FLOOR;
      count++;
    }
    smooth.push(sum / Math.max(1, count));
  }

  let bestHz = 0;
  let bestExcess = 0;
  for (let i = 1; i < n - 1; i++) {
    const hz = curve.hz[i] ?? 0;
    if (hz < 80 || hz > 8000) continue;
    const db = curve.db[i] ?? DB_FLOOR;
    // A peak, not a shoulder.
    if (db < (curve.db[i - 1] ?? DB_FLOOR) || db < (curve.db[i + 1] ?? DB_FLOOR)) continue;
    const excess = db - (smooth[i] ?? DB_FLOOR);
    if (excess > bestExcess) { bestExcess = excess; bestHz = hz; }
  }
  // Under 4 dB is the shape of the instrument, not a problem to notch.
  return bestExcess >= 4 && bestHz > 0
    ? { hz: bestHz, excessDb: bestExcess } : null;
}

/**
 * Mains hum: a narrow line at 50 or 60 Hz with its harmonics on top of it.
 *
 * Measured with a Goertzel on the samples rather than read off the spectrum
 * curve, because the curve is forty-eight log-spaced bands — a quarter of an
 * octave each — and a quarter octave at 50 Hz is 46 to 54.  A band that wide
 * cannot tell a 50 Hz line from a 54 Hz one, and telling those apart is the
 * entire job.  A Goertzel over half-second windows resolves 2 Hz.
 *
 * Two tests, and both are needed:
 *
 *   the line stands above its own neighbourhood     it is narrow
 *   two or more exact harmonics do the same         it is a ladder
 *
 * The second is what separates hum from a bass note that happens to sit at
 * 60 Hz: a sustained sine has no harmonics, and a bass guitar's move.  What
 * this cannot tell apart is hum and a bass note held at exactly 50 or 60 Hz
 * for the whole window with its own harmonic series — and neither can anyone
 * else, from the spectrum alone.
 */
function findHum(mono: Float32Array, sampleRate: number): number | null {
  const windowSize = Math.min(mono.length, Math.round(sampleRate * 0.5));
  if (windowSize < 2048) return null;
  const windows = Math.max(1, Math.min(6, Math.floor(mono.length / windowSize)));

  /** Averaged level of one frequency, in dB. */
  const line = (hz: number): number => {
    if (hz <= 0 || hz >= sampleRate / 2) return DB_FLOOR;
    const k = (2 * Math.PI * hz) / sampleRate;
    const coeff = 2 * Math.cos(k);
    let total = 0;
    for (let w = 0; w < windows; w++) {
      const from = w * windowSize;
      let s1 = 0;
      let s2 = 0;
      for (let i = from; i < from + windowSize; i++) {
        const s = (mono[i] ?? 0) + coeff * s1 - s2;
        s2 = s1;
        s1 = s;
      }
      total += Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / windowSize;
    }
    return toDb(total / windows);
  };

  /** How far a line stands above the frequencies either side of it. */
  const excess = (hz: number): number =>
    line(hz) - Math.max(line(hz - 7), line(hz + 7));

  let best: { hz: number; score: number } | null = null;
  for (const base of [50, 60]) {
    const fundamental = excess(base);
    if (fundamental < 8) continue;
    let harmonics = 0;
    for (const multiple of [2, 3, 4]) {
      if (excess(base * multiple) > 5) harmonics++;
    }
    if (harmonics < 2) continue;
    const score = fundamental + harmonics * 3;
    if (!best || score > best.score) best = { hz: base, score };
  }
  return best?.hz ?? null;
}

// ── Time helpers ────────────────────────────────────────────────────────────

interface Timing { rate: number; attackMs: number; decayMs: number }

/**
 * Onsets, and what they do either side of themselves.
 *
 * The envelope is the 20 ms window levels already computed for the noise
 * floor — reusing them keeps one definition of "how loud is it here" instead
 * of two that can disagree.
 */
function onsetTiming(
  mono: Float32Array, sampleRate: number,
  windowsDb: readonly number[], windowSamples: number,
): Timing {
  const windowMs = (windowSamples / sampleRate) * 1000;
  const durationSec = mono.length / sampleRate;
  if (windowsDb.length < 4 || durationSec <= 0) {
    return { rate: 0, attackMs: 20, decayMs: 200 };
  }

  const onsets: number[] = [];
  for (let i = 2; i < windowsDb.length - 1; i++) {
    const rise = (windowsDb[i] ?? DB_FLOOR) - (windowsDb[i - 2] ?? DB_FLOOR);
    // 6 dB in 40 ms is an attack; anything gentler is the music swelling.
    if (rise < 6) continue;
    if ((windowsDb[i] ?? DB_FLOOR) < (windowsDb[i + 1] ?? DB_FLOOR)) continue;
    if (onsets.length > 0 && i - (onsets[onsets.length - 1] ?? 0) < 3) continue;
    onsets.push(i);
  }

  const attacks: number[] = [];
  const decays: number[] = [];
  for (const index of onsets) {
    // Attack: back up while the level is still climbing.
    let back = index;
    while (back > 0 && (windowsDb[back - 1] ?? DB_FLOOR) < (windowsDb[back] ?? DB_FLOOR) - 1) back--;
    attacks.push(Math.max(1, (index - back) * windowMs));

    // Decay: forward until 20 dB below the hit.
    const top = windowsDb[index] ?? DB_FLOOR;
    let forward = index;
    while (forward < windowsDb.length - 1 && (windowsDb[forward] ?? DB_FLOOR) > top - 20) forward++;
    decays.push(Math.max(windowMs, (forward - index) * windowMs));
  }

  const median = (values: number[], fallback: number): number => {
    if (values.length === 0) return fallback;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? fallback;
  };

  return {
    rate: onsets.length / durationSec,
    attackMs: median(attacks, 20),
    decayMs: median(decays, 200),
  };
}

/** One-pole lowpass, for asking what the bass alone is doing in stereo. */
function lowpassed(data: ArrayLike<number>, sampleRate: number, cutoffHz: number): Float32Array {
  const a = Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  const out = new Float32Array(data.length);
  let z = 0;
  for (let i = 0; i < data.length; i++) {
    z = (data[i] ?? 0) * (1 - a) + z * a;
    out[i] = z;
  }
  return out;
}
