// MIDI capture — a stream of bytes becomes notes.
//
// Everything here is pure.  Opening a keyboard needs Web MIDI
// (daw/engine/midi-input.ts); this module decides what the stream MEANS, and
// that is where all the awkward cases live:
//
//   A NOTE IS A PAIR, NOT AN EVENT.  Note-on and note-off arrive separately and
//   can be seconds apart.  Until the off arrives the note has no length, so a
//   capture that is stopped mid-note has to close it rather than drop it —
//   dropping it is how DAWs lose the last chord of a take.
//
//   THE SAME KEY CAN BE DOWN TWICE.  Trills, sticky keys, and two controllers
//   on one channel all produce on-on-off-off.  Pairing FIFO (oldest on gets the
//   first off) keeps the total count right; pairing by pitch alone silently
//   merges them into one long note.
//
//   THE PEDAL IS PART OF THE NOTE.  Sustain (CC64) is not a controller anybody
//   wants drawn on a lane — it is length.  A note released under the pedal ends
//   when the pedal lifts, which is the only reading that plays back the way it
//   was performed.
//
//   BEND BELONGS TO WHAT IS SOUNDING.  A wheel move is a channel message: on an
//   MPE controller that channel holds one note, on an ordinary keyboard it holds
//   the whole chord.  Both cases are the same rule — the curve goes onto every
//   note sounding on that channel — and both play back, because the instruments
//   read per-note expression.
//
// What is NOT captured is stated rather than silently dropped: `ignoredCc`
// lists every controller number that arrived and had nowhere to go, so the UI
// can say "your mod wheel was not recorded" instead of leaving the player to
// discover it.

import {
  bendFrom14bit, createNote, from7bit, sortNotes,
  type Bipolar, type ExpressionPoint, type ExpressionTarget, type MidiNote, type Unipolar,
} from './midi.js';
import { secToBeatsAt, type PartClock } from './note-time.js';

// ── Messages ──────────────────────────────────────────────────────────────────

/** A parsed channel-voice message, stamped on the transport's own clock. */
export type CaptureEvent =
  | { kind: 'noteOn';          timeSec: number; channel: number; pitch: number; velocity: Unipolar }
  | { kind: 'noteOff';         timeSec: number; channel: number; pitch: number; velocity: Unipolar }
  | { kind: 'cc';              timeSec: number; channel: number; controller: number; value: Unipolar }
  | { kind: 'pitchBend';       timeSec: number; channel: number; value: Bipolar }
  | { kind: 'channelPressure'; timeSec: number; channel: number; value: Unipolar }
  | { kind: 'polyPressure';    timeSec: number; channel: number; pitch: number; value: Unipolar };

/** Sustain pedal.  Recorded as note length, never as a curve. */
export const SUSTAIN_CC = 64;
/** MPE's "Y axis" — the one continuous controller the instruments read. */
export const TIMBRE_CC = 74;
/** Half-pedalling is a piano thing; a switch pedal sends 0 or 127. */
export const PEDAL_DOWN_THRESHOLD = 0.5;

/**
 * One Web MIDI packet → one event.
 *
 * Returns null for everything that is not a channel-voice message: clock,
 * active sensing, sysex, and the transport bytes a keyboard sprays between
 * notes.  Running status does not appear here — Web MIDI delivers whole
 * messages — so a short packet is a malformed one and is dropped.
 */
export function parseMidiMessage(
  data: ArrayLike<number>, timeSec: number,
): CaptureEvent | null {
  const status = data[0] ?? 0;
  if (status < 0x80 || status >= 0xf0) return null;   // system / realtime / malformed
  if (data.length < 2) return null;
  const kind = status & 0xf0;
  const channel = status & 0x0f;
  const a = data[1] ?? 0;
  const b = data[2] ?? 0;

  switch (kind) {
    case 0x90:
      // Note-on at velocity 0 is a note-off.  Every keyboard made since the
      // eighties uses it, so treating it as an on leaves notes hanging forever.
      return b === 0
        ? { kind: 'noteOff', timeSec, channel, pitch: a, velocity: from7bit(64) }
        : { kind: 'noteOn', timeSec, channel, pitch: a, velocity: from7bit(b) };
    case 0x80:
      return { kind: 'noteOff', timeSec, channel, pitch: a, velocity: from7bit(b || 64) };
    case 0xa0:
      return { kind: 'polyPressure', timeSec, channel, pitch: a, value: from7bit(b) };
    case 0xb0:
      return { kind: 'cc', timeSec, channel, controller: a, value: from7bit(b) };
    case 0xd0:
      return { kind: 'channelPressure', timeSec, channel, value: from7bit(a) };
    case 0xe0:
      return { kind: 'pitchBend', timeSec, channel, value: bendFrom14bit(a + b * 128) };
    default:
      return null;                                    // 0xc0 program change
  }
}

/** True when this message would make a key sound — for the activity light. */
export function isNoteMessage(event: CaptureEvent): boolean {
  return event.kind === 'noteOn' || event.kind === 'noteOff';
}

