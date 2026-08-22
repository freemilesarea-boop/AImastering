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
import { scheduleShiftSec } from '../model/track-delay.js';
import { laneKey, pluginParamKey, pointValueAt } from '../model/automation.js';
import { isLiveAutomation } from './automation-live.js';
import { dbToGain, effectiveFaderDb, isAudible } from '../model/mixer-math.js';
import type {
  AutomationTarget, Clip, DawSession, Fade, Track, TrackId,
} from '../model/types.js';
import type { MidiNote } from '../model/midi.js';
import { getCached, loadAudio, preloadAll } from './audio-cache.js';
import { getSource } from './pcm-store.js';
import {
  createStreamVoice, ensureStreamRuntime, streamRuntimeReady, type StreamVoice,
} from './stream-voice.js';
import { ensureWarpedBufferForSession, prepareWarpsForSession } from './warp-render.js';
import { clipWarp } from '../model/warp.js';
import { clipNotes } from '../model/patterns.js';
import { findCoverage } from '../model/macro-automation.js';
import type { MacroId } from '../model/macros.js';
import { noteSpan, partClock } from '../model/note-time.js';
import { tempoMapOf } from '../model/tempo-map.js';
import { findInstrument } from './instruments.js';
import { makeRng } from '../edit/midi-edit.js';
import type { MixerEngine } from './mixer-engine.js';

const FADE_STEPS = 64;

/**
 * How finely a plugin lane is sampled onto its AudioParam.
 *
 * A host hands a plugin one parameter value per processing block; 20 ms is
 * coarser than most, but each step here is itself a linear RAMP rather than a
 * jump, so what the audio thread walks is a piecewise-linear approximation of
 * the drawn curve — smooth, and with no zipper.  Fine enough that a two-second
 * sweep is a hundred events, cheap enough that a one-second look-ahead window
 * with a dozen lanes is still nothing.
 */
export const AUTOMATION_BLOCK_SEC = 0.02;

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
  /** Where the samples come from: a resident buffer or a stream off disk. */
  source: AudioBufferSourceNode | StreamVoice;
  gain: GainNode;
  clipId: string;
  endsAtCtxTime: number;
}

function isBufferSource(source: Voice['source']): source is AudioBufferSourceNode {
  return 'buffer' in source;
}

/** Stop a voice's source, whichever kind it is. */
function stopSource(source: Voice['source'], at: number): void {
  if (isBufferSource(source)) {
    try { source.stop(at); } catch { /* already stopped */ }
    try { source.disconnect(); } catch { /* already disconnected */ }
  } else {
    source.stop();
  }
}

/** A sounding MIDI note — owned by the instrument that created it. */
interface NoteVoice {
  stop: (at: number) => void;
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
  private noteVoices: NoteVoice[] = [];
  private scheduled = new Set<string>();
  /** Files this pass has already asked the cache for, so it asks once. */
  private requested = new Set<string>();
  private origin = 0;

