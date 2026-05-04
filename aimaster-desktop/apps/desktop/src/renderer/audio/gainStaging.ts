// Automatic gain staging — pre-limiter input normalizer.
//
// Why this exists:
//   When a track enters the mastering chain hot (peaks at 0 dBFS, RMS
//   at -8 dBFS) the look-ahead limiter is forced to do > 6 dB of GR
//   right out of the gate, which collapses transients and causes
//   pumping.  When it enters too quiet (RMS at -30 dBFS) the maximizer
//   has to stack > 15 dB of boost, dragging the noise floor up with it.
//
//   The fix is the oldest trick in the studio: stage the input level so
//   the chain can do its real job.  We pick the gain that brings the
//   input to a comfortable working zone (peak ≈ -6 dBFS, RMS ≈ -18 dBFS,
//   loudness ≈ -18 LUFS), choosing the most conservative constraint so
//   we never push the input past any of those headroom targets.
//
// Result: the buffer enters the limiter with consistent dynamics, the
// limiter only does light corrective work, and the final loudness
// maximizer can stack its target gain without burning into distortion.

import { LoudnessAnalyzer, AudioBufferLike } from './loudnessCore.js';
import { TruePeakChannel } from './truePeak.js';

export interface GainStagingParams {
  /** Target sample-peak in dBFS.  Default -6 (≈ 6 dB of transient headroom). */
  targetPeakDb?:    number;
  /** Target RMS in dBFS.  Default -18 (broadcast-style internal working level). */
  targetRmsDb?:     number;
  /** Target integrated LUFS.  Default -18 (matches the RMS target). */
  targetLufs?:      number;
  /** Max boost we'll ever apply, dB.  Default +12 (avoid noise-floor pumping). */
  maxBoostDb?:      number;
  /** Max attenuation (negative dB).  Default -∞ (always attenuate as needed). */
  maxAttenuateDb?:  number;
  /** Use true-peak (4× polyphase) when judging the peak target.  Default true. */
  measureTruePeak?: boolean;
}

export type GainStagingDecision = 'attenuate' | 'boost' | 'pass';
export type GainStagingConstraint = 'peak' | 'truePeak' | 'rms' | 'lufs';

export interface GainStagingResult {
  /** Gain-staged buffer (NEW, independent of input). */
  buffer:           AudioBufferLike;
  /** Applied gain in dB (positive = boost, negative = attenuation, 0 = pass-through). */
  appliedGainDb:    number;
  /** Which constraint determined the chosen gain. */
  limitedBy:        GainStagingConstraint;
  /** Decision taxonomy. */
  decision:         GainStagingDecision;

  // Diagnostics — measured before applying gain.
  inputPeakDb:      number;
  inputRmsDb:       number;
  inputLufs:        number;
  inputTruePeakDb:  number;

  // Diagnostics — projected output (input + appliedGainDb, pre-saturation).
  outputPeakDb:     number;
  outputRmsDb:      number;
  outputLufs:       number;
  outputTruePeakDb: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function dbOf(linear: number): number {
  return linear <= 0 ? -Infinity : 20 * Math.log10(linear);
}

function measureSamplePeak(channels: Float32Array[]): number {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i] as number);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

function measureRms(channels: Float32Array[]): number {
  let sumSq = 0;
  let total = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i] as number;
      sumSq += v * v;
    }
    total += ch.length;
  }
  if (total === 0) return 0;
  return Math.sqrt(sumSq / total);
}

function measureTruePeakLinear(channels: Float32Array[]): number {
  let peak = 0;
  for (const ch of channels) {
    const tp = new TruePeakChannel();
    tp.processBlock(ch);
    if (tp.peakLinear() > peak) peak = tp.peakLinear();
  }
  return peak;
}

function measureLufs(channels: Float32Array[], sr: number): number {
  const an = new LoudnessAnalyzer(sr, channels.length);
  an.processBlock(channels);
  return an.getIntegratedLufs();
}

