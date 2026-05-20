// Realtime mastering graph manager (M2-full-NEXT-2).
//
// Coordinates the realtime mastering preview: loads the no-modules WASM
// worklet, splices the mastering node into the analyzer session's graph
// (source → mastering → tap → destination), forwards parameter config to
// the audio thread, aggregates metrics, and tears everything down safely.
//
// It NEVER owns the AudioContext or the MediaElementSource — those belong
// to the analyzer session (one source per element per context).  The
// manager only inserts/removes its node via `session.setInsertNode`.
//
// Every failure path is non-fatal: on any error the node is removed and
// the analyzer-only graph (native playback) is restored, so the existing
// re-render preview keeps working.

import {
  loadMasteringWorklet,
  initialMasteringWorkletLoadState,
  MasteringWorkletLoadError,
  type MasteringWorkletLoadState,
} from './mastering-worklet-loader.js';
import { RealtimeMetrics, type RealtimeMetricsSnapshot, type RealtimeMetricSample } from './realtime-metrics.js';
import type { RealtimeChainConfig } from './realtime-mastering-chain.js';

/** Minimal slice of the analyzer session the graph needs. */
export interface MasteringGraphSession {
  audioContext(): AudioContext | null;
  setInsertNode?(node: AudioNode | null): void;
}

export type RealtimeMasteringGraphStatus =
  | 'idle'
  | 'loading'
  | 'active'
  | 'bypassed'
  | 'failed'
  | 'disposed';

export interface RealtimeMasteringGraphState {
  status: RealtimeMasteringGraphStatus;
  load: MasteringWorkletLoadState;
  /** Coded reason the realtime path is not active (when failed). */
  fallbackReason?: string;
}

export interface CreateRealtimeMasteringGraphOptions {
  session: MasteringGraphSession;
  sampleRate: number;
  channels?: number;
  /** Fires whenever the load/status changes. */
  onStateChange?: (state: RealtimeMasteringGraphState) => void;
  /** Fires when a fresh metrics snapshot is available (per worklet post). */
  onMetrics?: (snapshot: RealtimeMetricsSnapshot) => void;
}

export interface RealtimeMasteringGraph {
  /** Load the worklet + splice the node in.  Resolves true on success. */
  attach(): Promise<boolean>;
  /** Push a parameter config to the audio thread (sanitised). */
  updateConfig(config: RealtimeChainConfig): void;
  /** Bypass the chain (still in the graph; audio passes through). */
  setBypassed(bypassed: boolean): void;
  /** Latest aggregated metrics. */
  getMetrics(): RealtimeMetricsSnapshot;
  /** Current graph state. */
  getState(): RealtimeMasteringGraphState;
  /** Remove the node + restore the analyzer-only graph.  Idempotent. */
  dispose(): void;
}

