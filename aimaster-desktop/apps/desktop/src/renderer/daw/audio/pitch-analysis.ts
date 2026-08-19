// Pitch analysis — the measurement half of a VariAudio-style vocal editor.
//
// What it produces, per detected note segment:
//   • pitch      — the note the singer aimed at, plus the exact curve they sang
//   • timing     — where the segment starts and ends
//   • vibrato    — rate in Hz and depth in cents
//   • drift      — how far the pitch slides across the note, in cents/second
// (Formant is an EDIT parameter rather than a measurement — see pitch-shift.)
//
// Detection is YIN (cumulative mean normalised difference), which is the
// standard monophonic F0 estimator: robust on vocals, cheap enough to run on
// a whole stem offline, and it reports a confidence that tells us when the
// singer is between notes or the mic caught a breath.
//
// Pure and array-based, so it is tested against synthesised tones with known
// pitch, vibrato and drift.

import { frequencyToPitch } from '../model/midi.js';

export interface PitchFrame {
  timeSec: number;
  /** 0 when unvoiced. */
  hz: number;
  /** 0…1 — how strongly periodic the frame is. */
  confidence: number;
}

export interface PitchAnalysisOptions {
  /** Analysis rate; the signal is decimated to this before YIN runs. */
  workingRate: number;
  frameSec: number;
  hopSec: number;
  minHz: number;
  maxHz: number;
  /** YIN's absolute threshold — lower is stricter about periodicity. */
  threshold: number;
  /** Frames below this confidence count as unvoiced. */
  voicedConfidence: number;
}

export const DEFAULT_PITCH_OPTIONS: PitchAnalysisOptions = {
  workingRate: 16_000,
  frameSec: 0.04,
  hopSec: 0.01,
  minHz: 65,
  maxHz: 1200,
  threshold: 0.15,
  voicedConfidence: 0.55,
};

// ── Decimation ────────────────────────────────────────────────────────────────

/**
 * Cheap anti-aliased decimation: a box filter over the decimation factor.
 * Good enough ahead of an F0 estimator that only cares about periodicity, and
 * it keeps the analysis pass fast on a full vocal take.
 */
export function decimate(
  samples: ArrayLike<number>, fromRate: number, toRate: number,
): { data: Float32Array; rate: number } {
  if (toRate >= fromRate) {
    const copy = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) copy[i] = samples[i] ?? 0;
    return { data: copy, rate: fromRate };
  }
  const factor = Math.max(1, Math.round(fromRate / toRate));
  const outLength = Math.floor(samples.length / factor);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    let sum = 0;
    for (let j = 0; j < factor; j++) sum += samples[i * factor + j] ?? 0;
    out[i] = sum / factor;
  }
  return { data: out, rate: fromRate / factor };
}

// ── YIN ───────────────────────────────────────────────────────────────────────

/**
 * F0 of one frame.  Returns 0 Hz when the frame is not periodic enough.
 */
export function yinF0(
  frame: ArrayLike<number>, sampleRate: number,
  minHz = 65, maxHz = 1200, threshold = 0.15,
): { hz: number; confidence: number } {
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const tauMax = Math.min(Math.floor(sampleRate / minHz), Math.floor(frame.length / 2));
  if (tauMax <= tauMin) return { hz: 0, confidence: 0 };

  const window = frame.length - tauMax;
  if (window <= 0) return { hz: 0, confidence: 0 };

  // 1. Difference function.
  const diff = new Float32Array(tauMax + 1);
  for (let tau = tauMin; tau <= tauMax; tau++) {
    let sum = 0;
    for (let i = 0; i < window; i++) {
      const delta = (frame[i] ?? 0) - (frame[i + tau] ?? 0);
      sum += delta * delta;
    }
    diff[tau] = sum;
  }

  // 2. Cumulative mean normalised difference.
  const cmnd = new Float32Array(tauMax + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    running += diff[tau] ?? 0;
    cmnd[tau] = running > 0 ? ((diff[tau] ?? 0) * (tau - tauMin + 1)) / running : 1;
  }

  // 3. First dip below the threshold, else the global minimum.
  let best = -1;
  for (let tau = tauMin + 1; tau < tauMax; tau++) {
    const v = cmnd[tau] ?? 1;
    if (v < threshold && v <= (cmnd[tau + 1] ?? 1)) { best = tau; break; }
  }
  if (best === -1) {
    let lowest = Infinity;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      const v = cmnd[tau] ?? 1;
      if (v < lowest) { lowest = v; best = tau; }
    }
    if (best === -1 || lowest > 0.6) return { hz: 0, confidence: 0 };
  }

  // 4. Parabolic interpolation around the dip for sub-sample accuracy —
  //    without it the pitch quantises to integer lag and reads several cents
  //    off, which is exactly the resolution a pitch editor needs.
  const prev = cmnd[best - 1] ?? cmnd[best] ?? 1;
  const here = cmnd[best] ?? 1;
  const next = cmnd[best + 1] ?? here;
  const denominator = prev + next - 2 * here;
  const shift = denominator !== 0 ? (0.5 * (prev - next)) / denominator : 0;
  const tau = best + Math.max(-1, Math.min(1, shift));

  return { hz: sampleRate / tau, confidence: Math.max(0, Math.min(1, 1 - here)) };
}

