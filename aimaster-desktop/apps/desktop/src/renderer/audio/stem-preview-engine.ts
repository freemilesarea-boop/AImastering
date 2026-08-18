// stem-preview-engine — play a stem session, and let the faders move while
// it plays.
//
// # Sync is by construction, not by correction
//
// Every stem plays from an `AudioBufferSourceNode`, and all of them are
// started with the same `when` on the same clock. There is no drift to
// correct because there is nothing to drift: the sources share the audio
// context's timeline. The alternative — one `<audio>` element per stem —
// gives each stem its own independent clock, and stems recorded together
// comb against each other at a millisecond of skew.
//
// # Seeking restarts, and that is not a compromise
//
// An `AudioBufferSourceNode` cannot be re-positioned; it is started once and
// discarded. So seeking (and pausing) tears down every source and builds new
// ones at the new offset. That sounds wasteful and is not: creating a source
// node is cheap, the decoded buffers are reused, and doing it this way is
// what keeps every stem aligned after a seek. Nudging positions individually
// is how sync is lost.
//
// # The chains run live, on the raw stems
//
// Each track's plugins run in their own worklet, inserted between its buffer
// and its fader, so turning a knob is heard immediately — which is the only
// way a plugin is usable at all.
//
// The buffers therefore hold the RAW stem rather than a rendered one. That
// is what makes the bake stable: adding a compressor or dragging a threshold
// changes nothing about the audio on disk, so nothing is re-decoded and
// nothing is re-rendered. Only a new FILE costs anything.
//
// Parity is not lost by moving the chain into the audio thread, because it is
// the same chain: the worklet runs the same Rust `MasteringChain` the offline
// render runs, from the same config. It is one implementation in two hosts,
// not two implementations.
//
// The cost is CPU — one chain instance per track in a 128-sample quantum —
// so the engine reports how many are running and the caller can say so.
//
// # What the preview is, and what it is not
//
// It is the track chains plus the mixer. It is NOT the master bus. The
// master's loudness is solved by measuring the finished file and correcting,
// repeatedly — an approximation of that in realtime would be a different
// algorithm producing a different level, and a preview confidently wrong
// about loudness is worse than one that says it does not cover it.

import {
  createStrip, stripGains, previewFitsInMemory,
  type MixerStrip, type StripSettings,
} from './stem-mixer-graph.js';
import { loadMasteringWorklet, createChainNode } from './mastering-worklet-loader.js';
import type { ChainConfigWire } from './chain-config.js';

export interface PreviewStemInput extends StripSettings {
  id: string;
  /** Temp WAV of the RAW stem, decoded once and reused. */
  previewPath: string;
  channels: 1 | 2;
  samples: number;
  /** This track's plugin chain, applied live. Null runs the stem dry. */
  config: ChainConfigWire | null;
}

export type PreviewState = 'idle' | 'loading' | 'ready' | 'playing';

export interface PreviewStatus {
  state: PreviewState;
  /** Seconds into the session. */
  position: number;
  duration: number;
  /** Bytes the decoded buffers occupy. */
  memoryBytes: number;
  /** Live chains running in the audio thread — the CPU cost of the session. */
  liveChains: number;
  /**
   * Set when the plugin chains could not be loaded into the audio thread.
   *
   * Playback still works; it is the raw stems through the mixer. Saying so
   * matters because the difference is every plugin on every track, and a
   * preview that quietly dropped them would send the user chasing a
   * settings bug that is not there.
   */
  chainsDegraded: string | null;
  error: string | null;
}

/** Fader moves ramp over this, so a drag does not click. */
const RAMP_MS = 25;

/**
 * Owns one AudioContext and the graph hanging off it.
 *
 * Deliberately a class rather than a hook: the graph outlives any component
 * that shows it, and tying its lifetime to a render would tear the audio
 * down every time React decided to remount the mixer.
 */
