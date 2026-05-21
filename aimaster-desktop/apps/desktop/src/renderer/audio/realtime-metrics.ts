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
  /** Cumulative output-safety bypasses (non-finite/absurd) from the chain. */
  safetyEvents?: number;
}

/** Aggregated, display-ready metrics. */
export interface RealtimeMetricsSnapshot {
  /** Estimated CPU load of the mastering chain (0..1) = avgProcessMs / blockPeriodMs. */
  cpuLoad: number;
  avgProcessMs: number;
  peakProcessMs: number;
  blockPeriodMs: number;
  /** Cumulative xrun count since reset. */
  totalXruns: number;
  limiterGrDb: number;
  /** Latest cumulative output-safety bypass count from the chain. */
  safetyEvents: number;
  /** Number of samples aggregated. */
  samples: number;
}

const EMPTY: RealtimeMetricsSnapshot = {
  cpuLoad: 0, avgProcessMs: 0, peakProcessMs: 0, blockPeriodMs: 0,
  totalXruns: 0, limiterGrDb: 0, safetyEvents: 0, samples: 0,
};

/**
 * Aggregates worklet metric samples.  Keeps an EMA of process time +
 * cumulative xruns.  Read `snapshot()` for the debug panel.
 */
export class RealtimeMetrics {
  private avgMs = 0;
  private peakMs = 0;
  private blockMs = 0;
  private totalXruns = 0;
  private gr = 0;
  private safety = 0;
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
    this.gr = s.limiterGrDb;
    if (typeof s.safetyEvents === 'number' && Number.isFinite(s.safetyEvents)) {
      // Cumulative counter from the chain — keep the latest (highest) value.
      this.safety = Math.max(this.safety, s.safetyEvents);
    }
    this.count += 1;
  }

  /** Current aggregated snapshot. */
  snapshot(): RealtimeMetricsSnapshot {
    if (this.count === 0) return EMPTY;
    return {
      cpuLoad: this.blockMs > 0 ? Math.min(1, this.avgMs / this.blockMs) : 0,
      avgProcessMs: this.avgMs,
      peakProcessMs: this.peakMs,
      blockPeriodMs: this.blockMs,
      totalXruns: this.totalXruns,
      limiterGrDb: this.gr,
      safetyEvents: this.safety,
      samples: this.count,
    };
  }

  /** Reset all counters. */
  reset(): void {
    this.avgMs = 0; this.peakMs = 0; this.blockMs = 0;
    this.totalXruns = 0; this.gr = 0; this.safety = 0; this.count = 0;
  }
}

/** Format a snapshot as a compact debug string. */
export function describeMetrics(s: RealtimeMetricsSnapshot): string {
  return [
    `cpu ${(s.cpuLoad * 100).toFixed(1)}%`,
    `avg ${s.avgProcessMs.toFixed(3)}ms`,
    `peak ${s.peakProcessMs.toFixed(3)}ms`,
    `xruns ${s.totalXruns}`,
    `GR ${s.limiterGrDb.toFixed(1)}dB`,
  ].join(' · ');
}