/** Frame-by-frame F0 track over a whole signal. */
export function analyzePitch(
  samples: ArrayLike<number>, sampleRate: number,
  options: Partial<PitchAnalysisOptions> = {},
): PitchFrame[] {
  const opt = { ...DEFAULT_PITCH_OPTIONS, ...options };
  const { data, rate } = decimate(samples, sampleRate, opt.workingRate);
  const frameSize = Math.max(64, Math.round(opt.frameSec * rate));
  const hop = Math.max(1, Math.round(opt.hopSec * rate));

  const frames: PitchFrame[] = [];
  for (let start = 0; start + frameSize <= data.length; start += hop) {
    const frame = data.subarray(start, start + frameSize);
    const { hz, confidence } = yinF0(frame, rate, opt.minHz, opt.maxHz, opt.threshold);
    frames.push({
      timeSec: (start + frameSize / 2) / rate,
      hz: confidence >= opt.voicedConfidence ? hz : 0,
      confidence,
    });
  }
  return frames;
}

// ── Segmentation ──────────────────────────────────────────────────────────────

export interface PitchCurvePoint {
  /** Seconds from the SEGMENT start. */
  timeSec: number;
  /** Deviation from the segment's centre pitch, in cents. */
  cents: number;
}

/** What the analyser measured about one sung note. */
export interface SegmentMeasurement {
  medianPitch: number;          // MIDI, fractional
  curve: PitchCurvePoint[];
  confidence: number;
  vibratoRateHz: number;
  vibratoDepthCents: number;
  driftCentsPerSec: number;
}

/** The user's edits — every one of them is reversible and explicit. */
export interface SegmentEdit {
  /** Move the whole note, in cents (100 = a semitone). */
  pitchOffsetCents: number;
  /** 1 = keep the performance's vibrato, 0 = remove it entirely. */
  vibratoScale: number;
  /** 1 = keep the drift, 0 = flatten the slide across the note. */
  driftScale: number;
  /** 1 = keep the micro-pitch curve, 0 = perfectly straight. */
  curveScale: number;
  /** Formant shift in semitones, independent of pitch (render-time). */
  formantSemitones: number;
  /** Timing nudge in seconds. */
  timeOffsetSec: number;
}

export const NEUTRAL_EDIT: SegmentEdit = {
  pitchOffsetCents: 0,
  vibratoScale: 1,
  driftScale: 1,
  curveScale: 1,
  formantSemitones: 0,
  timeOffsetSec: 0,
};

export interface VariSegment {
  id: string;
  startSec: number;
  endSec: number;
  measured: SegmentMeasurement;
  edit: SegmentEdit;
}

export interface SegmentOptions {
  /** Gaps of unvoiced frames longer than this split a segment. */
  maxGapSec: number;
  /** Segments shorter than this are noise, not notes. */
  minLengthSec: number;
  /** A jump larger than this starts a new segment even without a gap. */
  splitSemitones: number;
}

export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions = {
  maxGapSec: 0.06,
  minLengthSec: 0.06,
  splitSemitones: 0.8,
};

