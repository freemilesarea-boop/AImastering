// Fast, exact clip editing — the Pro Tools editing verbs.
//
// All pure: (session, selection, args) → session.  No rendering, no audio
// device, no UI.  That is what makes them safe to bind to single keystrokes:
// every one of them is unit-tested to the sample in shortcuts-selftest.
//
// Conventions:
//   • A "separation" splits one clip into two that still reference the same
//     source file at the same sample offsets — non-destructive, exactly like
//     the real thing.
//   • Operations that receive a `TimeSelection` apply to every selected
//     track; operations that receive a clip id apply to that clip only.

import {
  activePlaylist, clipEnd, createClip, sortClips, trackClips, updateClips, findTrack,
} from '../model/session-ops.js';
// Value import, not just a type: edit-groups takes only `type TimeSelection`
// from this file, so the dependency runs one way at runtime.
import { editGroupsOf } from './edit-groups.js';
import type { Clip, ClipId, DawSession, Fade, TrackId } from '../model/types.js';
import { withFade, type FadeSide } from '../model/clip-fade.js';
import { clipPitch, withClipPitch } from '../model/clip-pitch.js';
import { nextId } from '../model/ids.js';

/** An edit selection: a time range across one or more tracks. */
export interface TimeSelection {
  startSec: number;
  endSec: number;
  trackIds: TrackId[];
}

export const EMPTY_SELECTION: TimeSelection = { startSec: 0, endSec: 0, trackIds: [] };

export function selectionLength(sel: TimeSelection): number {
  return Math.max(0, sel.endSec - sel.startSec);
}

export function hasRange(sel: TimeSelection): boolean {
  return selectionLength(sel) > 1e-9 && sel.trackIds.length > 0;
}

// ── Separate / split ──────────────────────────────────────────────────────────

/**
 * Split every clip crossing `timeSec` on the given tracks.
 * A cut exactly on a clip boundary is a no-op (nothing to separate).
 */
export function separateAt(session: DawSession, trackIds: TrackId[], timeSec: number): DawSession {
  let out = session;
  for (const trackId of trackIds) {
    out = updateClips(out, trackId, (clips) => {
      let touched = false;
      const next: Clip[] = [];
      for (const c of clips) {
        if (timeSec > c.startSec + 1e-9 && timeSec < clipEnd(c) - 1e-9) {
          touched = true;
          next.push(...splitClip(c, timeSec));
        } else {
          next.push(c);
        }
      }
      return touched ? next : clips;
    });
  }
  return out;
}

/**
 * Split one clip at an absolute timeline position.  Fades follow the edges.
 *
 * A clip that had a chain rendered into it loses its `regionFx` here, and the
 * audio is untouched by that: the halves still point at the rendered file.
 * What goes is the offer to revert, and it has to go — `original` describes
 * the WHOLE clip, so carrying it onto a half would make "되돌리기" replace a
 * two-second piece with the full-length source.  In `keep` mode the clip is
 * even longer than its original, so there is no honest way to narrow it
 * either.
 */
export function splitClip(clip: Clip, timeSec: number): [Clip, Clip] {
  const headDuration = timeSec - clip.startSec;
  const { regionFx: _dropped, ...plain } = clip;
  const head: Clip = {
    ...plain,
    id: nextId('clip'),
    durationSec: headDuration,
    fadeOut: { durationSec: 0, shape: clip.fadeOut.shape },
  };
  const tail: Clip = {
    ...plain,
    id: nextId('clip'),
    startSec: timeSec,
    offsetSec: clip.offsetSec + headDuration,
    durationSec: clip.durationSec - headDuration,
    fadeIn: { durationSec: 0, shape: clip.fadeIn.shape },
  };
  return [head, tail];
}

/** Separate at both edges of a range, so the range becomes its own clip(s). */
export function separateRange(session: DawSession, sel: TimeSelection): DawSession {
  if (!hasRange(sel)) return session;
  let out = separateAt(session, sel.trackIds, sel.startSec);
  out = separateAt(out, sel.trackIds, sel.endSec);
  return out;
}