  /** Context time that timeline zero maps to — what the metronome anchors on. */
  get originSec(): number { return this.origin; }
  private playing = false;
  /**
   * Streaming is for the live transport only.  An offline render runs faster
   * than real time and cannot wait on a reader thread, so a bounce plays from
   * resident buffers — the same samples, delivered without a clock.
   */
  private streaming = false;
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
    // Bring up streaming if this context can have it.  When it can, no source
    // audio needs to be resident at all; when it cannot, fall back to loading
    // the files, which is what every context did before.
    this.streaming = await ensureStreamRuntime(this.engine.ctx);
    if (!this.streaming) await preloadAll(this.engine.ctx, session.files);
    // Warped clips are stretched into buffers up front — doing it inside the
    // scheduler would stall the audio thread's look-ahead.
    const clips = session.tracks.flatMap((t) => trackClips(t));
    prepareWarpsForSession(this.engine.ctx, clips, session);
  }

  /** Turn streaming off for this player — an offline render cannot wait. */
  useResidentBuffers(): void { this.streaming = false; }

  /** Frames the audio thread asked for and did not have this pass. */
  underruns(): number {
    let total = 0;
    for (const v of this.voices) {
      if (!isBufferSource(v.source)) total += v.source.underruns();
    }
    return total;
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
      stopSource(v.source, at);
      try { v.gain.disconnect(); } catch { /* ignore */ }
    }
    for (const v of this.noteVoices) {
      try { v.stop(at); } catch { /* already stopped */ }
    }
    if (this.playing) this.startedAtSec = this.position();
    this.voices = [];
    this.noteVoices = [];
    this.scheduled.clear();
    this.requested.clear();
    this.playing = false;
  }

  /** Schedule every clip (audio) and note (MIDI) inside [fromSec, toSec). */
  scheduleWindow(session: DawSession, fromSec: number, toSec: number): void {
    for (const track of session.tracks) {
      if (track.kind !== 'audio' && track.kind !== 'instrument') continue;
      const channel = this.engine.channel(track.id);
      if (!channel) continue;

      // Track Delay moves this track's events in time — negative plays early,
      // which is why it lives here and not in a delay line.  The window test
      // uses the SHIFTED position: a track pulled 30 ms early has to be
      // scheduled 30 ms before the look-ahead reaches its clip.
      const shift = scheduleShiftSec(track);

      for (const clip of trackClips(track)) {
        if (clip.muted) continue;
        const end = clipEnd(clip) + shift;
        if (end <= fromSec || clip.startSec + shift >= toSec) continue;

        if (clip.kind === 'midi') {
          this.scheduleMidi(session, track, clip, channel.input, fromSec, toSec, shift);
          continue;
        }
        if (this.scheduled.has(clip.id)) continue;
        this.scheduleClip(
          session, clip, channel.input, Math.max(fromSec, clip.startSec + shift), shift);
      }
    }
  }

  /**
   * Schedule the notes of a MIDI part.
   *
   * Notes are placed individually (not as a block) so the look-ahead window
   * works the same as it does for audio, and each one becomes its own voice —
   * which is what lets per-note expression bend a single note.
   */
  private scheduleMidi(
    session: DawSession, track: Track, clip: Clip, destination: AudioNode,
    fromSec: number, toSec: number, shiftSec: number,
  ): void {
    const instrument = findInstrument(track.instrumentId ?? 'polysynth');
    if (!instrument) return;
    const params = { ...track.instrumentParams };
    // Notes live in beats; the clock turns them into the seconds the graph
    // schedules on.  Built once per part, not once per note.
    const clock = partClock(tempoMapOf(session), clip.startSec);

    // Pattern-backed clips carry no notes of their own — resolve the link so
    // every placement of a pattern plays the one copy of the phrase.
    for (const note of clipNotes(session, clip)) {
      if (note.muted) continue;
      const span = noteSpan(clock, note);
      // The clock reads the tempo map at the note's REAL position, and the
      // shift is added afterwards.  Track Delay is a physical offset in
      // milliseconds, not a musical one: it must not change which beat a note
      // was written on, only when that beat reaches the ear.
      const absoluteStart = span.startSec + shiftSec;
      const absoluteEnd = span.endSec + shiftSec;
      // Skip notes that finished before the window and ones not reached yet.
      if (absoluteEnd <= fromSec || absoluteStart >= toSec) continue;
      // A note that is already sounding cannot be started mid-way by a
      // one-shot voice, so it is skipped rather than retriggered late.
      if (absoluteStart < fromSec - 1e-6) continue;

      const key = `${clip.id}:${note.id}`;
      if (this.scheduled.has(key)) continue;
      if (!this.passesProbability(note)) { this.scheduled.add(key); continue; }

      const voice = instrument.playNote({
        ctx: this.engine.ctx,
        destination,
        note,
        config: clip.midiConfig,
        when: this.origin + absoluteStart,
        durationSec: span.durationSec,
        params,
      });
      this.scheduled.add(key);
      this.noteVoices.push({ stop: voice.stop, endsAtCtxTime: this.origin + absoluteEnd + 4 });
    }
  }

  /**
   * Play probability, decided deterministically from the note id so a bounce
   * reproduces exactly the pass you approved.
   */
  private passesProbability(note: MidiNote): boolean {
    if (note.playProbability >= 1) return true;
    if (note.playProbability <= 0) return false;
    let hash = 0;
    for (let i = 0; i < note.id.length; i++) hash = (hash * 31 + note.id.charCodeAt(i)) | 0;
    return makeRng(hash)() < note.playProbability;
  }

  /**
   * Fetch a buffer the scheduler wanted and did not have, without blocking the
   * look-ahead.  One request per file per playback pass — a file that will not
   * decode must not be re-attempted fifty times a second.
   */
  private requestDecode(session: DawSession, fileId: string): void {
    if (this.requested.has(fileId)) return;
    const file = session.files.find((f) => f.id === fileId);
    if (!file) return;
    this.requested.add(fileId);
    void loadAudio(this.engine.ctx, file.id, file.path).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[ClipPlayer] 재생 중 디코딩 실패:', file.path, err);
    });
  }

  /** Schedule the WHOLE session — used by offline bounce. */
  scheduleAll(session: DawSession, fromSec: number, toSec: number): void {
    // A bounce renders faster than real time, so nothing may depend on a
    // reader thread keeping up: an offline pass always plays resident buffers.
    this.streaming = false;
    this.origin = -fromSec;
    this.scheduleWindow(session, fromSec, toSec);
    this.scheduleAutomation(session, fromSec, toSec);
  }

  private scheduleClip(
    session: DawSession, clip: Clip, destination: AudioNode, notBeforeSec: number,
    shiftSec = 0,
  ): void {
    const ctx = this.engine.ctx;

    // Where the clip SOUNDS, which is where it sits plus the track's delay.
    // Everything below reads this instead of `clip.startSec`, so entering a
    // clip mid-way — after a seek, or because a negative delay pushed its
    // head off the front of the timeline — takes the same path and cuts the
    // same amount off the front of the material.
    const soundsAt = clip.startSec + shiftSec;

    // A clip already under way when playback starts is entered mid-way.
    const enterSec  = Math.max(soundsAt, notBeforeSec);
    const skipSec   = enterSec - soundsAt;
    const remaining = clip.durationSec - skipSec;
    if (remaining <= 0.001) return;

    const startAt = this.origin + enterSec;
    const stopAt  = this.origin + soundsAt + clip.durationSec;

    // A warped clip plays its rendered buffer, which already starts at the
    // clip's first sample — so the read offset is the skip alone.  Warping
    // produces the buffer up front, so those clips are never streamed.
    const warped = clipWarp(clip) ? ensureWarpedBufferForSession(ctx, clip, session) : null;

    // Prefer streaming: a track that plays off disk costs a two-second ring
    // instead of its whole length in memory, which is the difference between
    // eight tracks and forty.  Everything below this point is identical for
    // either kind of source.
    const store = warped ? undefined : getSource(clip.fileId);
    const streamed = store && this.streaming && streamRuntimeReady()
      ? createStreamVoice(ctx, store, {
          startAtSec: Math.max(0, startAt),
          offsetFrames: Math.round((clip.offsetSec + skipSec) * store.sampleRate),
          durationFrames: Math.round(remaining * store.sampleRate),
        })
      : null;

    let source: Voice['source'];
    if (streamed) {
      source = streamed;
    } else {
      const cached = getCached(clip.fileId);
      if (!cached) {
        // Returning here silently is how a whole stem goes missing from a
        // take: a clip skipped once stays skipped for good, and the mix plays
        // back without its vocal saying nothing.  Ask for the file instead —
        // the next look-ahead tick enters the clip mid-way at the right
        // offset, exactly as seeking into it would.
        this.requestDecode(session, clip.fileId);
        return;
      }
      const buffered = ctx.createBufferSource();
      buffered.buffer = warped ?? cached.buffer;
      source = buffered;
    }

    const gain = ctx.createGain();
    const base = dbToGain(clip.gainDb);

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

    if (isBufferSource(source)) {
      source.connect(gain).connect(destination);
      const offset = warped ? skipSec : clip.offsetSec + skipSec;
      source.start(Math.max(0, startAt), Math.max(0, offset), remaining);
    } else {
      // The worklet holds its own start frame and length; it emits silence
      // until then, so there is nothing to schedule here.
      source.node.connect(gain).connect(destination);
    }

    this.scheduled.add(clip.id);
    this.voices.push({ source, gain, clipId: clip.id, endsAtCtxTime: stopAt });
  }

  // ── Automation playback ─────────────────────────────────────────────────

  /**
   * What the engine calls the AudioParam behind a target.
   *
   * The same three strings `markAutomated` uses; kept in one function so the
   * flag that is set and the flag that is cleared cannot drift apart.
   */
  private paramNameOf(target: AutomationTarget): string {
    if (target.kind === 'sendLevel') return `send:${target.sendId}`;
    if (target.kind === 'plugin') return pluginParamKey(target.insertId, target.paramId);
    if (target.kind === 'macro') return `macro:${target.macroId}`;
    return target.kind;
  }

  /**
   * Ramp fader, pan, send and plugin parameters through their breakpoints
   * over the window.  Tracks with a live lane are flagged on the engine so
   * `applyParams` stops fighting the ramps.
   */
  scheduleAutomation(session: DawSession, fromSec: number, toSec: number): void {
    for (const track of session.tracks) {
      const channel = this.engine.channel(track.id);
      if (!channel) continue;
      const audible = isAudible(session, track);

      for (const lane of track.automation) {
        if (lane.mode === 'off' || lane.points.length === 0) continue;
        // A lane being recorded is not played: the hand on the control is the
        // authority for this pass, and scheduling the old move underneath it
        // would drag the fader back on every window.
        if (isLiveAutomation(laneKey(track.id, lane.target))) {
          this.engine.clearAutomatedParam(track.id, this.paramNameOf(lane.target));
          continue;
        }

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
        } else if (lane.target.kind === 'plugin') {
          // A plugin parameter is not a fader, but the ones offered as lanes
          // ARE single AudioParams — so they take the same ramp, on the same
          // clock, through the same code.  That is what makes a bounce
          // reproduce the sweep you monitored: an OfflineAudioContext walks a
          // scheduled ramp exactly as the live one does, while anything driven
          // by a timer would be live-only.
          const insert = lane.target.insertId;
          const automatable = this.engine.automatableParam(
            track.id, insert, lane.target.paramId);
          if (!automatable) continue;
          this.engine.markAutomated(
            track.id, pluginParamKey(insert, lane.target.paramId));
          const map = automatable.map;
          this.rampParam(
            automatable.param, lane.points, fromSec, toSec,
            map ? (v) => map(v) : (v) => v, AUTOMATION_BLOCK_SEC);
        } else if (lane.target.kind === 'macro') {
          // One lane, MANY ramps.  A macro is a pure function from its own
          // value to every parameter of the rack, so each parameter it can
          // reach gets its own ramp — sampled from the same lane, mapped
          // through the macro's curve, on the same clock as the fader.  That
          // is what puts the move in the bounce as well as the monitor.
          if (!track.macros.enabled) continue;
          const coverage = findCoverage(track.macros, lane.target.macroId as MacroId);
          if (!coverage || coverage.moving.length === 0) continue;
          this.engine.markAutomated(track.id, `macro:${lane.target.macroId}`);
          for (const moving of coverage.moving) {
            // A knob may move a coupled pair — the compressor's threshold
            // carries its makeup compensation with it — which is legitimate
            // here precisely because one number decides both.
            for (const driven of this.engine.rackParams(track.id, moving.module, moving.param)) {
              const inner = driven.map;
              this.rampParam(
                driven.param, lane.points, fromSec, toSec,
                inner ? (v) => inner(moving.at(v)) : (v) => moving.at(v),
                AUTOMATION_BLOCK_SEC);
            }
          }
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
    subdivideSec = 0,
  ): void {
    const startCtx = this.origin + fromSec;
    // Anchor at the window start so the first ramp has a defined origin.
    const startValue = map(pointValueAt(points, fromSec, points[0]?.value ?? 0));
    param.cancelScheduledValues(Math.max(0, startCtx));
    param.setValueAtTime(startValue, Math.max(0, startCtx));

    if (subdivideSec > 0) {
      // Walk the lane in blocks, reading it in ITS OWN units and mapping each
      // step.  Between two breakpoints on a straight line, `linearRamp` alone
      // is linear in the AudioParam's units — which for a decibel lane means
      // gain, and for a frequency lane means hertz.  A line drawn from 20 kHz
      // to 400 Hz would then spend most of its length up in the treble and
      // fall off a cliff at the end, which is not the shape that was drawn.
      // Sampling the lane instead makes the AudioParam follow the drawing.
      const fallback = points[0]?.value ?? 0;
      let last = startValue;
      // Where the value was last seen to be unchanged.  A flat stretch emits
      // nothing until something moves; then the value is PINNED at the end of
      // the flat stretch first, because `linearRamp` interpolates from the
      // previous event — without the pin, a lane that sits still for a minute
      // and then rises would ramp across the whole minute.
      let flatAt = -1;
      for (let t = fromSec + subdivideSec; t <= toSec + 1e-9; t += subdivideSec) {
        const value = map(pointValueAt(points, t, fallback));
        if (value === last) { flatAt = t; continue; }
        if (flatAt >= 0) {
          param.setValueAtTime(last, Math.max(0, this.origin + flatAt));
          flatAt = -1;
        }
        param.linearRampToValueAtTime(value, Math.max(0, this.origin + t));
        last = value;
      }
      return;
    }

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
        stopSource(v.source, now);
        try { v.gain.disconnect(); } catch { /* ignore */ }
        this.scheduled.delete(v.clipId);
      } else {
        alive.push(v);
      }
    }
    this.voices = alive;

    const aliveNotes: NoteVoice[] = [];
    for (const v of this.noteVoices) {
      if (v.endsAtCtxTime < now) continue;                 // its nodes already stopped
      aliveNotes.push(v);
    }
    this.noteVoices = aliveNotes;
  }
}

/** Total playable length of a track's clips — used for bounce bounds. */
export function trackEndSec(session: DawSession, trackId: TrackId): number {
  const track: Track | undefined = findTrack(session, trackId);
  if (!track) return 0;
  return trackClips(track).reduce((max, c) => Math.max(max, clipEnd(c)), 0);
}
