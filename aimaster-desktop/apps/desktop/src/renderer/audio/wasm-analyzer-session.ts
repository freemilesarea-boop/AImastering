// WasmAnalyzerSessionFactory — production analyzer session backed by the
// Rust dsp-core (@loui/dsp-wasm).
//
// Architecture
// ────────────────────────────────────────────────────────────────────────
//   • AudioContext + AnalyzerTap AudioWorklet → forwards planar audio
//     blocks from the audio thread to the main thread via MessagePort.
//   • Main thread holds the WASM analyzer instances (loudness + spectrum).
//   • Subscribers receive throttled MeterTickSnapshot / FftFrame /
//     StereoScopeFrame on the configured cadences.
//
// Why main-thread WASM rather than worklet-WASM?
//   • Worklet+WASM needs Vite plugin scaffolding (top-level await,
//     SharedArrayBuffer cross-origin-isolation, etc).  M3-bridge-impl
//     keeps the worklet minimal (just a tap) and runs WASM on main —
//     analysis latency is ~16 ms (one block-period), well within the
//     M3 UI budget.  Worklet-WASM is a follow-up optimisation, not a
//     correctness requirement.
//
// Realtime contract
//   • Worklet does memcpy only (process() is allocation-free).
//   • Main-thread WASM calls do not block the audio thread.
//   • Subscriber callbacks run on the main thread at the configured rate.

import type {
  AnalyzerSession,
  AnalyzerSessionFactory,
  AnalyzerSessionOptions,
  AnalyzerUnsubscribe,
  FftFrame,
  MeterSnapshot,
  MeterTickSnapshot,
  StereoScopeFrame,
  SubscriptionRate,
} from '@aimaster/shared-types/streaming';
import {
  FFT_FRAME_SCHEMA,
  METER_SNAPSHOT_SCHEMA,
  STEREO_SCOPE_FRAME_SCHEMA,
} from '@aimaster/shared-types/streaming';

import init, {
  LouiAnalyzer,
  LouiSpectrumAnalyzer,
  WasmSpectrumOptions,
} from '@loui/dsp-wasm';

// The worklet ships from Vite's `public/` directory (root-relative URL).
// This avoids the static-analysis fragility of `new URL(..., import.meta.url)`
// when the importing module is behind a build-time-resolvable conditional —
// Vite's tree-shaker can drop the import statement, which silently drops
// the asset emission too.  `public/` files are always copied verbatim and
// served at the path declared here.
//
// Source of truth: `src/renderer/audio/analyzer-tap.worklet.js`.
// Build copies that file to `src/renderer/public/analyzer-tap.worklet.js`
// (handled by `scripts/sync-worklet.sh` for now — TODO: vite plugin).
const DEFAULT_WORKLET_URL = './analyzer-tap.worklet.js';

function defaultWorkletUrl(): string {
  return DEFAULT_WORKLET_URL;
}

// ── Tick-rate helpers ─────────────────────────────────────────────────────

function rateToMs(rate: SubscriptionRate): number {
  switch (rate) {
    case 'audio': return 16;
    case '60Hz':  return 16;
    case '30Hz':  return 33;
    case '10Hz':  return 100;
    default:      return 100;
  }
}

// ── Subscription bookkeeping ──────────────────────────────────────────────

interface Subscription<T> {
  rate?: SubscriptionRate;
  cb: (t: T) => void;
  lastEmit: number;
}

// ── Audio source — what feeds the worklet tap ──────────────────────────────

/**
 * The factory needs an audio source.  Today the renderer's typical
 * sources are:
 *   • HTMLMediaElement (the existing `<audio>` previews on ResultPage etc.)
 *   • AudioBufferSourceNode (for preview playback)
 *   • MediaStream (for mic / live monitoring — future)
 *
 * Callers attach the source via `attach(audioNode)` after `start()`.  The
 * factory wires it through the tap worklet → destination.
 */
export type AudioSourceNode =
  | MediaElementAudioSourceNode
  | AudioBufferSourceNode
  | MediaStreamAudioSourceNode;

// ── Internal session implementation ────────────────────────────────────────

class WasmAnalyzerSession implements AnalyzerSession {
  readonly options: AnalyzerSessionOptions;
  isRunning = false;

  private ctx: AudioContext | null = null;
  private tapNode: AudioWorkletNode | null = null;
  private analyzer: LouiAnalyzer | null = null;
  private spectrum: LouiSpectrumAnalyzer | null = null;
  private samplesProcessed = 0;
  private lastFftFrameRef: FftFrame | null = null;

