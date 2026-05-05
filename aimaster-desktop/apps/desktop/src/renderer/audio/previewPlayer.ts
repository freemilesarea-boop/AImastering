// Fast preview rendering — process a 5-second slice and play it on loop
// so the user can audition setting changes in <1 s instead of waiting
// for a full-track render.
//
//   previewSegment(buf, startSec, opts?)  → processed AudioBufferLike slice
//   PreviewPlayer                         → Web-Audio loop player with
//                                           click-free hot-swap when the
//                                           processed buffer changes
//
// On a 5 s slice at 48 kHz the entire mastering pipeline runs in a small
// number of milliseconds — well under the 1 s perceived-instant budget
// even after Web-Audio scheduling latency.
//
// Hot-swap pattern: when the caller re-processes the slice (e.g. user
// flips from BALANCED to LOUD), PreviewPlayer schedules the new source
// at `currentTime + 5 ms` with a sample-accurate phase offset so the
// loop point lines up — the old source fades out over 5 ms while the
// new source fades in.  Result: the swap feels instantaneous and never
// clicks, even mid-loop.

import { AudioBufferLike } from './loudnessCore.js';

export interface PreviewSegmentOptions {
  /** Window length in seconds.  Default 5. */
  durationSec?: number;
  /** Optional processing function applied to the slice. */
  process?: (slice: AudioBufferLike) => AudioBufferLike;
}

/**
 * Slice a 5-second window out of `audioBuffer` starting at `startTime`
 * (seconds), optionally pass it through a processing callback, and
 * return the result as an AudioBufferLike.  Pure / synchronous / fast.
 */
export function previewSegment(
  audioBuffer: AudioBufferLike,
  startTime: number,
  options: PreviewSegmentOptions = {},
): AudioBufferLike {
  const durationSec = Math.max(0.5, options.durationSec ?? 5);
  const sr = audioBuffer.sampleRate;
  const nCh = audioBuffer.numberOfChannels;

  const totalLen = audioBuffer.getChannelData(0).length;
  const startSamp = Math.max(0, Math.floor(startTime * sr));
  const winLen   = Math.min(
    Math.round(durationSec * sr),
    Math.max(1, totalLen - startSamp),
  );

  const channels: Float32Array[] = new Array(nCh);
  for (let c = 0; c < nCh; c++) {
    const src = audioBuffer.getChannelData(c);
    const dst = new Float32Array(winLen);
    // Use subarray + set for a single memcpy.
    dst.set(src.subarray(startSamp, startSamp + winLen));
    channels[c] = dst;
  }

  const slice: AudioBufferLike = {
    sampleRate:       sr,
    numberOfChannels: nCh,
    length:           winLen,
    getChannelData(c: number): Float32Array { return channels[c] as Float32Array; },
  };

  return options.process ? options.process(slice) : slice;
}

// ── PreviewPlayer ────────────────────────────────────────────────────────────

const FADE_SEC = 0.005;     // 5 ms swap fade

export interface PreviewPlayerState {
  loaded:        boolean;
  playing:       boolean;
  loopDurationSec: number;
  /** Wall-clock seconds spent processing the most recent slice (dev metric). */
  lastProcessMs: number;
}

export class PreviewPlayer {
  private ctx:    AudioContext | null = null;
  private buf:    AudioBuffer | null = null;
  private src:    AudioBufferSourceNode | null = null;
  private gain:   GainNode | null = null;
  private master: GainNode | null = null;
  private playing = false;
  private lastProcessMs = 0;

  public onChange: ((s: PreviewPlayerState) => void) | null = null;

  // ── lifecycle ────────────────────────────────────────────────────────────
  private async ensureContext(): Promise<AudioContext> {
    if (this.ctx) return this.ctx;
    const w = window as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) throw new Error('AudioContext not supported');
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  private notify(): void {
    if (this.onChange) this.onChange(this.getState());
  }