function bufferFromPlanar(channels: Float32Array[], sr: number): AudioBufferLike {
  return {
    sampleRate:       sr,
    numberOfChannels: channels.length,
    length:           (channels[0] as Float32Array | undefined)?.length ?? 0,
    getChannelData(c: number): Float32Array { return channels[c] as Float32Array; },
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Analyze the input level (peak / RMS / LUFS / true-peak) and apply the
 * gain that brings it to the configured headroom target — choosing the
 * MOST conservative constraint so no target is ever exceeded.  Returns a
 * fresh buffer plus a diagnostics record.
 */
export function applyGainStaging(
  input: AudioBufferLike,
  opts: GainStagingParams = {},
): GainStagingResult {
  const targetPeakDb    = opts.targetPeakDb    ?? -6;
  const targetRmsDb     = opts.targetRmsDb     ?? -18;
  const targetLufs      = opts.targetLufs      ?? -18;
  const maxBoostDb      = opts.maxBoostDb      ?? 12;
  const maxAttenuateDb  = opts.maxAttenuateDb  ?? -Infinity;
  const useTruePeak     = opts.measureTruePeak ?? true;

  const sr = input.sampleRate;
  const nCh = input.numberOfChannels;

  // Snapshot — independent copy, so input is never mutated.
  const channels: Float32Array[] = new Array(nCh);
  for (let c = 0; c < nCh; c++) {
    channels[c] = new Float32Array(input.getChannelData(c));
  }

  // Measurements.
  const peakLin = measureSamplePeak(channels);
  const rmsLin  = measureRms(channels);
  const tpLin   = useTruePeak ? measureTruePeakLinear(channels) : peakLin;
  const lufs    = measureLufs(channels, sr);

  const inputPeakDb     = dbOf(peakLin);
  const inputRmsDb      = dbOf(rmsLin);
  const inputTruePeakDb = dbOf(tpLin);
  const inputLufs       = lufs;

  // Silence: nothing to do.
  if (peakLin === 0) {
    return {
      buffer: bufferFromPlanar(channels, sr),
      appliedGainDb: 0,
      limitedBy: 'peak',
      decision: 'pass',
      inputPeakDb, inputRmsDb, inputLufs, inputTruePeakDb,
      outputPeakDb: -Infinity, outputRmsDb: -Infinity,
      outputLufs:   -Infinity, outputTruePeakDb: -Infinity,
    };
  }

  // Per-constraint allowed gain (dB) — what gain brings each metric
  // exactly to its target (positive → can boost, negative → must attenuate).
  const peakHeadroom = targetPeakDb - inputPeakDb;
  const tpHeadroom   = targetPeakDb - inputTruePeakDb;
  const rmsHeadroom  = targetRmsDb  - inputRmsDb;
  const lufsHeadroom = isFinite(inputLufs) ? targetLufs - inputLufs : Infinity;

  // The chosen gain is the MIN across all constraints — most conservative.
  const candidates: { value: number; tag: GainStagingConstraint }[] = [
    { value: peakHeadroom, tag: 'peak' },
    { value: rmsHeadroom,  tag: 'rms'  },
    { value: lufsHeadroom, tag: 'lufs' },
  ];
  if (useTruePeak) candidates.push({ value: tpHeadroom, tag: 'truePeak' });

  let chosen = candidates[0] as { value: number; tag: GainStagingConstraint };
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i] as { value: number; tag: GainStagingConstraint };
    if (c.value < chosen.value) chosen = c;
  }

  // Clamp to user-supplied boost/attenuate caps.
  let gainDb = chosen.value;
  if (gainDb > maxBoostDb)     gainDb = maxBoostDb;
  if (gainDb < maxAttenuateDb) gainDb = maxAttenuateDb;

  const decision: GainStagingDecision =
    Math.abs(gainDb) < 0.05 ? 'pass'
    : (gainDb > 0 ? 'boost' : 'attenuate');

  // Apply the gain.
  if (gainDb !== 0) {
    const g = Math.pow(10, gainDb / 20);
    for (let c = 0; c < nCh; c++) {
      const arr = channels[c] as Float32Array;
      for (let i = 0; i < arr.length; i++) arr[i] = (arr[i] as number) * g;
    }
  }

  return {
    buffer: bufferFromPlanar(channels, sr),
    appliedGainDb: gainDb,
    limitedBy: chosen.tag,
    decision,
    inputPeakDb, inputRmsDb, inputLufs, inputTruePeakDb,
    outputPeakDb:     inputPeakDb     + gainDb,
    outputRmsDb:      inputRmsDb      + gainDb,
    outputLufs:       isFinite(inputLufs) ? inputLufs + gainDb : -Infinity,
    outputTruePeakDb: inputTruePeakDb + gainDb,
  };
}
