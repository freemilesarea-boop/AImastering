// StereoScopeFrame — per-tick vectorscope / phase-scope payload.
//
// Two flavours:
//   • Aggregate (scalar) — emitted at meter cadence (10 Hz), composes well
//     with MeterSnapshot.  Same numbers but pulled out into a typed
//     sub-payload for the components that only need stereo data.
//   • Dot-cloud — small array of recent (L, R) pairs at higher cadence
//     (30 Hz) for X/Y vector display.  Bounded array length (≤ 1024).

/** Schema URI. */
export const STEREO_SCOPE_FRAME_SCHEMA = 'loui.streaming.stereo-scope-frame.v1';

/** Aggregate stereo data, suitable for bar-style correlation + MS displays. */
export interface StereoAggregateFrame {
  schema?: typeof STEREO_SCOPE_FRAME_SCHEMA;
  /** L/R Pearson correlation (-1..+1).  1.0 = mono. */
  correlation: number;
  /** M/S ratio in dB.  +Infinity = pure mono.  Negative = wider than centre. */
  msRatioDb: number;
  /** Composite width index 0..4.  1.0 = baseline stereo.  See loui-dsp `StereoMeter::width_index`. */
  widthIndex: number;
  /** Number of audio frames the aggregate was computed over (sliding 1-s window default). */
  windowFrames: number;
}

/** X/Y dot-cloud for vectorscope rendering. */
export interface StereoVectorscopeFrame {
  schema?: typeof STEREO_SCOPE_FRAME_SCHEMA;
  /** Mid axis = (L + R) / 2 — Y axis on screen. */
  midSamples: ReadonlyArray<number>;
  /** Side axis = (L - R) / 2 — X axis on screen. */
  sideSamples: ReadonlyArray<number>;
  /**
   * If the consumer needs cyclical decay (older points fade out), the
   * source samples are time-ordered: index 0 is oldest, last index is newest.
   */
}

/** Union — the bridge emits the variant the consumer asked for. */
export type StereoScopeFrame = StereoAggregateFrame | StereoVectorscopeFrame;
