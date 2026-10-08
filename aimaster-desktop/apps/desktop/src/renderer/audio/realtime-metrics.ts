// Realtime-preview performance instrumentation (M2-full device test).
//
// Collects per-block processing time, glitch/xrun counts, and a CPU-load
// estimate from the worklet.  The worklet posts lightweight metric
// samples to the main thread; this collector aggregates them for the
// debug panel.  Allocation-free on the audio thread (the worklet sends
// plain numbers).

/** A metric sample posted by the mastering worklet, per N blocks. */
export interface RealtimeMetricSample {
  /** Average WASM process() time per block, in ms (over the window). */
  avgProcessMs: number;
  /** Peak process() time in the window, in ms. */
  peakProcessMs: number;
  /** Quantum (block) period in ms = blockSize / sampleRate * 1000. */
  blockPeriodMs: number;
  /** Number of blocks where process() exceeded the block period (xruns). */
  xruns: number;
  /** Limiter gain reduction (dB) at the time of the sample. */
  limiterGrDb: number;
  /** Dynamics (compressor) gain reduction (dB) at the time of the sample. */
  dynamicsGrDb?: number;
  /** Cumulative output-safety bypasses (non-finite/absurd) from the chain. */
  safetyEvents?: number;
  /** Cumulative process() calls (proves the worklet is pulled). */
  processCalls?: number;
  /** Cumulative process() calls that received a non-empty input. */
  audioBlocks?: number;
  /** Cumulative input blocks that carried real (non-silent) signal. */
  nonSilentBlocks?: number;
}

/** Aggregated, display-ready metrics. */
export interface RealtimeMetricsSnapshot {
  /**
   * Chain load = avgProcessMs / blockPeriodMs.  NOT clamped: 1 is the
   * deadline, and what matters past it is how far past.
   *
   * It used to be `Math.min(1, …)`, which made the two cases a performance
   * readout exists to tell apart look identical — measured against a
   * 2.667 ms quantum, 8.0 ms per block (3x over, unusable) and 2.667 ms
   * (exactly at the deadline, the moment trouble starts) both reported
   * 100.0 %.  A scale whose top is where the problem begins cannot report
   * the size of the problem.
   */
  cpuLoad: number;
  /**
   * False when the worklet has not reported a block period yet, so
   * `cpuLoad` is a guess rather than a measurement.
   *
   * Without this, a missing period made `cpuLoad` 0: 5 ms of work per block
   * against an unknown budget read as an idle chain — the most alarming
   * state rendered as the calmest.
   */
  cpuLoadKnown: boolean;
  avgProcessMs: number;
  peakProcessMs: number;
  blockPeriodMs: number;
  /** Cumulative xrun count since reset. */
  totalXruns: number;
  /**
   * Xruns in the last `XRUN_WINDOW` samples.
   *
   * Cumulative alone cannot answer the question anybody asks of it. One
   * xrun while the audio graph is being built is ordinary; xruns still
   * arriving a minute later are the problem. Measured on the old
   * accumulator: one startup xrun followed by 60 s of clean samples left
   * `totalXruns` at 1 forever, and the panel's rule (`> 0` is danger)
   * painted it red for the rest of the session.
   */
  recentXruns: number;
  limiterGrDb: number;
  /** Dynamics (compressor) gain reduction (dB) from the latest sample. */
  dynamicsGrDb: number;
  /** Latest cumulative output-safety bypass count from the chain. */
  safetyEvents: number;
  /** Latest cumulative process() call count (0 = worklet never pulled). */
  processCalls: number;
  /** Latest cumulative non-empty input block count. */
  audioBlocks: number;
  /** Latest cumulative non-silent input block count. */
  nonSilentBlocks: number;
  /** Number of samples aggregated. */
  samples: number;
}

const EMPTY: RealtimeMetricsSnapshot = {
  cpuLoad: 0, cpuLoadKnown: false, avgProcessMs: 0, peakProcessMs: 0,
  blockPeriodMs: 0, totalXruns: 0, recentXruns: 0, limiterGrDb: 0,
  dynamicsGrDb: 0, safetyEvents: 0, processCalls: 0, audioBlocks: 0,
  nonSilentBlocks: 0, samples: 0,
};

