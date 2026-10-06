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
import { findLoudSpan, spanRmsDbfs } from './loud-span.js';

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
 * for a number that stopped moving a minute ago.
 */
const MEASURE_SECONDS = 90;
/**
 * The shortest span worth calling a reference, in seconds.
 *
 * The chain's band average is an exponential decay with a ~2 s constant, so
 * a span near that length reports mostly its own last moment.  There was no
 * minimum at all: a 0.3 s file measured 0.2 s and came back with a
 * confident-looking 32-band curve, which then became the target an entire
 * mix was matched to.  `profileSong` has always refused under a second; a
 * reference is held to more, because a profile only picks defaults while a
 * reference is pulled towards.
 */
const MIN_MEASURE_SECONDS = 4;
/**
 * Below this, there is nothing to measure, in dBFS.
 *
 * Measured rather than assumed: the analyser floors unobserved bands at
 * -200 and -140 dBFS rather than returning -Infinity, so 30 s of digital
 * silence came back as 32 FINITE bands, which normalising to zero mean
 * turned into a 60 dB "curve".  The `finite.length === 0` guard below
 * therefore cannot fire, and a reference that looks measured is worse than
 * one that is obviously flat.
 *
 * -60 dBFS is far under any mix and far over a dithered silent file.
 */
const SILENT_RMS_DBFS = -60;

/**
 * No `SKIP_SECONDS` any more.
 *
 * It was 20, to step over the intro — "the least representative part of a
 * record, often sparse, often filtered".  True, and a constant is a poor
 * way to find it; starting at the loudest window lands in the body of any
 * arrangement without guessing. See `loud-span`.
 */

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
 * Throws when the file cannot be decoded, when the WASM build predates the
 * suite config and cannot be put into analysis-only mode, when there is too
 * little audio for the average to converge, or when the span it found has
 * no sound in it — better than quietly answering with a curve that would
 * look like a valid reference and match the mix to nothing.
 *
 * That last pair is new.  This function already gave that as its reason for
 * throwing, and the two ways it actually happened both returned normally.
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

  // Where to measure.
  //
  // This used to be a fixed window: 20 s in, 90 s long.  The 20 s skipped
  // the intro — but nothing watched the OTHER end, and the end is what a
  // decaying average reports.  Measured on the real chain, 30 s of noise
  // followed by TWO seconds of silence moved the curve's mean from -3.2 dB
  // to -122.1 dB, and five seconds took it to -178.0: the analyser's own
  // floor, which then normalises into a shape that looks like a reference.
  // Trailing silence is in almost every audio file.
  //
  // The level is checked BEFORE the span, so a silent file is told it is
  // silent.  Checked after, it was told it was too short — true (the
  // trailing-quiet trim walks a silent span down to nothing) and useless,
  // since shortening it is not something the user can fix.
  const fileDbfs = spanRmsDbfs(left, right, 0, left.length);
  if (!(fileDbfs > SILENT_RMS_DBFS)) {
    throw new Error(
      `레퍼런스에 측정할 소리가 없습니다 — 파일 전체가 ${
        Number.isFinite(fileDbfs) ? `${fileDbfs.toFixed(1)} dBFS` : '완전한 무음'
      }입니다`,
    );
  }

  const span = findLoudSpan(left, right, MEASURE_SR, {
    maxSec: MEASURE_SECONDS, growBackward: true, trimTrailingQuiet: true,
  });
  const measuredSeconds = (span.to - span.from) / MEASURE_SR;
  if (measuredSeconds < MIN_MEASURE_SECONDS) {
    throw new Error(
      `레퍼런스가 너무 짧습니다 — 분석할 수 있는 구간이 ${measuredSeconds.toFixed(1)}초입니다 `
      + `(최소 ${MIN_MEASURE_SECONDS}초)`,
    );
  }
  // And the span itself, for a file that is loud somewhere and silent where
  // the span landed.
  const levelDbfs = spanRmsDbfs(left, right, span.from, span.to);
  if (!(levelDbfs > SILENT_RMS_DBFS)) {
    throw new Error(
      `레퍼런스에 측정할 소리가 없습니다 — 분석 구간이 ${
        Number.isFinite(levelDbfs) ? `${levelDbfs.toFixed(1)} dBFS` : '완전한 무음'
      }입니다`,
    );
  }

  // Copies, because the chain processes in place and the caller's decode
  // buffer is a view onto the ffmpeg output.
  for (let a = span.from; a < span.to; a += BLOCK) {
    const b = Math.min(a + BLOCK, span.to);
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
    measuredSeconds,
  };
}

/**
 * Replace non-finite bands with a measured neighbour — the one below when
 * there is one, otherwise the first above.
 *
 * Not "the nearest finite one on either side", which is what this claimed:
 * the lower neighbour wins however far away it is.  Which side a filled
 * band copies matters less than that it is filled, since a band left at
 * -Infinity poisons the mean and then every other band through it.
 */
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
