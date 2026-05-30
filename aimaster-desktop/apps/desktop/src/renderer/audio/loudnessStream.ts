// High-level wrapper around loudnessProcessor.worklet.js.
//
// Usage (in React):
//   const stream = new LoudnessStream();
//   await stream.attachMediaElement(htmlAudioElement);
//   stream.onMetrics = (m) => setMetrics(m);
//   ...
//   await stream.close();
//
// Backend: shared AudioContext + AudioWorkletNode mounted as a passive tap
// on the element's shared graph (see ./shared-audio-graph.ts).  The worklet
// posts metrics every `updateMs` (default 100 ms); we forward those to the
// onMetrics callback verbatim so React can render.
//
// History
//   This class used to construct its OWN AudioContext and call
//   `createMediaElementSource` directly on the supplied media element.  That
//   collided with shared-audio-graph: an HTMLMediaElement can be captured by
//   exactly one MediaElementSource for its whole lifetime, and the shared
//   graph already owns that source for any element with playback wired up.
//   The current implementation routes through shared-audio-graph instead,
//   leaving the source ownership untouched and adding the loudness worklet
//   as a passive analyser tap on the post-DSP master bus.

import {
  getSharedAudioContext,
  ensureElementGraph,
  addPassiveTap,
  removePassiveTap,
} from './shared-audio-graph.js';

export interface LiveLoudnessMetrics {
  momentaryLufs:  number;
  shortTermLufs:  number;
  integratedLufs: number;
  truePeakDbtp:   number;
  perChannelTpDb: number[];
  durationSec:    number;
  blocksAnalyzed: number;
}

// Worklet `addModule` deduplication — once per AudioContext for the whole
// renderer lifetime.  WeakSet keys on the context object so a future
// context teardown / re-create cycle re-registers cleanly.
const moduleAddedFor = new WeakSet<AudioContext>();

export class LoudnessStream {
  private ctx:    AudioContext | null = null;
  private node:   AudioWorkletNode | null = null;
  // The media element this stream is metering (tracked so close() can
  // detach the passive tap from the right shared graph).  `srcNode` only
  // exists in the mediaStream / raw-node attach paths.
  private currentMedia: HTMLMediaElement | null = null;
  private srcNode: AudioNode | null = null;

  // Lifecycle guards — React StrictMode runs effect cleanup-then-remount,
  // so attach can land alongside an in-flight close.  `_closed` is the
  // idempotency latch; once set, every public op short-circuits.
  private _attaching = false;
  private _closed    = false;

  public onMetrics: ((m: LiveLoudnessMetrics) => void) | null = null;
  public updateMs = 100;

  constructor(private workletUrl?: string) {}

  // Resolve the worklet URL.  We point at the **plain-JS** worklet file —
  // Vite passes static assets referenced via `new URL` through verbatim
  // (no TS transform), so the worklet itself must be valid JavaScript.
  // Callers can override via the constructor.
  private resolveWorkletUrl(): string {
    if (this.workletUrl) return this.workletUrl;
    return new URL('./loudnessProcessor.worklet.js', import.meta.url).toString();
  }

  private async ensureContext(): Promise<AudioContext> {
    if (this.ctx) return this.ctx;
    // Use the shared, app-wide AudioContext owned by shared-audio-graph.
    // Constructing a private context here would collide with the shared
    // graph's `createMediaElementSource` (each element can be captured by
    // at most one source-per-context, and the spec requires the same
    // context across all sources for the same element).
    const ctx = getSharedAudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    if (!moduleAddedFor.has(ctx)) {
      await ctx.audioWorklet.addModule(this.resolveWorkletUrl());
      moduleAddedFor.add(ctx);
    }
    this.ctx = ctx;
    return ctx;
  }