export class StemPreviewEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private strips = new Map<string, MixerStrip>();
  private sources = new Map<string, AudioBufferSourceNode>();
  private chains = new Map<string, AudioWorkletNode>();
  private wasmModule: WebAssembly.Module | null = null;
  private chainsDegraded: string | null = null;
  private stems: PreviewStemInput[] = [];

  private state: PreviewState = 'idle';
  private error: string | null = null;
  /** Context time at which position 0 would have played. */
  private startedAt = 0;
  /** Where playback sits while paused. */
  private pausedAt = 0;
  private duration = 0;

  private listeners = new Set<(s: PreviewStatus) => void>();

  subscribe(fn: (s: PreviewStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.status());
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    const s = this.status();
    for (const fn of this.listeners) fn(s);
  }

  status(): PreviewStatus {
    return {
      state: this.state,
      position: this.position(),
      duration: this.duration,
      memoryBytes: [...this.buffers.values()]
        .reduce((n, b) => n + b.length * b.numberOfChannels * 4, 0),
      liveChains: this.chains.size,
      chainsDegraded: this.chainsDegraded,
      error: this.error,
    };
  }

  position(): number {
    if (this.state !== 'playing' || !this.ctx) return this.pausedAt;
    const t = this.ctx.currentTime - this.startedAt;
    return Math.max(0, Math.min(this.duration, t));
  }

  /**
   * Decode the session's stems and build the graph.
   *
   * Stems already decoded at the same path are reused, so re-loading after
   * one stem's chain changed costs one decode rather than twelve.
   */
  async load(stems: PreviewStemInput[]): Promise<void> {
    this.error = null;

    const fit = previewFitsInMemory(stems);
    if (!fit.fits) {
      this.error =
        `이 세션은 미리듣기로 담기에 너무 큽니다 — ${(fit.bytes / 1e9).toFixed(2)} GB가 필요하고 한도는 ` +
        `${(fit.limit / 1e9).toFixed(2)} GB입니다. 합산과 익스포트는 그대로 됩니다. ` +
        `일부 스템을 솔로로 두고 들어보세요.`;
      this.state = 'idle';
      this.emit();
      return;
    }

    this.teardownGraph();
    this.state = 'loading';
    this.emit();

    try {
      const ctx = this.ensureContext();
      const wanted = new Set(stems.map((s) => s.previewPath));

      // Drop buffers for stems that left the session or were re-rendered.
      for (const key of [...this.buffers.keys()]) {
        if (!wanted.has(key)) this.buffers.delete(key);
      }

      for (const stem of stems) {
        if (this.buffers.has(stem.previewPath)) continue;
        const res = await fetch(toLocalUrl(stem.previewPath));
        if (!res.ok) throw new Error(`미리듣기 파일을 읽지 못했습니다: ${stem.previewPath}`);
        const bytes = await res.arrayBuffer();
        this.buffers.set(stem.previewPath, await ctx.decodeAudioData(bytes));
      }

      this.stems = stems;
      this.duration = stems.reduce((max, s) => {
        const b = this.buffers.get(s.previewPath);
        return b ? Math.max(max, b.duration) : max;
      }, 0);

      await this.ensureWorklet(ctx);
      this.rebuildStrips();
      this.applyChains();
      this.applyGains(0);
      this.pausedAt = Math.min(this.pausedAt, this.duration);
      this.state = 'ready';
    } catch (err) {
      this.error = (err as Error).message;
      this.state = 'idle';
    }
    this.emit();
  }

  /** Push fader / balance / mute / solo to the graph without interrupting audio. */
  update(stems: PreviewStemInput[]): void {
    // Identity is the strip set; a changed preview path means a re-render
    // and has to go through `load`.
    const sameSet =
      stems.length === this.stems.length &&
      stems.every((s, i) => this.stems[i]?.id === s.id && this.stems[i]?.previewPath === s.previewPath);
    if (!sameSet) return;

    this.stems = stems;
    // Chains first: a plugin change and a fader change arrive through the
    // same call, and the chain is the one that has to be heard immediately.
    this.applyChains();
    this.applyGains(RAMP_MS);
  }

  play(): void {
    if (this.state !== 'ready' || !this.ctx) return;
    const ctx = this.ctx;
    void ctx.resume();

    const offset = this.pausedAt >= this.duration ? 0 : this.pausedAt;
    // A small lead so every source is scheduled before the clock reaches it
    // — starting "now" means the first stem begins while the last is still
    // being created, which is exactly the skew this design exists to avoid.
    const when = ctx.currentTime + 0.05;

    for (const stem of this.stems) {
      const buffer = this.buffers.get(stem.previewPath);
      const strip = this.strips.get(stem.id);
      if (!buffer || !strip) continue;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.chains.get(stem.id) ?? strip.input);
      src.start(when, offset);
      this.sources.set(stem.id, src);
    }

    this.startedAt = when - offset;
    this.state = 'playing';
    this.emit();
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.pausedAt = this.position();
    this.stopSources();
    this.state = 'ready';
    this.emit();
  }

  seek(seconds: number): void {
    const wasPlaying = this.state === 'playing';
    if (wasPlaying) this.stopSources();
    this.pausedAt = Math.max(0, Math.min(this.duration, Number.isFinite(seconds) ? seconds : 0));
    if (wasPlaying) {
      this.state = 'ready';
      this.play();
    } else {
      this.emit();
    }
  }

  /**
   * Stop and return to the start.
   *
   * The graph stays. An earlier version tore down the strips here, which
   * made the stop button a one-way door: `play` looks its strips up by id,
   * found none, and did nothing until the session was loaded again. Stop is
   * a transport control, not a teardown — that is `dispose`.
   */
  stop(): void {
    this.stopSources();
    this.pausedAt = 0;
    if (this.state === 'playing') this.state = 'ready';
    this.emit();
  }

  /** Tear the graph down, keeping the decoded buffers. */
  private teardownGraph(): void {
    this.stopSources();
    for (const chain of this.chains.values()) {
      try { chain.disconnect(); } catch { /* already detached */ }
    }
    this.chains.clear();
    for (const strip of this.strips.values()) strip.disconnect();
    this.strips.clear();
  }

  /** Release everything, including the decoded buffers. */
  dispose(): void {
    this.teardownGraph();
    this.buffers.clear();
    this.stems = [];
    this.duration = 0;
    this.state = 'idle';
    if (this.ctx) { void this.ctx.close(); this.ctx = null; this.master = null; }
    this.emit();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private ensureContext(): AudioContext {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);
    this.ctx = ctx;
    this.master = master;
    return ctx;
  }

  /**
   * Compile and register the chain processor once per context.
   *
   * Failure is not fatal. Without it every track plays dry, which is a
   * worse preview but still a working one — and the status says so rather
   * than leaving the user to wonder why their compressor does nothing.
   */
  private async ensureWorklet(ctx: AudioContext): Promise<void> {
    if (this.wasmModule) return;
    try {
      const loaded = await loadMasteringWorklet(ctx, { sampleRate: ctx.sampleRate });
      this.wasmModule = loaded.wasmModule;
      // The node the loader built is not used — this engine makes one per
      // track — but constructing it is what proves the processor registered.
      loaded.node.disconnect();
      this.chainsDegraded = null;
    } catch (err) {
      this.wasmModule = null;
      this.chainsDegraded =
        `플러그인을 실시간으로 걸지 못했습니다 (${(err as Error).message}). ` +
        '지금 들리는 소리는 플러그인이 빠진 원본입니다 — 믹스다운에는 정상 적용됩니다.';
    }
  }

  private rebuildStrips(): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    for (const strip of this.strips.values()) strip.disconnect();
    this.strips.clear();
    for (const chain of this.chains.values()) {
      try { chain.disconnect(); } catch { /* already detached */ }
    }
    this.chains.clear();

    for (const stem of this.stems) {
      const strip = createStrip(ctx, master, stem.channels);
      this.strips.set(stem.id, strip);

      // The chain sits between the buffer and the fader, so the fader is
      // post-plugin — which is where a channel fader is on every console,
      // and what stops a fader move from changing how hard the compressor
      // on that channel works.
      if (this.wasmModule) {
        try {
          const node = createChainNode(ctx, this.wasmModule, ctx.sampleRate, 2);
          node.connect(strip.input);
          this.chains.set(stem.id, node);
        } catch {
          // One node that will not build should not take the session down;
          // that track simply plays dry.
        }
      }
    }
  }

  /** Push each track's plugin chain into its worklet. */
  private applyChains(): void {
    for (const stem of this.stems) {
      const node = this.chains.get(stem.id);
      if (!node) continue;
      // One message: `configJson` sets bypass from `masterBypass`, so a
      // separate bypass message after it would be undone by the next config,
      // and one before it would be ignored.
      node.port.postMessage({
        type: 'configJson',
        json: JSON.stringify(stem.config ?? {}),
        masterBypass: stem.config === null,
      });
    }
  }

  private applyGains(rampMs: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const gains = stripGains(this.stems);
    this.stems.forEach((stem, i) => {
      const strip = this.strips.get(stem.id);
      const g = gains[i];
      if (strip && g) strip.setGains(g.l, g.r, ctx.currentTime, rampMs);
    });
  }

  private stopSources(): void {
    for (const src of this.sources.values()) {
      try { src.stop(); } catch { /* already ended */ }
      try { src.disconnect(); } catch { /* already detached */ }
    }
    this.sources.clear();
  }
}

/** The renderer reads local files through the app's own protocol. */
function toLocalUrl(p: string): string {
  return `aimaster-local://local/${encodeURIComponent(p.replace(/\\/g, '/'))}`;
}
