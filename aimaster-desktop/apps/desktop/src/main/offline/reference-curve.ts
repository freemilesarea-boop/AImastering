// reference-curve — measure a reference track's tonal balance.
//
// Match EQ has always been able to pull a mix towards a reference curve,
// and there has never been a way to give it one. `matchTargetCurveDb` is a
// field on `ChainConfigInput` that no caller ever set, so the module drew an
// empty graph, said "no reference", and could not be switched on. The panel
// offered no way to load a track either — the feature was reachable only by
// writing the 32 numbers by hand.
//
// This measures them. Decode the reference, run it through the SAME spectral
// stage the Match EQ uses, in analysis-only mode so it measures without
// processing, and read the long-term curve off the chain.
//
// Using the engine's own measurement rather than an FFT written here is the
// point: the curve Match EQ compares against has to live on the engine's
// 32-band log grid with the engine's weighting and smoothing, or the match
// is computed against a slightly different picture of the same audio, and
// the error shows up as a tonal tilt nobody can trace.

import { createOfflineChain, type WasmMasteringChain } from './load-mastering-chain-node.js';
import { decodeToFloatStereo, deinterleaveStereo } from './process-audio-file-rust.js';

/** Bands in the shared log grid — `CURVE_BANDS` in `spectral.rs`. */
export const REFERENCE_CURVE_BANDS = 32;

/** Sample rate the reference is measured at. */
const MEASURE_SR = 48_000;
/** Block size for the measurement pass. */
const BLOCK = 512;
/**
 * How much of the track to measure, in seconds.
 *
 * The curve is a long-term average, so more is not better past the point
 * where it has converged — and a full album track would make the user wait
 * for a number that stopped moving a minute ago. Ninety seconds from the
 * middle covers a chorus on almost anything.
 */
const MEASURE_SECONDS = 90;
/**
 * Seconds skipped at the start.
 *
 * Intros are the least representative part of a record — often sparse,
 * often filtered — and a tonal reference taken from one describes a section
 * rather than the mix.
 */
const SKIP_SECONDS = 20;

export interface ReferenceCurveResult {
  /** dB per band on the shared 32-band log grid, normalised to zero mean. */
  curveDb: number[];
  /** Seconds of audio actually folded into the average. */
  measuredSeconds: number;
}

interface ChainWithCurve extends WasmMasteringChain {
  tonalCurveDb?(): Float64Array;
  setConfigJson?(json: string): void;
}

/**
 * Measure the tonal curve of a reference file.
 *
 * Throws when the file cannot be decoded, or when the WASM build predates
 * the suite config and cannot be put into analysis-only mode — better than
 * quietly answering with a flat curve, which would look like a valid
 * reference and match the mix to nothing.
 */
export async function measureReferenceCurve(filePath: string): Promise<ReferenceCurveResult> {
  const interleaved = await decodeToFloatStereo(filePath, MEASURE_SR);
  const { left, right } = deinterleaveStereo(interleaved);
  if (left.length === 0) throw new Error('reference decoded to no audio');

  const chain = createOfflineChain(MEASURE_SR) as ChainWithCurve;
  if (typeof chain.setConfigJson !== 'function' || typeof chain.tonalCurveDb !== 'function') {
    throw new Error('this build cannot measure a reference curve');
  }

  // Analysis only: the spectral stage measures the long-term curve and
  // leaves the audio alone. Everything else stays at its default, which is
  // pass-through, so what is measured is the reference itself.
  chain.setConfigJson(JSON.stringify({ spectral: { analysisOnly: true } }));

  const skip = Math.min(SKIP_SECONDS * MEASURE_SR, Math.floor(left.length / 3));
  const end = Math.min(left.length, skip + MEASURE_SECONDS * MEASURE_SR);

  // Copies, because the chain processes in place and the caller's decode
  // buffer is a view onto the ffmpeg output.
  for (let a = skip; a < end; a += BLOCK) {
    const b = Math.min(a + BLOCK, end);
    const l = left.slice(a, b);
    const r = right.slice(a, b);
    chain.processStereo(l, r);
  }

  const raw = Array.from(chain.tonalCurveDb());
  chain.free?.();

  if (raw.length !== REFERENCE_CURVE_BANDS) {
    throw new Error(`unexpected curve length ${raw.length}`);
  }

  // Bands the analysis never observed come back as -Infinity. Left in, they
  // would poison the mean and then every other band with it, so they are
  // filled from their nearest measured neighbour before normalising.
  const filled = fillGaps(raw);
  const finite = filled.filter((v) => Number.isFinite(v));
  if (finite.length === 0) throw new Error('reference produced no usable spectrum');
  const mean = finite.reduce((a, b) => a + b, 0) / finite.length;

  return {
    curveDb: filled.map((v) => (Number.isFinite(v) ? v - mean : 0)),
    measuredSeconds: (end - skip) / MEASURE_SR,
  };
}

/** Replace non-finite bands with the nearest finite one on either side. */
function fillGaps(curve: number[]): number[] {
  const out = curve.slice();
  for (let i = 0; i < out.length; i++) {
    if (Number.isFinite(out[i]!)) continue;
    let lo = i - 1;
    while (lo >= 0 && !Number.isFinite(out[lo]!)) lo--;
    let hi = i + 1;
    while (hi < out.length && !Number.isFinite(curve[hi]!)) hi++;
    if (lo >= 0) out[i] = out[lo]!;
    else if (hi < out.length) out[i] = curve[hi]!;
  }
  return out;
}