  // Build the AudioWorkletNode and wire up postMessage handling.
  private async buildNode(ctx: AudioContext): Promise<AudioWorkletNode> {
    const node = new AudioWorkletNode(ctx, 'loudness-processor', {
      numberOfInputs:  1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { updateMs: this.updateMs },
    });
    node.port.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg && msg.type === 'metrics' && this.onMetrics) {
        this.onMetrics({
          momentaryLufs:  msg.momentaryLufs,
          shortTermLufs:  msg.shortTermLufs,
          integratedLufs: msg.integratedLufs,
          truePeakDbtp:   msg.truePeakDbtp,
          perChannelTpDb: msg.perChannelTpDb || [],
          durationSec:    msg.durationSec,
          blocksAnalyzed: msg.blocksAnalyzed,
        });
      }
    };
    return node;
  }

  /**
   * Attach to an `<audio>` / `<video>` element — its post-DSP master bus is
   * metered.  The element keeps playing through the speakers via the
   * shared graph; this just adds a passive tap that reads the same audio.
   *
   * Idempotent: re-attaching while already attached to the same element is
   * a no-op; re-attaching to a different element first detaches.
   */
  async attachMediaElement(el: HTMLMediaElement): Promise<void> {
    if (this._closed)    return;
    if (this._attaching) return;
    if (this.currentMedia === el && this.node) return;
    if (this.currentMedia && this.currentMedia !== el) {
      this.detach();
    }
    this._attaching = true;
    try {
      // Ensure the shared graph exists for this element (creates source +
      // native analysers if first mount).  This is the ONLY path through
      // which a MediaElementSource is created for the element — we never
      // call createMediaElementSource ourselves.
      ensureElementGraph(el);
      const ctx = await this.ensureContext();
      if (this._closed) return;
      this.node = await this.buildNode(ctx);
      this.currentMedia = el;
      // Passive tap → reads masterGain (post-DSP), pulls to silentSink so
      // it never affects the audible output and never disconnects when
      // other DSP nodes splice in/out.
      addPassiveTap(el, this.node);
    } finally {
      this._attaching = false;
      // If close() arrived while we were awaiting, undo the just-built node.
      if (this._closed) await this.close();
    }
  }

  /**
   * Attach to a MediaStream (e.g., microphone, capture).  No element graph
   * involvement — the stream is wired into the loudness worklet directly,
   * with no destination connection (we never want to play the mic back).
   */
  async attachMediaStream(stream: MediaStream): Promise<void> {
    if (this._closed)    return;
    if (this._attaching) return;
    this._attaching = true;
    try {
      const ctx = await this.ensureContext();
      if (this._closed) return;
      const src = ctx.createMediaStreamSource(stream);
      this.srcNode = src;
      this.node = await this.buildNode(ctx);
      src.connect(this.node);
      // Intentionally no node.connect(ctx.destination) — mic should not
      // echo to speakers.  The worklet still pulls audio because the
      // shared context's master destination keeps the graph clock running.
    } finally {
      this._attaching = false;
      if (this._closed) await this.close();
    }
  }

  /**
   * Attach to an existing AudioNode (e.g., an OscillatorNode in tests).
   * The caller provides the context — it must be the shared context if
   * the source is going to be combined with other shared-graph traffic.
   */
  async attachNode(srcNode: AudioNode, ctx: AudioContext): Promise<void> {
    if (this._closed)    return;
    if (this._attaching) return;
    this._attaching = true;
    try {
      if (!this.ctx) {
        if (!moduleAddedFor.has(ctx)) {
          await ctx.audioWorklet.addModule(this.resolveWorkletUrl());
          moduleAddedFor.add(ctx);
        }
        this.ctx = ctx;
      }
      if (this._closed) return;
      this.srcNode = srcNode;
      this.node = await this.buildNode(this.ctx);
      srcNode.connect(this.node);
      this.node.connect(this.ctx.destination);
    } finally {
      this._attaching = false;
      if (this._closed) await this.close();
    }
  }

  reset(): void {
    if (this.node) this.node.port.postMessage({ type: 'reset' });
  }

  setUpdateMs(ms: number): void {
    this.updateMs = ms;
    if (this.node) this.node.port.postMessage({ type: 'setUpdateMs', value: ms });
  }

  // Force an immediate metrics emission (e.g., on stop).
  snapshot(): void {
    if (this.node) this.node.port.postMessage({ type: 'snapshot' });
  }

  /** Detach without tearing down the worklet module / context state. */
  detach(): void {
    if (this.currentMedia && this.node) {
      try { removePassiveTap(this.currentMedia, this.node); } catch { /* noop */ }
    }
    try { this.node?.disconnect(); }    catch { /* noop */ }
    try { this.srcNode?.disconnect(); } catch { /* noop */ }
    if (this.node) {
      try { this.node.port.onmessage = null; } catch { /* noop */ }
    }
    this.node = null;
    this.srcNode = null;
    this.currentMedia = null;
  }

  /**
   * Tear down everything this stream owns.  Idempotent — calling twice
   * (e.g. cleanup-then-remount on StrictMode) is a no-op the second time.
   * The shared AudioContext is NEVER closed here; it outlives every
   * individual LoudnessStream and is owned by shared-audio-graph.
   */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this.detach();
    // Drop the context reference but DO NOT close it — it belongs to
    // shared-audio-graph and other consumers may still be attached.
    this.ctx = null;
  }
}