// ── Heal ──────────────────────────────────────────────────────────────────────

const EPS = 1e-6;

/**
 * `clips.map` with identity preservation: when no clip actually changed the
 * ORIGINAL array comes back, so `updateClips` can skip the session rebuild.
 * Without this every no-op edit would produce a new session object, push an
 * undo entry and re-sync the audio graph.
 */
function mapClips(clips: Clip[], fn: (c: Clip) => Clip): Clip[] {
  let changed = false;
  const next = clips.map((c) => {
    const updated = fn(c);
    if (updated !== c) changed = true;
    return updated;
  });
  return changed ? next : clips;
}

/** True when `b` continues `a` from the same file with no gap and no slip. */
export function isHealable(a: Clip, b: Clip): boolean {
  return (
    a.fileId === b.fileId
    && Math.abs(clipEnd(a) - b.startSec) < EPS
    && Math.abs((a.offsetSec + a.durationSec) - b.offsetSec) < EPS
    && Math.abs(a.gainDb - b.gainDb) < EPS
    && a.muted === b.muted
  );
}

/**
 * Heal separation across the selection — rejoin clips that were split and
 * never moved.  Clips that were slipped, gain-changed, or came from other
 * files are left alone (the real Heal refuses those too).
 */
export function healSeparation(session: DawSession, sel: TimeSelection): DawSession {
  let out = session;
  for (const trackId of sel.trackIds) {
    out = updateClips(out, trackId, (clips) => {
      const sorted = sortClips(clips);
      const result: Clip[] = [];
      let healed = false;
      for (const clip of sorted) {
        const prev = result[result.length - 1];
        const touchesSelection =
          clipEnd(clip) > sel.startSec - EPS && clip.startSec < sel.endSec + EPS;
        if (prev && touchesSelection && isHealable(prev, clip)) {
          result[result.length - 1] = {
            ...prev,
            durationSec: prev.durationSec + clip.durationSec,
            fadeOut: clip.fadeOut,
          };
          healed = true;
        } else {
          result.push(clip);
        }
      }
      return healed ? result : clips;
    });
  }
  return out;
}

// ── Trim ──────────────────────────────────────────────────────────────────────

/** Trim the clip's head to `timeSec` (start moves, source offset follows). */
export function trimClipStart(clip: Clip, timeSec: number): Clip {
  const end = clipEnd(clip);
  const start = Math.max(0, Math.min(timeSec, end - EPS));
  const delta = start - clip.startSec;
  return {
    ...clip,
    startSec: start,
    offsetSec: clip.offsetSec + delta,
    durationSec: clip.durationSec - delta,
  };
}

/** Trim the clip's tail to `timeSec`. */
export function trimClipEnd(clip: Clip, timeSec: number): Clip {
  const duration = Math.max(EPS, timeSec - clip.startSec);
  return { ...clip, durationSec: duration };
}

/**
 * Trim every clip on the selected tracks down to the selection range —
 * "Trim to Selection".  Clips fully outside the range are removed.
 */
export function trimToSelection(session: DawSession, sel: TimeSelection): DawSession {
  if (!hasRange(sel)) return session;
  let out = session;
  for (const trackId of sel.trackIds) {
    out = updateClips(out, trackId, (clips) => {
      const next: Clip[] = [];
      for (const c of clips) {
        if (clipEnd(c) <= sel.startSec + EPS || c.startSec >= sel.endSec - EPS) continue;
        let trimmed = c;
        if (c.startSec < sel.startSec) trimmed = trimClipStart(trimmed, sel.startSec);
        if (clipEnd(trimmed) > sel.endSec) trimmed = trimClipEnd(trimmed, sel.endSec);
        next.push(trimmed);
      }
      return next;
    });
  }
  return out;
}

// ── Delete ────────────────────────────────────────────────────────────────────

