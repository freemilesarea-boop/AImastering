// shared-audio-graph — the SINGLE owner of the app's realtime audio graph.
//
// Why this exists
// ────────────────────────────────────────────────────────────────────────
// An HTMLMediaElement may have exactly ONE MediaElementSourceNode for its
// whole lifetime, and once captured its audio flows ONLY through the graph
// (never to the default output).  Previously the WASM analyzer session
// owned the context + source + routing; if it failed to start (worklet /
// WASM asset load error in the packaged app), no source was created, the
// `<audio>` played straight to the speakers, and the analyzer/meters got
// nothing — empty Spectrum, dead meters.
//
// This module decouples ROUTING from the WASM analyzer.  It guarantees:
//   • exactly one AudioContext (created once, never closed),
//   • exactly one MediaElementSource per element (cached, reused),
//   • a guaranteed audio path  source → [DSP insert] → masterGain → destination
//     so the user ALWAYS hears audio, even if every WASM/worklet tap fails,
//   • always-available native AnalyserNodes (main + L/R) for a WASM-free
//     spectrum / RMS / correlation fallback,
//   • passive taps (the WASM analyzer-tap worklet, the DSP insert) splice
//     in/out without ever silencing playback or double-routing to output.
//
// Every analyser / passive tap is pulled to `destination` through a
// zero-gain sink, so it processes audio without contributing to the output
// (no +6 dB double-output, no phasing).

import { createNativeDspChain, type NativeDspChain } from './native-dsp-chain.js';
import type { RealtimeChainConfig } from './realtime-mastering-chain.js';

export type AudioGraphEventKind =
  | 'audio-element-mounted'
  | 'src-changed'
  | 'audio-play'
  | 'audio-pause'
  | 'context-created'
  | 'context-resumed'
  | 'context-resume-failed'
  | 'media-source-created'
  | 'media-source-reused'
  | 'native-analyzer-connected'
  | 'wasm-analyzer-connected'
  | 'dsp-chain-connected'
  | 'dsp-chain-removed'
  | 'config-posted'
  | 'param-updated'
  | 'worklet-error'
  | 'fallback-activated'
  | 'error';

export interface AudioGraphEvent {
  /** Monotonic id for stable React keys. */
  id: number;
  /** epoch ms */
  t: number;
  kind: AudioGraphEventKind;
  msg: string;
}

const LOG_CAP = 60;
const log: AudioGraphEvent[] = [];
const logListeners = new Set<() => void>();
let nextEventId = 1;

/** Append a diagnostic event (shown in the in-app debug panel + console in dev). */
export function logAudioEvent(kind: AudioGraphEventKind, msg = ''): void {
  const ev: AudioGraphEvent = { id: nextEventId++, t: Date.now(), kind, msg };
  log.push(ev);
  if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
  for (const cb of logListeners) {
    try { cb(); } catch { /* ignore */ }
  }
  try {
    const dev = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
    // eslint-disable-next-line no-console
    if (dev) console.debug(`[AudioGraph] ${kind}${msg ? ': ' + msg : ''}`);
  } catch { /* ignore */ }
}

/** Snapshot of the event log (most-recent last). */
export function getAudioLog(): readonly AudioGraphEvent[] {
  return log;
}

/** Subscribe to log changes.  Returns an unsubscribe fn. */
export function subscribeAudioLog(cb: () => void): () => void {
  logListeners.add(cb);
  return () => { logListeners.delete(cb); };
}

// ── Shared context ──────────────────────────────────────────────────────

let ctx: AudioContext | null = null;
let lastError: string | null = null;

/** The single app-wide AudioContext (created on first call, never closed). */
export function getSharedAudioContext(sampleRate = 48_000): AudioContext {
  if (ctx && ctx.state !== 'closed') return ctx;
  ctx = new AudioContext({ sampleRate });
  logAudioEvent('context-created', `${ctx.sampleRate} Hz, ${ctx.state}`);
  return ctx;
}

/** Current context state, or 'none' before creation. */
export function sharedContextState(): AudioContextState | 'none' {
  return ctx ? ctx.state : 'none';
}

/** Most recent graph-level error (null when healthy). */
export function sharedGraphLastError(): string | null {
  return lastError;
}

/** Resume the context (call from a user gesture — play button). */
export async function resumeSharedContext(): Promise<boolean> {
  if (!ctx) return false;
  const c = ctx;
  if ((c.state as string) === 'running') return true;
  try {
    await c.resume();
    logAudioEvent('context-resumed', c.state);
    return (c.state as string) === 'running';
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    logAudioEvent('context-resume-failed', lastError);
    return false;
  }
}

// ── Per-element graph ─────────────────────────────────────────────────────

export interface NativeAnalysers {
  ctx: AudioContext;
  main: AnalyserNode;
  left: AnalyserNode;
  right: AnalyserNode;
}

