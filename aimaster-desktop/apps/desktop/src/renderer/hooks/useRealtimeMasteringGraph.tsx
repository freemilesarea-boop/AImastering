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
  type MasteringGraphSession,
} from '../audio/realtime-mastering-graph.js';
import {
  makeSharedMasteringSession,
  installNativeDsp,
  applyNativeDspConfig,
  uninstallNativeDsp,
} from '../audio/shared-audio-graph.js';
import { useMediaElement } from '../audio/media-element-context.js';
import { stateToChainConfig, type RealtimeChainConfig } from '../audio/realtime-mastering-chain.js';
import {
  deriveRealtimeUiStatus,
  type RealtimePreviewUiStatus,
} from '../audio/realtime-ui-status.js';

export type { RealtimePreviewUiStatus };
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
  totalXruns: 0, limiterGrDb: 0, dynamicsGrDb: 0, safetyEvents: 0,
  processCalls: 0, audioBlocks: 0, nonSilentBlocks: 0, samples: 0,
};

export interface RealtimeMasteringPreviewStatus {
  /** The realtime flag is on. */
  enabled: boolean;
  /** The worklet is genuinely processing audio (edits are heard live). */
  active: boolean;
  /** Coarse, honest UI status (off/unavailable/waiting/starting/passthrough/active/bypassed/failed). */
  uiStatus: RealtimePreviewUiStatus;
  /** Current graph/load state (null until attach starts). */
  graphState: RealtimeMasteringGraphState | null;
  /** Latest aggregated worklet metrics. */
  metrics: RealtimeMetricsSnapshot;
  /** Count of config pushes to the audio thread (proves edits reach DSP). */
  configUpdates: number;
  /** Epoch ms of the last config push, or null. */
  lastConfigAt: number | null;
  /** The live chain config the UI is sending (null when flag off). */
  config: RealtimeChainConfig | null;
  /** Environment readiness probe. */
  readiness: RealtimeReadiness;
  readinessLabel: string;
  /** Re-run the WASM worklet attach (recovery button). */
  reattach: () => void;
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

  // The realtime DSP prefers the WASM analyzer session (so it taps the same
  // graph), but falls back to a shared-graph-backed session when the WASM
  // analyzer is unavailable — so module edits stay AUDIBLE even when the
  // WASM analyzer failed to start.
  const media = useMediaElement();
  const effectiveSession = useMemo<MasteringGraphSession | null>(() => {
    if (session && typeof session.setInsertNode === 'function') return session;
    if (media) return makeSharedMasteringSession(media, sampleRate);
    return null;
  }, [session, media, sampleRate]);

  const graphRef = useRef<RealtimeMasteringGraph | null>(null);
  const [reattachNonce, setReattachNonce] = useState(0);
  const [graphState, setGraphState] = useState<RealtimeMasteringGraphState | null>(null);
  const [metrics, setMetrics] = useState<RealtimeMetricsSnapshot>(EMPTY_METRICS);
  const [configUpdates, setConfigUpdates] = useState(0);
  const [lastConfigAt, setLastConfigAt] = useState<number | null>(null);

  // Latest parameter state, readable from async callbacks without re-running
  // the attach effect.
  const pendingState = useRef(paramState);
  pendingState.current = paramState;

  // ── Lifecycle: attach when flag on + ready + a graph host is present ──
  useEffect(() => {
    if (!enabled || !readiness.ready || !effectiveSession) {
      return;
    }
    const graph = createRealtimeMasteringGraph({
      session: effectiveSession,
      sampleRate,
      channels,
      onStateChange: setGraphState,
      onMetrics: setMetrics,
    });
    graphRef.current = graph;
    // Seed the chain with the current parameter state before splicing in.
    try { graph.updateConfig(stateToChainConfig(pendingState.current)); } catch { /* ignore */ }
    void graph.attach().then((ok) => {
      if (!ok || graphRef.current !== graph) return;
      // Force-push the current config the moment the node exists so the
      // worklet always has a config (configUpdates leaves 0 only when the
      // graph never attached) and the debug panel reflects it.
      try {
        graph.updateConfig(stateToChainConfig(pendingState.current));
        setConfigUpdates((n) => n + 1);
        setLastConfigAt(Date.now());
      } catch { /* ignore */ }
    });

    return () => {
      graphRef.current = null;
      graph.dispose();
      setGraphState(null);
      setMetrics(EMPTY_METRICS);
    };
    // paramState intentionally excluded — config flows via the rAF effect
    // below, not by re-attaching the whole graph.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, readiness.ready, effectiveSession, sampleRate, channels, reattachNonce]);

  // ── Native DSP fallback (always-audible WebAudio chain) ──────────────
  // Installed whenever realtime is enabled + an element exists, so EQ /
  // dynamics / width / output edits change the sound even when the WASM
  // worklet fails.  When the WASM worklet attaches it takes priority; on
  // WASM failure the bus falls back to this chain (never silent-direct).
  useEffect(() => {
    if (!enabled || !media) return;
    try {
      installNativeDsp(media, sampleRate);
      applyNativeDspConfig(media, stateToChainConfig(pendingState.current));
    } catch { /* ignore */ }
    return () => { try { uninstallNativeDsp(media); } catch { /* ignore */ } };
  }, [enabled, media, sampleRate]);

  // ── Parameter live-update (rAF-batched) ──────────────────────────────
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    if (rafRef.current !== null) return; // already scheduled
    const schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number;
    rafRef.current = schedule(() => {
      rafRef.current = null;
      const cfg = stateToChainConfig(pendingState.current);
      // Always push to the native fallback chain so edits are audible even
      // when the WASM worklet is down.
      if (media) { try { applyNativeDspConfig(media, cfg); } catch { /* ignore */ } }
      const g = graphRef.current;
      try {
        if (g) g.updateConfig(cfg);
        setConfigUpdates((n) => n + 1);
        setLastConfigAt(Date.now());
      } catch { /* invalid config — skip */ }
    });
    return () => {
      if (rafRef.current !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [enabled, paramState, media]);

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

  // Honest status: "active" requires the worklet to be genuinely
  // processing (it only posts metrics from its non-passthrough branch), so
  // a spliced-but-passing-through node reads "passthrough", and no session
  // yet reads "waiting" — never a false "Live".
  const uiStatus: RealtimePreviewUiStatus = deriveRealtimeUiStatus({
    enabled,
    ready: readiness.ready,
    hasSession: !!effectiveSession,
    graphStatus: graphState?.status,
    // The worklet now posts metrics even while passing through, so "samples"
    // alone is not proof of DSP.  Real chain processing accrues process
    // TIME — avgProcessMs > 0 ⟺ the chain actually ran this window.
    processing: metrics.avgProcessMs > 0,
  });
  const active = uiStatus === 'active';
  return {
    enabled,
    active,
    uiStatus,
    graphState,
    metrics,
    configUpdates,
    lastConfigAt,
    config: enabled ? stateToChainConfig(paramState) : null,
    readiness,
    readinessLabel: describeReadiness(readiness),
    reattach: () => setReattachNonce((n) => n + 1),
  };
}