/**
 * Clear the selection range.  `ripple` closes the gap afterwards (Shuffle
 * mode); otherwise the gap stays (Slip mode).
 */
export function clearRange(session: DawSession, sel: TimeSelection, ripple = false): DawSession {
  if (!hasRange(sel)) return session;
  const length = selectionLength(sel);
  let out = separateRange(session, sel);
  for (const trackId of sel.trackIds) {
    out = updateClips(out, trackId, (clips) => {
      const kept = clips.filter((c) => clipEnd(c) <= sel.startSec + EPS || c.startSec >= sel.endSec - EPS);
      if (!ripple) return kept;
      return kept.map((c) => (c.startSec >= sel.endSec - EPS
        ? { ...c, startSec: c.startSec - length }
        : c));
    });
  }
  return out;
}

// ── Move / nudge / slip ───────────────────────────────────────────────────────

export function moveClip(session: DawSession, trackId: TrackId, clipId: ClipId, toSec: number): DawSession {
  return updateClips(session, trackId, (clips) =>
    mapClips(clips, (c) => (c.id === clipId ? { ...c, startSec: Math.max(0, toSec) } : c)));
}

export interface TrackMoveResult {
  session: DawSession;
  /** Empty when the move happened; one line saying why when it did not. */
  problems: string[];
}

/**
 * Move a clip to ANOTHER track, and to a new time, in one step.
 *
 * `moveClip` could only ever move a clip along its own lane — the destination
 * track was not a parameter — so the only way to get a piece onto a different
 * track was copy, select the other track, paste.  Dragging it there is the
 * gesture every DAW uses for this, and the model had no way to express it.
 *
 * One step rather than remove-then-add, because with undo recording every
 * apply, two steps means a state a user can press Ctrl+Z back into: the clip
 * gone from one track and not yet on the other.
 *
 * ── What is refused, and why it is refused rather than fixed up ────────────
 *
 * A MIDI part on an audio track, or an audio clip on an instrument track, is
 * not a thing the engine can play — `ClipPlayer` reads one and the instrument
 * reads the other.  Dropping it there and silently leaving it where it was is
 * how a drag "does nothing"; dropping it there and letting it land is how a
 * track goes silent with no explanation.  So it is refused out loud.
 *
 * A track in an EDIT GROUP is refused too, and that one is less obvious.  The
 * group exists to keep its members aligned in time; moving one member's clip
 * to a different track leaves the group holding an alignment that is no
 * longer true of the same material.  Cubase answers this with a track-offset
 * map across the group, which needs a correspondence between members that
 * this session model does not have.  Refusing says so instead of guessing.
 */
export function moveClipToTrack(
  session: DawSession,
  fromTrackId: TrackId,
  clipId: ClipId,
  toTrackId: TrackId,
  toSec: number,
): TrackMoveResult {
  if (fromTrackId === toTrackId) {
    return { session: moveClip(session, fromTrackId, clipId, toSec), problems: [] };
  }
  const refusal = clipTrackMoveRefusal(session, fromTrackId, clipId, toTrackId);
  if (refusal !== null) return { session, problems: [refusal] };

  const from = findTrack(session, fromTrackId);
  const clip = from && trackClips(from).find((c) => c.id === clipId);
  // Cannot be missing — the refusal check above would have said so — but the
  // compiler does not know that and a cast here would be the kind of lie that
  // produced the toFixed crash.
  if (!clip) return { session, problems: ['클립을 찾을 수 없습니다'] };

  const moved: Clip = { ...clip, startSec: Math.max(0, toSec) };
  // Lifted and landed in one expression so there is no session in between
  // with the clip on neither track.
  const lifted = updateClips(session, fromTrackId, (clips) => clips.filter((c) => c.id !== clipId));
  return {
    session: updateClips(lifted, toTrackId, (clips) => [...clips, moved]),
    problems: [],
  };
}

