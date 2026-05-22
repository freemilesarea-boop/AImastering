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
import { logAudioEvent } from './shared-audio-graph.js';

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

const RT_DEBUG = (() => {
  try { return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV); }
  catch { return false; }
})();

function rtLog(msg: string, data?: unknown): void {
  if (!RT_DEBUG) return;
  // eslint-disable-next-line no-console
  if (data !== undefined) console.debug(`[RealtimeAudio] ${msg}`, data);
  else console.debug(`[RealtimeAudio] ${msg}`);
}

/** Log which DSP groups changed between two configs (dev only, no spam). */
function logConfigDelta(prev: RealtimeChainConfig | null, next: RealtimeChainConfig): void {
  if (!RT_DEBUG) return;
  if (!prev) { rtLog('config (initial)', next); return; }
  const eqChanged = prev.eqLowCutHz !== next.eqLowCutHz || prev.eqLowShelfDb !== next.eqLowShelfDb
    || prev.eqPresenceDb !== next.eqPresenceDb || prev.eqAirDb !== next.eqAirDb
    || prev.eqAdaptive !== next.eqAdaptive || prev.eqBypass !== next.eqBypass
    || prev.outputGainDb !== next.outputGainDb;
  const dynChanged = prev.dynThresholdDb !== next.dynThresholdDb || prev.dynRatio !== next.dynRatio
    || prev.dynAttackMs !== next.dynAttackMs || prev.dynReleaseMs !== next.dynReleaseMs
    || prev.dynMixPct !== next.dynMixPct || prev.dynBypass !== next.dynBypass;
  const imgChanged = prev.imgWidthPct !== next.imgWidthPct || prev.imgLowMonoHz !== next.imgLowMonoHz
    || prev.imgBypass !== next.imgBypass;
  const limChanged = prev.limCeilingDbtp !== next.limCeilingDbtp || prev.limLookaheadMs !== next.limLookaheadMs
    || prev.limIsp !== next.limIsp || prev.limBypass !== next.limBypass;
  if (eqChanged) rtLog('EQ param updated', { lowCutHz: next.eqLowCutHz, lowShelfDb: next.eqLowShelfDb, presenceDb: next.eqPresenceDb, airDb: next.eqAirDb, outputGainDb: next.outputGainDb, bypass: next.eqBypass });
  if (dynChanged) rtLog('Dynamics param updated', { thresholdDb: next.dynThresholdDb, ratio: next.dynRatio, attackMs: next.dynAttackMs, releaseMs: next.dynReleaseMs, mixPct: next.dynMixPct, bypass: next.dynBypass });
  if (imgChanged) rtLog('Imager param updated', { widthPct: next.imgWidthPct, lowMonoHz: next.imgLowMonoHz, bypass: next.imgBypass });
  if (limChanged) rtLog('Limiter param updated', { ceilingDbtp: next.limCeilingDbtp, lookaheadMs: next.limLookaheadMs, isp: next.limIsp, bypass: next.limBypass });
}

function finite(v: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
/** Finite + clamped to [lo, hi]. */
function clamp(v: number, fallback: number, lo: number, hi: number): number {
  const x = finite(v, fallback);
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Guard every numeric field so a NaN — or an out-of-range UI/preset value —
 * can never reach the audio thread or push the DSP into instability.  The
 * Rust chain has its own clamps too (defence in depth); this keeps the
 * payload sane before it crosses the worklet boundary.
 */
export function sanitiseConfig(c: RealtimeChainConfig): RealtimeChainConfig {
  return {
    inputGainDb: clamp(c.inputGainDb, 0, -24, 24),
    eqLowCutHz: clamp(c.eqLowCutHz, 20, 10, 1000),
    eqLowShelfDb: clamp(c.eqLowShelfDb, 0, -24, 24),
    eqPresenceDb: clamp(c.eqPresenceDb, 0, -24, 24),
    eqAirDb: clamp(c.eqAirDb, 0, -24, 24),
    eqAdaptive: !!c.eqAdaptive,
    eqBypass: !!c.eqBypass,
    dynThresholdDb: clamp(c.dynThresholdDb, 0, -60, 0),
    dynRatio: clamp(c.dynRatio, 1, 1, 20),
    dynAttackMs: clamp(c.dynAttackMs, 10, 0.1, 200),
    dynReleaseMs: clamp(c.dynReleaseMs, 120, 5, 2000),
    dynMixPct: clamp(c.dynMixPct, 100, 0, 100),
    dynBypass: !!c.dynBypass,
    imgWidthPct: clamp(c.imgWidthPct, 100, 0, 200),
    imgLowMonoHz: clamp(c.imgLowMonoHz, 20, 20, 2000),
    imgBypass: !!c.imgBypass,
    limCeilingDbtp: clamp(c.limCeilingDbtp, -1, -24, 0),
    limLookaheadMs: clamp(c.limLookaheadMs, 2.5, 0, 20),
    limIsp: !!c.limIsp,
    limBypass: !!c.limBypass,
    outputGainDb: clamp(c.outputGainDb, 0, -24, 24),
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
    // A gesture-suspended context never pulls the worklet — resume it so
    // process() actually runs (best-effort; playback gesture usually has).
    if (ctx.state === 'suspended') {
      try { void ctx.resume(); } catch { /* ignore */ }
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
          dynamicsGrDb: finite(msg.dynamicsGrDb ?? 0, 0),
          safetyEvents: Math.max(0, Math.trunc(finite(msg.safetyEvents ?? 0, 0))),
          processCalls: Math.max(0, Math.trunc(finite(msg.processCalls ?? 0, 0))),
          audioBlocks: Math.max(0, Math.trunc(finite(msg.audioBlocks ?? 0, 0))),
          nonSilentBlocks: Math.max(0, Math.trunc(finite(msg.nonSilentBlocks ?? 0, 0))),
        });
        opts.onMetrics?.(metrics.snapshot());
      };

      // Apply any config staged before the node existed, then bypass state.
      if (lastConfig) postConfig(lastConfig);
      postBypass(bypassed);

      // Splice into the analyzer graph: source → node → tap → destination.
      opts.session.setInsertNode(node);
      rtLog('processor chain connected (source → mastering → tap → destination)', { ctxState: ctx.state, sampleRate: opts.sampleRate, channels: opts.channels ?? 2 });
      emit({ status: bypassed ? 'bypassed' : 'active' });
      return true;
    } catch (e) {
      const reason = e instanceof MasteringWorkletLoadError ? e.code : 'unknown';
      restoreAnalyzerOnly();
      emit({ status: 'failed', fallbackReason: reason });
      return false;
    }
  };

  let lastSentConfig: RealtimeChainConfig | null = null;
  let configPostCount = 0;
  const postConfig = (config: RealtimeChainConfig) => {
    if (!node) return;
    const sane = sanitiseConfig(config);
    logConfigDelta(lastSentConfig, sane);
    lastSentConfig = sane;
    try {
      node.port.postMessage({ type: 'config', config: sane });
      // Surface the first push + occasional pushes to the in-app log so the
      // tester can confirm edits actually reach the DSP graph.
      if (configPostCount === 0 || configPostCount % 30 === 0) {
        logAudioEvent('config-posted', `eqAir=${sane.eqAirDb} out=${sane.outputGainDb} width=${sane.imgWidthPct} #${configPostCount}`);
      }
      configPostCount++;
    } catch { /* ignore */ }
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
