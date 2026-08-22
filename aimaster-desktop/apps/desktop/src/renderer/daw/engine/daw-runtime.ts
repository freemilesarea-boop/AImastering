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
import { Metronome } from './metronome.js';
import { tempoMapOf } from '../model/tempo-map.js';
import { noteSpan, partClock } from '../model/note-time.js';
import {
  MidiInputHandle, anchorTimebase, midiFailureReason, openMidiInputs,
} from './midi-input.js';
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
/** The same ceiling in beats — long enough that no curve ever reaches it. */
const LIVE_HOLD_BEATS = 64;
/** Fallback release when the instrument has no release parameter. */
const LIVE_RELEASE_SEC = 0.12;

/**
 * One pass of the transport, as captured.
 *
 * Both halves come back together because they were recorded together: the
 * microphones and the keyboard rode the same transport from the same tape
 * zero, and committing them as one edit is the only way the takes line up in
 * the undo history as well as on the timeline.
 */
export interface CapturedPass {
  audio: Map<TrackId, { channels: Float32Array[]; sampleRate: number }>;
  /** Null when no instrument track was armed. */
  midi: { events: CaptureEvent[]; trackIds: TrackId[] } | null;
  /** Seconds of transport that actually rolled. */
  tapeSec: number;
}

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
  /** The click.  Not in the mix — see engine/metronome.ts. */
  readonly metronome = new Metronome();
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

  /**
   * Live inputs, one per armed audio track.
   *
   * A band take is several microphones at once, so this is a map rather than a
   * single capture: each armed track opens its OWN `getUserMedia` stream with
   * its own device and channel count, monitors through its own channel strip,
   * and hands back its own tape.  Nothing is shared between them but the
   * transport.
   */
  private captures = new Map<TrackId, InputCapture>();
  /** Tracks whose input is currently routed to their channel input. */
  private monitored = new Set<TrackId>();
  private punchOutAtSec: number | null = null;

  // ── MIDI input ──────────────────────────────────────────────────────────
  private midi: MidiInputHandle | null = null;
  /**
   * Every armed instrument track.
   *
   * One keyboard, several tracks: the same performance sounds through each
   * armed instrument and is committed to each of them.  That is what layering
   * a pad under a piano means, and it is what every DAW does with more than
   * one MIDI track armed.
   */
  private midiTrackIds: TrackId[] = [];
  private midiMonitor = false;
  private midiEvents: CaptureEvent[] = [];
  private midiRecording = false;
  private midiTapeZeroSec = 0;
  /** One live voice per sounding key, so a note-off finds exactly its own. */
  private liveVoices = new Map<string, LiveVoice>();

  /** Every MIDI message that arrives, for the activity light and the pitch. */
  onMidiActivity: ((event: CaptureEvent) => void) | null = null;
  /**
   * Anything else that wants the raw stream — the control surface, MIDI learn.
   *
   * A registry rather than one more callback slot, because these listeners
   * outlive each other: a surface stays mapped while tracks are armed and
   * disarmed underneath it, and learn is a listener that removes itself.
   */
  private midiListeners = new Set<(event: CaptureEvent) => void>();
  /** True while something other than a track wants the port kept open. */
  private midiHeldOpen = false;

  get isReady(): boolean { return this.ctx !== null; }
  get isPlaying(): boolean { return this.player?.isPlaying ?? false; }
  get sampleRate(): number { return this.ctx?.sampleRate ?? 48_000; }
  get mixer(): MixerEngine | null { return this.engine; }
  get context(): AudioContext | null { return this.ctx; }
  /** The capture open for one track, if any. */
  inputFor(trackId: TrackId): InputCapture | null {
    return this.captures.get(trackId) ?? null;
  }
  /** Every track with an audio input open — what `canRecord` checks against. */
  get openInputTracks(): TrackId[] { return [...this.captures.keys()]; }
  get midiInput(): MidiInputHandle | null { return this.midi; }
  get isMidiOpen(): boolean { return this.midi !== null; }

  // ── Input ───────────────────────────────────────────────────────────────

  /**
   * Open (or re-open) the audio input.  Monitoring is a separate decision from
   * capturing: the input is routed into the armed track's channel only when
   * asked, so the player hears themselves through their own inserts.
   */
  async openInput(
    session: DawSession, trackId: TrackId,
    options: { deviceId?: string | null; channels?: 1 | 2; monitor?: boolean } = {},
  ): Promise<InputCapture | null> {
    if (!this.ensure(session.sampleRate)) return null;
    const ctx = this.ctx;
    if (!ctx) return null;
    await ctx.resume();
    // Only THIS track's input is replaced.  Re-opening one track's device in
    // the middle of arming five would otherwise silence the other four.
    this.closeInput(trackId);
    this.sync(session);

    const capture = await openCapture(ctx, {
      deviceId: options.deviceId ?? null,
      channels: options.channels ?? 1,
    });
    this.captures.set(trackId, capture);
    if (options.monitor) this.setMonitoring(trackId, true);
    return capture;
  }

  /** Route (or unroute) one track's live input through its own channel. */
  setMonitoring(trackId: TrackId, on: boolean): void {
    const capture = this.captures.get(trackId);
    if (!capture) return;
    if (this.monitored.has(trackId)) {
      try { capture.monitorNode.disconnect(); } catch { /* not connected */ }
      this.monitored.delete(trackId);
    }
    if (!on) return;
    const channel = this.engine?.channel(trackId);
    if (!channel) return;
    capture.monitorNode.connect(channel.input);
    this.monitored.add(trackId);
  }

  /** Turn monitoring on or off for everything that is open. */
  setAllMonitoring(on: boolean): void {
    for (const trackId of this.captures.keys()) this.setMonitoring(trackId, on);
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
    session: DawSession, trackIds: readonly TrackId[],
    options: { deviceId?: string | null; monitor?: boolean } = {},
  ): Promise<MidiInputHandle> {
    this.ensure(session.sampleRate);
    // A re-open really does replace the port, hold or no hold.
    const held = this.midiHeldOpen;
    this.midiHeldOpen = false;
    this.closeMidiInput();
    this.midiHeldOpen = held;
    this.sync(session);

    const handle = await openMidiInputs(options.deviceId ?? null);
    this.midi = handle;
    this.midiTrackIds = [...trackIds];
    this.midiMonitor = options.monitor ?? true;
    // Not recording yet, so a message stamped now belongs at the playhead.
    handle.fallbackSec = () => this.midiTapeZeroSec;
    handle.onMessage((event) => this.receiveMidi(event));
    return handle;
  }

  /**
   * Close the port — unless something else is holding it open, in which case
   * only the tracks are detached and the surface keeps hearing the desk.
   */
  closeMidiInput(): void {
    this.allNotesOff();
    this.midiTrackIds = [];
    this.midiRecording = false;
    this.midiEvents = [];
    if (this.midiHeldOpen) return;
    this.midi?.close();
    this.midi = null;
  }

  setMidiMonitoring(on: boolean): void {
    this.midiMonitor = on;
    if (!on) this.allNotesOff();
  }

  /** Which tracks the keyboard plays into.  Changing them silences what is held. */
  setMidiTracks(trackIds: readonly TrackId[]): void {
    const same = trackIds.length === this.midiTrackIds.length
      && trackIds.every((id, i) => this.midiTrackIds[i] === id);
    if (same) return;
    this.allNotesOff();
    this.midiTrackIds = [...trackIds];
  }

  /**
   * Listen to every incoming MIDI message.
   *
   * Returns the unsubscribe.  Independent of arming: a control surface has to
   * work with nothing armed at all, which is most of the time.
   */
  addMidiListener(listener: (event: CaptureEvent) => void): () => void {
    this.midiListeners.add(listener);
    return () => this.midiListeners.delete(listener);
  }

  /**
   * Open the MIDI port for something that is not a track, and keep it open.
   *
   * Arming opens the port too, and disarming closes it — which would take the
   * control surface down with it.  `midiHeldOpen` is what stops that: once
   * something is holding the port, `closeMidiInput` only detaches the tracks.
   */
  async holdMidiOpen(session: DawSession, deviceId: string | null): Promise<boolean> {
    this.midiHeldOpen = true;
    if (this.midi) return this.midi.deviceCount > 0;
    try {
      const handle = await this.openMidiInput(session, [], { deviceId, monitor: false });
      this.midiHeldOpen = true;
      return handle.deviceCount > 0;
    } catch {
      this.midiHeldOpen = false;
      throw new Error(midiFailureReason() ?? 'MIDI 입력을 열 수 없습니다');
    }
  }

  /** Names of the inputs currently open — how feedback finds the matching output. */
  midiDeviceNames(): string[] {
    return this.midi?.deviceNames ?? [];
  }

  /** Let go of the port.  It closes unless a track still wants it. */
  releaseMidiHold(): void {
    this.midiHeldOpen = false;
    if (this.midiTrackIds.length === 0) this.closeMidiInput();
  }

  private receiveMidi(event: CaptureEvent): void {
    if (this.midiRecording) this.midiEvents.push(event);
    if (this.midiMonitor) this.playLive(event);
    this.onMidiActivity?.(event);
    for (const listener of this.midiListeners) listener(event);
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
    if (!ctx) return;

    if (event.kind === 'noteOn') {
      // Every armed instrument track sounds it — the voice key carries the
      // track id so each one is released by its own note-off.
      for (const trackId of this.midiTrackIds) {
        const channel = this.engine?.channel(trackId);
        if (!channel) continue;
        const track = this.session?.tracks.find((t) => t.id === trackId);
        const instrument = findInstrument(track?.instrumentId ?? 'polysynth');
        if (!instrument) continue;
        const key = `${trackId}:${event.channel}:${event.pitch}`;
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
          durationSec: LIVE_HOLD_SEC,
          params,
        });
        this.liveVoices.set(key, {
          gate, voice, releaseSec: Math.max(0.03, params['release'] ?? LIVE_RELEASE_SEC),
        });
      }
      return;
    }

    if (event.kind === 'noteOff') {
      for (const trackId of this.midiTrackIds) {
        this.releaseLive(`${trackId}:${event.channel}:${event.pitch}`, undefined);
      }
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

  /** Close one track's input, or every one of them. */
  closeInput(trackId?: TrackId): void {
    const ids = trackId === undefined ? [...this.captures.keys()] : [trackId];
    for (const id of ids) {
      const capture = this.captures.get(id);
      if (!capture) continue;
      this.setMonitoring(id, false);
      capture.close();
      this.captures.delete(id);
    }
    if (this.captures.size === 0) this.punchOutAtSec = null;
  }

  /**
   * Roll for a take.  Count-in clicks play over silence first, then the
   * transport starts at the plan's pre-roll point and capture begins with it —
   * the pre-roll is trimmed after the fact so it can be recovered if wanted.
   */
  async record(session: DawSession, plan: RecordPlan): Promise<void> {
    if (!this.ensure(session.sampleRate)) return;
    const ctx = this.ctx;
    if (!ctx) return;
    const captures = [...this.captures.values()];
    const midi = this.midi;
    if (captures.length === 0 && !midi) throw new Error('입력이 열려 있지 않습니다');
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

    // Every tape starts on the SAME timer callback, so the takes line up with
    // each other as well as with the transport.  Starting them in a loop of
    // separate timers would spread them over several milliseconds.
    this.punchOutAtSec = plan.recordEndSec;
    const tapeZeroCtx = ctx.currentTime + lead;
    globalThis.setTimeout(() => {
      for (const capture of captures) capture.start();
    }, Math.max(0, (lead - 0.02) * 1000));

    // A MIDI track can be armed alongside the microphones; the keyboard rides
    // the same transport and the same tape zero.
    if (midi) {
      this.midiEvents = [];
      this.midiRecording = true;
      this.midiTapeZeroSec = 0;
      midi.timebase = anchorTimebase(ctx, tapeZeroCtx, 0);
      midi.fallbackSec = () => Math.max(0, ctx.currentTime - tapeZeroCtx);
    }

    this.player.start(session, plan.transportStartSec, lead);
    this.startTicking();
  }

  /**
   * Stop the transport and hand back every tape.
   *
   * Tracks whose tape came back empty are simply absent from the map — the
   * caller decides whether that is an error, because "one of six microphones
   * was unplugged" and "nothing recorded at all" are different situations.
   */
  stopRecording(): CapturedPass {
    this.punchOutAtSec = null;
    // Read the tape length BEFORE stopping the transport — afterwards the
    // player reports where it was parked, not how far it ran.
    const tapeSec = Math.max(0, this.player?.position() ?? 0);
    const wasMidiRecording = this.midiRecording;
    this.midiRecording = false;
    this.stop();

    const audio = new Map<TrackId, { channels: Float32Array[]; sampleRate: number }>();
    for (const [trackId, capture] of this.captures) {
      const buffer = capture.stop();
      if (buffer.isEmpty) continue;
      audio.set(trackId, { channels: buffer.toChannels(), sampleRate: buffer.sampleRate });
    }

    const handle = this.midi;
    if (handle) {
      handle.timebase = null;
      handle.fallbackSec = () => this.midiTapeZeroSec;
    }
    const events = wasMidiRecording ? this.midiEvents : null;
    this.midiEvents = [];

    return {
      audio,
      midi: events === null ? null : { events, trackIds: [...this.midiTrackIds] },
      tapeSec,
    };
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
    // Whatever was scheduled ahead is no longer true.
    this.metronome.reset();
    this.player?.stop();
    this.stopTicking();
  }

  /** Move the play head; keeps playing if it was playing. */
  /** Turn the click on or off.  Persisted by the store, not here. */
  setMetronome(on: boolean): void {
    if (this.ctx) this.metronome.attach(this.ctx);
    this.metronome.setEnabled(on);
  }

  get metronomeOn(): boolean { return this.metronome.enabled; }

  seek(session: DawSession, toSec: number): void {
    const wasPlaying = this.isPlaying;
    this.player?.stop();
    // A locate invalidates every click already scheduled into the future.
    this.metronome.reset();
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
      // The click rides the same tick and the same origin as the clips, so a
      // beat and a kick on that beat are scheduled to the same context time.
      this.metronome.tick(tempoMapOf(session), pos, LOOKAHEAD_SEC, player.originSec);
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
      // A Session slot is fired by hand, not placed on the timeline, so its
      // notes are read against the tempo map from the clip's own start.
      const clock = partClock(tempoMapOf(session), clip.startSec);
      for (let pass = 0; pass < passes; pass++) {
        for (const note of clip.notes) {
          if (note.muted) continue;
          const span = noteSpan(clock, note);
          const voice = instrument.playNote({
            ctx,
            destination: channel.input,
            note,
            config: clip.midiConfig,
            when: startAt + pass * clip.durationSec + (span.startSec - clip.startSec),
            durationSec: span.durationSec,
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
    this.midiListeners.clear();
    this.midiHeldOpen = false;
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

/**
 * A note for a key that is down and has not come up yet.
 *
 * A held key has no musical length — it lasts until the finger lifts — so
 * the hold is expressed in seconds at the voice (`durationSec`) and the beat
 * length is only the ceiling that keeps a stuck note from ringing forever.
 */
function createLiveNote(pitch: number, velocity: number): MidiNote {
  return {
    id: 'live',
    pitch,
    pitchOffsetSemitones: 0,
    startBeat: 0,
    durationBeat: LIVE_HOLD_BEATS,
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
