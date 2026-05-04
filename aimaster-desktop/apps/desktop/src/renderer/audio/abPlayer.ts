// A/B comparison player.
//
// Strategy for instant toggling:
//   • Both buffers run through their own AudioBufferSourceNode + GainNode,
//     both started in the same render quantum (sample-accurate sync).
//   • A "toggle" is just a 5 ms linear gain crossfade between the two
//     channels — short enough to feel instantaneous, long enough to
//     avoid audible clicks at the switch.
//   • Both buffers also pass through a per-side trim gain that bakes in
//     the BS.1770-4 loudness-matching offset so the user is comparing
//     QUALITY, not LEVEL.
//
// Loudness matching:
//   • Measure integrated LUFS of A and B via LoudnessAnalyzer.
//   • Reference level = min(LUFS_A, LUFS_B) — we ALWAYS attenuate, never
//     amplify (so we can't push the louder one into clipping).
//   • trimA_dB = ref - LUFS_A   (≤ 0)
//   • trimB_dB = ref - LUFS_B   (≤ 0)

import { LoudnessAnalyzer, AudioBufferLike } from './loudnessCore.js';

export type ABSide = 'A' | 'B';

export interface ABState {
  loaded:        boolean;
  playing:       boolean;
  active:        ABSide;
  positionSec:   number;
  durationSec:   number;
  // Loudness-matching diagnostics
  lufsA:         number;     // integrated LUFS of buffer A (raw)
  lufsB:         number;     // integrated LUFS of buffer B (raw)
  matchedLufs:   number;     // common reference level (min of A, B)
  trimAdb:       number;     // gain applied to A (≤ 0)
  trimBdb:       number;     // gain applied to B (≤ 0)
}

const TOGGLE_FADE_SEC = 0.005;     // 5 ms gain cross-fade

export class ABPlayer {
  private ctx:       AudioContext | null = null;
  private bufA:      AudioBuffer | null = null;
  private bufB:      AudioBuffer | null = null;
  private srcA:      AudioBufferSourceNode | null = null;
  private srcB:      AudioBufferSourceNode | null = null;
  private toggleGainA: GainNode | null = null;
  private toggleGainB: GainNode | null = null;
  private trimA:     GainNode | null = null;
  private trimB:     GainNode | null = null;
  private master:    GainNode | null = null;

  // Playback state
  private active:        ABSide = 'A';
  private playing:       boolean = false;
  private startCtxTime:  number = 0;        // ctx.currentTime at last start
  private startOffset:   number = 0;        // playback offset at last start (sec)

  // Loudness-match diagnostics (also surfaced via getState).
  private lufsA       = -Infinity;
  private lufsB       = -Infinity;
  private matchedLufs = -Infinity;
  private trimAdb     = 0;
  private trimBdb     = 0;

  public onChange: ((s: ABState) => void) | null = null;
  public onEnded:  (() => void) | null = null;