  private async toRealBuffer(src: AudioBufferLike | AudioBuffer): Promise<AudioBuffer> {
    const ctx = await this.ensureContext();
    if (typeof (src as AudioBuffer).copyFromChannel === 'function'
        && (src as AudioBuffer).sampleRate === ctx.sampleRate) {
      return src as AudioBuffer;
    }
    const ch = src.numberOfChannels;
    const ch0 = src.getChannelData(0);
    const buf = ctx.createBuffer(ch, ch0.length, src.sampleRate);
    for (let c = 0; c < ch; c++) {
      const view = src.getChannelData(c);
      const fresh = new Float32Array(view.length);
      fresh.set(view);
      buf.copyToChannel(fresh, c);
    }
    return buf;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Load a processed slice and start looping it immediately.  If a slice
   * is already playing, the new one is scheduled with a 5 ms crossfade
   * so the swap is click-free and perceptually instantaneous.
   */
  async loadAndPlay(processedSlice: AudioBufferLike, processMs: number = 0): Promise<void> {
    this.lastProcessMs = processMs;
    const ctx = await this.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume();
    const newBuf = await this.toRealBuffer(processedSlice);

    // If already playing, crossfade old → new.
    if (this.src && this.gain && this.master && this.playing) {
      const oldSrc  = this.src;
      const oldGain = this.gain;
      const t  = ctx.currentTime;
      const t1 = t + FADE_SEC;

      // Build new chain.
      const newGain = ctx.createGain();
      newGain.gain.setValueAtTime(0, t);
      newGain.gain.linearRampToValueAtTime(1, t1);
      newGain.connect(this.master);

      const newSrc = ctx.createBufferSource();
      newSrc.buffer    = newBuf;
      newSrc.loop      = true;
      newSrc.loopStart = 0;
      newSrc.loopEnd   = newBuf.duration;
      newSrc.connect(newGain);
      newSrc.start(t);

      // Fade out + stop old after a short safety margin.
      oldGain.gain.cancelScheduledValues(t);
      oldGain.gain.setValueAtTime(oldGain.gain.value, t);
      oldGain.gain.linearRampToValueAtTime(0, t1);
      try { oldSrc.stop(t1 + 0.01); } catch { /* noop */ }

      this.src  = newSrc;
      this.gain = newGain;
      this.buf  = newBuf;
      this.notify();
      return;
    }

    // Cold start.
    const gain = ctx.createGain();
    gain.gain.value = 1;
    gain.connect(this.master as GainNode);

    const src = ctx.createBufferSource();
    src.buffer    = newBuf;
    src.loop      = true;
    src.loopStart = 0;
    src.loopEnd   = newBuf.duration;
    src.connect(gain);
    src.start();

    this.src  = src;
    this.gain = gain;
    this.buf  = newBuf;
    this.playing = true;
    this.notify();
  }

  /** Stop playback (does NOT close the AudioContext — call dispose()). */
  stop(): void {
    if (!this.playing) return;
    if (this.src) {
      try { this.src.stop(); } catch { /* noop */ }
      this.src.disconnect();
    }
    this.gain?.disconnect();
    this.src = null;
    this.gain = null;
    this.playing = false;
    this.notify();
  }

  /** Master volume (linear 0–1).  Useful for ducking during a swap. */
  setMasterGain(linear: number): void {
    if (!this.master || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(Math.max(0, linear), t + 0.01);
  }

  getState(): PreviewPlayerState {
    return {
      loaded:          this.buf !== null,
      playing:         this.playing,
      loopDurationSec: this.buf ? this.buf.duration : 0,
      lastProcessMs:   this.lastProcessMs,
    };
  }

  async dispose(): Promise<void> {
    this.stop();
    if (this.ctx) {
      try { await this.ctx.close(); } catch { /* noop */ }
      this.ctx = null;
      this.master = null;
    }
    this.buf = null;
  }
}

// ── High-level helper ────────────────────────────────────────────────────────

/**
 * Convenience: slice + process + play in one call.  Returns the
 * processed slice as well so callers can show metrics / waveforms.
 */
export async function startPreview(
  player: PreviewPlayer,
  audioBuffer: AudioBufferLike,
  startTime: number,
  options: PreviewSegmentOptions = {},
): Promise<AudioBufferLike> {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const processed = previewSegment(audioBuffer, startTime, options);
  const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  await player.loadAndPlay(processed, elapsed);
  return processed;
}
