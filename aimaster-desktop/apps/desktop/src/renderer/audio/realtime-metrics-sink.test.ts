import { describe, it, expect } from 'vitest';
import { createMetricsSink, type WorkletMetrics } from './realtime-metrics-sink.js';

function metrics(grDb: number): WorkletMetrics {
  return {
    avgProcessMs: 0.1, peakProcessMs: 0.2, blockPeriodMs: 2.6, xruns: 0,
    limiterGrDb: grDb, dynamicsGrDb: 0, safetyEvents: 0,
    processCalls: 1, audioBlocks: 1, nonSilentBlocks: 1,
  };
}

describe('realtime-metrics-sink (renderer-crash root-cause fix)', () => {
  it('coalesces many per-block pushes into one emit per minInterval', () => {
    const sink = createMetricsSink({ minIntervalMs: 100 });
    for (let i = 0; i < 200; i++) sink.push(metrics(i));

    // First drain emits the LATEST coalesced value.
    expect(sink.drain(0)?.limiterGrDb).toBe(199);

    // Every drain inside the window is throttled (no per-message emits).
    let extra = 0;
    for (let t = 1; t < 100; t++) if (sink.drain(t)) extra++;
    expect(extra).toBe(0);
  });

  it('emits again once the interval elapses with new data', () => {
    const sink = createMetricsSink({ minIntervalMs: 100 });
    sink.push(metrics(1));
    expect(sink.drain(0)?.limiterGrDb).toBe(1);
    sink.push(metrics(2));
    expect(sink.drain(100)?.limiterGrDb).toBe(2);
  });

  it('returns null when there is no new data, even past the interval', () => {
    const sink = createMetricsSink({ minIntervalMs: 100 });
    sink.push(metrics(5));
    sink.drain(0);
    expect(sink.drain(500)).toBeNull();
  });

  it('latest() reflects the newest push regardless of throttle; reset clears', () => {
    const sink = createMetricsSink();
    sink.push(metrics(7));
    sink.push(metrics(9));
    expect(sink.latest()?.limiterGrDb).toBe(9);
    sink.reset();
    expect(sink.latest()).toBeNull();
  });
});