function finite(v: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Guard every numeric field so a NaN can never reach the audio thread. */
function sanitiseConfig(c: RealtimeChainConfig): RealtimeChainConfig {
  return {
    inputGainDb: finite(c.inputGainDb, 0),
    eqLowCutHz: finite(c.eqLowCutHz, 20),
    eqLowShelfDb: finite(c.eqLowShelfDb, 0),
    eqPresenceDb: finite(c.eqPresenceDb, 0),
    eqAirDb: finite(c.eqAirDb, 0),
    eqAdaptive: !!c.eqAdaptive,
    eqBypass: !!c.eqBypass,
    dynThresholdDb: finite(c.dynThresholdDb, 0),
    dynRatio: finite(c.dynRatio, 1),
    dynAttackMs: finite(c.dynAttackMs, 10),
    dynReleaseMs: finite(c.dynReleaseMs, 120),
    dynMixPct: finite(c.dynMixPct, 100),
    dynBypass: !!c.dynBypass,
    imgWidthPct: finite(c.imgWidthPct, 100),
    imgLowMonoHz: finite(c.imgLowMonoHz, 20),
    imgBypass: !!c.imgBypass,
    limCeilingDbtp: finite(c.limCeilingDbtp, -1),
    limLookaheadMs: finite(c.limLookaheadMs, 2.5),
    limIsp: !!c.limIsp,
    limBypass: !!c.limBypass,
    outputGainDb: finite(c.outputGainDb, 0),
    masterBypass: !!c.masterBypass,
  };
}

export function createRealtimeMasteringGraph(
  opts: CreateRealtimeMasteringGraphOptions,
): RealtimeMasteringGraph {
  const metrics = new RealtimeMetrics();
  let node: AudioWorkletNode | null = null;
  let lastConfig: RealtimeChainConfig | null = null;
  let bypassed = false;
  let disposed = false;

  const state: RealtimeMasteringGraphState = {
    status: 'idle',
    load: initialMasteringWorkletLoadState(),
  };

  const emit = (patch: Partial<RealtimeMasteringGraphState>) => {
    Object.assign(state, patch);
    opts.onStateChange?.({ ...state, load: { ...state.load } });
  };

  const restoreAnalyzerOnly = () => {
    try { opts.session.setInsertNode?.(null); } catch { /* ignore */ }
    if (node) {
      try { node.port.onmessage = null; } catch { /* ignore */ }
      try { node.disconnect(); } catch { /* ignore */ }
      node = null;
    }
  };

  const attach = async (): Promise<boolean> => {
    if (disposed) return false;
    if (typeof opts.session.setInsertNode !== 'function') {
      emit({ status: 'failed', fallbackReason: 'session-no-insert-support' });
      return false;
    }
    const ctx = opts.session.audioContext();
    if (!ctx) {
      emit({ status: 'failed', fallbackReason: 'no-audio-context' });
      return false;
    }

    emit({ status: 'loading' });
    try {
      const loaded = await loadMasteringWorklet(ctx, {
        sampleRate: opts.sampleRate,
        channels: opts.channels ?? 2,
        onPhase: (load) => emit({ load }),
      });
      if (disposed) {
        // Disposed while loading — don't splice a dangling node in.
        try { loaded.node.disconnect(); } catch { /* ignore */ }
        return false;
      }
      node = loaded.node;
      node.port.onmessage = (ev: MessageEvent) => {
        const msg = ev.data as ({ type?: string } & Partial<RealtimeMetricSample>) | undefined;
        if (!msg || msg.type !== 'metrics') return;
        metrics.push({
          avgProcessMs: finite(msg.avgProcessMs ?? 0, 0),
          peakProcessMs: finite(msg.peakProcessMs ?? 0, 0),
          blockPeriodMs: finite(msg.blockPeriodMs ?? 0, 0),
          xruns: Math.max(0, Math.trunc(finite(msg.xruns ?? 0, 0))),
          limiterGrDb: finite(msg.limiterGrDb ?? 0, 0),
        });
        opts.onMetrics?.(metrics.snapshot());
      };

      // Apply any config staged before the node existed, then bypass state.
      if (lastConfig) postConfig(lastConfig);
      postBypass(bypassed);

      // Splice into the analyzer graph: source → node → tap → destination.
      opts.session.setInsertNode(node);
      emit({ status: bypassed ? 'bypassed' : 'active' });
      return true;
    } catch (e) {
      const reason = e instanceof MasteringWorkletLoadError ? e.code : 'unknown';
      restoreAnalyzerOnly();
      emit({ status: 'failed', fallbackReason: reason });
      return false;
    }
  };

  const postConfig = (config: RealtimeChainConfig) => {
    if (!node) return;
    try { node.port.postMessage({ type: 'config', config: sanitiseConfig(config) }); } catch { /* ignore */ }
  };

  const postBypass = (b: boolean) => {
    if (!node) return;
    try { node.port.postMessage({ type: 'bypass', bypass: b }); } catch { /* ignore */ }
  };

  return {
    attach,
    updateConfig(config: RealtimeChainConfig) {
      lastConfig = config;
      postConfig(config);
    },
    setBypassed(b: boolean) {
      bypassed = b;
      postBypass(b);
      if (state.status === 'active' || state.status === 'bypassed') {
        emit({ status: b ? 'bypassed' : 'active' });
      }
    },
    getMetrics: () => metrics.snapshot(),
    getState: () => ({ ...state, load: { ...state.load } }),
    dispose() {
      disposed = true;
      restoreAnalyzerOnly();
      metrics.reset();
      emit({ status: 'disposed' });
    },
  };
}