/**
 * Why this clip cannot go on that track, or `null` if it can.
 *
 * Pure, and separate from the move, because the drag has to ask BEFORE it
 * applies anything: a drag that applied the move and then inspected the
 * result would have to undo it on every refused mouse-move, and the user
 * would see the clip flicker onto a track it is not allowed on. The move
 * above asks the same function, so there is one copy of the rules.
 */
export function clipTrackMoveRefusal(
  session: DawSession, fromTrackId: TrackId, clipId: ClipId, toTrackId: TrackId,
): string | null {
  if (fromTrackId === toTrackId) return null;

  const from = findTrack(session, fromTrackId);
  const to = findTrack(session, toTrackId);
  if (!from || !to) return '트랙을 찾을 수 없습니다';

  const clip = trackClips(from).find((c) => c.id === clipId);
  if (!clip) return '클립을 찾을 수 없습니다';

  if (to.kind !== 'audio' && to.kind !== 'instrument') {
    return `${to.name} 트랙에는 클립을 놓을 수 없습니다`;
  }
  const wants = clip.kind === 'midi' ? 'instrument' : 'audio';
  if (to.kind !== wants) {
    return clip.kind === 'midi'
      ? `MIDI 파트는 인스트루먼트 트랙에만 놓을 수 있습니다 — ${to.name} 은 오디오 트랙입니다`
      : `오디오 클립은 오디오 트랙에만 놓을 수 있습니다 — ${to.name} 은 인스트루먼트 트랙입니다`;
  }
  if (editGroupsOf(session, fromTrackId).length > 0
      || editGroupsOf(session, toTrackId).length > 0) {
    return '편집 그룹에 묶인 트랙끼리는 클립을 옮길 수 없습니다 — 그룹을 먼저 끄세요';
  }
  return null;
}

/** Nudge every clip touching the selection by ±delta seconds. */
export function nudgeSelection(session: DawSession, sel: TimeSelection, deltaSec: number): DawSession {
  let out = session;
  for (const trackId of sel.trackIds) {
    out = updateClips(out, trackId, (clips) => mapClips(clips, (c) =>
      (overlapsSelection(c, sel) ? { ...c, startSec: Math.max(0, c.startSec + deltaSec) } : c)));
  }
  return out;
}

/** Slip: move the audio inside the clip without moving the clip. */
export function slipSelection(session: DawSession, sel: TimeSelection, deltaSec: number): DawSession {
  let out = session;
  for (const trackId of sel.trackIds) {
    out = updateClips(out, trackId, (clips) => mapClips(clips, (c) =>
      (overlapsSelection(c, sel) ? { ...c, offsetSec: Math.max(0, c.offsetSec + deltaSec) } : c)));
  }
  return out;
}

export function overlapsSelection(c: Clip, sel: TimeSelection): boolean {
  if (!hasRange(sel)) return false;
  return clipEnd(c) > sel.startSec + EPS && c.startSec < sel.endSec - EPS;
}

// ── Duplicate / repeat ────────────────────────────────────────────────────────

/**
 * Duplicate the selection immediately after itself (Mod+D).  `times` > 1 is
 * the Repeat command.
 */
export function duplicateSelection(session: DawSession, sel: TimeSelection, times = 1): DawSession {
  if (!hasRange(sel) || times < 1) return session;
  const length = selectionLength(sel);
  let out = separateRange(session, sel);
  for (const trackId of sel.trackIds) {
    out = updateClips(out, trackId, (clips) => {
      const source = clips.filter((c) => overlapsSelection(c, sel));
      if (source.length === 0) return clips;
      const copies: Clip[] = [];
      for (let n = 1; n <= times; n++) {
        for (const c of source) {
          copies.push({ ...c, id: nextId('clip'), startSec: c.startSec + length * n });
        }
      }
      return [...clips, ...copies];
    });
  }
  return out;
}

// ── Clip gain / fades ─────────────────────────────────────────────────────────

