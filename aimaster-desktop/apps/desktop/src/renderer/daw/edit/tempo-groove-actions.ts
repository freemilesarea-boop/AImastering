// Tempo detection and groove extraction — the verbs the UI calls.
//
// The two models underneath (`model/tempo-detect.ts`, `model/groove.ts`) are
// pure and know nothing about a session.  This is where they meet a clip:
// where the onsets come from, what "the clip's own time" means, and what it
// takes for a measurement to be allowed to change the project.
//
// One rule runs through all of it: A MEASUREMENT DOES NOT GET TO EDIT THE
// SESSION ON ITS OWN.  Setting the tempo moves every clip in the project, so
// a reading the detector itself calls uncertain is reported and stops there
// unless the user says otherwise.  `force` exists because the user is allowed
// to be more certain than the detector; it is not a default.

import { findTrack, trackClips, updateClip } from '../model/session-ops.js';
import { setSessionTempo } from '../model/warp.js';
import { transientMarksFor } from '../engine/audio-cache.js';
import {
  TRUST_THRESHOLD, describeDetection, detectTempo,
  type DetectOptions, type TempoDetection, type WeightedOnset,
} from '../model/tempo-detect.js';
import {
  applyGroove, describeGroove, extractGroove, grooveKnows, onsetsFromNotes, onsetsToBeats,
  type ApplyOptions, type ExtractOptions, type Groove, type GrooveExtraction,
} from '../model/groove.js';
import type { Clip, ClipId, DawSession, TrackId } from '../model/types.js';

function requireClip(session: DawSession, trackId: TrackId, clipId: ClipId): Clip {
  const track = findTrack(session, trackId);
  const clip = track ? trackClips(track).find((c) => c.id === clipId) : undefined;
  if (!clip) throw new Error('클립을 찾을 수 없습니다');
  return clip;
}

/**
 * The clip's attacks, timed from the start of the CLIP.
 *
 * The marks are found in the source file, so the clip's own offset comes off
 * them: a detected first beat of 0.2 s means two tenths into the clip as it
 * sits on the timeline, which is the only frame a caller can act in.
 *
 * Warp is deliberately not applied.  Detecting the tempo of material that has
 * already been warped to the session is answering a question nobody asked;
 * this reads the recording.
 */
export function clipOnsets(clip: Clip): WeightedOnset[] {
  if (clip.kind !== 'audio') return [];
  const from = clip.offsetSec;
  const to = clip.offsetSec + clip.durationSec;
  return transientMarksFor(clip.fileId)
    .filter((m) => m.timeSec >= from && m.timeSec <= to)
    .map((m) => ({ timeSec: m.timeSec - from, weight: Math.max(0.01, m.strength) }));
}

export function detectClipTempo(
  session: DawSession, trackId: TrackId, clipId: ClipId, options: DetectOptions = {},
): TempoDetection {
  const clip = requireClip(session, trackId, clipId);
  if (clip.kind !== 'audio') {
    return {
      bpm: 0, phaseSec: 0, confidence: 0, alternatives: [],
      reason: '오디오 클립에서만 템포를 검출할 수 있습니다',
    };
  }
  const onsets = clipOnsets(clip);
  if (onsets.length === 0) {
    return {
      bpm: 0, phaseSec: 0, confidence: 0, alternatives: [],
      reason: '아직 디코딩되지 않았습니다 — 파형이 보인 뒤에 다시 시도하세요',
    };
  }
  return detectTempo(onsets, options);
}

export interface TempoMatchResult {
  session: DawSession;
  detection: TempoDetection;
  /** False when the reading was too weak to act on — the session is unchanged. */
  applied: boolean;
  /** True when the clip was slid so its first beat sits on a beat line. */
  aligned: boolean;
  message: string;
}

export interface TempoMatchOptions extends DetectOptions {
  /** Act on a reading the detector does not trust.  The user's call, not ours. */
  force?: boolean;
  /** Slide the clip so its detected first beat lands on the grid. */
  align?: boolean;
}

/**
 * Take the session tempo from a recording.
 *
 * The phase is what makes this worth having.  A tempo alone leaves the clip
 * wherever it was dropped, still off the grid; sliding it so the detected
 * first beat lands on a beat line is the difference between a number in a
 * field and a project that lines up.
 */
