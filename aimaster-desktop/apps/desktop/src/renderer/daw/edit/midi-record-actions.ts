// Turning a MIDI capture into parts.
//
// The audio side of this (edit/record-actions.ts) writes one file and points a
// clip per pass into it.  MIDI has no file, so the shape is simpler — but the
// three decisions are deliberately the SAME ones, because a player who has
// recorded a vocal should not have to learn a second set of rules to record a
// keyboard:
//
//   The pre-roll is discarded, and a note held ACROSS the punch is trimmed to
//   the take rather than dropped — the same thing the tape does with sound.
//
//   A loop pass is a take.  One continuous performance, cut at the wrap points,
//   one playlist each, the last one left active.
//
//   Nothing else on the track is touched.  Takes stack; they never overwrite.

import { createMidiPart, findTrack, createPlaylist, updateTrack } from '../model/session-ops.js';
import { loopPasses, passClipName, type LoopPass, type RecordPlan, type RecordSettings } from '../model/recording.js';
import { noteEnd, sortNotes, type MidiNote, type MidiPartConfig } from '../model/midi.js';
import { DEFAULT_MIDI_CONFIG } from '../model/midi.js';
import type { Clip, DawSession, Playlist, TrackId } from '../model/types.js';

/**
 * What the capture produced.
 *
 * `notes` are in TAPE time — seconds since the transport started rolling, which
 * is the plan's `transportStartSec`.  That is the same frame the audio tape
 * uses, so the pre-roll trimming and the loop cutting are shared arithmetic.
 */
export interface CapturedPerformance {
  notes: readonly MidiNote[];
  /** Seconds of tape rolled, including the pre-roll. */
  tapeSec: number;
  config?: MidiPartConfig;
}

export interface MidiCommitResult {
  session: DawSession;
  takes: number;
  notes: number;
  activePlaylistId: string;
}

/** A part with nothing in it is not a take — it is a player who did not play. */
export function hasPerformance(captured: CapturedPerformance): boolean {
  return captured.notes.length > 0;
}

export function commitMidiRecording(
  session: DawSession, trackId: TrackId, captured: CapturedPerformance,
  plan: RecordPlan, settings: RecordSettings,
): MidiCommitResult {
  const track = findTrack(session, trackId);
  if (!track) throw new Error('트랙을 찾을 수 없습니다');
  if (captured.notes.length === 0) throw new Error('연주된 노트가 없습니다');

  // Drop the pre-roll and anything past a punch-out — the same window the tape
  // keeps, expressed in tape seconds.
  const keepFrom = plan.preRollSec;
  const plannedEnd = plan.recordEndSec === null
    ? captured.tapeSec
    : keepFrom + (plan.recordEndSec - plan.recordStartSec);
  const keepTo = Math.min(captured.tapeSec, plannedEnd);
  const keptSec = Math.max(0, keepTo - keepFrom);
  if (keptSec <= 1e-4) throw new Error('녹음 구간이 비어 있습니다');

  const kept = trimNotes(captured.notes, keepFrom, keepTo);
  if (kept.length === 0) throw new Error('녹음 구간에 노트가 없습니다');

  const passes = loopPasses(
    plan.recordStartSec, keptSec, settings.loopTakes ? plan.loop : null);
  if (passes.length === 0) throw new Error('녹음된 패스가 없습니다');

  const config = captured.config ?? DEFAULT_MIDI_CONFIG;
  const lanes: Playlist[] = [];
  let written = 0;
  passes.forEach((pass) => {
    const part = partForPass(kept, track.name, pass, passes.length, config);
    written += part.notes.length;
    lanes.push(createPlaylist(
      laneName(track.name, track.playlists.length + lanes.length + 1), [part]));
  });

  // The LAST pass is the one just played, so that is the take left active.
  const active = lanes[lanes.length - 1] as Playlist;

  return {
    session: updateTrack(session, trackId, (t) => ({
      ...t,
      playlists: [...t.playlists, ...lanes],
      activePlaylistId: active.id,
    })),
    takes: lanes.length,
    notes: written,
    activePlaylistId: active.id,
  };
}

/**
 * Keep the part of the performance inside the window, rebased so 0 is the first
 * kept sample.
 *
 * A note that started in the pre-roll and was still held at the punch is kept
 * from the punch onward.  Its attack is gone, which is true of the tape too;
 * throwing the whole note away would silence a pad that was deliberately held
 * into the section.
 */
export function trimNotes(
  notes: readonly MidiNote[], fromSec: number, toSec: number,
): MidiNote[] {
  const out: MidiNote[] = [];
  for (const note of notes) {
    const start = Math.max(note.startSec, fromSec);
    const end = Math.min(noteEnd(note), toSec);
    if (end - start <= 1e-4) continue;
    out.push(shiftNote(note, start, end, fromSec));
  }
  return sortNotes(out);
}

/**
 * Re-anchor one note onto a new origin.
 *
 * Expression curves live in the NOTE's time frame, so cutting the front of a
 * note has to slide them too, or a bend recorded half a second in would play
 * half a second early.
 */
function shiftNote(note: MidiNote, startSec: number, endSec: number, originSec: number): MidiNote {
  const lost = startSec - note.startSec;
  return {
    ...note,
    startSec: startSec - originSec,
    durationSec: endSec - startSec,
    expression: lost <= 1e-9 ? note.expression : note.expression.map((curve) => ({
      target: curve.target,
      points: cutCurveFront(curve.points, lost),
    })),
  };
}

/**
 * Slide a curve back by `lost` seconds, keeping the value it was already at.
 *
 * Points before the cut are discarded, but the LAST of them is pinned to zero
 * first: a wheel that was pushed up before the punch and held there has no
 * point inside the window at all, and dropping it outright would start the note
 * centred and then jump.
 */
function cutCurveFront(
  points: readonly { timeSec: number; value: number }[], lost: number,
): { timeSec: number; value: number }[] {
  const out: { timeSec: number; value: number }[] = [];
  let carried: { timeSec: number; value: number } | null = null;
  for (const point of points) {
    const shifted = point.timeSec - lost;
    if (shifted < 0) { carried = { timeSec: 0, value: point.value }; continue; }
    if (carried) { out.push(carried); carried = null; }
    out.push({ timeSec: shifted, value: point.value });
  }
  if (carried) out.push(carried);
  return out;
}

function partForPass(
  notes: readonly MidiNote[], trackName: string, pass: LoopPass, total: number,
  config: MidiPartConfig,
): Clip {
  const length = pass.captureToSec - pass.captureFromSec;
  const inPass = trimNotes(notes, pass.captureFromSec, pass.captureToSec);
  return createMidiPart(passClipName(trackName, pass, total), {
    startSec: pass.timelineStartSec,
    offsetSec: 0,
    durationSec: length,
    notes: inPass,
    midiConfig: config,
  });
}

function laneName(trackName: string, index: number): string {
  return `${trackName}.${String(index).padStart(2, '0')}`;
}