export const CLIP_GAIN_MIN_DB = -60;
export const CLIP_GAIN_MAX_DB = 24;

export function clampClipGain(db: number): number {
  return Math.max(CLIP_GAIN_MIN_DB, Math.min(CLIP_GAIN_MAX_DB, db));
}

/** Set clip gain on every clip touching the selection. */
export function setClipGain(session: DawSession, sel: TimeSelection, db: number): DawSession {
  return mapSelectedClips(session, sel, (c) => ({ ...c, gainDb: clampClipGain(db) }));
}

/**
 * Set the gain of ONE clip.
 *
 * `setClipGain` works on a selection, which is the wrong shape for a mouse:
 * the person is riding the line on one specific clip and has selected
 * nothing — the same reason `setClipFade` exists beside `setFades`.
 */
export function setOneClipGain(
  session: DawSession, trackId: TrackId, clipId: ClipId, db: number,
): DawSession {
  return updateClips(session, trackId, (clips) => {
    let touched = false;
    const next = clips.map((c) => {
      if (c.id !== clipId) return c;
      touched = true;
      return { ...c, gainDb: clampClipGain(db) };
    });
    return touched ? next : clips;
  });
}

/** Nudge clip gain (Pro Tools uses ±0.5 dB, ±1 dB with a modifier). */
export function nudgeClipGain(session: DawSession, sel: TimeSelection, deltaDb: number): DawSession {
  return mapSelectedClips(session, sel, (c) => ({ ...c, gainDb: clampClipGain(c.gainDb + deltaDb) }));
}

/**
 * Nudge the transpose of every clip in the selection.
 *
 * The audio counterpart of `daw.transposeUp`, which has always been MIDI
 * only.  Held to the range the render survives, in the model rather than
 * here, so a session file with a wild number reads back the same way.
 */
export function nudgeClipPitch(session: DawSession, sel: TimeSelection, deltaSemitones: number): DawSession {
  return mapSelectedClips(session, sel, (c) => (
    c.kind === 'audio' ? withClipPitch(c, clipPitch(c) + deltaSemitones) : c
  ));
}

/** Put every selected clip back to its original pitch. */
export function resetClipPitch(session: DawSession, sel: TimeSelection): DawSession {
  return mapSelectedClips(session, sel, (c) => (c.kind === 'audio' ? withClipPitch(c, 0) : c));
}

/**
 * Set one fade on one clip.
 *
 * `setFades` works on a SELECTION, which is the wrong shape for a mouse: the
 * person is pulling the corner of one specific clip and has selected nothing.
 */
export function setClipFade(
  session: DawSession, trackId: TrackId, clipId: ClipId, side: FadeSide, fade: Fade,
): DawSession {
  return updateClips(session, trackId, (clips) => mapClips(clips, (c) => (
    c.id === clipId ? withFade(c, side, fade) : c
  )));
}

/**
 * Fade to the play head — the "F" workhorse.  A cursor inside a clip fades
 * from the clip start up to the cursor (or from the cursor to the clip end
 * when `direction` is 'out').
 */
export function fadeToCursor(
  session: DawSession, trackIds: TrackId[], timeSec: number,
  direction: 'in' | 'out', shape: Fade['shape'] = 'equalPower',
): DawSession {
  let out = session;
  for (const trackId of trackIds) {
    out = updateClips(out, trackId, (clips) => mapClips(clips, (c) => {
      if (timeSec <= c.startSec || timeSec >= clipEnd(c)) return c;
      return direction === 'in'
        ? { ...c, fadeIn:  { durationSec: timeSec - c.startSec, shape } }
        : { ...c, fadeOut: { durationSec: clipEnd(c) - timeSec, shape } };
    }));
  }
  return out;
}

