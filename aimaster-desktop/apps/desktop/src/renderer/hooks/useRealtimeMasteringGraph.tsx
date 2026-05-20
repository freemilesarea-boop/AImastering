// useRealtimeMasteringGraph — flag-gated realtime mastering preview hook
// (M2-full-NEXT-2).
//
// Wires the realtime mastering graph into ProductPage: when the
// realtime-preview flag is ON and the environment is ready, it loads the
// WASM worklet, splices the mastering node into the analyzer session's
// graph, and forwards parameter changes (rAF-batched) to the audio
// thread.  When the flag is OFF (default) it does NOTHING — the existing
// re-render preview path is byte-identical.
//
// All failures degrade to native playback (analyzer-only graph) — the
// graph manager removes its node and the re-render preview keeps working.

import { useEffect, useMemo, useRef, useState } from 'react';

import { isRealtimePreviewEnabled } from '../audio/realtime-preview-flag.js';
import {
  detectRealtimeReadiness,
  describeReadiness,
  type RealtimeReadiness,
} from '../audio/realtime-readiness.js';
import {
  createRealtimeMasteringGraph,
  type RealtimeMasteringGraph,
  type RealtimeMasteringGraphState,
} from '../audio/realtime-mastering-graph.js';
import { stateToChainConfig } from '../audio/realtime-mastering-chain.js';
import type { RealtimeMetricsSnapshot } from '../audio/realtime-metrics.js';
import { useAllModuleParameters } from '../audio/parameters/useModuleParameterState.js';
import type { AttachableAnalyzerSession } from '../audio/wasm-analyzer-context.js';

declare global {
  interface Window {
    __LOUI_REALTIME_DEBUG__?: {
      getState: () => RealtimeMasteringGraphState | null;
      getMetrics: () => RealtimeMetricsSnapshot;
      dumpMetrics: () => void;
      exportJSON: () => string;
    };
  }
}

const EMPTY_METRICS: RealtimeMetricsSnapshot = {
  cpuLoad: 0, avgProcessMs: 0, peakProcessMs: 0, blockPeriodMs: 0,
  totalXruns: 0, limiterGrDb: 0, samples: 0,
};

export interface RealtimeMasteringPreviewStatus {
  /** The realtime flag is on. */
  enabled: boolean;
  /** Node spliced in and processing (not bypassed). */
  active: boolean;
  /** Current graph/load state (null until attach starts). */
  graphState: RealtimeMasteringGraphState | null;
  /** Latest aggregated worklet metrics. */
  metrics: RealtimeMetricsSnapshot;
  /** Environment readiness probe. */
  readiness: RealtimeReadiness;
  readinessLabel: string;
}

export interface UseRealtimeMasteringGraphOptions {
  sampleRate?: number;
  channels?: number;
}

export function useRealtimeMasteringGraph(
  session: AttachableAnalyzerSession | null,
  opts: UseRealtimeMasteringGraphOptions = {},
): RealtimeMasteringPreviewStatus {
  const sampleRate = opts.sampleRate ?? 48_000;
  const channels = opts.channels ?? 2;

  // Flag + readiness are evaluated once per mount (flag is a static/runtime
  // toggle; readiness is pure environment feature detection).
  const enabled = useMemo(() => isRealtimePreviewEnabled(), []);
  const readiness = useMemo(() => detectRealtimeReadiness(), []);

  const { state: paramState } = useAllModuleParameters();

  const graphRef = useRef<RealtimeMasteringGraph | null>(null);
  const [graphState, setGraphState] = useState<RealtimeMasteringGraphState | null>(null);
  const [metrics, setMetrics] = useState<RealtimeMetricsSnapshot>(EMPTY_METRICS);

  // ── Lifecycle: attach when flag on + ready + session present ──────────
  useEffect(() => {
    if (!enabled || !readiness.ready || !session || typeof session.setInsertNode !== 'function') {
      return;
    }
    const graph = createRealtimeMasteringGraph({
      session,
      sampleRate,
      channels,
      onStateChange: setGraphState,
      onMetrics: setMetrics,
    });
    graphRef.current = graph;
    // Seed the chain with the current parameter state before splicing in.
    try { graph.updateConfig(stateToChainConfig(paramState)); } catch { /* ignore */ }
    void graph.attach();

    return () => {
      graphRef.current = null;
      graph.dispose();
      setGraphState(null);
      setMetrics(EMPTY_METRICS);
    };
    // paramState intentionally excluded — config flows via the rAF effect
    // below, not by re-attaching the whole graph.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, readiness.ready, session, sampleRate, channels]);

  // ── Parameter live-update (rAF-batched) ──────────────────────────────
  const rafRef = useRef<number | null>(null);
  const pendingState = useRef(paramState);
  pendingState.current = paramState;
  useEffect(() => {
    if (!enabled) return;
    if (rafRef.current !== null) return; // already scheduled
    const schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number;
    rafRef.current = schedule(() => {
      rafRef.current = null;
      const g = graphRef.current;
      if (!g) return;
      try { g.updateConfig(stateToChainConfig(pendingState.current)); } catch { /* invalid config — skip */ }
    });
    return () => {
      if (rafRef.current !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [enabled, paramState]);

  // ── Device-test hooks (window.__LOUI_REALTIME_DEBUG__) ────────────────
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    window.__LOUI_REALTIME_DEBUG__ = {
      getState: () => graphRef.current?.getState() ?? null,
      getMetrics: () => graphRef.current?.getMetrics() ?? EMPTY_METRICS,
      dumpMetrics: () => {
        const m = graphRef.current?.getMetrics() ?? EMPTY_METRICS;
        // eslint-disable-next-line no-console
        console.table({
          'cpu %': (m.cpuLoad * 100).toFixed(1),
          'avg ms': m.avgProcessMs.toFixed(3),
          'peak ms': m.peakProcessMs.toFixed(3),
          'block ms': m.blockPeriodMs.toFixed(3),
          xruns: m.totalXruns,
          'GR dB': m.limiterGrDb.toFixed(2),
          samples: m.samples,
        });
      },
      exportJSON: () => JSON.stringify({
        state: graphRef.current?.getState() ?? null,
        metrics: graphRef.current?.getMetrics() ?? EMPTY_METRICS,
        readiness,
      }, null, 2),
    };
    return () => {
      if (typeof window !== 'undefined') delete window.__LOUI_REALTIME_DEBUG__;
    };
  }, [enabled, readiness]);

  const status = graphState?.status;
  return {
    enabled,
    active: status === 'active',
    graphState,
    metrics,
    readiness,
    readinessLabel: describeReadiness(readiness),
  };
}
