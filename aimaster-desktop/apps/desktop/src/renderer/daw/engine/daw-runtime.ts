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
import { trackClips } from '../model/session-ops.js';
import { ClipPlayer } from './clip-player.js';
import { getCached, pinFiles, preloadAll } from './audio-cache.js';
import { findInstrument } from './instruments.js';
import { InputCapture, openCapture, scheduleCountIn } from './recorder.js';
import { MidiInputHandle, anchorTimebase, openMidiInputs } from './midi-input.js';
import type { CaptureEvent } from '../model/midi-capture.js';
import type { MidiNote } from '../model/midi.js';
import type { RecordPlan } from '../model/recording.js';

export interface LoopState {
  enabled: boolean;
  startSec: number;
  endSec: number;
}

const TICK_MS = 50;
const LOOKAHEAD_SEC = 1.0;
/** How long a live voice is scheduled for before the key comes up. */
const LIVE_HOLD_SEC = 30;
/** Fallback release when the instrument has no release parameter. */
const LIVE_RELEASE_SEC = 0.12;

interface LiveVoice {
  gate: GainNode;
  voice: { stop: (at: number) => void };
  releaseSec: number;
}

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

  // ── MIDI input ──────────────────────────────────────────────────────────
  private midi: MidiInputHandle | null = null;
  private midiTrackId: TrackId | null = null;
  private midiMonitor = false;
  private midiEvents: CaptureEvent[] = [];
  private midiRecording = false;
  private midiTapeZeroSec = 0;
  /** One live voice per sounding key, so a note-off finds exactly its own. */
  private liveVoices = new Map<string, LiveVoice>();

  /** Every MIDI message that arrives, for the activity light and the pitch. */
  onMidiActivity: ((event: CaptureEvent) => void) | null = null;

  get isReady(): boolean { return this.ctx !== null; }
  get isPlaying(): boolean { return this.player?.isPlaying ?? false; }
  get sampleRate(): number { return this.ctx?.sampleRate ?? 48_000; }
  get mixer(): MixerEngine | null { return this.engine; }
  get context(): AudioContext | null { return this.ctx; }
  get input(): InputCapture | null { return this.capture; }
  get midiInput(): MidiInputHandle | null { return this.midi; }
  get isMidiOpen(): boolean { return this.midi !== null; }

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

  // ── MIDI ────────────────────────────────────────────────────────────────

  /**
   * Open a keyboard for an instrument track.
   *
   * Monitoring is the default and not really optional in practice: a keyboard
   * you cannot hear is a keyboard you cannot play.  It is still a flag, because
   * a player using their hardware synth's own sound wants the DAW silent.
   */
  async openMidiInput(
    session: DawSession, trackId: TrackId | null,
    options: { deviceId?: string | null; monitor?: boolean } = {},
  ): Promise<MidiInputHandle> {
    this.ensure(session.sampleRate);
    this.closeMidiInput();
    this.sync(session);

    const handle = await openMidiInputs(options.deviceId ?? null);
    this.midi = handle;
    this.midiTrackId = trackId;
    this.midiMonitor = options.monitor ?? true;
    // Not recording yet, so a message stamped now belongs at the playhead.
    handle.fallbackSec = () => this.midiTapeZeroSec;
    handle.onMessage((event) => this.receiveMidi(event));
    return handle;
  }

  closeMidiInput(): void {
    this.allNotesOff();
    this.midi?.close();
    this.midi = null;
    this.midiTrackId = null;
    this.midiRecording = false;
    this.midiEvents = [];
  }

  setMidiMonitoring(on: boolean): void {
    this.midiMonitor = on;
    if (!on) this.allNotesOff();
  }

  /** Which track the keyboard plays into.  Changing it silences what is held. */
  setMidiTrack(trackId: TrackId | null): void {
    if (this.midiTrackId === trackId) return;
    this.allNotesOff();
    this.midiTrackId = trackId;
  }

  private receiveMidi(event: CaptureEvent): void {
    if (this.midiRecording) this.midiEvents.push(event);
    if (this.midiMonitor) this.playLive(event);
    this.onMidiActivity?.(event);
  }

  /**
   * Sound one incoming message.
   *
   * The instrument descriptors schedule a whole note — attack, decay, release —
   * from a duration known up front, and a live note has no duration until the
   * key comes up.  So the voice is started with a long hold and routed through
   * a gate of our own; the note-off rides the gate down and then tears the
   * voice out.  Native nodes only, same as everywhere else.
   */
  private playLive(event: CaptureEvent): void {
    const ctx = this.ctx;
    const channel = this.midiTrackId ? this.engine?.channel(this.midiTrackId) : null;
    if (!ctx || !channel) return;

    if (event.kind === 'noteOn') {
      const track = this.session?.tracks.find((t) => t.id === this.midiTrackId);
      const instrument = findInstrument(track?.instrumentId ?? 'polysynth');
      if (!instrument) return;
      const key = `${event.channel}:${event.pitch}`;
      this.releaseLive(key, 0);

      const gate = ctx.createGain();
      gate.gain.value = 1;
      gate.connect(channel.input);
      const params = { ...(track?.instrumentParams ?? {}) };
      const voice = instrument.playNote({
        ctx,
        destination: gate,
        note: createLiveNote(event.pitch, event.velocity),
        config: { bendRangeSemitones: 2, mpe: false },
        when: ctx.currentTime,
        params,
      });
      this.liveVoices.set(key, {
        gate, voice, releaseSec: Math.max(0.03, params['release'] ?? LIVE_RELEASE_SEC),
      });
      return;
    }

    if (event.kind === 'noteOff') {
      this.releaseLive(`${event.channel}:${event.pitch}`, undefined);
      return;
    }

    // 120 = all sound off, 123 = all notes off.  Both are what a controller
    // sends when it is unplugged mid-chord, and ignoring them is how a note
    // gets stuck on forever.
    if (event.kind === 'cc' && (event.controller === 120 || event.controller === 123)) {
      this.allNotesOff();
    }
  }

  private releaseLive(key: string, overrideRelease?: number): void {
    const live = this.liveVoices.get(key);
    if (!live) return;
    this.liveVoices.delete(key);
    const ctx = this.ctx;
    const now = ctx?.currentTime ?? 0;
    const release = overrideRelease ?? live.releaseSec;
    try {
      live.gate.gain.cancelScheduledValues(now);
      live.gate.gain.setValueAtTime(live.gate.gain.value, now);
      live.gate.gain.linearRampToValueAtTime(0, now + release);
    } catch { /* context gone */ }
    try { live.voice.stop(now + release + 0.01); } catch { /* already stopped */ }
    globalThis.setTimeout(() => {
      try { live.gate.disconnect(); } catch { /* already gone */ }
    }, (release + 0.1) * 1000);
  }

  /** Silence everything the keyboard is holding — panic, and every teardown. */
  allNotesOff(): void {
    for (const key of [...this.liveVoices.keys()]) this.releaseLive(key, 0.01);
  }

  /**
   * Roll for a MIDI take.
   *
   * Same plan, same count-in, same transport as an audio take — the only
   * difference is that the tape is a list of events, and its zero is anchored
   * to the context clock here so every message can be placed without reading
   * the clock again.
   */
  async recordMidi(session: DawSession, plan: RecordPlan): Promise<void> {
    if (!this.ensure(session.sampleRate)) return;
    const ctx = this.ctx;
    const handle = this.midi;
    if (!ctx || !handle) throw new Error('MIDI 입력이 열려 있지 않습니다');
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

    // Tape zero is the instant the transport starts, which is what the player
    // is about to be told.  Reading the clock once here and once inside
    // `start` differs by well under a millisecond; re-reading it per message
    // would cost far more.
    const tapeZeroCtx = ctx.currentTime + lead;
    this.midiEvents = [];
    this.midiRecording = true;
    this.midiTapeZeroSec = 0;
    handle.timebase = anchorTimebase(ctx, tapeZeroCtx, 0);
    handle.fallbackSec = () => Math.max(0, ctx.currentTime - tapeZeroCtx);

    this.punchOutAtSec = plan.recordEndSec;
    this.player.start(session, plan.transportStartSec, lead);
    this.startTicking();
  }

  /** Stop the transport and hand back the events, in tape seconds. */
  stopMidiRecording(): { events: CaptureEvent[]; tapeSec: number } | null {
    const handle = this.midi;
    const wasRecording = this.midiRecording;
    const tapeSec = Math.max(0, (this.player?.position() ?? 0));
    this.punchOutAtSec = null;
    this.midiRecording = false;
    this.stop();
    if (handle) {
      handle.timebase = null;
      handle.fallbackSec = () => this.midiTapeZeroSec;
    }
    if (!wasRecording) return null;
    const events = this.midiEvents;
    this.midiEvents = [];
    return { events, tapeSec };
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
    // Every session change passes through here, so this is the one place that
    // always knows what audio is open.  Pinning it means the cache can never
    // evict a stem out from under the scheduler.
    pinFiles(session.files.map((f) => f.id));
    if (!this.engine) return;
    this.engine.sync(session);
  }

  setLoop(loop: LoopState): void { this.loop = loop; }

  /**
   * Decode what the transport needs.
   *
   * Only files an unmuted clip actually plays — a session that has imported
   * ten takes and kept two should not decode the other eight to press play.
   * Anything already decoded is skipped, so on a warm session this returns
   * without doing any work at all.
   */
  async preload(session: DawSession): Promise<void> {
    if (!this.ctx) return;
    await preloadAll(this.ctx, playableFiles(session));
  }

  /**
   * Start playback.
   *
   * The transport does NOT wait for every stem to decode.  It starts with
   * whatever is ready and the look-ahead picks up each remaining stem as it
   * lands — a clip that arrives late is entered mid-way at the right offset,
   * which is what the scheduler already does for a clip you seek into.
   * Waiting instead meant pressing space on an eight-stem session and staring
   * at a still play head for seconds.
   *
   * On a warm session — which is every session that has been open long enough
   * to draw its waveforms — nothing is left to decode and this is immediate.
   */
  async play(session: DawSession, fromSec: number): Promise<void> {
    if (!this.ensure(session.sampleRate)) return;
    this.sync(session);
    await this.ctx?.resume();
    if (!this.player) return;

    this.player.start(session, fromSec);
    this.startTicking();

    // Fill in anything still missing behind the play head.
    void this.preload(session).catch(() => { /* reported per file already */ });
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

  /**
   * Gain reduction an insert is applying right now, in dB, or null when the
   * device cannot say.  Measured by the device itself — a modelled meter would
   * drift from what is actually happening to the audio.
   */
  insertReduction(trackId: TrackId, insertId: string): number | null {
    return this.engine?.reduction(trackId, insertId) ?? null;
  }

  /** A metering insert's current reading, or null when it is not one. */
  insertAnalysis(trackId: TrackId, insertId: string): { lufs: number; peakDb: number } | null {
    return this.engine?.analyse(trackId, insertId) ?? null;
  }

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
    this.closeMidiInput();
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

/** Files an unmuted clip references — what playback actually needs decoded. */
function playableFiles(session: DawSession): Array<{ id: string; path: string }> {
  const needed = new Set<string>();
  for (const track of session.tracks) {
    for (const clip of trackClips(track)) {
      if (clip.kind === 'audio' && !clip.muted) needed.add(clip.fileId);
    }
  }
  return session.files.filter((f) => needed.has(f.id));
}

/** A note for a key that is down and has not come up yet. */
function createLiveNote(pitch: number, velocity: number): MidiNote {
  return {
    id: 'live',
    pitch,
    pitchOffsetSemitones: 0,
    startSec: 0,
    durationSec: LIVE_HOLD_SEC,
    velocity,
    releaseVelocity: 0.5,
    channel: 0,
    muted: false,
    expression: [],
    articulation: null,
    playProbability: 1,
  };
}

export const dawRuntime = new DawRuntime();