/**
 * How many samples `recentXruns` looks back over.
 *
 * The worklet posts about ten times a second, so thirty samples is roughly
 * the last three seconds — long enough that a single glitch does not vanish
 * before anyone reads it, short enough that it clears once the chain
 * settles.
 */
export const XRUN_WINDOW = 30;

/**
 * Aggregates worklet metric samples.  Keeps an EMA of process time +
 * cumulative xruns.  Read `snapshot()` for the debug panel.
 */
export class RealtimeMetrics {
  private avgMs = 0;
  private peakMs = 0;
  private blockMs = 0;
  private totalXruns = 0;
  /** The last `XRUN_WINDOW` samples' xrun counts, oldest first. */
  private xrunRing: number[] = [];
  private gr = 0;
  private dynGr = 0;
  private safety = 0;
  private processCalls = 0;
  private audioBlocks = 0;
  private nonSilentBlocks = 0;
  private count = 0;
  private readonly emaAlpha: number;

  constructor(emaAlpha = 0.2) {
    this.emaAlpha = emaAlpha;
  }

  /** Ingest one sample from the worklet. */
  push(s: RealtimeMetricSample): void {
    this.avgMs = this.count === 0 ? s.avgProcessMs : this.avgMs + this.emaAlpha * (s.avgProcessMs - this.avgMs);
    this.peakMs = Math.max(this.peakMs * 0.9, s.peakProcessMs); // decaying peak
    this.blockMs = s.blockPeriodMs;
    this.totalXruns += s.xruns;
    this.xrunRing.push(s.xruns);
    if (this.xrunRing.length > XRUN_WINDOW) this.xrunRing.shift();
    this.gr = s.limiterGrDb;
    if (typeof s.dynamicsGrDb === 'number' && Number.isFinite(s.dynamicsGrDb)) this.dynGr = s.dynamicsGrDb;
    if (typeof s.safetyEvents === 'number' && Number.isFinite(s.safetyEvents)) {
      // Cumulative counter from the chain — keep the latest (highest) value.
      this.safety = Math.max(this.safety, s.safetyEvents);
    }
    if (typeof s.processCalls === 'number') this.processCalls = Math.max(this.processCalls, s.processCalls);
    if (typeof s.audioBlocks === 'number') this.audioBlocks = Math.max(this.audioBlocks, s.audioBlocks);
    if (typeof s.nonSilentBlocks === 'number') this.nonSilentBlocks = Math.max(this.nonSilentBlocks, s.nonSilentBlocks);
    this.count += 1;
  }

  /** Current aggregated snapshot. */
  snapshot(): RealtimeMetricsSnapshot {
    if (this.count === 0) return EMPTY;
    return {
      cpuLoad: this.blockMs > 0 ? this.avgMs / this.blockMs : 0,
      cpuLoadKnown: this.blockMs > 0,
      avgProcessMs: this.avgMs,
      peakProcessMs: this.peakMs,
      blockPeriodMs: this.blockMs,
      totalXruns: this.totalXruns,
      recentXruns: this.xrunRing.reduce((a, b) => a + b, 0),
      limiterGrDb: this.gr,
      dynamicsGrDb: this.dynGr,
      safetyEvents: this.safety,
      processCalls: this.processCalls,
      audioBlocks: this.audioBlocks,
      nonSilentBlocks: this.nonSilentBlocks,
      samples: this.count,
    };
  }

  /** Reset all counters. */
  reset(): void {
    this.avgMs = 0; this.peakMs = 0; this.blockMs = 0;
    this.totalXruns = 0; this.xrunRing = []; this.gr = 0; this.dynGr = 0; this.safety = 0;
    this.processCalls = 0; this.audioBlocks = 0; this.nonSilentBlocks = 0;
    this.count = 0;
  }
}