interface ElementGraph {
  ctx: AudioContext;
  source: MediaElementAudioSourceNode;
  /** Real audio bus: (source|insert) → masterGain → destination. */
  masterGain: GainNode;
  /** Zero-gain sink that pulls every passive tap/analyser to destination. */
  silentSink: GainNode;
  /** WASM mastering worklet insert (highest priority when present). */
  wasmInsert: AudioNode | null;
  /** Native (WebAudio) DSP fallback chain, when installed. */
  nativeDsp: NativeDspChain | null;
  analysers: NativeAnalysers;
  splitter: ChannelSplitterNode;
  /** External passive taps (e.g. WASM analyzer-tap worklet). */
  passiveTaps: Set<AudioNode>;
  /** True once a MediaElementSource exists (i.e. element audio is captured). */
  sourceCreated: boolean;
}

/**
 * (Re)wire the audio bus from the source, choosing the active insert:
 *   wasmInsert  → source → wasmInsert → masterGain   (best quality)
 *   nativeDsp   → source → nativeDsp  → masterGain   (WASM-free fallback)
 *   neither     → source → masterGain                (direct)
 * masterGain → destination + all taps/analysers are untouched.
 */
function rerouteBus(g: ElementGraph): void {
  try { g.source.disconnect(); } catch { /* ignore */ }
  if (g.nativeDsp) { try { g.nativeDsp.output.disconnect(g.masterGain); } catch { /* ignore */ } }
  if (g.wasmInsert) {
    g.source.connect(g.wasmInsert);
    try { g.wasmInsert.connect(g.masterGain); } catch { /* ignore (already connected) */ }
    logAudioEvent('dsp-chain-connected', 'source → WASM → master');
  } else if (g.nativeDsp) {
    g.source.connect(g.nativeDsp.input);
    g.nativeDsp.output.connect(g.masterGain);
    logAudioEvent('fallback-activated', 'source → native DSP → master');
  } else {
    g.source.connect(g.masterGain);
    logAudioEvent('dsp-chain-removed', 'source → master (direct)');
  }
}

const graphs = new WeakMap<HTMLMediaElement, ElementGraph>();
let activeGraph: ElementGraph | null = null;

/**
 * Get-or-create the full graph for a media element.  Idempotent: a second
 * call returns the cached graph (never re-creates the source).  Establishes
 * the guaranteed audio path + native analysers immediately, so spectrum /
 * meters / playback work the instant an element with a src is mounted —
 * independent of any WASM/worklet success.
 */
export function ensureElementGraph(media: HTMLMediaElement, sampleRate = 48_000): ElementGraph {
  const existing = graphs.get(media);
  if (existing) { activeGraph = existing; return existing; }

  const context = getSharedAudioContext(sampleRate);
  let source: MediaElementAudioSourceNode;
  try {
    source = context.createMediaElementSource(media);
    logAudioEvent('media-source-created');
  } catch (e) {
    // Should never happen (one graph per element), but if the element was
    // already captured we cannot recover the node — surface the error.
    lastError = e instanceof Error ? e.message : String(e);
    logAudioEvent('error', `createMediaElementSource: ${lastError}`);
    throw e;
  }

  const masterGain = context.createGain();
  masterGain.gain.value = 1;
  const silentSink = context.createGain();
  silentSink.gain.value = 0;

  const main = context.createAnalyser();
  main.fftSize = 2048;
  main.smoothingTimeConstant = 0.7;
  const left = context.createAnalyser();
  left.fftSize = 2048;
  left.smoothingTimeConstant = 0.5;
  const right = context.createAnalyser();
  right.fftSize = 2048;
  right.smoothingTimeConstant = 0.5;
  const splitter = context.createChannelSplitter(2);

  // Guaranteed audio bus.
  source.connect(masterGain);
  masterGain.connect(context.destination);

  // Native analyser taps off the post-everything bus, pulled via silentSink.
  masterGain.connect(main);
  main.connect(silentSink);
  masterGain.connect(splitter);
  splitter.connect(left, 0);
  splitter.connect(right, 1);
  left.connect(silentSink);
  right.connect(silentSink);
  silentSink.connect(context.destination);

  logAudioEvent('native-analyzer-connected', 'AnalyserNode main + L/R');

  const graph: ElementGraph = {
    ctx: context, source, masterGain, silentSink,
    wasmInsert: null, nativeDsp: null, analysers: { ctx: context, main, left, right }, splitter,
    passiveTaps: new Set(), sourceCreated: true,
  };
  graphs.set(media, graph);
  activeGraph = graph;
  return graph;
}

/** Native analysers for an element (creates the graph if needed). */
export function getNativeAnalysers(media: HTMLMediaElement, sampleRate = 48_000): NativeAnalysers {
  return ensureElementGraph(media, sampleRate).analysers;
}

/** Whether a MediaElementSource has been created for this element. */
export function isSourceCreated(media: HTMLMediaElement | null): boolean {
  if (!media) return false;
  const g = graphs.get(media);
  return !!g && g.sourceCreated;
}

