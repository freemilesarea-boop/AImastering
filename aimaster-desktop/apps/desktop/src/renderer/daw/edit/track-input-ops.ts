// Assigning inputs — the session-level verbs.
//
// The readers and the resolver live in `model/track-input.ts`; what is here
// is the part that changes the project, plus the one question the UI keeps
// asking: given what is plugged in right now, what will each armed track
// actually record from, and is there anything the user needs to be told?

import { findTrack, updateTrack } from '../model/session-ops.js';
import {
  DEFAULT_INPUT_REF, describeInput, hasInputAssignment, inputRefFor, refPatch,
  refreshHint, resolveTrackInput, trackInputRef,
} from '../model/track-input.js';
import type { InputPatch } from '../model/input-channels.js';
import type {
  InputDeviceLike, InputResolution, TrackInputRef,
} from '../model/track-input.js';
import { armedTracks, trackRecordKind } from '../model/recording.js';
import type { DawSession, Track, TrackId } from '../model/types.js';

export function setTrackInput(
  session: DawSession, trackId: TrackId, ref: TrackInputRef,
): DawSession {
  const track = findTrack(session, trackId);
  if (!track) return session;
  const channels: 1 | 2 = ref.channels === 2 ? 2 : 1;
  const next = {
    deviceLabel: ref.deviceLabel || null,
    deviceId: ref.deviceId || null,
    channels,
    firstChannel: Math.max(0, Math.floor(ref.firstChannel || 0)),
  };
  const current = trackInputRef(track);
  if (current.deviceLabel === next.deviceLabel
    && current.deviceId === next.deviceId
    && current.channels === next.channels
    && current.firstChannel === next.firstChannel) return session;
  return updateTrack(session, trackId, (t) => ({ ...t, recordInput: next }));
}

/** Pick a device for a track, keeping its socket unless told otherwise. */
export function assignInputDevice(
  session: DawSession, trackId: TrackId,
  device: InputDeviceLike | null, patch?: InputPatch,
): DawSession {
  const track = findTrack(session, trackId);
  if (!track) return session;
  const current = trackInputRef(track);
  return setTrackInput(session, trackId, inputRefFor(device, patch ?? refPatch(current)));
}

export function setTrackInputChannels(
  session: DawSession, trackId: TrackId, channels: 1 | 2,
): DawSession {
  const track = findTrack(session, trackId);
  if (!track) return session;
  return setTrackInput(session, trackId, { ...trackInputRef(track), channels });
}

/** Point a track at one socket of its device — input 5, or inputs 3/4. */
export function setTrackInputPatch(
  session: DawSession, trackId: TrackId, patch: InputPatch,
): DawSession {
  const track = findTrack(session, trackId);
  if (!track) return session;
  return setTrackInput(session, trackId, {
    ...trackInputRef(track),
    channels: patch.channels,
    firstChannel: patch.firstChannel,
  });
}

/** Forget a track's assignment — back to the system default. */
export function clearTrackInput(session: DawSession, trackId: TrackId): DawSession {
  return setTrackInput(session, trackId, DEFAULT_INPUT_REF);
}

/**
 * Write back the id the lookup found.
 *
 * A no-op unless the device was found by NAME, which is exactly the case
 * where the stored id had gone stale — so the next arm on this machine takes
 * the fast path instead of searching again.
 */
export function rememberResolved(
  session: DawSession, trackId: TrackId, resolution: InputResolution,
): DawSession {
  const track = findTrack(session, trackId);
  if (!track) return session;
  const ref = trackInputRef(track);
  const next = refreshHint(ref, resolution);
  return next === ref ? session : setTrackInput(session, trackId, next);
}

// ── What will actually happen ─────────────────────────────────────────────────

export interface TrackInputPlan {
  trackId: TrackId;
  trackName: string;
  ref: TrackInputRef;
  resolution: InputResolution;
}

export interface InputPlan {
  items: TrackInputPlan[];
  /** One line per track whose saved device is not here, named. */
  problems: string[];
}

/**
 * What every armed AUDIO track will record from, given the devices present.
 *
 * MIDI tracks are left out rather than reported as having no input: they do
 * not use one, and listing them as problems would bury the track that does.
 */
export function planInputs(
  session: DawSession, devices: readonly InputDeviceLike[],
): InputPlan {
  const items: TrackInputPlan[] = [];
  const problems: string[] = [];
  for (const track of armedTracks(session)) {
    if (trackRecordKind(track) !== 'audio') continue;
    const ref = trackInputRef(track);
    const resolution = resolveTrackInput(ref, devices);
    items.push({ trackId: track.id, trackName: track.name, ref, resolution });
    if (resolution.reason) problems.push(`${track.name}: ${resolution.reason}`);
  }
  return { items, problems };
}

/** Resolve ONE track, whether it is armed or not. */
export function inputFor(
  session: DawSession, trackId: TrackId, devices: readonly InputDeviceLike[],
): InputResolution {
  const track = findTrack(session, trackId);
  return resolveTrackInput(track ? trackInputRef(track) : DEFAULT_INPUT_REF, devices);
}

/** Every track that has been given an input, for a status read-out. */
export function assignedTracks(session: DawSession): { track: Track; ref: TrackInputRef }[] {
  return session.tracks
    .filter(hasInputAssignment)
    .map((track) => ({ track, ref: trackInputRef(track) }));
}

export function describeAssignments(session: DawSession): string {
  const assigned = assignedTracks(session);
  if (assigned.length === 0) return '입력 지정 없음';
  return assigned.map(({ track, ref }) => `${track.name} ← ${describeInput(ref)}`).join(' · ');
}
