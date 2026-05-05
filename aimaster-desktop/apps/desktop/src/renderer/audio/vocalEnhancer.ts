// Vocal presence detection + enhancement.
//
// The single hardest constraint here is "must not affect instrumental-only
// tracks negatively".  That makes detection — not correction — the headline
// engineering problem.  A spectral peak in the 1–4 kHz range proves
// nothing: cymbals, distorted guitars, snare drums, brass and ride
// patterns all live there.  So we triangulate.
//
// Three independent cues, each weak alone, robust together:
//
//   1. CENTRALITY — vocals are mixed center.  Mid (L+R)/2 RMS in the
//      vocal band vs side (L-R)/2 RMS in the same band.  >+6 dB → likely
//      vocal; ≤0 dB → almost certainly not.
//
//   2. SYLLABIC MODULATION — speech and singing have a 3–7 Hz amplitude-
//      envelope rhythm (the syllable rate).  Sustained instruments don't.
//      Drums modulate too, but at irregular high rates (transients) — when
//      we lowpass the rectified signal at 30 Hz the drum hits flatten out.
//      We measure envelope contrast (std/mean) inside a 1–4 kHz bandpass.
//
//   3. SPECTRAL BALANCE — the vocal band carries enough energy that it's
//      not a phantom artefact (e.g., very quiet noise floor).
//
// Score = √(centrality · modulation) · (0.5 + 0.5·presence).
//
// Multiplicative geometric mean of centrality and modulation matters: it
// means *both* must be present to score > 0.  A centered sustained tone
// (mod=0) drops to 0; uncorrelated noise (cent=0) drops to 0; only
// vocals get both, so only vocals score.
//
// Below score 0.40 we BYPASS — instrumentals get bit-perfect output.
// Between 0.40–0.60 we apply at most half-strength corrections.
// Above 0.60 we apply full corrections.
//
// Diagnosis:
//   • "buried" — vocal band sits ≥ 3 dB below the surrounding mix bands,
//                AND vocal score is positive → +1 to +2.5 dB peaking EQ
//                at 2.5 kHz, Q ≈ 0.9 (broad presence shelf).
//   • "harsh"  — harsh-band (2.5–5 kHz) energy ≥ 4 dB above the rest of
//                the vocal band → -1 to -2 dB peaking EQ at 3.5 kHz,
//                Q ≈ 2.5 (narrow notch).
//   • "balanced" — vocal present and well-balanced → no change.
//   • "no_vocal" — score below threshold → bypass.

import { Biquad, rbjPeakingEq, rbjLowPass, rbjHighPass } from './biquad.js';
import { AudioBufferLike } from './loudnessCore.js';

export type VocalDiagnosis = 'no_vocal' | 'buried' | 'harsh' | 'balanced';

export interface VocalAnalysis {
  vocalScore:        number;   // 0–1 confidence vocals are present
  centralityScore:   number;   // 0–1 (mid vs side in 1–4 kHz)
  modulationScore:   number;   // 0–1 (3–7 Hz envelope contrast)
  presenceScore:     number;   // 0–1 (vocal band has meaningful energy)
  // Per-band RMS (dBFS) — diagnostic.
  vocalBandDb:       number;   // 1–4 kHz
  harshBandDb:       number;   // 2.5–5 kHz
  lowMidBandDb:      number;   // 200–1 kHz
  airBandDb:         number;   // 5–12 kHz
  midSideRatioDb:    number;   // mid - side in vocal band
  envelopeCv:        number;   // coefficient of variation of vocal envelope
  diagnosis:         VocalDiagnosis;
  /** Suggested correction (zero-length array means no correction).  */
  correction:        VocalCorrection[];
}

export interface VocalCorrection {
  freqHz: number;
  gainDb: number;
  q:      number;
}

export interface EnhanceVocalOptions {
  /** Override the bypass threshold.  Default 0.40. */
  scoreThreshold?:   number;
  /** Cap on absolute correction (dB).  Default 2.5 dB. */
  maxCorrectionDb?:  number;
  /** Force-apply even when bypass conditions hit.  Default false. */
  forceEnable?:      boolean;
}