  // Subscribers
  private tickSubs:   Subscription<MeterTickSnapshot>[] = [];
  private fullSubs:   Subscription<MeterSnapshot>[]     = [];
  private fftSubs:    Subscription<FftFrame>[]          = [];
  private stereoSubs: Subscription<StereoScopeFrame>[]  = [];

  // Throttled fan-out timestamps
  private lastTickEmitAt: Record<string, number> = {};
  private lastFullEmitAt = 0;
  private lastFftEmitAt = 0;
  private lastStereoEmitAt = 0;

  private wasmReady: Promise<void> | null = null;

  constructor(options: AnalyzerSessionOptions, private readonly workletUrl: string) {
    this.options = { ...options };
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    // Init WASM once per session.
    this.wasmReady = init().then(() => {
      this.analyzer = new LouiAnalyzer(this.options.sampleRate, this.options.channels);
      this.spectrum = new LouiSpectrumAnalyzer(
        this.options.sampleRate,
        new WasmSpectrumOptions()
          .setFftSize(2048)
          .setSmoothing(0.5)
          .setPeakHoldDecayDb(1.5)
          .useLog(128, 20, 20_000),
      );
    });

    await this.wasmReady;

    // Create AudioContext at the requested sample rate when possible.
    this.ctx = new AudioContext({ sampleRate: this.options.sampleRate });
    await this.ctx.audioWorklet.addModule(this.workletUrl);

    this.tapNode = new AudioWorkletNode(this.ctx, 'analyzer-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [this.options.channels],
      channelCount: this.options.channels,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });

    // Receive audio blocks from worklet → push to WASM analyzers on main.
    this.tapNode.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { left: Float32Array; right?: Float32Array };
      if (!data || !data.left) return;
      this.processBlock(data.left, data.right);
    };

    this.isRunning = true;
  }

  async stop(): Promise<void> {
    if (this.tapNode) {
      try { this.tapNode.port.onmessage = null; } catch { /* ignore */ }
      try { this.tapNode.disconnect(); } catch { /* ignore */ }
      this.tapNode = null;
    }
    if (this.ctx) {
      try { await this.ctx.close(); } catch { /* ignore */ }
      this.ctx = null;
    }
    if (this.analyzer) {
      try { this.analyzer.free(); } catch { /* ignore */ }
      this.analyzer = null;
    }
    if (this.spectrum) {
      try { this.spectrum.free(); } catch { /* ignore */ }
      this.spectrum = null;
    }
    this.isRunning = false;
    this.samplesProcessed = 0;
    this.lastFftFrameRef = null;
  }

  /**
   * Attach an audio source so its output is analyzed.  Connection is:
   *   source → tap → destination.
   *
   * The tap forwards audio to both destination (playback) and the WASM
   * analyzer (via port).  Multiple calls replace the previous source.
   */
  attach(source: AudioSourceNode): void {
    if (!this.ctx || !this.tapNode) {
      throw new Error('analyzer session not started');
    }
    try { this.tapNode.disconnect(); } catch { /* ignore */ }
    source.connect(this.tapNode);
    this.tapNode.connect(this.ctx.destination);
  }

  /**
   * Convenience: wrap an `HTMLMediaElement` in a `MediaElementSource`
   * and attach.  Idempotent in spirit — re-attaching the same element
   * silently replaces the previous routing.
   *
   * Caveat: `createMediaElementSource` can only be called **once per
   * element per AudioContext**.  We cache the source node so callers
   * can re-call attachMediaElement safely.
   */
  attachMediaElement(media: HTMLMediaElement): void {
    if (!this.ctx || !this.tapNode) {
      throw new Error('analyzer session not started');
    }
    let src = WasmAnalyzerSession.mediaSourceCache.get(media);
    if (!src || src.context !== this.ctx) {
      src = this.ctx.createMediaElementSource(media);
      WasmAnalyzerSession.mediaSourceCache.set(media, src);
    }
    this.attach(src);
  }

  /**
   * AudioContext owned by this session.  Useful for callers that need
   * to wire additional nodes (e.g. user-side analyser nodes).  Returns
   * null when the session has not started or has been stopped.
   */
  audioContext(): AudioContext | null {
    return this.ctx;
  }

  /**
   * Browser-imposed constraint: `createMediaElementSource` may only be
   * called once per (element, context) pair.  We cache the result so
   * the gate component can call `attachMediaElement` on every render
   * without crashing.
   */
  private static mediaSourceCache = new WeakMap<
    HTMLMediaElement,
    MediaElementAudioSourceNode
  >();

  // ── Subscriptions ────────────────────────────────────────────────────────

  onTickSnapshot(rate: SubscriptionRate, cb: (snap: MeterTickSnapshot) => void): AnalyzerUnsubscribe {
    const sub: Subscription<MeterTickSnapshot> = { rate, cb, lastEmit: 0 };
    this.tickSubs.push(sub);
    return () => { this.tickSubs = this.tickSubs.filter((s) => s !== sub); };
  }

  onFullSnapshot(cb: (snap: MeterSnapshot) => void): AnalyzerUnsubscribe {
    const sub: Subscription<MeterSnapshot> = { cb, lastEmit: 0 };
    this.fullSubs.push(sub);
    return () => { this.fullSubs = this.fullSubs.filter((s) => s !== sub); };
  }

  onFftFrame(cb: (frame: FftFrame) => void): AnalyzerUnsubscribe {
    const sub: Subscription<FftFrame> = { cb, lastEmit: 0 };
    this.fftSubs.push(sub);
    return () => { this.fftSubs = this.fftSubs.filter((s) => s !== sub); };
  }

  onStereoFrame(cb: (frame: StereoScopeFrame) => void): AnalyzerUnsubscribe {
    const sub: Subscription<StereoScopeFrame> = { cb, lastEmit: 0 };
    this.stereoSubs.push(sub);
    return () => { this.stereoSubs = this.stereoSubs.filter((s) => s !== sub); };
  }

  async requestSnapshot(): Promise<MeterSnapshot> {
    if (!this.analyzer) {
      throw new Error('analyzer not initialised');
    }
    const wasm = this.analyzer.snapshot();
    const snap: MeterSnapshot = {
      schema: METER_SNAPSHOT_SCHEMA,
      sampleRate: this.options.sampleRate,
      channels: this.options.channels,
      samplesProcessed: this.samplesProcessed,
      integratedLufs: wasm.integratedLufs,
      shortTermLufs:  wasm.shortTermLufs,
      momentaryLufs:  wasm.momentaryLufs,
      loudnessRange:  wasm.loudnessRange,
      truePeakDbtp:   wasm.truePeakDbtp,
      samplePeakDb:   wasm.samplePeakDb,
      rmsDb:          wasm.rmsDb,
      correlation:    wasm.correlation,
      msRatioDb:      wasm.msRatioDb,
      gatedBlocks:    wasm.gatedBlocks,
    };
    return snap;
  }

  async reset(): Promise<void> {
    if (this.analyzer) this.analyzer.reset();
    if (this.spectrum) this.spectrum.reset();
    this.samplesProcessed = 0;
    this.lastFftFrameRef = null;
    this.lastTickEmitAt = {};
    this.lastFullEmitAt = 0;
    this.lastFftEmitAt = 0;
    this.lastStereoEmitAt = 0;
  }

  // ── Audio block processing (called from worklet port onmessage) ──────────

  private processBlock(left: Float32Array, right?: Float32Array): void {
    if (!this.analyzer || !this.spectrum) return;

    if (right && this.options.channels === 2) {
      this.analyzer.processStereo(left, right);
      this.spectrum.processStereo(left, right);
    } else {
      this.analyzer.processMono(left);
      this.spectrum.processMono(left);
    }
    this.samplesProcessed += left.length;

    // Cache the latest FFT frame if one is ready — emit it on the FFT cadence.
    if (this.spectrum.tryFrame()) {
      this.lastFftFrameRef = {
        schema: FFT_FRAME_SCHEMA,
        sampleRate: this.options.sampleRate,
        samplesProcessed: this.samplesProcessed,
        fftSize: this.spectrum.fftSize,
        // Vec<f32> over wasm-bindgen returns Float32Array proxies — we
        // copy into number arrays for storage so subsequent WASM calls
        // don't mutate the snapshot consumers read.
        binCentresHz: Array.from(this.spectrum.binCentresHz),
        magnitudeDb:  Array.from(this.spectrum.magnitudeDb),
        peakHoldDb:   Array.from(this.spectrum.peakHoldDb),
      };
    }

    // Throttled fan-out.
    const now = performance.now();
    this.emitTickSnapshots(now);
    this.emitFullSnapshot(now);
    this.emitFftFrame(now);
    this.emitStereoFrame(now);
  }

  private buildTick(): MeterTickSnapshot {
    const wasm = this.analyzer!.tickSnapshot();
    return {
      schema: METER_SNAPSHOT_SCHEMA,
      sampleRate: this.options.sampleRate,
      channels: this.options.channels,
      samplesProcessed: this.samplesProcessed,
      integratedLufs: Number.NaN,
      loudnessRange:  Number.NaN,
      gatedBlocks: 0,
      shortTermLufs: wasm.shortTermLufs,
      momentaryLufs: wasm.momentaryLufs,
      truePeakDbtp:  wasm.truePeakDbtp,
      samplePeakDb:  wasm.samplePeakDb,
      rmsDb:         wasm.rmsDb,
      correlation:   wasm.correlation,
      msRatioDb:     wasm.msRatioDb,
    };
  }

  private emitTickSnapshots(now: number): void {
    if (this.tickSubs.length === 0) return;
    // Cache the tick snapshot once — multiple subscribers share it.
    let snap: MeterTickSnapshot | null = null;
    for (const sub of this.tickSubs) {
      const period = rateToMs(sub.rate ?? '10Hz');
      if (now - sub.lastEmit < period) continue;
      if (snap == null) snap = this.buildTick();
      sub.cb(snap);
      sub.lastEmit = now;
    }
  }

  private emitFullSnapshot(now: number): void {
    if (this.fullSubs.length === 0) return;
    // Full snapshots throttle to 1 Hz — gated calc is the expensive bit.
    if (now - this.lastFullEmitAt < 1000) return;
    this.lastFullEmitAt = now;
    // Async resolution doesn't matter here; we compute synchronously.
    this.requestSnapshot().then((s) => {
      for (const sub of this.fullSubs) sub.cb(s);
    }).catch(() => { /* analyzer was disposed between schedule and resolve */ });
  }

  private emitFftFrame(now: number): void {
    if (this.fftSubs.length === 0 || !this.lastFftFrameRef) return;
    if (now - this.lastFftEmitAt < 33) return;     // 30 Hz cap
    this.lastFftEmitAt = now;
    const frame = this.lastFftFrameRef;
    for (const sub of this.fftSubs) sub.cb(frame);
  }

  private emitStereoFrame(now: number): void {
    if (this.stereoSubs.length === 0 || !this.analyzer) return;
    if (now - this.lastStereoEmitAt < 33) return;  // 30 Hz cap
    this.lastStereoEmitAt = now;
    const tick = this.analyzer.tickSnapshot();
    const frame: StereoScopeFrame = {
      schema: STEREO_SCOPE_FRAME_SCHEMA,
      correlation: tick.correlation,
      msRatioDb: tick.msRatioDb,
      widthIndex: 1 - tick.correlation * 0.5,
      windowFrames: 0,
    };
    for (const sub of this.stereoSubs) sub.cb(frame);
  }
}