/**
 * Set (or clear) the WASM mastering worklet insert.  When cleared, routing
 * falls back to the native DSP chain (if installed) — NOT silent direct —
 * so module edits stay audible after a WASM failure.  Taps/analysers always
 * read masterGain (post-DSP).
 */
export function setRealtimeInsert(media: HTMLMediaElement, node: AudioNode | null): void {
  const g = graphs.get(media);
  if (!g) return;
  if (g.wasmInsert && g.wasmInsert !== node) {
    try { g.wasmInsert.disconnect(g.masterGain); } catch { /* ignore */ }
  }
  g.wasmInsert = node;
  rerouteBus(g);
}

/**
 * Install the native (WebAudio) DSP fallback chain for an element and make
 * it the active insert (unless the WASM worklet is present).  Idempotent.
 * Returns the chain so callers can push config to it.
 */
export function installNativeDsp(media: HTMLMediaElement, sampleRate = 48_000): NativeDspChain {
  const g = ensureElementGraph(media, sampleRate);
  if (!g.nativeDsp) {
    g.nativeDsp = createNativeDspChain(g.ctx);
    logAudioEvent('native-analyzer-connected', 'native DSP chain built');
    rerouteBus(g);
  }
  return g.nativeDsp;
}

/** Apply a config to the native DSP chain (no-op if not installed). */
export function applyNativeDspConfig(media: HTMLMediaElement, cfg: RealtimeChainConfig): void {
  graphs.get(media)?.nativeDsp?.apply(cfg);
}

/** Remove the native DSP chain and re-route (→ WASM insert or direct). */
export function uninstallNativeDsp(media: HTMLMediaElement): void {
  const g = graphs.get(media);
  if (!g || !g.nativeDsp) return;
  const chain = g.nativeDsp;
  g.nativeDsp = null;
  rerouteBus(g);
  try { chain.dispose(); } catch { /* ignore */ }
}

/**
 * Add a passive tap (e.g. the WASM analyzer-tap worklet).  It reads the
 * post-DSP bus and is pulled to destination via the zero-gain sink, so it
 * NEVER affects the audible output.  Idempotent per node.
 */
export function addPassiveTap(media: HTMLMediaElement, node: AudioNode): void {
  const g = graphs.get(media);
  if (!g || g.passiveTaps.has(node)) return;
  g.masterGain.connect(node);
  try { node.connect(g.silentSink); } catch { /* a sink-less node still analyses */ }
  g.passiveTaps.add(node);
  logAudioEvent('wasm-analyzer-connected', 'tap → master (passive)');
}

/** Remove a passive tap (on session stop).  Never touches the audio bus. */
export function removePassiveTap(media: HTMLMediaElement, node: AudioNode): void {
  const g = graphs.get(media);
  if (!g || !g.passiveTaps.has(node)) return;
  try { g.masterGain.disconnect(node); } catch { /* ignore */ }
  try { node.disconnect(g.silentSink); } catch { /* ignore */ }
  g.passiveTaps.delete(node);
}

/** The shared source node for an element (graph must already exist). */
export function getSharedSource(media: HTMLMediaElement): MediaElementAudioSourceNode | null {
  return graphs.get(media)?.source ?? null;
}

/** The masterGain (post-DSP bus) for an element. */
export function getMasterGain(media: HTMLMediaElement): GainNode | null {
  return graphs.get(media)?.masterGain ?? null;
}

/** The most-recently-touched element graph (for status panels). */
export function activeContextState(): AudioContextState | 'none' {
  return activeGraph ? activeGraph.ctx.state : sharedContextState();
}

/**
 * Human-readable description of the CURRENT audio route for an element, for
 * the debug panel.  The analyser/tap is always post-insert (it reads
 * masterGain), so it is shown inline in every route.
 */
export function currentRouteLabel(media: HTMLMediaElement | null): string {
  if (!media) return 'no element';
  const g = graphs.get(media);
  if (!g) return 'no graph';
  if (g.wasmInsert) return 'WASM: source → WASM DSP → analyser/tap → master';
  if (g.nativeDsp) return 'FALLBACK: source → Native DSP → analyser/tap → master';
  return 'DIRECT: source → analyser/tap → master';
}

/**
 * A minimal MasteringGraphSession backed by the shared graph (not the WASM
 * analyzer session).  Lets the realtime DSP attach + splice its node even
 * when the WASM analyzer fails to start, so module edits stay audible.
 */
export function makeSharedMasteringSession(media: HTMLMediaElement, sampleRate = 48_000): {
  audioContext: () => AudioContext | null;
  setInsertNode: (node: AudioNode | null) => void;
} {
  return {
    audioContext: () => {
      try { return ensureElementGraph(media, sampleRate).ctx; } catch { return null; }
    },
    setInsertNode: (node: AudioNode | null) => {
      try { ensureElementGraph(media, sampleRate); setRealtimeInsert(media, node); } catch { /* ignore */ }
    },
  };
}
