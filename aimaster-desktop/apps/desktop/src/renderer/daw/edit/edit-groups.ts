// Edit groups — eight drum tracks that cut as one.
//
// The mixer half of a group already existed: link the faders, the mutes, the
// solos, and move them relatively so the balance survives.  What did not was
// the half that matters after a stem split — selecting a phrase on the snare
// and having the kick, the overheads and the room selected with it, so one
// cut is one cut and not eight.
//
// The mechanism is deliberately ONE hook.  Rather than teaching every edit
// verb about groups — thirty places to add it and thirty places to forget —
// the SELECTION is widened where it is stored.  Everything downstream reads
// the selection, so separate, heal, trim, clear, fades, gain, transpose,
// bounce, strip-silence and the rest follow the group without knowing groups
// exist.  Only the direct-manipulation gestures (dragging a clip) need their
// own handling, because they act on a clip id rather than on a range.
//
// Two consequences worth stating, because both are Pro Tools' behaviour and
// both surprise people who have not met it:
//
//   • the widened selection is what you SEE.  The highlight covers every
//     member, so the group is visible before you press anything rather than
//     after you have cut something you did not mean to.
//   • there is a global suspend.  A group you cannot temporarily switch off
//     is a group people delete instead, and then rebuild for the next edit.

import { clipEnd, findTrack, trackClips, updateClips } from '../model/session-ops.js';
import type { TimeSelection } from './clip-edit.js';
import type { Clip, ClipId, DawSession, GroupDef, TrackId } from '../model/types.js';

const EPS = 1e-9;

/**
 * Does this group link editing?
 *
 * Absent reads as NO.  Every group that exists today was made by a track
 * template to link faders; switching those to move audio because a new field
 * defaulted to true would rewrite people's sessions on load.
 */
export function linksEdit(group: GroupDef): boolean {
  return group.enabled && group.linkEdit === true;
}

/** The edit groups a track belongs to. */
export function editGroupsOf(session: DawSession, trackId: TrackId): GroupDef[] {
  return session.groups.filter((g) => linksEdit(g) && g.memberIds.includes(trackId));
}

/**
 * Every track that edits when this one does, including itself.
 *
 * A track in two edit groups pulls in both — the union, not the first match.
 * Membership is not transitive beyond that: A and B in one group, B and C in
 * another, editing A does not touch C.  Pro Tools behaves the same way, and
 * the alternative makes one careless group join the whole session together.
 */
export function editMembers(session: DawSession, trackId: TrackId): TrackId[] {
  const out = new Set<TrackId>([trackId]);
  for (const g of editGroupsOf(session, trackId)) for (const m of g.memberIds) out.add(m);
  return [...out];
}

/** True when at least one enabled group links editing. */
export function anyEditGroups(session: DawSession): boolean {
  return session.groups.some(linksEdit);
}

/**
 * Widen a selection to every member of every edit group it touches.
 *
 * Order follows the session's own track order rather than the order tracks
 * were added to the selection, so a grouped selection reads top-to-bottom
 * like the arrangement does — and so two selections covering the same tracks
 * compare equal.
 */
export function expandSelection(session: DawSession, sel: TimeSelection): TimeSelection {
  if (sel.trackIds.length === 0 || !anyEditGroups(session)) return sel;
  const wanted = new Set<TrackId>();
  for (const id of sel.trackIds) for (const m of editMembers(session, id)) wanted.add(m);
  if (wanted.size === sel.trackIds.length && sel.trackIds.every((id) => wanted.has(id))) return sel;
  return { ...sel, trackIds: session.tracks.filter((t) => wanted.has(t.id)).map((t) => t.id) };
}

/** A clip on another member that moves when this one does. */
export interface LinkedClip {
  trackId: TrackId;
  clipId: ClipId;
}

/**
 * The clips on the other members that correspond to this one.
 *
 * Matched by TIME, because that is the only thing eight tracks of one take
 * have in common — they have different files, different lengths and no
 * shared ids.  A clip counts as corresponding when it overlaps the span at
 * all, which is what makes a snare hit that starts a few milliseconds late
 * still move with the kick it was played against.
 */
export function linkedClips(
  session: DawSession, trackId: TrackId, clip: Clip,
): LinkedClip[] {
  const out: LinkedClip[] = [];
  const from = clip.startSec;
  const to = clipEnd(clip);
  for (const id of editMembers(session, trackId)) {
    if (id === trackId) continue;
    const track = findTrack(session, id);
    if (!track) continue;
    for (const other of trackClips(track)) {
      if (clipEnd(other) > from + EPS && other.startSec < to - EPS) {
        out.push({ trackId: id, clipId: other.id });
      }
    }
  }
  return out;
}

/**
 * Move a clip and everything grouped with it, by the SAME distance.
 *
 * By distance, not to the same place.  Eight tracks of one take are not
 * aligned to the sample — a snare hit a few milliseconds behind the kick is
 * the performance, and a group move that snapped every member to one
 * position would flatten exactly what the group exists to preserve.
 *
 * The delta is taken from where the dragged clip IS, so a drag that snapped
 * to the grid carries its snapped distance to the others rather than putting
 * them each on their own nearest line.
 */
export function moveClipWithGroup(
  session: DawSession, trackId: TrackId, clipId: ClipId, toSec: number,
): DawSession {
  const track = findTrack(session, trackId);
  const clip = track ? trackClips(track).find((c) => c.id === clipId) : undefined;
  if (!clip) return session;
  const target = Math.max(0, toSec);
  const delta = target - clip.startSec;
  if (Math.abs(delta) < EPS) return session;

  const linked = linkedClips(session, trackId, clip);
  let out = moveOne(session, trackId, clipId, target);
  for (const other of linked) {
    const otherTrack = findTrack(out, other.trackId);
    const otherClip = otherTrack ? trackClips(otherTrack).find((c) => c.id === other.clipId) : undefined;
    if (!otherClip) continue;
    out = moveOne(out, other.trackId, other.clipId, Math.max(0, otherClip.startSec + delta));
  }
  return out;
}

function moveOne(
  session: DawSession, trackId: TrackId, clipId: ClipId, toSec: number,
): DawSession {
  return updateClips(session, trackId, (clips) =>
    clips.map((c) => (c.id === clipId ? { ...c, startSec: Math.max(0, toSec) } : c)));
}

/** `드럼 (4트랙)` — for the toast and the header badge. */
export function describeGroup(group: GroupDef): string {
  return `${group.name} (${group.memberIds.length}트랙)`;
}