let segmentCounter = 0;
function nextSegmentId(): string { segmentCounter += 1; return `seg-${segmentCounter}`; }
export function resetSegmentIds(): void { segmentCounter = 0; }

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : (((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
}

/** Least-squares slope of y over x. */
export function linearSlope(points: ReadonlyArray<{ x: number; y: number }>): number {
  const n = points.length;
  if (n < 2) return 0;
  let sx = 0; let sy = 0; let sxy = 0; let sxx = 0;
  for (const p of points) { sx += p.x; sy += p.y; sxy += p.x * p.y; sxx += p.x * p.x; }
  const denominator = n * sxx - sx * sx;
  return denominator === 0 ? 0 : (n * sxy - sx * sy) / denominator;
}

/**
 * Vibrato from the detrended cents curve: autocorrelation finds the rate,
 * and the RMS of the modulation gives the depth.  Singing vibrato lives
 * between about 4 and 8 Hz, so the search is bounded there — otherwise slow
 * drift reads as "0.5 Hz vibrato".
 */
export function measureVibrato(
  curve: readonly PitchCurvePoint[], driftCentsPerSec: number,
): { rateHz: number; depthCents: number } {
  if (curve.length < 8) return { rateHz: 0, depthCents: 0 };
  const first = curve[0];
  const last = curve[curve.length - 1];
  if (!first || !last) return { rateHz: 0, depthCents: 0 };
  const duration = last.timeSec - first.timeSec;
  if (duration <= 0.15) return { rateHz: 0, depthCents: 0 };

  // Remove the drift so only the oscillation is left.
  const detrended = curve.map((p) => p.cents - driftCentsPerSec * p.timeSec);
  const mean = detrended.reduce((s, v) => s + v, 0) / detrended.length;
  const centred = detrended.map((v) => v - mean);

  const hop = duration / (curve.length - 1);
  const minLag = Math.max(1, Math.round(1 / 8 / hop));      // 8 Hz
  const maxLag = Math.min(centred.length - 2, Math.round(1 / 4 / hop));   // 4 Hz
  if (maxLag <= minLag) return { rateHz: 0, depthCents: 0 };

  let bestLag = 0;
  let bestScore = 0;
  let energy = 0;
  for (const v of centred) energy += v * v;
  if (energy <= 1e-9) return { rateHz: 0, depthCents: 0 };

  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < centred.length; i++) sum += (centred[i] ?? 0) * (centred[i + lag] ?? 0);
    const score = sum / energy;
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  if (bestLag === 0 || bestScore < 0.3) return { rateHz: 0, depthCents: 0 };

  const rms = Math.sqrt(energy / centred.length);
  return { rateHz: 1 / (bestLag * hop), depthCents: rms * Math.SQRT2 };
}

/**
 * Group the F0 track into note-like segments and measure each one.
 */
export function segmentPitch(
  frames: readonly PitchFrame[], options: Partial<SegmentOptions> = {},
): VariSegment[] {
  const opt = { ...DEFAULT_SEGMENT_OPTIONS, ...options };
  const segments: VariSegment[] = [];
  let current: PitchFrame[] = [];
  let lastVoicedTime = -Infinity;

  const flush = (): void => {
    if (current.length === 0) return;
    const voiced = current.filter((f) => f.hz > 0);
    current = [];
    if (voiced.length < 3) return;
    const first = voiced[0];
    const last = voiced[voiced.length - 1];
    if (!first || !last) return;
    const startSec = first.timeSec;
    const endSec = last.timeSec;
    if (endSec - startSec < opt.minLengthSec) return;

    const pitches = voiced.map((f) => frequencyToPitch(f.hz));
    const centre = median(pitches);
    const curve: PitchCurvePoint[] = voiced.map((f, i) => ({
      timeSec: f.timeSec - startSec,
      cents: ((pitches[i] ?? centre) - centre) * 100,
    }));
    const drift = linearSlope(curve.map((p) => ({ x: p.timeSec, y: p.cents })));
    const vibrato = measureVibrato(curve, drift);
    const confidence = voiced.reduce((s, f) => s + f.confidence, 0) / voiced.length;

    segments.push({
      id: nextSegmentId(),
      startSec,
      endSec,
      measured: {
        medianPitch: centre,
        curve,
        confidence,
        vibratoRateHz: vibrato.rateHz,
        vibratoDepthCents: vibrato.depthCents,
        driftCentsPerSec: drift,
      },
      edit: { ...NEUTRAL_EDIT },
    });
  };

  for (const frame of frames) {
    if (frame.hz <= 0) {
      if (frame.timeSec - lastVoicedTime > opt.maxGapSec) flush();
      continue;
    }
    const previous = current[current.length - 1];
    if (previous && previous.hz > 0) {
      const jump = Math.abs(frequencyToPitch(frame.hz) - frequencyToPitch(previous.hz));
      if (jump > opt.splitSemitones) flush();
    }
    if (frame.timeSec - lastVoicedTime > opt.maxGapSec) flush();
    current.push(frame);
    lastVoicedTime = frame.timeSec;
  }
  flush();
  return segments;
}

/** One call: samples → editable segments. */
export function analyzeVocal(
  samples: ArrayLike<number>, sampleRate: number,
  pitchOptions: Partial<PitchAnalysisOptions> = {},
  segmentOptions: Partial<SegmentOptions> = {},
): VariSegment[] {
  return segmentPitch(analyzePitch(samples, sampleRate, pitchOptions), segmentOptions);
}

// ── Target pitch after edits ──────────────────────────────────────────────────

/**
 * The pitch the segment should sound at, `tRel` seconds in, once the edits
 * are applied.  This is the single function the renderer follows, so what the
 * UI draws and what the audio does cannot disagree.
 */
export function targetPitchAt(segment: VariSegment, tRel: number): number {
  const { measured, edit } = segment;
  const drift = measured.driftCentsPerSec * tRel;
  const rawCents = curveCentsAt(measured.curve, tRel);
  // Split the measured curve into drift + everything else (vibrato and the
  // micro-detail), so each can be scaled on its own.
  const detail = rawCents - drift;
  const cents =
    edit.pitchOffsetCents
    + drift * edit.driftScale
    + detail * edit.curveScale * edit.vibratoScale;
  return measured.medianPitch + cents / 100;
}

export function curveCentsAt(curve: readonly PitchCurvePoint[], tRel: number): number {
  if (curve.length === 0) return 0;
  const first = curve[0];
  const last = curve[curve.length - 1];
  if (!first || !last) return 0;
  if (tRel <= first.timeSec) return first.cents;
  if (tRel >= last.timeSec) return last.cents;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (!a || !b) continue;
    if (tRel <= b.timeSec) {
      const span = b.timeSec - a.timeSec;
      if (span <= 1e-9) return b.cents;
      return a.cents + ((b.cents - a.cents) * (tRel - a.timeSec)) / span;
    }
  }
  return last.cents;
}

