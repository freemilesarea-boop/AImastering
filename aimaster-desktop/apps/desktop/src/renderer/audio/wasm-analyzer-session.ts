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

import {
  getSharedAudioContext as getAppAudioContext,
  ensureElementGraph,
  addPassiveTap,
  removePassiveTap,
  setRealtimeInsert,
  logAudioEvent,
} from './shared-audio-graph.js';

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

// ── Shared (singleton) AudioContext ─────────────────────────────────────────
//
// Routing (context, MediaElementSource, audio bus, native analysers) is
// owned by `shared-audio-graph.ts` — the single source of truth.  The WASM
// session no longer creates or closes the context, nor the source: it only
// attaches its analyzer-tap worklet as a PASSIVE tap on the post-DSP bus.
// This guarantees playback + native spectrum/meters work even if this
// session fails to start.

const ctxModuleAdded = new WeakSet<AudioContext>();

function getSharedAudioContext(sampleRate: number): AudioContext {
  return getAppAudioContext(sampleRate);
}

const RT_DEBUG = (() => {
  try { return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV); }
  catch { return false; }
})();

/** Dev-only diagnostic log for the realtime audio graph. */
function rtLog(msg: string, data?: unknown): void {
  if (!RT_DEBUG) return;
  // eslint-disable-next-line no-console
  if (data !== undefined) console.debug(`[RealtimeAudio] ${msg}`, data);
  else console.debug(`[RealtimeAudio] ${msg}`);
}

// ── Internal session implementation ────────────────────────────────────────

class WasmAnalyzerSession implements AnalyzerSession {
  readonly options: AnalyzerSessionOptions;
  isRunning = false;

  private ctx: AudioContext | null = null;
  private tapNode: AudioWorkletNode | null = null;
  // The current source node attached to the graph (kept so the optional
  // realtime-mastering insert node can be spliced in/out without a
  // re-attach).  Null until attach() runs.
  private currentSource: AudioSourceNode | null = null;
  // The media element this session is tapping (shared-graph routing).
  private currentMedia: HTMLMediaElement | null = null;
  // Optional processing node spliced between source and tap (realtime
  // mastering preview, M2-full-NEXT-2).  Null = analyzer-only graph
  // (the default; flag OFF behaviour is byte-identical).
  private insertNode: AudioNode | null = null;
  private analyzer: LouiAnalyzer | null = null;
  private spectrum: LouiSpectrumAnalyzer | null = null;
  private samplesProcessed = 0;
  private blockCount = 0;
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

    // Use the shared, never-closed AudioContext (see top of file) so the
    // element's one-and-only MediaElementSource is reusable across mounts.
    this.ctx = getSharedAudioContext(this.options.sampleRate);
    if (!ctxModuleAdded.has(this.ctx)) {
      await this.ctx.audioWorklet.addModule(this.workletUrl);
      ctxModuleAdded.add(this.ctx);
    }
    rtLog('session start', { ctxState: this.ctx.state, sampleRate: this.ctx.sampleRate, channels: this.options.channels });

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
    // Detach the passive tap from the shared graph — NEVER touch the source,
    // the DSP insert, or the audio bus (the shared graph owns those, so
    // playback + native analysers keep working after this session stops).
    if (this.currentMedia && this.tapNode) {
      try { removePassiveTap(this.currentMedia, this.tapNode); } catch { /* ignore */ }
    }
    this.currentSource = null;
    this.insertNode = null;
    if (this.tapNode) {
      try { this.tapNode.port.onmessage = null; } catch { /* ignore */ }
      try { this.tapNode.disconnect(); } catch { /* ignore */ }
      this.tapNode = null;
    }
    this.currentMedia = null;
    // NOTE: the shared AudioContext is intentionally NOT closed here.
    this.ctx = null;
    rtLog('session stop (shared context + routing kept alive)');
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
    this.currentSource = source;
    this.wireGraph();
  }

  /**
   * (Re)build the playback graph from the current source.  The optional
   * insert node (realtime mastering preview) is spliced between source
   * and tap when present:
   *
   *   insertNode == null →  source → tap → destination   (analyzer-only)
   *   insertNode != null →  source → insertNode → tap → destination
   *
   * Fully tears down + rebuilds the connections so it is safe to call
   * repeatedly (no duplicate edges).  No-op if not started/attached.
   */
  private wireGraph(): void {
    if (!this.ctx || !this.tapNode || !this.currentSource) return;
    const src = this.currentSource;
    const tap = this.tapNode;
    try { src.disconnect(); } catch { /* ignore */ }
    try { tap.disconnect(); } catch { /* ignore */ }
    if (this.insertNode) { try { this.insertNode.disconnect(); } catch { /* ignore */ } }
    if (this.insertNode) {
      src.connect(this.insertNode);
      this.insertNode.connect(tap);
    } else {
      src.connect(tap);
    }
    tap.connect(this.ctx.destination);
  }

  /**
   * Splice a realtime DSP node into the shared audio bus
   * (source → node → masterGain).  Pass `null` to remove it.  The analyzer
   * tap reads the post-DSP bus, so the spectrum reflects processed audio.
   * For the legacy raw-source path (no media element) we fall back to
   * rewiring the local graph.
   */
  setInsertNode(node: AudioNode | null): void {
    this.insertNode = node;
    if (this.currentMedia) {
      setRealtimeInsert(this.currentMedia, node);
      return;
    }
    this.wireGraph();
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
    rtLog('audio element found', {
      paused: media.paused, currentTime: media.currentTime, duration: media.duration,
      readyState: media.readyState,
    });
    // The shared graph owns the source + audio bus + native analysers.  It
    // is created on element mount (independent of this session), so it
    // already exists here; this is idempotent.
    const graph = ensureElementGraph(media, this.options.sampleRate);
    this.currentMedia = media;
    this.currentSource = graph.source;
    // Add the analyzer-tap as a passive tap on the post-DSP bus — it reads
    // what the user hears and never affects the output.
    addPassiveTap(media, this.tapNode);
    // If a DSP insert was staged before attach, splice it now.
    if (this.insertNode) setRealtimeInsert(media, this.insertNode);
    logAudioEvent('wasm-analyzer-connected', 'session attached');
  }

  /**
   * AudioContext owned by this session.  Useful for callers that need
   * to wire additional nodes (e.g. user-side analyser nodes).  Returns
   * null when the session has not started or has been stopped.
   */
  audioContext(): AudioContext | null {
    return this.ctx;
  }

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

    // Dev frame-flow telemetry — logs the first block and then every ~1 s
    // worth of blocks so the console proves frames are arriving.
    this.blockCount++;
    if (this.blockCount === 1) logAudioEvent('dsp-chain-connected', 'first WASM analyzer block');
    if (RT_DEBUG && (this.blockCount === 1 || this.blockCount % 256 === 0)) {
      rtLog('analyser frames', { blocks: this.blockCount, samples: this.samplesProcessed, len: left.length, stereo: !!right });
    }

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
