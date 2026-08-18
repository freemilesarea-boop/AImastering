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
// # What the preview is, and what it is not
//
// It is the stem chains plus the mixer: exactly what the export produces up
// to the master bus, because the stems were rendered by the export's own
// code. It is NOT the master bus. The master's loudness is solved by
// measuring the finished file and correcting, twice — an approximation of
// that in realtime would be a different algorithm producing a different
// level, and a preview that is confidently wrong about loudness is worse
// than one that says it does not cover it.

import {
  createStrip, stripGains, previewFitsInMemory,
  type MixerStrip, type StripSettings,
} from './stem-mixer-graph.js';

export interface PreviewStemInput extends StripSettings {
  id: string;
  /** Temp WAV written by the main process, already carrying the chain. */
  previewPath: string;
  channels: 1 | 2;
  samples: number;
}

export type PreviewState = 'idle' | 'loading' | 'ready' | 'playing';

export interface PreviewStatus {
  state: PreviewState;
  /** Seconds into the session. */
  position: number;
  duration: number;
  /** Bytes the decoded buffers occupy. */
  memoryBytes: number;
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

    this.stop();
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

      this.rebuildStrips();
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
      src.connect(strip.input);
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

  stop(): void {
    this.stopSources();
    for (const strip of this.strips.values()) strip.disconnect();
    this.strips.clear();
    this.pausedAt = 0;
    if (this.state === 'playing') this.state = 'ready';
    this.emit();
  }

  /** Release everything, including the decoded buffers. */
  dispose(): void {
    this.stop();
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

  private rebuildStrips(): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    for (const strip of this.strips.values()) strip.disconnect();
    this.strips.clear();
    for (const stem of this.stems) {
      this.strips.set(stem.id, createStrip(ctx, master, stem.channels));
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