// ── Capture ───────────────────────────────────────────────────────────────────

export interface CaptureOptions {
  /** Transport time the take ends.  Notes still held are closed here. */
  endSec: number;
  /**
   * The transport's own frame (a clock built at 0 s).
   *
   * The player's hands are in seconds and the notes they produce are in
   * beats, so the take crosses over exactly here — once, at the edge.
   */
  clock: PartClock;
  /** Honour CC64.  Off for controllers that send it as an ordinary lane. */
  sustainPedal?: boolean;
  /** Keep continuous controllers as per-note curves. */
  expression?: boolean;
  /** Notes shorter than this are performance noise, not notes. */
  minDurationSec?: number;
}

export interface CaptureResult {
  notes: MidiNote[];
  /** Controllers that arrived and were not recorded, lowest first. */
  ignoredCc: number[];
  /** Notes closed by the end of the take rather than by a note-off. */
  heldAtEnd: number;
  /** Notes dropped for being shorter than `minDurationSec`. */
  tooShort: number;
}

/** A key press that has not been released yet. */
interface Held {
  pitch: number;
  channel: number;
  startSec: number;
  velocity: Unipolar;
  /** Set when the key came up under the pedal — the note ends at pedal-up. */
  releasedAtSec: number | null;
  releaseVelocity: Unipolar;
  curves: Map<string, { target: ExpressionTarget; points: ExpressionPoint[] }>;
}

export const MIN_NOTE_SEC = 0.012;

/**
 * Turn a take's events into notes.
 *
 * The caller stamps events on the transport clock in seconds; the notes come
 * back in transport BEATS through `options.clock`.  Making them part-local is
 * the commit's job, because only the commit knows where the part starts.
 */
export function captureNotes(
  events: readonly CaptureEvent[], options: CaptureOptions,
): CaptureResult {
  const endSec = options.endSec;
  const sustainPedal = options.sustainPedal ?? true;
  const expression = options.expression ?? true;
  const minDuration = options.minDurationSec ?? MIN_NOTE_SEC;

  // Events are stamped in TAPE seconds — from where the transport started
  // rolling, not from the top of the session — so they are measured from the
  // clock's own origin.  Reading them as timeline seconds would put every
  // note of a take that began at 0:08 eight seconds early.
  const toBeat = (tapeSec: number): number => secToBeatsAt(options.clock, tapeSec);

  const ordered = [...events].sort((a, b) => a.timeSec - b.timeSec);

  /** Keys down, oldest first, per channel:pitch. */
  const held = new Map<string, Held[]>();
  /** Keys released under the pedal, waiting for it to lift, per channel. */
  const pedalled = new Map<number, Held[]>();
  const pedalDown = new Set<number>();
  const ignored = new Set<number>();
  const notes: MidiNote[] = [];
  let heldAtEnd = 0;
  let tooShort = 0;

  const key = (channel: number, pitch: number): string => `${channel}:${pitch}`;

  const finish = (note: Held, atSec: number, closedByEnd: boolean): void => {
    const duration = Math.max(0, Math.min(atSec, endSec) - note.startSec);
    if (duration < minDuration) { tooShort += 1; return; }
    if (closedByEnd) heldAtEnd += 1;
    const startBeat = toBeat(note.startSec);
    notes.push(createNote({
      pitch: note.pitch,
      channel: note.channel,
      startBeat,
      durationBeat: Math.max(0, toBeat(note.startSec + duration) - startBeat),
      velocity: note.velocity,
      releaseVelocity: note.releaseVelocity,
      expression: [...note.curves.values()]
        .filter((c) => c.points.length > 0)
        .map((c) => ({ target: c.target, points: c.points })),
    }));
  };

  /** Add a controller point to everything currently sounding on a channel. */
  const addPoint = (channel: number, target: ExpressionTarget, timeSec: number, value: number): void => {
    if (!expression) return;
    const id = target.kind === 'cc' ? `cc:${target.controller}` : target.kind;
    const touch = (note: Held): void => {
      const curve = note.curves.get(id) ?? { target, points: [] as ExpressionPoint[] };
      const relative = Math.max(0, toBeat(timeSec) - toBeat(note.startSec));
      // The instruments read curves in the note's own time frame, and a curve
      // that starts after the note has begun would jump from the default; the
      // first point is therefore anchored at the note start.
      if (curve.points.length === 0 && relative > 1e-6) {
        curve.points.push({ timeBeat: 0, value: neutralFor(target) });
      }
      curve.points.push({ timeBeat: relative, value });
      note.curves.set(id, curve);
    };
    for (const list of held.values()) {
      for (const note of list) if (note.channel === channel) touch(note);
    }
    // A note the pedal is holding is still sounding, so the wheel still reaches it.
    for (const note of pedalled.get(channel) ?? []) touch(note);
  };

  for (const event of ordered) {
    if (event.timeSec > endSec + 1e-9) break;

    switch (event.kind) {
      case 'noteOn': {
        const list = held.get(key(event.channel, event.pitch)) ?? [];
        list.push({
          pitch: event.pitch,
          channel: event.channel,
          startSec: event.timeSec,
          velocity: event.velocity,
          releasedAtSec: null,
          releaseVelocity: from7bit(64),
          curves: new Map(),
        });
        held.set(key(event.channel, event.pitch), list);
        break;
      }

      case 'noteOff': {
        const k = key(event.channel, event.pitch);
        const list = held.get(k);
        // FIFO: the oldest press is the one this release belongs to.
        const note = list?.shift();
        if (!note) break;
        if (list && list.length === 0) held.delete(k);
        note.releaseVelocity = event.velocity;
        if (sustainPedal && pedalDown.has(event.channel)) {
          // Still sounding — the pedal holds it.  Moving it out of `held`
          // means a re-press of the same key starts a NEW note instead of
          // being paired with this one's release; `pedalled` keeps it
          // reachable by the wheel until the pedal lifts.
          note.releasedAtSec = event.timeSec;
          const waiting = pedalled.get(event.channel) ?? [];
          waiting.push(note);
          pedalled.set(event.channel, waiting);
        } else {
          finish(note, event.timeSec, false);
        }
        break;
      }

      case 'cc': {
        if (event.controller === SUSTAIN_CC && sustainPedal) {
          if (event.value >= PEDAL_DOWN_THRESHOLD) {
            pedalDown.add(event.channel);
          } else {
            pedalDown.delete(event.channel);
            for (const note of pedalled.get(event.channel) ?? []) finish(note, event.timeSec, false);
            pedalled.delete(event.channel);
          }
          break;
        }
        if (event.controller === TIMBRE_CC) {
          addPoint(event.channel, { kind: 'timbre' }, event.timeSec, event.value);
        } else {
          // Nothing plays it back, so nothing pretends to record it.
          ignored.add(event.controller);
        }
        break;
      }

      case 'pitchBend':
        addPoint(event.channel, { kind: 'pitchBend' }, event.timeSec, event.value);
        break;

      case 'channelPressure':
        addPoint(event.channel, { kind: 'pressure' }, event.timeSec, event.value);
        break;

      case 'polyPressure':
        addPoint(event.channel, { kind: 'pressure' }, event.timeSec, event.value);
        break;
    }
  }

  // The take ended with keys still down (or the pedal still down).  Both close
  // at the end rather than vanishing.
  for (const list of held.values()) {
    for (const note of list) finish(note, endSec, true);
  }
  for (const list of pedalled.values()) {
    for (const note of list) finish(note, endSec, true);
  }

  return {
    notes: sortNotes(notes),
    ignoredCc: [...ignored].sort((a, b) => a - b),
    heldAtEnd,
    tooShort,
  };
}