/** Semitone shift the renderer must apply at a moment inside the segment. */
export function shiftSemitonesAt(segment: VariSegment, tRel: number): number {
  const measuredPitch = segment.measured.medianPitch + curveCentsAt(segment.measured.curve, tRel) / 100;
  return targetPitchAt(segment, tRel) - measuredPitch;
}

// ── Editing helpers (what the smart controls do) ──────────────────────────────

export function withEdit(segment: VariSegment, patch: Partial<SegmentEdit>): VariSegment {
  return { ...segment, edit: { ...segment.edit, ...patch } };
}

/** Snap a segment to the nearest semitone, by `amount` (0…1). */
export function quantizePitch(segment: VariSegment, amount = 1): VariSegment {
  const target = Math.round(segment.measured.medianPitch);
  const errorCents = (target - segment.measured.medianPitch) * 100;
  return withEdit(segment, { pitchOffsetCents: errorCents * Math.max(0, Math.min(1, amount)) });
}

/** Snap to the nearest pitch in a set (a scale or a chord). */
export function quantizeToPitches(
  segment: VariSegment, allowedPitchClasses: ReadonlySet<number>, amount = 1,
): VariSegment {
  if (allowedPitchClasses.size === 0) return segment;
  const base = segment.measured.medianPitch;
  let best = Math.round(base);
  let bestDistance = Infinity;
  for (let candidate = Math.round(base) - 6; candidate <= Math.round(base) + 6; candidate++) {
    if (!allowedPitchClasses.has(((candidate % 12) + 12) % 12)) continue;
    const distance = Math.abs(candidate - base);
    if (distance < bestDistance) { bestDistance = distance; best = candidate; }
  }
  const errorCents = (best - base) * 100;
  return withEdit(segment, { pitchOffsetCents: errorCents * Math.max(0, Math.min(1, amount)) });
}

/** Straighten the performance: less vibrato, less drift, less wobble. */
export function straighten(segment: VariSegment, amount = 1): VariSegment {
  const keep = 1 - Math.max(0, Math.min(1, amount));
  return withEdit(segment, { vibratoScale: keep, driftScale: keep, curveScale: keep });
}
