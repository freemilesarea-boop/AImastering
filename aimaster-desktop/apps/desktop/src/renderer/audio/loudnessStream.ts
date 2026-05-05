// High-level wrapper around loudnessProcessor.worklet.ts.
//
// Usage (in React):
//   const stream = new LoudnessStream();
//   await stream.attach(htmlAudioElement);  // or attach(mediaStream)
//   stream.onMetrics = (m) => setMetrics(m);
//   ...
//   stream.detach();
//
// Backend: Web-Audio AudioContext + AudioWorkletNode.  The worklet posts
// metrics every `updateMs` (default 100 ms).  We forward those to the
// onMetrics callback verbatim so React can render.

export interface LiveLoudnessMetrics {
  momentaryLufs:  number;
  shortTermLufs:  number;
  integratedLufs: number;
  truePeakDbtp:   number;
  perChannelTpDb: number[];
  durationSec:    number;
  blocksAnalyzed: number;
}

export class LoudnessStream {
  private ctx:    AudioContext | null = null;
  private node:   AudioWorkletNode | null = null;
  private srcEl:  HTMLMediaElement | null = null;
  private srcNode: AudioNode | null = null;
  private moduleAdded = false;

  public onMetrics: ((m: LiveLoudnessMetrics) => void) | null = null;
  public updateMs = 100;

  constructor(private workletUrl?: string) {}

  // Resolve the worklet URL.  Vite + bundlers route this through:
  //   new URL('./loudnessProcessor.worklet.ts', import.meta.url).
  // Callers can override via the constructor.
  private resolveWorkletUrl(): string {
    if (this.workletUrl) return this.workletUrl;
    return new URL('./loudnessProcessor.worklet.ts', import.meta.url).toString();
  }

  private async ensureContext(): Promise<AudioContext> {
    if (this.ctx) return this.ctx;
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) throw new Error('AudioContext not supported in this environment');
    const ctx: AudioContext = new Ctor({ latencyHint: 'interactive' });
    if (!this.moduleAdded) {
      await ctx.audioWorklet.addModule(this.resolveWorkletUrl());
      this.moduleAdded = true;
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

  // Attach to an <audio> / <video> element — its output is metered.
  // The element keeps playing through the speakers via the routed graph.
  async attachMediaElement(el: HTMLMediaElement): Promise<void> {
    const ctx = await this.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume();
    this.srcEl   = el;
    const src    = ctx.createMediaElementSource(el);
    this.srcNode = src;
    this.node    = await this.buildNode(ctx);
    src.connect(this.node);
    this.node.connect(ctx.destination);
  }

  // Attach to a MediaStream (e.g., microphone, capture).
  async attachMediaStream(stream: MediaStream): Promise<void> {
    const ctx = await this.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume();
    const src = ctx.createMediaStreamSource(stream);
    this.srcNode = src;
    this.node    = await this.buildNode(ctx);
    src.connect(this.node);
    // Don't connect to destination — we don't want to play microphone back.
  }

  // Attach to an existing AudioNode (e.g., an OscillatorNode in tests).
  async attachNode(srcNode: AudioNode, ctx: AudioContext): Promise<void> {
    if (!this.ctx) {
      this.ctx = ctx;
      if (!this.moduleAdded) {
        await ctx.audioWorklet.addModule(this.resolveWorkletUrl());
        this.moduleAdded = true;
      }
    }
    this.srcNode = srcNode;
    this.node    = await this.buildNode(this.ctx);
    srcNode.connect(this.node);
    this.node.connect(this.ctx.destination);
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

  detach(): void {
    try { this.node?.disconnect(); } catch { /* noop */ }
    try { this.srcNode?.disconnect(); } catch { /* noop */ }
    this.node    = null;
    this.srcNode = null;
    this.srcEl   = null;
  }

  async close(): Promise<void> {
    this.detach();
    if (this.ctx) {
      try { await this.ctx.close(); } catch { /* noop */ }
      this.ctx = null;
      this.moduleAdded = false;
    }
  }
}
