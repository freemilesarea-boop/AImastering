// FFT-frame → visualizer spectrum adapter (OZONE-MODULE-NEXT-1).
//
// Converts an analyzer `FftFrame` into the plain arrays the
// SpectrumWaveformCanvas consumes.  Real data only — returns null when
// there is no frame (the visualizer then shows its idle state); never
// fabricates mock data.

import type { FftFrame } from '@aimaster/shared-types/streaming';

export interface VisualizerSpectrum {
  binCentresHz: number[];
  magnitudeDb: number[];
  peakHoldDb?: number[];
  sampleRate: number;
  fftSize: number;
}

/** dB floor for empty bins (FftFrame uses -Infinity for silence). */
const DB_FLOOR = -100;

function sanitize(values: ReadonlyArray<number>): number[] {
  const out = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    out[i] = Number.isFinite(v) ? v : DB_FLOOR;
  }
  return out;
}

/**
 * Adapt a frame for the visualizer.  Returns null for a missing/empty
 * frame so the caller renders the idle ("재생을 시작하면…") state rather
 * than a fake spectrum.
 */
export function fftFrameToSpectrum(frame: FftFrame | null | undefined): VisualizerSpectrum | null {
  if (!frame) return null;
  const bins = frame.binCentresHz;
  const mags = frame.magnitudeDb;
  if (!bins || !mags || bins.length < 2 || bins.length !== mags.length) return null;
  const result: VisualizerSpectrum = {
    binCentresHz: bins.slice() as number[],
    magnitudeDb: sanitize(mags),
    sampleRate: frame.sampleRate,
    fftSize: frame.fftSize,
  };
  if (frame.peakHoldDb && frame.peakHoldDb.length === bins.length) {
    result.peakHoldDb = sanitize(frame.peakHoldDb);
  }
  return result;
}
