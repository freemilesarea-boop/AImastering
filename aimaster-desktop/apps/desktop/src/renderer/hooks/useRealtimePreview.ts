// useRealtimePreview — hear parameter changes while the track plays.
//
// The previous integration of this worklet crashed the renderer and was
// hard-disabled.  The cause was a feedback loop, not the DSP: worklet
// message → setState → re-render → new callback identity → the attach
// effect's deps changed → detach + re-attach the worklet → more messages.
// At audio rate that is unrecoverable.
//
// This hook is built so that loop cannot form, by construction:
//
//   1. **The attach effect depends only on stable primitives** — the media
//      element, `enabled`, and the sample rate.  Not on the config, not on
//      callbacks, not on any object built during render.  A parameter change
//      therefore cannot re-attach anything.
//
//   2. **Config is pushed imperatively** through a ref-held node, in its own
//      effect keyed on the config *string*.  A primitive dependency means
//      re-running it is idempotent and cheap; it posts a message and stops.
//
//   3. **Metrics never touch React state here.**  They go to an external
//      store that notifies on a fixed timer (see `realtime-preview-store`).
//
// Attach is also guarded against React 18 StrictMode's double-mount: the
// async load is cancellable and the effect always tears down what it built.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ensureElementGraph,
  setRealtimeInsert,
  logAudioEvent,
} from '../audio/shared-audio-graph.js';
import {
  loadMasteringWorklet,
  type MasteringWorkletLoadState,
} from '../audio/mastering-worklet-loader.js';
import {
  ingestWorkletMetrics,
  resetPreviewMetrics,
  subscribePreviewMetrics,
  getPreviewMetrics,
  getPreviewMetricsServer,
  type RealtimePreviewMetrics,
} from '../audio/realtime-preview-store.js';
import { chainConfigToJson, type ChainConfigWire } from '../audio/chain-config.js';

/** How the preview is doing.  Drives the honest status row in the UI. */
export type RealtimePreviewPhase =
  | 'disabled'    // the flag is off
  | 'idle'        // nothing to attach to yet
  | 'loading'     // fetching + compiling the worklet
  | 'running'     // attached and processing
  | 'failed';     // load failed — playback continues unprocessed

export interface RealtimePreviewState {
  phase: RealtimePreviewPhase;
  /** Present when `phase === 'failed'`. */
  error: string | null;
  metrics: RealtimePreviewMetrics;
}

export interface UseRealtimePreviewOptions {
  /** The element whose audio is routed through the chain. */
  media: HTMLMediaElement | null;
  /** Master switch — false tears the insert down and leaves playback alone. */
  enabled: boolean;
  /** The chain config.  Re-pushed whenever its serialisation changes. */
  config: ChainConfigWire;
  sampleRate?: number;
}

export function useRealtimePreview(opts: UseRealtimePreviewOptions): RealtimePreviewState {
  const { media, enabled, config } = opts;
  const sampleRate = opts.sampleRate ?? 48_000;

  const nodeRef = useRef<AudioWorkletNode | null>(null);
  // Phase/error DO use state — they change a handful of times per attach,
  // never per message.  The rule that matters is that nothing on the audio
  // path schedules a render, and messages go to the store instead.
  const [phase, setPhase] = useState<RealtimePreviewPhase>('idle');
  const [error, setError] = useState<string | null>(null);

  const metrics = useSyncExternalStore(
    subscribePreviewMetrics,
    getPreviewMetrics,
    getPreviewMetricsServer,
  );

  // The config, serialised.  A primitive, so the push effect below can
  // depend on it without dragging object identity into the dependency list.
  const configJson = chainConfigToJson(config);
  const masterBypass = config.bypass === true;

  // Latest config, readable from the attach effect WITHOUT being a dep.
  // Declared before the effect so the reference is obvious rather than
  // relying on hoisting.
  const latestConfigRef = useRef({ json: configJson, masterBypass });
  latestConfigRef.current = { json: configJson, masterBypass };

  // ── Attach / detach ────────────────────────────────────────────────────
  // Deps are deliberately only: media, enabled, sampleRate.  Adding the
  // config here is what re-created the crash loop.
  useEffect(() => {
    if (!enabled) {
      setPhase('disabled');
      return;
    }
    if (!media) {
      setPhase('idle');
      return;
    }

    let cancelled = false;
    let attached: AudioWorkletNode | null = null;
    setPhase('loading');
    setError(null);

    const graph = ensureElementGraph(media, sampleRate);

    void loadMasteringWorklet(graph.ctx, {
      // The worklet runs at the graph's rate, not the requested one — an
      // AudioContext may refuse the hint and pick the device rate.
      sampleRate: graph.ctx.sampleRate,
      onPhase: (s: MasteringWorkletLoadState) => {
        if (!cancelled && s.phase === 'failed') {
          setError(s.lastError ?? 'worklet load failed');
        }
      },
    })
      .then(({ node }) => {
        // StrictMode mounts, unmounts and remounts; the first load can
        // resolve after its own teardown.  Drop it rather than splicing an
        // orphan node into a graph that already has a live one.
        if (cancelled) {
          try { node.disconnect(); } catch { /* already gone */ }
          return;
        }
        node.port.onmessage = (ev: MessageEvent) => {
          const msg = ev.data as Record<string, unknown> | null;
          if (!msg || msg['type'] !== 'metrics') return;
          // Straight into the external store.  No setState, ever.
          ingestWorkletMetrics(msg);
        };
        node.onprocessorerror = () => {
          setError('worklet processor error');
          setPhase('failed');
          logAudioEvent('worklet-error', 'mastering worklet processor error');
        };

        attached = node;
        nodeRef.current = node;
        setRealtimeInsert(media, node);
        setPhase('running');
        logAudioEvent('dsp-chain-connected', 'realtime mastering worklet attached');

        // Send whatever the config is *now*, read through the ref so this
        // effect never has to depend on it.
        node.port.postMessage({
          type: 'configJson',
          json: latestConfigRef.current.json,
          masterBypass: latestConfigRef.current.masterBypass,
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setPhase('failed');
        // Playback is unaffected — the insert simply never lands, and the
        // shared graph keeps routing source → masterGain → destination.
        logAudioEvent('fallback-activated', `realtime preview unavailable: ${msg}`);
      });

    return () => {
      cancelled = true;
      try { setRealtimeInsert(media, null); } catch { /* graph already gone */ }
      const n = attached ?? nodeRef.current;
      if (n) {
        n.port.onmessage = null;
        n.onprocessorerror = null;
        try { n.disconnect(); } catch { /* already disconnected */ }
      }
      nodeRef.current = null;
      resetPreviewMetrics();
      logAudioEvent('dsp-chain-removed', 'realtime mastering worklet detached');
    };
  }, [media, enabled, sampleRate]);

  // ── Push config ────────────────────────────────────────────────────────
  // Keyed on the serialised config: a primitive, so this runs exactly when
  // the settings actually changed and never re-attaches anything.
  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;
    node.port.postMessage({ type: 'configJson', json: configJson, masterBypass });
  }, [configJson, masterBypass]);

  return { phase, error, metrics };
}