// ── Public factory ─────────────────────────────────────────────────────────

export interface WasmAnalyzerSessionFactoryOptions {
  /**
   * URL of the bundled analyzer-tap worklet module.  Defaults to the
   * Vite-resolved path that ships with this package; pass an override
   * when bundling with a custom build setup.
   */
  workletUrl?: string;
}

/**
 * Production analyzer session factory backed by the Rust `loui-dsp` WASM
 * build.
 *
 * Each `create()` returns a fresh `AnalyzerSession`.  Call `start()` on
 * the session, then `attach(audioNode)` once your source is ready; the
 * session forwards audio through the tap worklet, analyzes on main, and
 * fans MeterSnapshot / FftFrame / StereoScopeFrame to subscribers.
 */
export class WasmAnalyzerSessionFactory implements AnalyzerSessionFactory {
  private readonly workletUrl: string;

  constructor(opts: WasmAnalyzerSessionFactoryOptions = {}) {
    // Vite resolves `defaultWorkletUrl()` at module-evaluation time so
    // the worklet ships alongside the renderer bundle.  In production
    // it is fingerprint-stable under /assets/.
    this.workletUrl = opts.workletUrl ?? defaultWorkletUrl();
  }

  create(options: AnalyzerSessionOptions): AnalyzerSession {
    return new WasmAnalyzerSession(options, this.workletUrl);
  }
}

/**
 * One-shot helper for the common case: create a session and attach an
 * `<audio>` element source to it.  Returns the session ready to consume.
 */
export async function startWasmAnalyzerForMediaElement(
  factory: WasmAnalyzerSessionFactory,
  media: HTMLMediaElement,
  options: AnalyzerSessionOptions,
): Promise<{ session: AnalyzerSession; ctx: AudioContext }> {
  const session = factory.create(options);
  await session.start();
  // Cast — we know the impl is `WasmAnalyzerSession` which exposes attach.
  const ws = session as WasmAnalyzerSession;
  if (!(ws as unknown as { ctx?: AudioContext }).ctx) {
    throw new Error('analyzer session failed to initialise AudioContext');
  }
  const ctx = (ws as unknown as { ctx: AudioContext }).ctx;
  const src = ctx.createMediaElementSource(media);
  ws.attach(src);
  return { session, ctx };
}
