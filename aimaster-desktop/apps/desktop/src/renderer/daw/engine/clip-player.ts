// ClipPlayer — schedules clips and automation onto the mixer graph.
//
// Timeline time `t` maps to context time `origin + t`.  Everything is
// scheduled against that mapping with AudioParam automation, so playback is
// sample-accurate and identical under an OfflineAudioContext (where the whole
// session is scheduled in one pass instead of in look-ahead windows).
//
// Clip gain and fades live on a per-voice GainNode: base gain from the clip's
// gainDb, fade curves ramped at the clip edges.  That is exactly the
// pre-fader, pre-insert position clip gain occupies in Pro Tools.

import { clipEnd, findTrack, trackClips } from '../model/session-ops.js';
import { pointValueAt } from '../model/automation.js';
import { dbToGain, effectiveFaderDb, isAudible } from '../model/mixer-math.js';
import type { Clip, DawSession, Fade, Track, TrackId } from '../model/types.js';
import { getCached, loadAudio } from './audio-cache.js';
import type { MixerEngine } from './mixer-engine.js';

const FADE_STEPS = 64;

/** Fade curve samples for a shape, from 0 → 1. */
export function fadeCurve(shape: Fade['shape'], steps = FADE_STEPS): Float32Array {
  const curve = new Float32Array(steps);
  for (let i = 0; i < steps; i++) {
    const x = i / (steps - 1);
    curve[i] = shape === 'linear' ? x
      : shape === 'equalPower' ? Math.sin((x * Math.PI) / 2)
      : x * x * (3 - 2 * x);                     // sCurve — smoothstep
  }
  return curve;
}

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  clipId: string;
  endsAtCtxTime: number;
}

export interface PlayerState {
  playing: boolean;
  /** Timeline position in seconds. */
  positionSec: number;
}

export class ClipPlayer {
  private engine: MixerEngine;
  private voices: Voice[] = [];
  private scheduled = new Set<string>();
  private origin = 0;
  private playing = false;
  private startedAtSec = 0;

  constructor(engine: MixerEngine) {
    this.engine = engine;
  }

  get isPlaying(): boolean { return this.playing; }

  /** Timeline position right now. */
  position(): number {
    if (!this.playing) return this.startedAtSec;
    return this.engine.ctx.currentTime - this.origin;
  }

