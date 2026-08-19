// DawRuntime — the live audio side of the DAW workspace.
//
// Owns the AudioContext, the mixer graph, the clip scheduler and the
// transport loop.  The store drives it; it reports position and meter levels
// back through callbacks so the store never has to poll the graph.
//
// Only ONE AudioContext is created, and only on the first real transport
// gesture — browsers refuse to start one without a user gesture, and a
// suspended context that nobody resumed is the classic "no sound" bug.

import type { Clip, DawSession, TrackId } from '../model/types.js';
import { MixerEngine } from './mixer-engine.js';
import { ClipPlayer } from './clip-player.js';
import { getCached, loadAudio } from './audio-cache.js';
import { findInstrument } from './instruments.js';
import { InputCapture, openCapture, scheduleCountIn } from './recorder.js';
import type { RecordPlan } from '../model/recording.js';

export interface LoopState {
  enabled: boolean;
  startSec: number;
  endSec: number;
}

const TICK_MS = 50;
const LOOKAHEAD_SEC = 1.0;

class DawRuntime {
  private ctx: AudioContext | null = null;
  private engine: MixerEngine | null = null;
  private player: ClipPlayer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private session: DawSession | null = null;
  private loop: LoopState = { enabled: false, startSec: 0, endSec: 0 };

  // ── Session View ────────────────────────────────────────────────────────
  /**
   * The Session clock runs independently of the arrangement transport, so
   * clips can be jammed with the timeline stopped — which is the entire point
   * of a clip launcher.
   */
  private sessionOrigin: number | null = null;
  private sessionBarSec = 2;
  private slotVoices = new Map<TrackId, Array<{ stop: (at: number) => void }>>();

  /** Position updates while the transport runs (seconds). */
  onPosition: ((sec: number) => void) | null = null;
  /** Fired when playback stops on its own (end of session). */
  onStopped: (() => void) | null = null;
  /** Fired when a punch-out ends a recording by itself. */
  onPunchOut: (() => void) | null = null;

  /** Live input, open only while a track is armed. */
  private capture: InputCapture | null = null;
  private monitorTrackId: TrackId | null = null;
  private punchOutAtSec: number | null = null;

  get isReady(): boolean { return this.ctx !== null; }
  get isPlaying(): boolean { return this.player?.isPlaying ?? false; }
  get sampleRate(): number { return this.ctx?.sampleRate ?? 48_000; }
  get mixer(): MixerEngine | null { return this.engine; }
  get context(): AudioContext | null { return this.ctx; }
  get input(): InputCapture | null { return this.capture; }

  // ── Input ───────────────────────────────────────────────────────────────

  /**
   * Open (or re-open) the audio input.  Monitoring is a separate decision from
   * capturing: the input is routed into the armed track's channel only when
   * asked, so the player hears themselves through their own inserts.
   */
  async openInput(
    session: DawSession, trackId: TrackId | null,
    options: { deviceId?: string | null; channels?: 1 | 2; monitor?: boolean } = {},
  ): Promise<InputCapture | null> {
    if (!this.ensure(session.sampleRate)) return null;
    const ctx = this.ctx;
    if (!ctx) return null;
    await ctx.resume();
    this.closeInput();
    this.sync(session);

    const capture = await openCapture(ctx, {
      deviceId: options.deviceId ?? null,
      channels: options.channels ?? 1,
    });
    this.capture = capture;
    if (options.monitor && trackId) this.setMonitoring(trackId, true);
    return capture;
  }

  /** Route (or unroute) the live input through a track's channel. */
  setMonitoring(trackId: TrackId | null, on: boolean): void {
    const capture = this.capture;
    if (!capture) return;
    if (this.monitorTrackId) {
      try { capture.monitorNode.disconnect(); } catch { /* not connected */ }
      this.monitorTrackId = null;
    }
    if (!on || !trackId) return;
    const channel = this.engine?.channel(trackId);
    if (!channel) return;
    capture.monitorNode.connect(channel.input);
    this.monitorTrackId = trackId;
  }

  closeInput(): void {
    if (!this.capture) return;
    this.setMonitoring(null, false);
    this.capture.close();
    this.capture = null;
    this.punchOutAtSec = null;
  }