/**
 * Where a curve sits before anything has moved it.
 *
 * These match the fallbacks the instruments use when a note has no curve at
 * all, so a note whose wheel move starts halfway through begins from the same
 * place a note with no wheel move sits at — no step at the first point.
 */
function neutralFor(target: ExpressionTarget): number {
  switch (target.kind) {
    case 'pitchBend': return 0;     // centred
    case 'timbre':    return 0.5;   // the instruments' own default brightness
    default:          return 0;     // no pressure
  }
}

// ── Reading the stream ────────────────────────────────────────────────────────

/**
 * Does this stream look like MPE?
 *
 * The same test the file importer uses, for the same reason: MPE spreads a
 * chord over member channels and bends each one.  It only decides the bend
 * RANGE to assume (±48 vs ±2) — the curve assignment is per-channel either way.
 */
export function looksLikeMpeStream(events: readonly CaptureEvent[]): boolean {
  const noteChannels = new Set<number>();
  const bendChannels = new Set<number>();
  for (const e of events) {
    if (e.kind === 'noteOn') noteChannels.add(e.channel);
    if (e.kind === 'pitchBend') bendChannels.add(e.channel);
  }
  if (noteChannels.size < 3 || bendChannels.size < 3) return false;
  let shared = 0;
  for (const c of bendChannels) if (noteChannels.has(c)) shared += 1;
  return shared >= 3;
}

/** MPE's default bend range is ±48; an ordinary keyboard's is ±2. */
export function bendRangeFor(mpe: boolean): number {
  return mpe ? 48 : 2;
}

/** `3음 · CC1 무시됨` — what actually landed, for the UI to say. */
export function describeCapture(result: CaptureResult): string {
  const parts = [`${result.notes.length}음`];
  if (result.heldAtEnd > 0) parts.push(`${result.heldAtEnd}음은 끝에서 끊김`);
  if (result.tooShort > 0) parts.push(`${result.tooShort}음은 너무 짧아 버림`);
  if (result.ignoredCc.length > 0) parts.push(`CC ${result.ignoredCc.join(', ')} 미기록`);
  return parts.join(' · ');
}