  // ── lifecycle ────────────────────────────────────────────────────────────
  private async ensureContext(): Promise<AudioContext> {
    if (this.ctx) return this.ctx;
    const Ctor = (window as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
              ?? (window as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error('AudioContext not supported');
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    return this.ctx;
  }

  private notify(): void {
    if (this.onChange) this.onChange(this.getState());
  }

  // Convert any AudioBufferLike to a real AudioBuffer in this context.
  private async toRealBuffer(src: AudioBufferLike | AudioBuffer): Promise<AudioBuffer> {
    const ctx = await this.ensureContext();
    if (typeof (src as AudioBuffer).copyFromChannel === 'function' &&
        (src as AudioBuffer).sampleRate === ctx.sampleRate) {
      return src as AudioBuffer;
    }
    const ch = src.numberOfChannels;
    const ch0 = src.getChannelData(0);
    const buf = ctx.createBuffer(ch, ch0.length, src.sampleRate);
    for (let c = 0; c < ch; c++) {
      // copyToChannel wants Float32Array<ArrayBuffer> in current lib.dom.
      // We re-wrap in a fresh Float32Array (which is always ArrayBuffer-backed).
      const view = src.getChannelData(c);
      const fresh = new Float32Array(view.length);
      fresh.set(view);
      buf.copyToChannel(fresh, c);
    }
    return buf;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Load two buffers into the player and prepare for instant A/B switching.
   * Computes BS.1770-4 integrated loudness for each and bakes a level-match
   * offset (attenuates the louder one) so the comparison is fair.
   */
  async setReference(
    bufferA: AudioBufferLike | AudioBuffer,
    bufferB: AudioBufferLike | AudioBuffer,
  ): Promise<void> {
    // Stop anything currently playing.
    if (this.playing) this.pause();

    const ctx = await this.ensureContext();
    this.bufA = await this.toRealBuffer(bufferA);
    this.bufB = await this.toRealBuffer(bufferB);

    // Loudness match (raw I-LUFS, before any trim).
    this.lufsA = measureI(bufferA);
    this.lufsB = measureI(bufferB);
    if (isFinite(this.lufsA) && isFinite(this.lufsB)) {
      this.matchedLufs = Math.min(this.lufsA, this.lufsB);
      this.trimAdb = this.matchedLufs - this.lufsA;
      this.trimBdb = this.matchedLufs - this.lufsB;
    } else if (isFinite(this.lufsA)) {
      this.matchedLufs = this.lufsA; this.trimAdb = 0; this.trimBdb = 0;
    } else if (isFinite(this.lufsB)) {
      this.matchedLufs = this.lufsB; this.trimAdb = 0; this.trimBdb = 0;
    } else {
      this.matchedLufs = -Infinity; this.trimAdb = 0; this.trimBdb = 0;
    }

    // (Re)build the static graph nodes.  Sources are created per-start.
    if (!this.master) this.master = ctx.createGain();
    this.master.gain.value = 1;

    if (!this.trimA) this.trimA = ctx.createGain();
    if (!this.trimB) this.trimB = ctx.createGain();
    this.trimA.gain.value = Math.pow(10, this.trimAdb / 20);
    this.trimB.gain.value = Math.pow(10, this.trimBdb / 20);

    if (!this.toggleGainA) this.toggleGainA = ctx.createGain();
    if (!this.toggleGainB) this.toggleGainB = ctx.createGain();
    this.toggleGainA.gain.value = this.active === 'A' ? 1 : 0;
    this.toggleGainB.gain.value = this.active === 'B' ? 1 : 0;

    // Wire: trim → toggle → master → destination
    this.trimA.disconnect();        this.trimA.connect(this.toggleGainA);
    this.trimB.disconnect();        this.trimB.connect(this.toggleGainB);
    this.toggleGainA.disconnect();  this.toggleGainA.connect(this.master);
    this.toggleGainB.disconnect();  this.toggleGainB.connect(this.master);
    this.master.disconnect();       this.master.connect(ctx.destination);

    this.startOffset = 0;
    this.notify();
  }

  /** Start (or resume) playback from the current position. */
  async play(): Promise<void> {
    if (!this.bufA || !this.bufB) return;
    const ctx = await this.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume();
    if (this.playing) return;

    // Re-create source nodes (they're one-shot per start() in Web Audio).
    this.srcA = ctx.createBufferSource();
    this.srcB = ctx.createBufferSource();
    this.srcA.buffer = this.bufA;
    this.srcB.buffer = this.bufB;
    this.srcA.connect(this.trimA as GainNode);
    this.srcB.connect(this.trimB as GainNode);

    // Sample-accurate sync: schedule both at the same when.
    const when = ctx.currentTime + 0.02;       // 20 ms safety margin
    const offset = Math.max(0, Math.min(this.startOffset, this.bufA.duration - 0.001));
    this.srcA.start(when, offset);
    this.srcB.start(when, offset);
    this.startCtxTime = when;
    this.playing = true;

    // Auto-stop when the (shorter) buffer ends.
    const ended = (): void => {
      if (this.playing) {
        this.playing = false;
        this.startOffset = this.getDurationSec();
        this.notify();
        if (this.onEnded) this.onEnded();
      }
    };
    this.srcA.onended = ended;
    this.notify();
  }

  /** Pause and remember the position. */
  pause(): void {
    if (!this.ctx || !this.playing) return;
    const elapsed = this.ctx.currentTime - this.startCtxTime;
    this.startOffset = Math.max(0, this.startOffset + elapsed);
    try { this.srcA?.stop(); } catch { /* noop */ }
    try { this.srcB?.stop(); } catch { /* noop */ }
    this.srcA = null;
    this.srcB = null;
    this.playing = false;
    this.notify();
  }

  /** Seek to the given offset (seconds).  If playing, restart from there. */
  async seek(sec: number): Promise<void> {
    const wasPlaying = this.playing;
    if (this.playing) this.pause();
    this.startOffset = Math.max(0, sec);
    if (wasPlaying) await this.play();
    else this.notify();
  }

  /** Switch between A and B.  Sample-accurate, click-free. */
  toggleAB(): void {
    this.setActive(this.active === 'A' ? 'B' : 'A');
  }

  /** Force the active side. */
  setActive(side: ABSide): void {
    if (this.active === side) return;
    this.active = side;
    if (!this.ctx || !this.toggleGainA || !this.toggleGainB) {
      this.notify();
      return;
    }
    const t  = this.ctx.currentTime;
    const t1 = t + TOGGLE_FADE_SEC;
    const a  = this.toggleGainA.gain;
    const b  = this.toggleGainB.gain;
    // Anchor the current value, then ramp to the new target.
    a.cancelScheduledValues(t);
    b.cancelScheduledValues(t);
    a.setValueAtTime(a.value, t);
    b.setValueAtTime(b.value, t);
    a.linearRampToValueAtTime(side === 'A' ? 1 : 0, t1);
    b.linearRampToValueAtTime(side === 'B' ? 1 : 0, t1);
    this.notify();
  }

  /** Master output volume (0–1). */
  setMasterGain(linear: number): void {
    if (!this.master || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(Math.max(0, linear), t + 0.01);
  }

  getDurationSec(): number {
    if (!this.bufA || !this.bufB) return 0;
    return Math.min(this.bufA.duration, this.bufB.duration);
  }

  getPositionSec(): number {
    if (!this.playing || !this.ctx) return this.startOffset;
    const elapsed = this.ctx.currentTime - this.startCtxTime;
    return Math.max(0, Math.min(this.getDurationSec(), this.startOffset + elapsed));
  }

  getState(): ABState {
    return {
      loaded:      Boolean(this.bufA && this.bufB),
      playing:     this.playing,
      active:      this.active,
      positionSec: this.getPositionSec(),
      durationSec: this.getDurationSec(),
      lufsA:       this.lufsA,
      lufsB:       this.lufsB,
      matchedLufs: this.matchedLufs,
      trimAdb:     this.trimAdb,
      trimBdb:     this.trimBdb,
    };
  }

  async dispose(): Promise<void> {
    this.pause();
    if (this.ctx) {
      try { await this.ctx.close(); } catch { /* noop */ }
      this.ctx = null;
    }
    this.bufA = this.bufB = null;
    this.master = this.trimA = this.trimB = null;
    this.toggleGainA = this.toggleGainB = null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function measureI(b: AudioBufferLike | AudioBuffer): number {
  const ch = b.numberOfChannels;
  const an = new LoudnessAnalyzer(b.sampleRate, ch);
  const planar: Float32Array[] = new Array(ch);
  for (let c = 0; c < ch; c++) planar[c] = b.getChannelData(c);
  an.processBlock(planar);
  return an.getIntegratedLufs();
}