  /**
   * Roll for a take.  Count-in clicks play over silence first, then the
   * transport starts at the plan's pre-roll point and capture begins with it —
   * the pre-roll is trimmed after the fact so it can be recovered if wanted.
   */
  async record(session: DawSession, plan: RecordPlan): Promise<void> {
    if (!this.ensure(session.sampleRate)) return;
    const ctx = this.ctx;
    const capture = this.capture;
    if (!ctx || !capture) throw new Error('입력이 열려 있지 않습니다');
    await ctx.resume();
    await this.preload(session);
    this.sync(session);
    if (!this.player) return;

    let lead = 0.06;
    if (plan.countInSec > 0) {
      scheduleCountIn(ctx, ctx.destination, {
        tempoBpm: session.tempoBpm,
        beatsPerBar: session.timeSignature[0],
        bars: Math.round(plan.countInSec / (session.timeSignature[0] * (60 / session.tempoBpm))),
        when: ctx.currentTime + lead,
      });
      lead += plan.countInSec;
    }

    // Capture starts with the transport, not with the count-in: the clicks are
    // monitoring, not material.
    this.punchOutAtSec = plan.recordEndSec;
    globalThis.setTimeout(() => capture.start(), Math.max(0, (lead - 0.02) * 1000));
    this.player.start(session, plan.transportStartSec, lead);
    this.startTicking();
  }

  /** Stop the transport and hand back the tape. */
  stopRecording(): { channels: Float32Array[]; sampleRate: number } | null {
    const capture = this.capture;
    this.punchOutAtSec = null;
    this.stop();
    if (!capture) return null;
    const buffer = capture.stop();
    if (buffer.isEmpty) return null;
    return { channels: buffer.toChannels(), sampleRate: buffer.sampleRate };
  }

  /** Create the context on a user gesture, then keep it. */
  ensure(sampleRate = 48_000): boolean {
    if (this.ctx) { void this.ctx.resume(); return true; }
    if (typeof AudioContext === 'undefined') return false;
    try {
      this.ctx = new AudioContext({ sampleRate, latencyHint: 'interactive' });
      this.engine = new MixerEngine(this.ctx, this.ctx.destination, { meters: true });
      this.player = new ClipPlayer(this.engine);
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[DawRuntime] AudioContext 생성 실패:', err);
      this.ctx = null;
      return false;
    }
  }

  /** Push the current session into the graph (structure + parameters). */
  sync(session: DawSession): void {
    this.session = session;
    if (!this.engine) return;
    this.engine.sync(session);
  }

  setLoop(loop: LoopState): void { this.loop = loop; }

  /** Decode every referenced file so the first bar is not silent. */
  async preload(session: DawSession): Promise<void> {
    if (!this.ctx) return;
    const ctx = this.ctx;
    await Promise.all(session.files.map((f) => loadAudio(ctx, f.id, f.path).catch(() => null)));
  }

  async play(session: DawSession, fromSec: number): Promise<void> {
    if (!this.ensure(session.sampleRate)) return;
    await this.ctx?.resume();
    await this.preload(session);
    this.sync(session);
    if (!this.player) return;

    this.player.start(session, fromSec);
    this.startTicking();
  }

  stop(): void {
    this.player?.stop();
    this.stopTicking();
  }

  /** Move the play head; keeps playing if it was playing. */
  seek(session: DawSession, toSec: number): void {
    const wasPlaying = this.isPlaying;
    this.player?.stop();
    if (wasPlaying) {
      this.player?.start(session, Math.max(0, toSec));
      this.startTicking();
    } else {
      this.onPosition?.(Math.max(0, toSec));
    }
  }

  position(): number { return this.player?.position() ?? 0; }

  meterLevels(): Map<TrackId, number> {
    return this.engine?.meterLevels() ?? new Map();
  }

