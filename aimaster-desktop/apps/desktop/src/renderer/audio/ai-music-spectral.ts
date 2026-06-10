// ai-music-spectral — precise spectral features for AI-music detection.
//
// Pure feature extraction from an FFT magnitude spectrum (dB per linear bin,
// e.g. AnalyserNode.getFloatFrequencyData or the WASM spectrum analyzer).
// Produces normalised scores that sharpen the boolean rule-based detection:
//   • metallicScore  — 3–5 kHz concentration (AI vocal/synth "metal")
//   • harshnessScore — 5–9 kHz harsh top
//   • aliasingScore  — elevated near-Nyquist energy (upsample/aliasing)
//   • highToMidDb / lowToMidDb — tonal tilt
//
// Headless-testable with synthetic spectra (no audio device).

export interface SpectrumFrame {
  /** Magnitude in dB per linear FFT bin (bin i ↔ i·sr/(2·N) Hz). */
  magsDb: Float32Array | number[];
  sampleRate: number;
}

export interface AiSpectralFeatures {
  metallicScore: number;   // 0..1
  harshnessScore: number;  // 0..1
  aliasingScore: number;   // 0..1
  highToMidDb: number;
  lowToMidDb: number;
}

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

/** Average POWER level (dB) over a frequency band [loHz, hiHz). */
export function bandPowerDb(frame: SpectrumFrame, loHz: number, hiHz: number): number {
  const mags = frame.magsDb;
  const n = mags.length;
  if (n === 0) return -120;
  const binHz = frame.sampleRate / (2 * n);
  let sumP = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const f = i * binHz;
    if (f < loHz) continue;
    if (f >= hiHz) break;
    const db = mags[i]!;
    if (!Number.isFinite(db)) continue;
    const amp = Math.pow(10, db / 20);
    sumP += amp * amp;
    count++;
  }
  if (count === 0) return -120;
  return 10 * Math.log10(sumP / count + 1e-20);
}

/**
 * Compute AI-music spectral features.  `nyquist`-aware: bands are clamped to
 * the usable range so a 44.1/48 kHz file behaves sensibly.
 */
export function computeAiSpectralFeatures(frame: SpectrumFrame): AiSpectralFeatures {
  const nyq = frame.sampleRate / 2;
  const cap = (hz: number): number => Math.min(hz, nyq);

  const lowDb = bandPowerDb(frame, 20, 200);
  const midDb = bandPowerDb(frame, 200, 2000);
  const highMidDb = bandPowerDb(frame, 3000, 6000);
  const harshDb = bandPowerDb(frame, 5000, 9000);
  const highDb = bandPowerDb(frame, 6000, 12000);
  const airDb = bandPowerDb(frame, cap(12000), cap(18000));
  const nyqDb = bandPowerDb(frame, cap(18000), cap(nyq * 0.999));

  // Metallic: 3–5 kHz region sitting above the mids.
  const metallicScore = clamp01((highMidDb - midDb + 2) / 10);
  // Harshness: 5–9 kHz above the mids.
  const harshnessScore = clamp01((harshDb - midDb + 2) / 10);
  // Aliasing: near-Nyquist energy that doesn't roll off vs the air band.
  const aliasingScore = clamp01((nyqDb - airDb + 18) / 18);

  return {
    metallicScore,
    harshnessScore,
    aliasingScore,
    highToMidDb: highDb - midDb,
    lowToMidDb: lowDb - midDb,
  };
}

/** True when a frame carries real signal (not all -Inf / empty). */
export function isUsableSpectrum(frame: SpectrumFrame | null): frame is SpectrumFrame {
  if (!frame || frame.magsDb.length === 0) return false;
  for (let i = 0; i < frame.magsDb.length; i++) {
    const v = frame.magsDb[i]!;
    if (Number.isFinite(v) && v > -120) return true;
  }
  return false;
}

/** 7-band power profile (dB), used by genre detection + reference matching. */
export interface SpectralBands {
  subDb: number;     // 20–60
  lowDb: number;     // 60–200
  lowMidDb: number;  // 200–800
  midDb: number;     // 800–2500 (reference)
  highMidDb: number; // 2500–6000
  highDb: number;    // 6000–12000
  airDb: number;     // 12000–18000
}

export function spectralBandsDb(frame: SpectrumFrame): SpectralBands {
  const nyq = frame.sampleRate / 2;
  const cap = (hz: number): number => Math.min(hz, nyq);
  return {
    subDb: bandPowerDb(frame, 20, 60),
    lowDb: bandPowerDb(frame, 60, 200),
    lowMidDb: bandPowerDb(frame, 200, 800),
    midDb: bandPowerDb(frame, 800, 2500),
    highMidDb: bandPowerDb(frame, 2500, 6000),
    highDb: bandPowerDb(frame, cap(6000), cap(12000)),
    airDb: bandPowerDb(frame, cap(12000), cap(18000)),
  };
}

/** Band levels relative to the mid band (dB) — tonal tilt fingerprint. */
export interface TonalTilt {
  bassRel: number;   // low - mid
  subRel: number;    // sub - mid
  presenceRel: number; // highMid - mid
  brightRel: number; // high - mid
  airRel: number;    // air - mid
}

export function tonalTilt(b: SpectralBands): TonalTilt {
  return {
    bassRel: b.lowDb - b.midDb,
    subRel: b.subDb - b.midDb,
    presenceRel: b.highMidDb - b.midDb,
    brightRel: b.highDb - b.midDb,
    airRel: b.airDb - b.midDb,
  };
}