export interface EnhanceVocalResult {
  buffer:    AudioBufferLike;
  analysis:  VocalAnalysis;
  bypassed:  boolean;
  appliedEq: VocalCorrection[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const dbOf = (lin: number): number => lin <= 1e-12 ? -Infinity : 20 * Math.log10(lin);
const rmsOf = (a: Float32Array): number => {
  if (!a.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) { const v = a[i] as number; s += v * v; }
  return Math.sqrt(s / a.length);
};

// Apply a 4th-order bandpass (HPF + LPF cascade) to a buffer copy and
// return the filtered signal.
function bandpass(src: Float32Array, fs: number, fLo: number, fHi: number): Float32Array {
  const out = new Float32Array(src);
  const hp = new Biquad(rbjHighPass(fs, fLo));
  const lp = new Biquad(rbjLowPass(fs, fHi));
  hp.processBlock(out);
  lp.processBlock(out);
  // Second-pass for steeper rolloff.
  const hp2 = new Biquad(rbjHighPass(fs, fLo));
  const lp2 = new Biquad(rbjLowPass(fs, fHi));
  hp2.processBlock(out);
  lp2.processBlock(out);
  return out;
}

// Build a downsampled envelope of |x|, lowpassed at 30 Hz, decimated to
// ~120 Hz so the next-step CV calculation is cheap.  Returns the envelope
// and its sample rate.
function envelope30Hz(src: Float32Array, fs: number): { env: Float32Array; envFs: number } {
  // Full-wave rectify then low-pass at 30 Hz.
  const rect = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) rect[i] = Math.abs(src[i] as number);
  const lp = new Biquad(rbjLowPass(fs, 30));
  lp.processBlock(rect);
  // Decimate to ~120 Hz (factor = floor(fs / 120)).
  const factor = Math.max(1, Math.floor(fs / 120));
  const envFs = fs / factor;
  const envLen = Math.floor(rect.length / factor);
  const env = new Float32Array(envLen);
  for (let i = 0; i < envLen; i++) env[i] = rect[i * factor] as number;
  return { env, envFs };
}

// Coefficient of variation (std / mean) of a non-negative signal.  For
// near-constant envelopes this is ≈ 0; for strongly modulated speech-like
// envelopes it's typically ≥ 0.5.
function envelopeCv(env: Float32Array): number {
  if (!env.length) return 0;
  let s = 0;
  for (let i = 0; i < env.length; i++) s += env[i] as number;
  const mean = s / env.length;
  if (mean <= 1e-12) return 0;
  let varSum = 0;
  for (let i = 0; i < env.length; i++) {
    const d = (env[i] as number) - mean;
    varSum += d * d;
  }
  return Math.sqrt(varSum / env.length) / mean;
}

// Build mid (L+R)/2 channel.  Mono input → returned as-is.
function buildMidSide(channels: Float32Array[]): { mid: Float32Array; side: Float32Array | null } {
  if (channels.length === 1) return { mid: channels[0] as Float32Array, side: null };
  const a = channels[0] as Float32Array;
  const b = channels[1] as Float32Array;
  const N = Math.min(a.length, b.length);
  const mid = new Float32Array(N);
  const side = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    mid[i]  = ((a[i] as number) + (b[i] as number)) * 0.5;
    side[i] = ((a[i] as number) - (b[i] as number)) * 0.5;
  }
  return { mid, side };
}

// Map a raw cue value into a 0–1 score using a smooth sigmoid-like curve.
function smoothScore(value: number, lo: number, hi: number): number {
  if (value <= lo) return 0;
  if (value >= hi) return 1;
  const t = (value - lo) / (hi - lo);
  // Smoothstep: 3t² − 2t³ — first-derivative-zero at endpoints.
  return t * t * (3 - 2 * t);
}

