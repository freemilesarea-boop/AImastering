// Committing a whole pass of the transport.
//
// One take used to be one track.  A band take is six microphones and a
// keyboard, all riding the same transport from the same tape zero — and the
// only honest way to land that is as ONE edit:
//
//   ONE UNDO STEP.  Six separate commits would be six presses of Cmd+Z to get
//   back to where the take started, with the session in a half-recorded state
//   at every step in between.  The session is threaded through every track here
//   and handed back once.
//
//   ONE TRACK'S FAILURE IS NOT THE PASS'S FAILURE.  An unplugged microphone on
//   channel four must not throw away the five that worked.  Every track is
//   committed independently and whatever went wrong is REPORTED by name, so
//   the player learns which one to check instead of losing the take.
//
//   THE KEYBOARD IS JUST ANOTHER ARMED TRACK.  Its performance is committed to
//   every armed instrument track, which is what arming two of them means.

import { commitRecording, type AudioWriter, type CapturedTake } from './record-actions.js';
import { commitMidiRecording } from './midi-record-actions.js';
import {
  bendRangeFor, captureNotes, describeCapture, looksLikeMpeStream,
  type CaptureEvent, type CaptureResult,
} from '../model/midi-capture.js';
import { findTrack } from '../model/session-ops.js';
import { armedTracks, trackRecordKind } from '../model/recording.js';
import { writeTempChannels } from '../engine/offline-render.js';
import type { RecordPlan, RecordSettings } from '../model/recording.js';
import type { DawSession, TrackId } from '../model/types.js';

/** What the runtime handed back after the transport stopped. */
export interface PassCapture {
  audio: Map<TrackId, CapturedTake>;
  midi: { events: CaptureEvent[]; trackIds: readonly TrackId[] } | null;
  tapeSec: number;
}

export interface PassResult {
  session: DawSession;
  /** Tracks that received audio takes. */
  audioTracks: TrackId[];
  /** Tracks that received MIDI parts. */
  midiTracks: TrackId[];
  /** Takes laid down across every track. */
  takes: number;
  /** What the MIDI capture contained, when there was one. */
  midiCapture: CaptureResult | null;
  /** One line per track that produced nothing, naming it. */
  problems: string[];
}

/**
 * Lay a whole pass down.
 *
 * `writer` is injectable for the same reason it is on the single-track commit:
 * the selftest runs the entire arrangement of files and clips without touching
 * a disk.
 */
export async function commitPass(
  session: DawSession, capture: PassCapture,
  plan: RecordPlan, settings: RecordSettings,
  writer: AudioWriter = writeTempChannels,
): Promise<PassResult> {
  let next = session;
  const audioTracks: TrackId[] = [];
  const midiTracks: TrackId[] = [];
  const problems: string[] = [];
  let takes = 0;

  const nameOf = (trackId: TrackId): string =>
    findTrack(session, trackId)?.name ?? trackId;

  // Audio first, in the session's own track order rather than in whatever
  // order the capture map happens to iterate — so take lane numbers read the
  // same way twice.
  for (const track of session.tracks) {
    const take = capture.audio.get(track.id);
    if (!take) continue;
    try {
      const result = await commitRecording(next, track.id, take, plan, settings, writer);
      next = result.session;
      audioTracks.push(track.id);
      takes += result.takes;
    } catch (err) {
      problems.push(`${track.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // A track that was armed and produced no tape at all — an input that was
  // open but silent, or a stream that died mid-take.  Six microphones is
  // exactly the situation where one of them quietly not recording has to be
  // said out loud.
  for (const track of armedTracks(session)) {
    if (trackRecordKind(track) !== 'audio') continue;
    if (!capture.audio.has(track.id)) problems.push(`${track.name}: 녹음된 오디오가 없습니다`);
  }

  let midiCapture: CaptureResult | null = null;
  if (capture.midi && capture.midi.trackIds.length > 0) {
    const mpe = looksLikeMpeStream(capture.midi.events);
    midiCapture = captureNotes(capture.midi.events, {
      endSec: capture.tapeSec,
      sustainPedal: settings.midiSustainPedal,
    });
    const config = { bendRangeSemitones: bendRangeFor(mpe), mpe };
    for (const trackId of capture.midi.trackIds) {
      try {
        const result = commitMidiRecording(next, trackId, {
          notes: midiCapture.notes,
          tapeSec: capture.tapeSec,
          config,
        }, plan, settings);
        next = result.session;
        midiTracks.push(trackId);
        takes += result.takes;
      } catch (err) {
        problems.push(`${nameOf(trackId)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { session: next, audioTracks, midiTracks, takes, midiCapture, problems };
}

/** True when the pass produced nothing at all — the one case that IS an error. */
export function passIsEmpty(capture: PassCapture): boolean {
  return capture.audio.size === 0
    && (capture.midi === null || capture.midi.events.length === 0);
}

/** `오디오 3트랙 · MIDI 1트랙 · 4테이크` — what a pass actually laid down. */
export function describePass(result: PassResult): string {
  const parts: string[] = [];
  if (result.audioTracks.length > 0) parts.push(`오디오 ${result.audioTracks.length}트랙`);
  if (result.midiTracks.length > 0) parts.push(`MIDI ${result.midiTracks.length}트랙`);
  if (result.midiCapture) parts.push(describeCapture(result.midiCapture));
  if (parts.length === 0) return '기록된 것이 없습니다';
  if (result.takes > result.audioTracks.length + result.midiTracks.length) {
    parts.push(`${result.takes}테이크`);
  }
  return parts.join(' · ');
}