  private startTicking(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const session = this.session;
      const player = this.player;
      if (!session || !player) return;

      const pos = player.position();

      // Punch-out ends the take on its own, sample-late by at most one tick —
      // the extra audio is trimmed against the plan when the take is committed.
      if (this.punchOutAtSec !== null && pos >= this.punchOutAtSec) {
        this.punchOutAtSec = null;
        this.onPunchOut?.();
        return;
      }

      // Loop: wrap at the right locator by re-arming the scheduler there.
      if (this.loop.enabled && this.loop.endSec > this.loop.startSec && pos >= this.loop.endSec) {
        player.stop();
        player.start(session, this.loop.startSec);
        this.onPosition?.(this.loop.startSec);
        return;
      }

      player.tick(session, LOOKAHEAD_SEC);
      this.onPosition?.(pos);

      // Stop at the end of the last clip (plus a tail for effects).
      const end = sessionEnd(session);
      if (end > 0 && pos > end + 2) {
        this.stop();
        this.onStopped?.();
      }
    }, TICK_MS);
  }

  private stopTicking(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // ── Session clip launching ──────────────────────────────────────────────

  /** Start (or restart) the Session clock; bar length comes from the tempo. */
  startSessionClock(barSec: number): void {
    this.sessionBarSec = Math.max(0.05, barSec);
    if (this.sessionOrigin === null && this.ctx) this.sessionOrigin = this.ctx.currentTime;
  }

  /** Musical position of the Session clock, in bars. */
  sessionBar(): number {
    if (!this.ctx || this.sessionOrigin === null) return 0;
    return (this.ctx.currentTime - this.sessionOrigin) / this.sessionBarSec;
  }

  resetSessionClock(): void {
    this.sessionOrigin = this.ctx ? this.ctx.currentTime : null;
  }

  /**
   * Play a Session slot on a track, looping.  Audio clips loop natively;
   * MIDI parts are scheduled a few passes ahead and topped up by the tick.
   */
  startSlot(session: DawSession, trackId: TrackId, clip: Clip, loop: boolean): void {
    if (!this.ensure(session.sampleRate)) return;
    const ctx = this.ctx;
    const channel = this.engine?.channel(trackId);
    if (!ctx || !channel) return;

    this.stopSlot(trackId);
    const voices: Array<{ stop: (at: number) => void }> = [];
    const startAt = ctx.currentTime + 0.03;

    if (clip.kind === 'audio') {
      const cached = getCached(clip.fileId);
      if (!cached) return;
      const source = ctx.createBufferSource();
      source.buffer = cached.buffer;
      source.loop = loop;
      source.loopStart = clip.offsetSec;
      source.loopEnd = clip.offsetSec + clip.durationSec;
      const gain = ctx.createGain();
      gain.gain.value = Math.pow(10, clip.gainDb / 20);
      source.connect(gain).connect(channel.input);
      source.start(startAt, clip.offsetSec, loop ? undefined : clip.durationSec);
      voices.push({
        stop: (at: number) => {
          try { source.stop(at); } catch { /* already stopped */ }
          try { source.disconnect(); gain.disconnect(); } catch { /* ignore */ }
        },
      });
    } else {
      const track = session.tracks.find((t) => t.id === trackId);
      const instrument = findInstrument(track?.instrumentId ?? 'polysynth');
      if (!instrument) return;
      const passes = loop ? 4 : 1;
      for (let pass = 0; pass < passes; pass++) {
        for (const note of clip.notes) {
          if (note.muted) continue;
          const voice = instrument.playNote({
            ctx,
            destination: channel.input,
            note,
            config: clip.midiConfig,
            when: startAt + pass * clip.durationSec + note.startSec,
            params: { ...(track?.instrumentParams ?? {}) },
          });
          voices.push(voice);
        }
      }
    }

    this.slotVoices.set(trackId, voices);
  }

  stopSlot(trackId: TrackId): void {
    const voices = this.slotVoices.get(trackId);
    if (!voices) return;
    const at = this.ctx?.currentTime ?? 0;
    for (const voice of voices) {
      try { voice.stop(at); } catch { /* ignore */ }
    }
    this.slotVoices.delete(trackId);
  }

  stopAllSlots(): void {
    for (const trackId of [...this.slotVoices.keys()]) this.stopSlot(trackId);
  }

  dispose(): void {
    this.stopAllSlots();
    this.stop();
    this.closeInput();
    this.engine?.dispose();
    void this.ctx?.close();
    this.ctx = null;
    this.engine = null;
    this.player = null;
    this.session = null;
  }
}

function sessionEnd(session: DawSession): number {
  let end = 0;
  for (const t of session.tracks) {
    const pl = t.playlists.find((p) => p.id === t.activePlaylistId);
    for (const c of pl?.clips ?? []) end = Math.max(end, c.startSec + c.durationSec);
  }
  return end;
}

export const dawRuntime = new DawRuntime();
