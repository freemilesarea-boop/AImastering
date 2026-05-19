// MeterSnapshot — per-tick analyzer output.
//
// Mirrors `loui_dsp::MeterSnapshot` (Rust) and `WasmMeterSnapshot` (WASM
// binding) / `JsMeterSnapshot` (N-API binding).  Field names match the JS
// camelCase surface that both bindings expose.
//
// Two snapshot variants:
//   • `MeterSnapshot`      — full (includes integratedLufs, loudnessRange).
//   • `MeterTickSnapshot`  — light (audio-thread safe, allocation-free).
//
// Used by:
//   • apps/desktop/src/renderer/hooks/useAnalyzerStream.ts (M3 hook skeleton)
//   • Anywhere a meter UI subscribes to live analyzer data

/** Schema URI for transport / wire format. */
export const METER_SNAPSHOT_SCHEMA = 'loui.streaming.meter-snapshot.v1';

/** Common fields present in BOTH tick and full snapshots. */
export interface MeterSnapshotBase {
  /** Schema URI — pinned to the consumer's expected version. */
  schema?: typeof METER_SNAPSHOT_SCHEMA;
  /** Crate version that produced this snapshot. */
  crateVersion?: string;
  /** Sample rate of the analyzed audio (Hz). */
  sampleRate?: number;
  /** Channel count of the analyzed audio. */
  channels?: number;
  /** Number of audio samples processed (per-channel). */
  samplesProcessed: number;
  /** Short-term (3 s) loudness in LUFS.  -Infinity for silence. */
  shortTermLufs: number;
  /** Momentary (400 ms) loudness in LUFS.  -Infinity for silence. */
  momentaryLufs: number;
  /** True peak in dBTP (4× oversampled).  -Infinity for silence. */
  truePeakDbtp: number;
  /** Sample peak in dBFS.  -Infinity for silence. */
  samplePeakDb: number;
  /** Sliding-window RMS in dBFS.  -Infinity for silence. */
  rmsDb: number;
  /** L/R Pearson correlation over a 1-s sliding window.  1.0 for mono. */
  correlation: number;
  /** Mid/Side energy ratio in dB.  +Infinity for mono. */
  msRatioDb: number;
}

/**
 * Lightweight snapshot suitable for audio-thread polling at 60 Hz+.
 *
 * `integratedLufs` and `loudnessRange` are *not* available in this variant
 * (they require gated calculations that allocate).  Use `MeterSnapshot`
 * from a worker thread for those.
 */
export interface MeterTickSnapshot extends MeterSnapshotBase {
  /** `NaN` — integrated LUFS not computed in tick snapshots. */
  integratedLufs: number;
  /** `NaN` — loudness range not computed in tick snapshots. */
  loudnessRange: number;
  /** Always 0 in tick snapshots. */
  gatedBlocks: number;
}

/**
 * Full snapshot with integrated LUFS + LRA.  Computed off the audio thread
 * (allocation-bearing).
 */
export interface MeterSnapshot extends MeterSnapshotBase {
  /** Integrated LUFS (BS.1770-4 gated mean).  -Infinity for silence. */
  integratedLufs: number;
  /** EBU R128 Loudness Range in LU. */
  loudnessRange: number;
  /** Number of 400-ms blocks that contributed to integrated LUFS. */
  gatedBlocks: number;
}

/** Type guard: `MeterSnapshot` vs `MeterTickSnapshot`. */
export function isFullSnapshot(s: MeterSnapshotBase): s is MeterSnapshot {
  return Number.isFinite((s as MeterSnapshot).integratedLufs)
      || (s as MeterSnapshot).integratedLufs === Number.NEGATIVE_INFINITY;
}