  /** Decode every file the session references (before playback or a bounce). */
  async prepare(session: DawSession): Promise<void> {
    await Promise.all(session.files.map((f) =>
      loadAudio(this.engine.ctx, f.id, f.path).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[ClipPlayer] decode failed:', f.path, err);
        return null;
      })));
  }

  /**
   * Start playback at `fromSec`.  `leadSec` gives the scheduler a moment of
   * head-room so the first clip is not late.
   */
  start(session: DawSession, fromSec: number, leadSec = 0.06): void {
    this.stop();
    this.origin = this.engine.ctx.currentTime + leadSec - fromSec;
    this.playing = true;
    this.startedAtSec = fromSec;
    this.scheduleWindow(session, fromSec, fromSec + 1.0);
    this.scheduleAutomation(session, fromSec, fromSec + 1.0);
  }

  /** Look-ahead tick — call every ~50 ms while playing. */
  tick(session: DawSession, lookaheadSec = 1.0): void {
    if (!this.playing) return;
    const now = this.position();
    this.scheduleWindow(session, now, now + lookaheadSec);
    this.scheduleAutomation(session, now, now + lookaheadSec);
    this.reapVoices();
  }

  stop(): void {
    const at = this.engine.ctx.currentTime;
    for (const v of this.voices) {
      try { v.source.stop(at); } catch { /* already stopped */ }
      try { v.source.disconnect(); v.gain.disconnect(); } catch { /* ignore */ }
    }
    if (this.playing) this.startedAtSec = this.position();
    this.voices = [];
    this.scheduled.clear();
    this.playing = false;
  }

  /** Schedule every clip that begins inside [fromSec, toSec). */
  scheduleWindow(session: DawSession, fromSec: number, toSec: number): void {
    for (const track of session.tracks) {
      if (track.kind !== 'audio') continue;
      const channel = this.engine.channel(track.id);
      if (!channel) continue;
      for (const clip of trackClips(track)) {
        if (clip.muted) continue;
        const end = clipEnd(clip);
        if (end <= fromSec || clip.startSec >= toSec) continue;
        if (this.scheduled.has(clip.id)) continue;
        this.scheduleClip(session, clip, channel.input, Math.max(fromSec, clip.startSec));
      }
    }
  }

  /** Schedule the WHOLE session — used by offline bounce. */
  scheduleAll(session: DawSession, fromSec: number, toSec: number): void {
    this.origin = -fromSec;
    this.scheduleWindow(session, fromSec, toSec);
    this.scheduleAutomation(session, fromSec, toSec);
  }

  private scheduleClip(
    session: DawSession, clip: Clip, destination: AudioNode, notBeforeSec: number,
  ): void {
    const cached = getCached(clip.fileId);
    if (!cached) return;                       // not decoded yet — next tick
    const ctx = this.engine.ctx;

    // A clip already under way when playback starts is entered mid-way.
    const enterSec  = Math.max(clip.startSec, notBeforeSec);
    const skipSec   = enterSec - clip.startSec;
    const remaining = clip.durationSec - skipSec;
    if (remaining <= 0.001) return;

    const source = ctx.createBufferSource();
    source.buffer = cached.buffer;
    const gain = ctx.createGain();
    const base = dbToGain(clip.gainDb);

    const startAt = this.origin + enterSec;
    const stopAt  = this.origin + clip.startSec + clip.durationSec;

    gain.gain.cancelScheduledValues(0);
    gain.gain.setValueAtTime(base, Math.max(0, startAt));

    // Fade in — skipped when we entered the clip past its fade.
    const fadeIn = clip.fadeIn.durationSec;
    if (fadeIn > 0 && skipSec < fadeIn) {
      const remainingFade = fadeIn - skipSec;
      const curve = fadeCurve(clip.fadeIn.shape);
      const scaled = new Float32Array(curve.length);
      // Continue the curve from where we entered it.
      const enterRatio = skipSec / fadeIn;
      for (let i = 0; i < curve.length; i++) {
        const x = enterRatio + (1 - enterRatio) * (i / (curve.length - 1));
        const idx = Math.min(curve.length - 1, Math.round(x * (curve.length - 1)));
        scaled[i] = (curve[idx] ?? 1) * base;
      }
      gain.gain.setValueCurveAtTime(scaled, Math.max(0, startAt), remainingFade);
    }

    // Fade out.
    const fadeOut = clip.fadeOut.durationSec;
    if (fadeOut > 0) {
      const curve = fadeCurve(clip.fadeOut.shape);
      const reversed = new Float32Array(curve.length);
      for (let i = 0; i < curve.length; i++) {
        reversed[i] = (curve[curve.length - 1 - i] ?? 0) * base;
      }
      const fadeStart = Math.max(startAt, stopAt - fadeOut);
      gain.gain.setValueCurveAtTime(reversed, fadeStart, Math.min(fadeOut, stopAt - fadeStart));
    }

    source.connect(gain).connect(destination);
    const offset = clip.offsetSec + skipSec;
    source.start(Math.max(0, startAt), Math.max(0, offset), remaining);

    this.scheduled.add(clip.id);
    this.voices.push({ source, gain, clipId: clip.id, endsAtCtxTime: stopAt });
    void session;
  }

  // ── Automation playback ─────────────────────────────────────────────────

  /**
   * Ramp fader / pan / send params through their breakpoints over the
   * window.  Tracks with a live lane are flagged on the engine so
   * `applyParams` stops fighting the ramps.
   */
  scheduleAutomation(session: DawSession, fromSec: number, toSec: number): void {
    for (const track of session.tracks) {
      const channel = this.engine.channel(track.id);
      if (!channel) continue;
      const audible = isAudible(session, track);

      for (const lane of track.automation) {
        if (lane.mode === 'off' || lane.points.length === 0) continue;

        if (lane.target.kind === 'volume') {
          this.engine.markAutomated(track.id, 'volume');
          this.rampParam(channel.fader.gain, lane.points, fromSec, toSec, (db) =>
            (audible ? dbToGain(db + effectiveFaderDb(session, track) - track.volumeDb) : 0));
        } else if (lane.target.kind === 'pan') {
          this.engine.markAutomated(track.id, 'pan');
          this.rampParam(channel.panner.pan, lane.points, fromSec, toSec,
            (v) => Math.max(-1, Math.min(1, v)));
        } else if (lane.target.kind === 'sendLevel') {
          const node = channel.sends.get(lane.target.sendId);
          if (!node) continue;
          this.engine.markAutomated(track.id, `send:${lane.target.sendId}`);
          this.rampParam(node.gain, lane.points, fromSec, toSec, (db) => dbToGain(db));
        }
      }
    }
  }

  private rampParam(
    param: AudioParam,
    points: readonly { timeSec: number; value: number }[],
    fromSec: number,
    toSec: number,
    map: (value: number) => number,
  ): void {
    const startCtx = this.origin + fromSec;
    // Anchor at the window start so the first ramp has a defined origin.
    const startValue = map(pointValueAt(points, fromSec, points[0]?.value ?? 0));
    param.cancelScheduledValues(Math.max(0, startCtx));
    param.setValueAtTime(startValue, Math.max(0, startCtx));
    for (const p of points) {
      if (p.timeSec <= fromSec || p.timeSec > toSec) continue;
      param.linearRampToValueAtTime(map(p.value), Math.max(0, this.origin + p.timeSec));
    }
  }

  private reapVoices(): void {
    const now = this.engine.ctx.currentTime;
    const alive: Voice[] = [];
    for (const v of this.voices) {
      if (v.endsAtCtxTime < now - 0.2) {
        try { v.source.disconnect(); v.gain.disconnect(); } catch { /* ignore */ }
        this.scheduled.delete(v.clipId);
      } else {
        alive.push(v);
      }
    }
    this.voices = alive;
  }
}

/** Total playable length of a track's clips — used for bounce bounds. */
export function trackEndSec(session: DawSession, trackId: TrackId): number {
  const track: Track | undefined = findTrack(session, trackId);
  if (!track) return 0;
  return trackClips(track).reduce((max, c) => Math.max(max, clipEnd(c)), 0);
}
