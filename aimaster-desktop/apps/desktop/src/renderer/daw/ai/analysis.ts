// The measurements the Intelligence Layer reasons over.
//
// Everything above this file is pure: given a `MixAnalysis`, the diagnosis,
// the auto-mix and the auto-master are deterministic functions with no audio
// and no I/O.  That is what makes them testable, and it is why this file
// exists — it is the only place that touches buffers.

import {
  analyzeForReference, averageSpectrum, bandLevelDb, correlationOf,
  widthFromCorrelation, TONAL_BANDS,
  type ReferenceAnalysis, type SpectrumCurve,
} from '../analysis/reference.js';
import { getLoudnessMetrics, type AudioBufferLike } from '../../audio/loudnessCore.js';
import { guessRole, refineRole, type RoleGuess, type SpectralShape } from './roles.js';
import type { DawSession, TrackId } from '../model/types.js';

export interface TrackAnalysis {
  trackId: TrackId;
  name: string;
  guess: RoleGuess;
  /** Integrated loudness of the track on its own. */
  integratedLufs: number;
  truePeakDbtp: number;
  /** Peak-to-loudness ratio — how percussive it is. */
  crestDb: number;
  spectrum: SpectrumCurve;
  shape: SpectralShape;
  correlation: number;
  widthPercent: number;
  /** Nothing audible on this track. */
  silent: boolean;
}

export interface MixAnalysis {
  /** The full mix, measured the same way a reference is. */
  master: ReferenceAnalysis;
  tracks: TrackAnalysis[];
  sampleRate: number;
  durationSec: number;
}

/** Energy shares, used to let the audio correct a weak name guess. */
export function shapeOf(spectrum: SpectrumCurve, crestDb: number): SpectralShape {
  const power = (lowHz: number, highHz: number): number => {
    let sum = 0;
    for (let i = 0; i < spectrum.hz.length; i++) {
      const hz = spectrum.hz[i] ?? 0;
      if (hz < lowHz || hz > highHz) continue;
      sum += Math.pow(10, (spectrum.db[i] ?? -120) / 10);
    }
    return sum;
  };
  const low = power(0, 120);
  const mid = power(120, 2000);
  const high = power(6000, 30000);
  const total = power(0, 30000) || 1;
  return {
    lowShare: low / total,
    midShare: mid / total,
    highShare: high / total,
    crestDb,
  };
}

export function analyzeTrackBuffer(
  buffer: AudioBufferLike, trackId: TrackId, name: string, kind: string,
): TrackAnalysis {
  const metrics = getLoudnessMetrics(buffer);
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;

  const mono = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) mono[i] = ((left[i] ?? 0) + (right[i] ?? 0)) * 0.5;

  const spectrum = averageSpectrum(mono, buffer.sampleRate);
  const silent = !Number.isFinite(metrics.integratedLufs) || metrics.integratedLufs < -60;
  const crestDb = Number.isFinite(metrics.truePeakDbtp) && Number.isFinite(metrics.integratedLufs)
    ? metrics.truePeakDbtp - metrics.integratedLufs
    : 0;
  const correlation = buffer.numberOfChannels > 1 ? correlationOf(left, right) : 1;

  const shape = shapeOf(spectrum, crestDb);
  return {
    trackId,
    name,
    guess: refineRole(guessRole(name, kind), shape),
    integratedLufs: metrics.integratedLufs,
    truePeakDbtp: metrics.truePeakDbtp,
    crestDb,
    spectrum,
    shape,
    correlation,
    widthPercent: widthFromCorrelation(correlation),
    silent,
  };
}

export function analyzeMix(
  master: AudioBufferLike,
  tracks: ReadonlyArray<{ trackId: TrackId; name: string; kind: string; buffer: AudioBufferLike }>,
  sessionName = 'YOUR MIX',
): MixAnalysis {
  return {
    master: analyzeForReference(master, sessionName),
    tracks: tracks.map((t) => analyzeTrackBuffer(t.buffer, t.trackId, t.name, t.kind)),
    sampleRate: master.sampleRate,
    durationSec: (master.length ?? master.getChannelData(0).length) / master.sampleRate,
  };
}

/** Which tracks a session would render for analysis. */
export function analysableTracks(session: DawSession): { id: TrackId; name: string; kind: string }[] {
  return session.tracks
    .filter((t) => (t.kind === 'audio' || t.kind === 'instrument') && !t.mute)
    .map((t) => ({ id: t.id, name: t.name, kind: t.kind }));
}

/** Band levels of the master, so the diagnostics can talk in ranges. */
export function masterBands(analysis: MixAnalysis): { low: number; mid: number; high: number } {
  const s = analysis.master.spectrum;
  return {
    low: bandLevelDb(s, TONAL_BANDS.low.lowHz, TONAL_BANDS.low.highHz),
    mid: bandLevelDb(s, TONAL_BANDS.mid.lowHz, TONAL_BANDS.mid.highHz),
    high: bandLevelDb(s, TONAL_BANDS.high.lowHz, TONAL_BANDS.high.highHz),
  };
}