export function matchSessionTempo(
  session: DawSession, trackId: TrackId, clipId: ClipId,
  options: TempoMatchOptions = {},
): TempoMatchResult {
  const detection = detectClipTempo(session, trackId, clipId, options);
  const unchanged = (message: string): TempoMatchResult =>
    ({ session, detection, applied: false, aligned: false, message });

  if (detection.reason) return unchanged(detection.reason);
  if (detection.confidence < TRUST_THRESHOLD && !options.force) {
    return unchanged(`${describeDetection(detection)} — 세션 템포를 바꾸지 않았습니다`);
  }

  const next = setSessionTempo(session, detection.bpm).session;

  let aligned = false;
  let result = next;
  if (options.align !== false && detection.phaseSec > 0) {
    // After the tempo change every clip has moved, so the alignment is
    // computed against where the clip is NOW.  The phase itself does not
    // move: it is a position in the recording, and the recording is not
    // warped by a tempo change.
    const moved = requireClip(next, trackId, clipId);
    const period = 60 / detection.bpm;
    const beatAt = moved.startSec + detection.phaseSec;
    const target = Math.round(beatAt / period) * period;
    const startSec = Math.max(0, moved.startSec + (target - beatAt));
    if (Math.abs(startSec - moved.startSec) > 1e-6) {
      result = updateClip(next, trackId, clipId, (c) => ({ ...c, startSec }));
      aligned = true;
    }
  }

  return {
    session: result, detection, applied: true, aligned,
    message: `${describeDetection(detection)}${aligned ? ' · 첫 박을 그리드에 맞췄습니다' : ''}`,
  };
}

// ── Groove ────────────────────────────────────────────────────────────────────

export interface ClipGrooveResult extends GrooveExtraction {
  /** The reading the groove was measured against — null for a MIDI part. */
  detection: TempoDetection | null;
}

export interface ClipGrooveOptions extends ExtractOptions {
  /** Skip detection and use this tempo — the session's, usually. */
  bpm?: number;
  phaseSec?: number;
  force?: boolean;
}

/**
 * Lift the feel off a clip.
 *
 * An audio clip needs a tempo before it can have a groove — an attack 30 ms
 * late is only late once you know how long a beat is — so detection runs
 * first unless a tempo is handed in.  A MIDI part already lives in beats and
 * skips all of that.
 */
export function extractClipGroove(
  session: DawSession, trackId: TrackId, clipId: ClipId,
  options: ClipGrooveOptions = {},
): ClipGrooveResult {
  const clip = requireClip(session, trackId, clipId);
  const name = options.name ?? clip.name;

  if (clip.kind === 'midi') {
    return { ...extractGroove(onsetsFromNotes(clip.notes), { ...options, name }), detection: null };
  }

  let detection: TempoDetection | null = null;
  let bpm = options.bpm;
  let phaseSec = options.phaseSec ?? 0;
  if (bpm === undefined) {
    detection = detectClipTempo(session, trackId, clipId);
    if (detection.reason) return { groove: null, reason: detection.reason, detection };
    if (detection.confidence < TRUST_THRESHOLD && !options.force) {
      return {
        groove: null, detection,
        reason: `${describeDetection(detection)} — 템포를 모르면 그루브를 잴 수 없습니다`,
      };
    }
    bpm = detection.bpm;
    phaseSec = detection.phaseSec;
  }

  const beats = onsetsToBeats(clipOnsets(clip), bpm, phaseSec);
  return { ...extractGroove(beats, { ...options, name }), detection };
}

export interface GrooveApplyResult {
  session: DawSession;
  /** How many notes actually moved — the honest count, not the selection size. */
  movedCount: number;
  /** Notes the groove had nothing to say about, and so left alone. */
  untouchedCount: number;
  message: string;
}

/** Put a groove onto a MIDI part's notes. */
export function applyGrooveToPart(
  session: DawSession, trackId: TrackId, clipId: ClipId, groove: Groove,
  ids: ReadonlySet<string> | null, options: ApplyOptions = {},
): GrooveApplyResult {
  const clip = requireClip(session, trackId, clipId);
  if (clip.kind !== 'midi') throw new Error('MIDI 파트에만 그루브를 적용할 수 있습니다');

  const before = clip.notes;
  const after = applyGroove(before, ids, groove, options);
  const byId = new Map(after.map((n) => [n.id, n]));
  let movedCount = 0;
  let untouchedCount = 0;
  for (const note of before) {
    const now = byId.get(note.id);
    const moved = !!now
      && (Math.abs(now.startBeat - note.startBeat) > 1e-9
        || Math.abs(now.velocity - note.velocity) > 1e-9);
    if (moved) { movedCount++; continue; }
    // Not moved is two different things.  A note already sitting where the
    // groove wants it was treated; a note on a slot the groove never saw was
    // skipped.  Only the second is worth telling the user about.
    if ((!ids || ids.has(note.id)) && !grooveKnows(groove, note.startBeat)) untouchedCount++;
  }

  const untouched = untouchedCount > 0
    ? ` · ${untouchedCount}개는 그루브가 모르는 자리라 그대로 뒀습니다`
    : '';
  return {
    session: updateClip(session, trackId, clipId, (c) => ({ ...c, notes: after })),
    movedCount, untouchedCount,
    message: `${describeGroove(groove)} · ${movedCount}개 노트 적용${untouched}`,
  };
}
