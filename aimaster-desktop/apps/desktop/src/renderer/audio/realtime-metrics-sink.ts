// realtime-metrics-sink — mount-safe coalescing sink for worklet metrics.
//
// ROOT-CAUSE FIX (realtime-preview hard-disable):
//   The realtime mastering worklet posts a `metrics` message roughly every
//   METRIC_INTERVAL audio blocks.  The previous integration forwarded every
//   message straight into React `setState`, which — combined with the
//   product-page render tree — produced a runaway re-render loop that killed
//   the renderer process.  That is why `isRealtimePreviewEnabled()` was
//   hard-disabled.
//
//   This sink decouples the audio-thread message rate from React entirely:
//     • `push()` only stores the latest metrics in a plain closure variable
//       (no React, no allocation beyond the object reference).
//     • A subscriber is notified at most once per `minIntervalMs`, with the
//       *coalesced* latest value — never once per message.
//
//   The throttle is deterministic (clock-injectable) so it can be unit
//   tested headlessly without timers or an audio thread.

/** Telemetry posted by `mastering-chain.worklet.js` `_postMetrics()`. */
export interface WorkletMetrics {
  avgProcessMs: number;
  peakProcessMs: number;
  blockPeriodMs: number;
  xruns: number;
  limiterGrDb: number;
  dynamicsGrDb: number;
  safetyEvents: number;
  processCalls: number;
  audioBlocks: number;
  nonSilentBlocks: number;
}

export interface MetricsSink {
  /** Record the newest metrics (cheap — called per worklet message). */
  push(m: WorkletMetrics): void;
  /**
   * Emit the coalesced latest metrics if at least `minIntervalMs` has
   * elapsed since the last emit.  Returns the value emitted, or null when
   * throttled / nothing new.  `now` is injectable for tests.
   */
  drain(now?: number): WorkletMetrics | null;
  /** Most-recent metrics regardless of throttle (null before first push). */
  latest(): WorkletMetrics | null;
  /** Subscribe to throttled emits via an internal interval.  Returns unsub. */
  subscribe(cb: (m: WorkletMetrics) => void): () => void;
  /** Clear state (on teardown / re-attach). */
  reset(): void;
}

export interface MetricsSinkOptions {
  /** Minimum ms between subscriber notifications.  Default 100 (≤10 Hz). */
  minIntervalMs?: number;
  /** Clock for `subscribe`'s timer cadence.  Default 100 ms. */
  pollMs?: number;
}

const nowMs = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

export function createMetricsSink(opts: MetricsSinkOptions = {}): MetricsSink {
  const minInterval = Math.max(0, opts.minIntervalMs ?? 100);
  const pollMs = Math.max(16, opts.pollMs ?? 100);

  let last: WorkletMetrics | null = null;
  let dirty = false;
  let lastEmitAt = -Infinity;
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<(m: WorkletMetrics) => void>();

  const push = (m: WorkletMetrics): void => {
    last = m;
    dirty = true;
  };

  const drain = (now: number = nowMs()): WorkletMetrics | null => {
    if (!dirty || last === null) return null;
    if (now - lastEmitAt < minInterval) return null;
    lastEmitAt = now;
    dirty = false;
    return last;
  };

  const subscribe = (cb: (m: WorkletMetrics) => void): (() => void) => {
    listeners.add(cb);
    if (timer === null && typeof setInterval !== 'undefined') {
      timer = setInterval(() => {
        const m = drain();
        if (m) for (const fn of listeners) { try { fn(m); } catch { /* ignore */ } }
      }, pollMs);
    }
    return () => {
      listeners.delete(cb);
      if (listeners.size === 0 && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
  };

  const reset = (): void => {
    last = null;
    dirty = false;
    lastEmitAt = -Infinity;
  };

  return { push, drain, latest: () => last, subscribe, reset };
}