// ── Analysis ─────────────────────────────────────────────────────────────────
export function analyzeVocalPresence(input: AudioBufferLike): VocalAnalysis {
  const fs = input.sampleRate;
  const nCh = input.numberOfChannels;
  const channels: Float32Array[] = new Array(nCh);
  for (let c = 0; c < nCh; c++) channels[c] = input.getChannelData(c);

  const { mid, side } = buildMidSide(channels);

  // Per-band RMS on the mid channel.
  const lowMid = bandpass(mid, fs, 200,  1000);
  const vocal  = bandpass(mid, fs, 1000, 4000);
  const harsh  = bandpass(mid, fs, 2500, 5000);
  const air    = bandpass(mid, fs, 5000, 12000);

  const lowMidDb = dbOf(rmsOf(lowMid));
  const vocalDb  = dbOf(rmsOf(vocal));
  const harshDb  = dbOf(rmsOf(harsh));
  const airDb    = dbOf(rmsOf(air));

  // Centrality: mid vs side in the vocal band.
  let midSideDb = +Infinity;       // mono ≡ infinite centrality
  if (side) {
    const sideVocal = bandpass(side, fs, 1000, 4000);
    const sideDb = dbOf(rmsOf(sideVocal));
    midSideDb = vocalDb - sideDb;
  }
  const centralityScore = !isFinite(midSideDb)
    ? 1
    : smoothScore(midSideDb, 0, 9);     // 0 dB → 0; ≥9 dB → 1

  // Syllabic modulation: envelope CV in the vocal band.
  const { env } = envelope30Hz(vocal, fs);
  const cv = envelopeCv(env);
  const modulationScore = smoothScore(cv, 0.25, 0.85);

  // Spectral presence: vocal band must not be near the noise floor.
  // Compare to overall RMS (in dB) — vocal band should be within 25 dB of mix.
  const wholeRmsDb = dbOf(rmsOf(mid));
  const presenceGap = isFinite(vocalDb) && isFinite(wholeRmsDb)
    ? vocalDb - wholeRmsDb       // negative number, e.g., -8 dB
    : -Infinity;
  // Healthy: vocal-band sits within ~15 dB of overall RMS.
  const presenceScore = smoothScore(presenceGap, -25, -8);

  // Geometric mean of centrality + modulation requires BOTH to fire,
  // weighted by spectral presence as a soft multiplier (0.5..1).
  const vocalScore = Math.sqrt(centralityScore * modulationScore)
                   * (0.5 + 0.5 * presenceScore);

  // Diagnosis.
  let diagnosis: VocalDiagnosis;
  const correction: VocalCorrection[] = [];
  if (vocalScore < 0.40) {
    diagnosis = 'no_vocal';
  } else {
    // "Buried": vocal band RMS sits ≥ 3 dB below low-mid+air average.
    const surroundDb = (lowMidDb + airDb) / 2;
    const buriedGap = surroundDb - vocalDb;     // positive → vocal weaker
    // "Harsh": harsh-band exceeds the rest of the vocal band by ≥ 4 dB.
    const vocalLowerHalf = bandpass(mid, fs, 1000, 2500);
    const vocalLowerDb = dbOf(rmsOf(vocalLowerHalf));
    const harshExcess = harshDb - vocalLowerDb;

    if (harshExcess > 4 && buriedGap < 1) {
      diagnosis = 'harsh';
      const cutDb = -Math.min(2.0, 0.5 * (harshExcess - 4) + 1.0);
      correction.push({ freqHz: 3500, gainDb: cutDb, q: 2.5 });
    } else if (buriedGap > 3) {
      diagnosis = 'buried';
      const boostDb = Math.min(2.5, 0.6 * (buriedGap - 3) + 1.0);
      correction.push({ freqHz: 2500, gainDb: boostDb, q: 0.9 });
    } else {
      diagnosis = 'balanced';
    }
  }

  return {
    vocalScore, centralityScore, modulationScore, presenceScore,
    vocalBandDb: vocalDb,
    harshBandDb: harshDb,
    lowMidBandDb: lowMidDb,
    airBandDb: airDb,
    midSideRatioDb: midSideDb,
    envelopeCv: cv,
    diagnosis,
    correction,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Analyze the input for vocal presence and apply gentle EQ if a clear
 * problem is detected.  Bypasses (returns the input untouched) when:
 *   • vocal score is below threshold (no clear vocal evidence), OR
 *   • diagnosis is "balanced" (vocal present and well-balanced).
 */
export function enhanceVocal(
  input: AudioBufferLike,
  opts: EnhanceVocalOptions = {},
): EnhanceVocalResult {
  const threshold = opts.scoreThreshold ?? 0.40;
  const maxCorrDb = opts.maxCorrectionDb ?? 2.5;
  const force     = opts.forceEnable ?? false;

  const analysis = analyzeVocalPresence(input);

  // Build an independent copy of the buffer.
  const fs = input.sampleRate;
  const nCh = input.numberOfChannels;
  const out: Float32Array[] = new Array(nCh);
  for (let c = 0; c < nCh; c++) out[c] = new Float32Array(input.getChannelData(c));

  // Decide whether to apply.
  const shouldBypass = !force && (
    analysis.vocalScore < threshold ||
    analysis.diagnosis  === 'no_vocal' ||
    analysis.diagnosis  === 'balanced' ||
    analysis.correction.length === 0
  );

  let appliedEq: VocalCorrection[] = [];
  if (!shouldBypass) {
    // Half-strength when in the uncertain band [threshold, threshold+0.2].
    const certaintyScale = analysis.vocalScore > threshold + 0.2
      ? 1
      : 0.5 * ((analysis.vocalScore - threshold) / 0.2 + 1);
    appliedEq = analysis.correction.map((c) => ({
      ...c,
      gainDb: Math.max(-maxCorrDb, Math.min(maxCorrDb, c.gainDb * certaintyScale)),
    }));
    // Apply each EQ band as a per-channel peaking biquad.
    for (const eq of appliedEq) {
      const coeffs = rbjPeakingEq(fs, eq.freqHz, eq.q, eq.gainDb);
      for (let c = 0; c < nCh; c++) {
        const bq = new Biquad(coeffs);
        bq.processBlock(out[c] as Float32Array);
      }
    }
  }

  return {
    buffer: {
      sampleRate:       fs,
      numberOfChannels: nCh,
      length:           (out[0] as Float32Array | undefined)?.length ?? 0,
      getChannelData(c: number): Float32Array { return out[c] as Float32Array; },
    },
    analysis,
    bypassed: shouldBypass,
    appliedEq,
  };
}
