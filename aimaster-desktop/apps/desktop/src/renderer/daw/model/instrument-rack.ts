// The instrument rack — what is loaded, and what happens when you add one.
//
// Cubase's F11 opens a rack of instrument slots.  That window is not a
// decoration: it is the ONLY place in that program where "I want a piano"
// turns into a track you can write on, in one gesture, without first knowing
// that a track has a hidden instrument field.
//
// This app had the field and the engine and no such gesture.  `+ 인스트루먼트`
// always made a `polysynth`, and the only way to reach the other four was a
// dropdown inside the Key Editor — which you can only open once a part
// already exists on a track you already made.  So every instrument except the
// default was two discoveries deep.
//
// Everything here is pure: the panel renders it and the commands apply it, so
// the numbering, the naming and the note gathering can be tested without a
// store, a canvas or an audio context.

import type { Clip, DawSession, Track, TrackId } from './types.js';
import { addTrack, trackClips, updateClips } from './session-ops.js';
import { assignDrumMap } from './drum-map-session.js';
import { GM_DRUM_MAP } from './drum-map.js';
import { partClock } from './note-time.js';
import { tempoMapOf } from './tempo-map.js';
import type { MidiNote } from './midi.js';

export interface RackSlot {
  /** 1-based, the way a rack numbers its slots. */
  index: number;
  trackId: TrackId;
  trackName: string;
  instrumentId: string;
  /** How many MIDI parts live on the track. */
  parts: number;
  /** Notes across every part — an empty slot is worth showing as empty. */
  notes: number;
  /** The part a rack "edit" button should open, if there is one. */
  firstPartId: string | null;
  muted: boolean;
  frozen: boolean;
}

/** Every instrument track, in session order. */
export function rackSlots(session: DawSession): RackSlot[] {
  const out: RackSlot[] = [];
  for (const track of session.tracks) {
    if (track.kind !== 'instrument') continue;
    const clips = trackClips(track).filter((c) => c.kind === 'midi');
    out.push({
      index: out.length + 1,
      trackId: track.id,
      trackName: track.name,
      // A track whose instrument was never set still PLAYS the default, so
      // the rack shows the default rather than an empty slot that lies.
      instrumentId: track.instrumentId ?? 'polysynth',
      parts: clips.length,
      notes: clips.reduce((n, c) => n + (c.notes?.length ?? 0), 0),
      firstPartId: clips[0]?.id ?? null,
      muted: track.mute,
      frozen: track.frozen !== null,
    });
  }
  return out;
}

/**
 * A name for a new slot, taken from the instrument.
 *
 * `Synth 1, Synth 2, Synth 3` tells you nothing once the three of them are
 * three different instruments.  Numbering skips names already in the session
 * so a second Rhodes is `Rhodes 2` even when a guitar was added between them
 * — a running count of ALL instrument tracks would call it `Rhodes 3`.
 */
export function nextInstrumentName(session: DawSession, instrumentName: string): string {
  const base = instrumentName.replace(/\s*\([^)]*\)\s*$/, '').trim() || 'Instrument';
  const taken = new Set(session.tracks.map((t) => t.name));
  for (let n = 1; n < 1000; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base;
}

/**
 * Where a new part goes on a track.
 *
 * At the end of what is already there, not on top of it.  Dropping every new
 * part at 0 stacks them invisibly: the arrangement looks like one part and
 * plays like four.
 */
export function newPartPlacement(
  session: DawSession, track: Track | undefined, bars = 4,
): { startSec: number; durationSec: number } {
  const beatsPerBar = session.timeSignature[0] || 4;
  const barSec = (60 / session.tempoBpm) * beatsPerBar;
  const durationSec = barSec * Math.max(1, bars);
  if (!track) return { startSec: 0, durationSec };
  const end = trackClips(track).reduce((m, c) => Math.max(m, c.startSec + c.durationSec), 0);
  return { startSec: end, durationSec };
}

/**
 * Every note on a track, moved onto one timeline in beats.
 *
 * A note's `startBeat` is measured from ITS PART, so writing the parts out
 * one after another without this would stack them all at bar 1 — four parts
 * exported as one bar of mush.  The parts are anchored in seconds and ride
 * the tempo map from there, so the offset is a map lookup per part rather
 * than a multiplication.
 */
export function trackNotesInBeats(session: DawSession, track: Track): MidiNote[] {
  const map = tempoMapOf(session);
  const out: MidiNote[] = [];
  for (const clip of trackClips(track)) {
    if (clip.kind !== 'midi' || !clip.notes) continue;
    const clock = partClock(map, clip.startSec);
    for (const note of clip.notes) {
      out.push({ ...note, startBeat: clock.startBeat + note.startBeat });
    }
  }
  return out.sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);
}

/**
 * A filename for an exported .mid.
 *
 * The track name comes from the user, so it is stripped to something every
 * platform will take — Windows refuses `< > : " / \ | ? *` and a trailing
 * dot, and a name that is nothing but punctuation must still produce a file
 * rather than a bare extension.
 */
export function midiFileName(trackName: string): string {
  const cleaned = trackName
    .replace(/[<>:"/\\|?*]/g, ' ')
    // Control characters and the null byte: a track name is user text,
    // and a path is not the place to find out that it was.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 64);
  return `${cleaned || 'part'}.mid`;
}

/**
 * The id of the one instrument that is a kit rather than a keyboard.
 *
 * Named here rather than compared inline in three places: a drum track needs
 * a DRUM MAP as well as a sound, and the two have to be decided together or
 * you get a working kit whose piano roll is still a wall of numbers.
 */
export const DRUM_INSTRUMENT_ID = 'drumkit';

/**
 * Does picking this instrument also mean giving the track a kit map?
 *
 * The map is what turns the piano roll into named lanes — 킥, 스네어, 하이햇 —
 * and what chokes the hats.  Without it the drum kit still SOUNDS right,
 * because the sound is chosen by pitch either way, and the editor is still
 * unusable.  Half a feature is the failure mode this whole area keeps having.
 */
export function needsDrumMap(instrumentId: string): boolean {
  return instrumentId === DRUM_INSTRUMENT_ID;
}

/**
 * Add a slot to a session: the track, its first part, and its kit if it needs
 * one — as ONE function, so the three cannot drift apart.
 *
 * They were three statements in the panel first, and a test could only grep
 * for them.  Removing the map assignment then left every check green while a
 * new drum track opened onto a piano roll of anonymous numbers, which is the
 * exact half-working state this whole area keeps producing.  Here it is a
 * value a test can call and inspect.
 */
export function addInstrumentSlot(
  session: DawSession, track: Track, part: Clip,
): DawSession {
  const withPart = updateClips(addTrack(session, track), track.id, () => [part]);
  return needsDrumMap(track.instrumentId ?? '')
    ? assignDrumMap(withPart, track.id, GM_DRUM_MAP)
    : withPart;
}

/** One line for the slot row: what this instrument is actually carrying. */
export function describeSlot(slot: RackSlot): string {
  if (slot.parts === 0) return '파트 없음';
  const parts = `${slot.parts}파트`;
  const notes = slot.notes === 0 ? '노트 없음' : `${slot.notes}노트`;
  const flags = [slot.muted ? '뮤트' : '', slot.frozen ? '프리즈' : ''].filter(Boolean);
  return [parts, notes, ...flags].join(' · ');
}