/** Crossfade the boundary between two abutting clips inside the selection. */
export function crossfadeAt(
  session: DawSession, trackIds: TrackId[], timeSec: number, lengthSec: number,
  shape: Fade['shape'] = 'equalPower',
): DawSession {
  const half = lengthSec / 2;
  let out = session;
  for (const trackId of trackIds) {
    out = updateClips(out, trackId, (clips) => {
      const sorted = sortClips(clips);
      let touched = false;
      const next = sorted.map((c, i) => {
        const prev = sorted[i - 1];
        if (prev && Math.abs(clipEnd(prev) - c.startSec) < EPS
            && Math.abs(c.startSec - timeSec) < Math.max(EPS, half)) {
          touched = true;
          return { ...c, fadeIn: { durationSec: Math.min(half, c.durationSec), shape } };
        }
        const nextClip = sorted[i + 1];
        if (nextClip && Math.abs(clipEnd(c) - nextClip.startSec) < EPS
            && Math.abs(clipEnd(c) - timeSec) < Math.max(EPS, half)) {
          touched = true;
          return { ...c, fadeOut: { durationSec: Math.min(half, c.durationSec), shape } };
        }
        return c;
      });
      return touched ? next : clips;
    });
  }
  return out;
}

function mapSelectedClips(
  session: DawSession, sel: TimeSelection, fn: (c: Clip) => Clip,
): DawSession {
  if (!hasRange(sel)) return session;
  let out = session;
  for (const trackId of sel.trackIds) {
    out = updateClips(out, trackId, (clips) =>
      mapClips(clips, (c) => (overlapsSelection(c, sel) ? fn(c) : c)));
  }
  return out;
}

// ── Consolidate ───────────────────────────────────────────────────────────────

/**
 * Replace the selection's clips with a single clip backed by a freshly
 * rendered file.  The render itself lives in the engine; this applies the
 * result to the model.
 */
export function applyConsolidation(
  session: DawSession, trackId: TrackId, sel: TimeSelection,
  fileId: string, name: string,
): DawSession {
  return updateClips(session, trackId, (clips) => {
    const kept = clips.filter((c) => !overlapsSelection(c, sel));
    return [...kept, createClip(fileId, name, {
      startSec: sel.startSec,
      offsetSec: 0,
      durationSec: selectionLength(sel),
    })];
  });
}

// ── Selection helpers ─────────────────────────────────────────────────────────

/** Grow the selection to the boundaries of the clips it touches. */
export function selectionToClipBounds(session: DawSession, sel: TimeSelection): TimeSelection {
  let start = Infinity;
  let end = -Infinity;
  for (const trackId of sel.trackIds) {
    const track = findTrack(session, trackId);
    if (!track) continue;
    for (const c of trackClips(track)) {
      if (!overlapsSelection(c, sel)) continue;
      start = Math.min(start, c.startSec);
      end = Math.max(end, clipEnd(c));
    }
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return sel;
  return { ...sel, startSec: start, endSec: end };
}

/**
 * The inclusive run of tracks between two rows, in screen order.
 *
 * What a marquee actually selects.  Dragging from the third track up to the
 * first has to give the same three tracks as dragging back down, so the band
 * is taken between the two positions rather than from the anchor forwards —
 * and an id that is not on screen (a collapsed stack member) yields just the
 * anchor rather than an empty selection that looks like the drag did nothing.
 */
export function trackBand(
  order: readonly TrackId[], fromId: TrackId, toId: TrackId,
): TrackId[] {
  const from = order.indexOf(fromId);
  const to = order.indexOf(toId);
  if (from < 0) return [];
  if (to < 0) return [fromId];
  return order.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** All clip edges on the given tracks, sorted — used by boundary navigation. */
export function clipBoundaries(session: DawSession, trackIds: TrackId[]): number[] {
  const edges = new Set<number>();
  for (const trackId of trackIds) {
    const track = findTrack(session, trackId);
    if (!track) continue;
    const pl = activePlaylist(track);
    for (const c of pl?.clips ?? []) { edges.add(c.startSec); edges.add(clipEnd(c)); }
  }
  return [...edges].sort((a, b) => a - b);
}
