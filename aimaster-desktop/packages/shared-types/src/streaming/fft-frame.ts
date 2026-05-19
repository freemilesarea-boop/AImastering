// FFTFrame — single-frame spectrum analyzer output.
//
// Designed for live spectrum visualisers.  Emitted at the analyzer's
// configured cadence (typically 30 Hz for spectrum, separate from the
// meter snapshot cadence of 10 Hz).
//
// Memory layout: the magnitude array is intentionally bounded
// (≤ 256 elements) to keep postMessage transfer cheap.  For 1/3-octave
// binning, ≈ 30 elements suffice (M1.75 schema cap).  For linear FFT
// visualisers, the WASM/N-API binding bins down to ≤ 256 before transfer.

/** Schema URI. */
export const FFT_FRAME_SCHEMA = 'loui.streaming.fft-frame.v1';

/** How the frequency axis is binned. */
export type FftBinning =
  | { kind: 'third-octave' }     // ≈ 30 bins, M1.75-compatible
  | { kind: 'log';   bins: number; minHz: number; maxHz: number }
  | { kind: 'linear'; bins: number; minHz: number; maxHz: number };

/** A single spectrum frame — meant for immediate render + discard. */
export interface FftFrame {
  schema?: typeof FFT_FRAME_SCHEMA;
  /** Crate version that produced this frame. */
  crateVersion?: string;
  /** Sample rate of the analyzed audio. */
  sampleRate: number;
  /** Number of frames analyzed when this frame was emitted (per-channel). */
  samplesProcessed: number;
  /**
   * FFT window size used (power of two ≥ 1024).  Informational — the
   * binned `magnitudeDb` is independent of this.
   */
  fftSize: number;
  /**
   * Bin layout the magnitudes are in.  Optional — bindings that always
   * use a single layout per session may omit.
   */
  binning?: FftBinning;
  /**
   * Bin centre frequencies in Hz, length matches `magnitudeDb`.
   * Pre-computed once on construction; same array reused frame to frame
   * (the consumer should NOT mutate).
   */
  binCentresHz: ReadonlyArray<number>;
  /**
   * Per-bin magnitude in dBFS.  -Infinity for empty bins.
   * Length is bounded (≤ 256) to keep postMessage cheap.
   */
  magnitudeDb: ReadonlyArray<number>;
  /**
   * Per-bin spectral peak hold in dBFS (rolling max over a 1-s window).
   * Same length as `magnitudeDb`.  Optional — null when peak-hold disabled.
   */
  peakHoldDb?: ReadonlyArray<number> | null;
}
