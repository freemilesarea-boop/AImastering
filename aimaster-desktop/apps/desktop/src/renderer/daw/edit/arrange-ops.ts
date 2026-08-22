// Editing the song by the section, not by the clip.
//
// "Make the last chorus twice as long" and "cut the second verse" are single
// thoughts, and in a clip-level editor they are afternoons.  These are the
// ripple edits that make them one action — and a ripple edit is only correct if
// EVERYTHING anchored to the timeline moves together:
//
//   clips        split at the boundary, then moved
//   automation   points inside a cut are dropped, and the lane is re-anchored
//                at the splice so it continues from where it was
//   markers      moved; the ones inside a cut go with it
//   chords       the same
//   sections     the same, and a cut section's own boundary goes too
//   TEMPO        moved in BEATS, not seconds — a tempo event is anchored to a
//                beat, and shifting it in seconds would silently put every
//                later bar line somewhere else
//
// Miss any one of them and the session is quietly inconsistent in a way that
// only shows up three edits later.
//
// The one thing that cannot always follow is the METER map: a signature change
// is anchored to a BAR, so it can only move by a whole number of bars.  When a
// ripple is not a whole number of bars the meter events are left where they are
// and the caller is TOLD, rather than being rounded into the wrong bar.

import { splitClip } from './clip-edit.js';
import { pointValueAt } from '../model/automation.js';
import { clipEnd, findTrack } from '../model/session-ops.js';
import {
  beatsPerBar, meterAtBeat, secToBeat, tempoAtSec, tempoMapOf, withTempoMap,
} from '../model/tempo-map.js';
import {
  rangeOf, removeSectionMarker, sectionLabel, sectionRanges, sectionsOf, shiftSections,
  withSections,
  type Section, type SectionRange,
} from '../model/arrangement.js';
import { nextId } from '../model/ids.js';
import type {
  AutomationLane, ChordEvent, Clip, DawSession, Marker, Playlist, TempoMap, Track,
} from '../model/types.js';

const EPS = 1e-6;

export interface RippleResult {
  session: DawSession;
  /** What could not be moved, said out loud rather than rounded. */
  problems: string[];
}

/** Where the last clip on any track ends — what the final section runs to. */
export function songEnd(session: DawSession): number {
  let end = 0;
  for (const track of session.tracks) {
    for (const playlist of track.playlists) {
      for (const clip of playlist.clips) end = Math.max(end, clipEnd(clip));
    }
  }
  return end;
}

// ── Clips ─────────────────────────────────────────────────────────────────────

/** Open a gap in one playlist: split at `atSec`, then push the tail later. */
function insertIntoClips(clips: readonly Clip[], atSec: number, lengthSec: number): Clip[] {
  const out: Clip[] = [];
  for (const clip of clips) {
    if (clipEnd(clip) <= atSec + EPS) { out.push(clip); continue; }
    if (clip.startSec >= atSec - EPS) {
      out.push({ ...clip, startSec: clip.startSec + lengthSec });
      continue;
    }
    // Straddles the point: the head stays, the tail moves with everything else.
    const [head, tail] = splitClip(clip, atSec);
    out.push(head, { ...tail, startSec: tail.startSec + lengthSec });
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

/** Remove `[fromSec, toSec)` from one playlist and close the gap. */
function deleteFromClips(clips: readonly Clip[], fromSec: number, toSec: number): Clip[] {
  const length = toSec - fromSec;
  const out: Clip[] = [];
  for (const clip of clips) {
    const start = clip.startSec;
    const end = clipEnd(clip);

    if (end <= fromSec + EPS) { out.push(clip); continue; }
    if (start >= toSec - EPS) {
      out.push({ ...clip, startSec: start - length });
      continue;
    }
    // Entirely swallowed.
    if (start >= fromSec - EPS && end <= toSec + EPS) continue;

    if (start < fromSec - EPS && end > toSec + EPS) {
      // Spans the whole cut: keep both ends, and they become neighbours.
      const [head, rest] = splitClip(clip, fromSec);
      const [, tail] = splitClip(rest, toSec);
      out.push(head, { ...tail, startSec: tail.startSec - length });
      continue;
    }
    if (start < fromSec - EPS) {
      // Straddles the front edge — keep what is before the cut.
      out.push(splitClip(clip, fromSec)[0]);
      continue;
    }
    // Straddles the back edge — keep what is after, pulled back.
    const [, tail] = splitClip(clip, toSec);
    out.push({ ...tail, startSec: tail.startSec - length });
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

/**
 * The part of a playlist inside a range, rebased to start at zero.
 *
 * `freshIds` is false when the range is being MOVED rather than copied.  A
 * moved clip is the same clip — renumbering it would break anything holding
 * onto it (a selection, an undo diff) for no reason.  A clip that had to be
 * SPLIT at the range edge is a new object either way, so that half always
 * gets a new id.
 */
function copyClips(
  clips: readonly Clip[], fromSec: number, toSec: number, freshIds = true,
): Clip[] {
  const out: Clip[] = [];
  for (const clip of clips) {
    if (clipEnd(clip) <= fromSec + EPS || clip.startSec >= toSec - EPS) continue;
    let piece: Clip = freshIds ? { ...clip, id: nextId('clip') } : { ...clip };
    if (piece.startSec < fromSec) {
      const [, tail] = splitClip(piece, fromSec);
      piece = { ...tail, id: nextId('clip') };
    }
    if (clipEnd(piece) > toSec) {
      const [head] = splitClip(piece, toSec);
      piece = { ...head, id: nextId('clip') };
    }
    out.push({ ...piece, startSec: piece.startSec - fromSec });
  }
  return out;
}

function mapPlaylists(track: Track, fn: (clips: readonly Clip[]) => Clip[]): Track {
  return { ...track, playlists: track.playlists.map((p): Playlist => ({ ...p, clips: fn(p.clips) })) };
}

// ── Automation ────────────────────────────────────────────────────────────────

function insertIntoLane(lane: AutomationLane, atSec: number, lengthSec: number): AutomationLane {
  return {
    ...lane,
    points: lane.points
      .map((p) => (p.timeSec >= atSec - EPS ? { ...p, timeSec: p.timeSec + lengthSec } : p))
      .sort((a, b) => a.timeSec - b.timeSec),
  };
}

/**
 * Cut a range out of a lane.
 *
 * Points inside go with the audio.  What is left would otherwise ramp straight
 * from the last surviving point before the cut to the first one after it —
 * across a splice where the material changed — so the value the lane HAD at
 * the cut is pinned there.  The lane then continues from where it was, which
 * is what an engineer means by cutting a section out.
 */
function deleteFromLane(lane: AutomationLane, fromSec: number, toSec: number): AutomationLane {
  if (lane.points.length === 0) return lane;
  const length = toSec - fromSec;
  const held = pointValueAt(lane.points, fromSec, lane.points[0]?.value ?? 0);

  const kept = lane.points
    .filter((p) => p.timeSec < fromSec - EPS || p.timeSec >= toSec - EPS)
    .map((p) => (p.timeSec >= toSec - EPS ? { ...p, timeSec: p.timeSec - length } : p));

  const anchored = kept.some((p) => Math.abs(p.timeSec - fromSec) < EPS)
    ? kept
    : [...kept, { timeSec: fromSec, value: held }];

  return { ...lane, points: anchored.sort((a, b) => a.timeSec - b.timeSec) };
}

/**
 * A range of a lane, rebased to start at zero, with BOTH ends pinned.
 *
 * The points inside a range do not describe it on their own.  A lane is a
 * continuous curve, so the value at the start of a range is usually set by a
 * point BEFORE it, and the value at the end by a point AFTER it — a chorus
 * whose volume climbs across it has that climb defined by where the next
 * section begins.
 *
 * Copy only the inside points and the range arrives somewhere else with its
 * shape half-rewritten by its new neighbours: it opens on whatever preceded
 * it there and ramps toward whatever follows.  Pinning both ends is what
 * makes a moved or duplicated section sound like the one that was there.
 */
function copyLane(lane: AutomationLane, fromSec: number, toSec: number): AutomationLane['points'] {
  const inside = lane.points
    .filter((p) => p.timeSec >= fromSec - EPS && p.timeSec < toSec - EPS)
    .map((p) => ({ timeSec: p.timeSec - fromSec, value: p.value }));
  if (lane.points.length === 0) return inside;

  const fallback = lane.points[0]!.value;
  if (!inside.some((p) => Math.abs(p.timeSec) < EPS)) {
    inside.unshift({ timeSec: 0, value: pointValueAt(lane.points, fromSec, fallback) });
  }
  const length = toSec - fromSec;
  if (!inside.some((p) => Math.abs(p.timeSec - length) < EPS)) {
    inside.push({ timeSec: length, value: pointValueAt(lane.points, toSec, fallback) });
  }
  return inside;
}

// ── Points on the timeline (markers, chords) ─────────────────────────────────

function shiftStamped<T extends { timeSec: number }>(
  items: readonly T[], atSec: number, lengthSec: number,
): T[] {
  return items
    .map((m) => (m.timeSec >= atSec - EPS ? { ...m, timeSec: m.timeSec + lengthSec } : m))
    .sort((a, b) => a.timeSec - b.timeSec);
}

function cutStamped<T extends { timeSec: number }>(
  items: readonly T[], fromSec: number, toSec: number,
): T[] {
  const length = toSec - fromSec;
  return items
    .filter((m) => m.timeSec < fromSec - EPS || m.timeSec >= toSec - EPS)
    .map((m) => (m.timeSec >= toSec - EPS ? { ...m, timeSec: m.timeSec - length } : m))
    .sort((a, b) => a.timeSec - b.timeSec);
}

function copyStamped<T extends { timeSec: number }>(
  items: readonly T[], fromSec: number, toSec: number,
): T[] {
  return items
    .filter((m) => m.timeSec >= fromSec - EPS && m.timeSec < toSec - EPS)
    .map((m) => ({ ...m, timeSec: m.timeSec - fromSec }));
}

// ── Tempo ─────────────────────────────────────────────────────────────────────

/**
 * Move the tempo map with the audio.
 *
 * Everything here is in BEATS.  A tempo event says "from beat 64 the song is at
 * 128" — moving it in seconds would leave it on a different beat, and every bar
 * line after it would land somewhere else.
 *
 * `copied` is the duplicated region's own events, already rebased to zero, for
 * a duplicate; empty for an inserted silence, which simply runs at whatever
 * tempo was in force where it was opened.
 */
function insertIntoTempo(
  map: TempoMap, atBeat: number, beats: number,
  copied: readonly { bpm: number; curve: TempoEventCurve }[] = [],
  copiedAtBeats: readonly number[] = [],
): TempoMap {
  const tempos = map.tempos
    .map((t) => (t.beat >= atBeat - 1e-9 ? { ...t, beat: t.beat + beats } : t));
  copied.forEach((event, index) => {
    const offset = copiedAtBeats[index] ?? 0;
    tempos.push({ id: nextId('tempo'), beat: atBeat + offset, bpm: event.bpm, curve: event.curve });
  });
  return { ...map, tempos: tempos.sort((a, b) => a.beat - b.beat) };
}

type TempoEventCurve = TempoMap['tempos'][number]['curve'];

function deleteFromTempo(map: TempoMap, fromBeat: number, toBeat: number): TempoMap {
  const beats = toBeat - fromBeat;
  const kept = map.tempos
    .filter((t) => t.beat < fromBeat - 1e-9 || t.beat >= toBeat - 1e-9)
    .map((t) => (t.beat >= toBeat - 1e-9 ? { ...t, beat: t.beat - beats } : t));
  // Beat 0 must always carry a tempo; the normaliser will re-add one, but
  // keeping the first event here means the song does not change speed because
  // of a cut that happened later.
  return { ...map, tempos: kept.sort((a, b) => a.beat - b.beat) };
}

/**
 * Move signature changes, when the ripple is a whole number of bars.
 *
 * Returns null when it is not — a meter event is anchored to a bar and there is
 * no honest way to move it by two and a half of them.
 */
function shiftMeters(
  map: TempoMap, fromBar: number, bars: number,
): TempoMap['meters'] | null {
  if (Math.abs(bars - Math.round(bars)) > 1e-6) return null;
  const whole = Math.round(bars);
  return map.meters
    .map((m) => (m.bar >= fromBar ? { ...m, bar: Math.max(1, m.bar + whole) } : m))
    .sort((a, b) => a.bar - b.bar);
}

/** How many bars a beat span covers, at the meter in force where it starts. */
function barsIn(map: TempoMap, atBeat: number, beats: number): number {
  return beats / beatsPerBar(meterAtBeat(map, atBeat));
}

// ── The two primitives ────────────────────────────────────────────────────────

/**
 * Open `lengthSec` of empty time at `atSec`.
 *
 * The gap runs at whatever tempo was in force where it was opened, which is the
 * only answer that does not invent a tempo change nobody asked for.
 */
export function rippleInsert(
  session: DawSession, atSec: number, lengthSec: number,
): RippleResult {
  if (!(lengthSec > 0)) return { session, problems: ['길이가 0 입니다'] };
  const problems: string[] = [];
  const map = tempoMapOf(session);
  const atBeat = secToBeat(map, atSec);
  const beats = (lengthSec * tempoAtSec(map, atSec)) / 60;

  let next: DawSession = {
    ...session,
    tracks: session.tracks.map((t) => ({
      ...mapPlaylists(t, (clips) => insertIntoClips(clips, atSec, lengthSec)),
      automation: t.automation.map((lane) => insertIntoLane(lane, atSec, lengthSec)),
    })),
    markers: shiftStamped<Marker>(session.markers, atSec, lengthSec),
    chordTrack: shiftStamped<ChordEvent>(session.chordTrack, atSec, lengthSec),
  };

  const shifted = insertIntoTempo(map, atBeat, beats);
  const meters = shiftMeters(map, Math.floor(atBeat / beatsPerBar(meterAtBeat(map, atBeat))) + 1,
    barsIn(map, atBeat, beats));
  if (meters === null) {
    problems.push('삽입 길이가 마디 단위가 아니라 박자 변경은 그대로 두었습니다');
  }
  next = withTempoMap(next, meters === null ? shifted : { ...shifted, meters });
  next = withSections(next, shiftSections(sectionsOf(session), atSec, lengthSec));
  return { session: next, problems };
}

/** Remove `[fromSec, toSec)` from the timeline and close the gap. */
export function rippleDelete(
  session: DawSession, fromSec: number, toSec: number,
): RippleResult {
  const length = toSec - fromSec;
  if (!(length > 0)) return { session, problems: ['구간의 길이가 0 입니다'] };
  const problems: string[] = [];
  const map = tempoMapOf(session);
  const fromBeat = secToBeat(map, fromSec);
  const toBeat = secToBeat(map, toSec);

  let next: DawSession = {
    ...session,
    tracks: session.tracks.map((t) => ({
      ...mapPlaylists(t, (clips) => deleteFromClips(clips, fromSec, toSec)),
      automation: t.automation.map((lane) => deleteFromLane(lane, fromSec, toSec)),
    })),
    markers: cutStamped<Marker>(session.markers, fromSec, toSec),
    chordTrack: cutStamped<ChordEvent>(session.chordTrack, fromSec, toSec),
  };

  const cut = deleteFromTempo(map, fromBeat, toBeat);
  const meters = shiftMeters(map,
    Math.floor(fromBeat / beatsPerBar(meterAtBeat(map, fromBeat))) + 1,
    -barsIn(map, fromBeat, toBeat - fromBeat));
  if (meters === null) {
    problems.push('삭제 길이가 마디 단위가 아니라 박자 변경은 그대로 두었습니다');
  }
  next = withTempoMap(next, meters === null ? cut : { ...cut, meters });

  // Sections strictly inside the cut go with it; the rest slide back.
  const kept = sectionsOf(session).filter(
    (s) => s.startSec < fromSec - EPS || s.startSec >= toSec - EPS);
  next = withSections(next, shiftSections(kept, toSec, -length));
  return { session: next, problems };
}

// ── Section operations ────────────────────────────────────────────────────────

function rangeFor(session: DawSession, sectionId: string): SectionRange | null {
  return rangeOf(sectionsOf(session), sectionId, songEnd(session));
}

/**
 * Double a section: copy its contents and lay them down immediately after.
 *
 * "Make the last chorus twice as long" is one thought and this is one action.
 * The copy carries the clips, the automation, the markers, the chords AND the
 * section's own tempo events — so a chorus that speeds up still speeds up the
 * second time round.
 */
// ── Lifting a section out, and putting one down ──────────────────────────────

/**
 * Everything inside a stretch of timeline, rebased so it starts at zero.
 *
 * Read BEFORE any gap is opened or closed — the whole point is to hold the
 * content while the timeline underneath it changes.  Duplicating a section and
 * moving one are the same lift, put down in different places.
 */
export interface SectionContent {
  /** False when this was lifted to be moved — see `LiftOptions.freshIds`. */
  freshIds: boolean;
  lengthSec: number;
  /** Clips by track id, then playlist id. */
  clips: Map<string, Map<string, Clip[]>>;
  /** Automation points by track id, then lane id. */
  lanes: Map<string, Map<string, AutomationLane['points']>>;
  markers: Marker[];
  chords: ChordEvent[];
  /** Tempo events, as offsets in beats from the start of the range. */
  tempos: Array<{ bpm: number; curve: TempoEventCurve; offset: number }>;
  /** Length in beats — what the tempo map has to make room for. */
  beats: number;
  /** The section's own label, for the boundary that lands with it. */
  section: Section;
}

export interface LiftOptions {
  /**
   * Give everything new ids.
   *
   * True for a duplicate — the copy is a different clip from the original.
   * False for a MOVE, where the clip that lands is the same clip that left,
   * and renumbering it would break anything holding onto it.
   */
  freshIds?: boolean;
}

export function liftSection(
  session: DawSession, range: SectionRange, options: LiftOptions = {},
): SectionContent {
  const freshIds = options.freshIds !== false;
  const map = tempoMapOf(session);
  const startBeat = secToBeat(map, range.startSec);
  const endBeat = secToBeat(map, range.endSec);

  const clips = new Map<string, Map<string, Clip[]>>();
  const lanes = new Map<string, Map<string, AutomationLane['points']>>();
  for (const track of session.tracks) {
    const byPlaylist = new Map<string, Clip[]>();
    for (const playlist of track.playlists) {
      byPlaylist.set(playlist.id,
        copyClips(playlist.clips, range.startSec, range.endSec, freshIds));
    }
    clips.set(track.id, byPlaylist);
    const byLane = new Map<string, AutomationLane['points']>();
    for (const lane of track.automation) {
      byLane.set(lane.id, copyLane(lane, range.startSec, range.endSec));
    }
    lanes.set(track.id, byLane);
  }

  return {
    freshIds,
    lengthSec: range.endSec - range.startSec,
    clips,
    lanes,
    markers: copyStamped<Marker>(session.markers, range.startSec, range.endSec),
    chords: copyStamped<ChordEvent>(session.chordTrack, range.startSec, range.endSec),
    tempos: map.tempos
      .filter((t) => t.beat >= startBeat - 1e-9 && t.beat < endBeat - 1e-9)
      .map((t) => ({ bpm: t.bpm, curve: t.curve, offset: t.beat - startBeat })),
    beats: endBeat - startBeat,
    section: range.section,
  };
}

/**
 * Open a gap at `atSec` and lay a lifted section into it.
 *
 * `withBoundary` decides whether the copy gets a section marker of its own.
 * A duplicate wants one — the arrangement should read intro · chorus · chorus
 * rather than one chorus that is mysteriously twice as long — and so does a
 * move, because the section has to still exist afterwards.
 */
export function dropSection(
  session: DawSession, content: SectionContent, atSec: number,
  options: { boundary?: Section | null } = {},
): RippleResult {
  const { lengthSec: length, beats } = content;
  if (!(length > 0)) return { session, problems: ['구간의 길이가 0 입니다'] };

  const problems: string[] = [];
  const map = tempoMapOf(session);
  const atBeat = secToBeat(map, atSec);
  const at = atSec;

  let next: DawSession = {
    ...session,
    tracks: session.tracks.map((track) => {
      const clipsFor = content.clips.get(track.id);
      const lanesFor = content.lanes.get(track.id);
      return {
        ...track,
        playlists: track.playlists.map((playlist): Playlist => ({
          ...playlist,
          clips: [
            ...insertIntoClips(playlist.clips, at, length),
            ...(clipsFor?.get(playlist.id) ?? []).map((c) => ({
              ...c,
              ...(content.freshIds ? { id: nextId('clip') } : {}),
              startSec: c.startSec + at,
            })),
          ].sort((a, b) => a.startSec - b.startSec),
        })),
        automation: track.automation.map((lane) => {
          const opened = insertIntoLane(lane, at, length);
          const copied = (lanesFor?.get(lane.id) ?? [])
            .map((p) => ({ timeSec: p.timeSec + at, value: p.value }));
          if (copied.length === 0) return opened;
          // A point already at the splice would be doubled; the copy wins,
          // because it is what now plays there.
          const kept = opened.points.filter(
            (p) => !copied.some((c) => Math.abs(c.timeSec - p.timeSec) < EPS));
          return { ...lane, points: [...kept, ...copied].sort((a, b) => a.timeSec - b.timeSec) };
        }),
      };
    }),
    markers: [
      ...shiftStamped<Marker>(session.markers, at, length),
      ...content.markers.map((m) => ({
        ...m, ...(content.freshIds ? { id: nextId('mk') } : {}), timeSec: m.timeSec + at,
      })),
    ].sort((a, b) => a.timeSec - b.timeSec),
    chordTrack: [
      ...shiftStamped<ChordEvent>(session.chordTrack, at, length),
      ...content.chords.map((c) => ({
        ...c, ...(content.freshIds ? { id: nextId('chord') } : {}), timeSec: c.timeSec + at,
      })),
    ].sort((a, b) => a.timeSec - b.timeSec),
  };

  const withTempo = insertIntoTempo(
    map, atBeat, beats,
    content.tempos.map((t) => ({ bpm: t.bpm, curve: t.curve })),
    content.tempos.map((t) => t.offset),
  );
  const meters = shiftMeters(map,
    Math.floor(atBeat / beatsPerBar(meterAtBeat(map, atBeat))) + 1,
    barsIn(map, atBeat, beats));
  if (meters === null) {
    problems.push('구간 길이가 마디 단위가 아니라 박자 변경은 그대로 두었습니다');
  }
  next = withTempoMap(next, meters === null ? withTempo : { ...withTempo, meters });

  const shiftedSections = shiftSections(sectionsOf(session), at, length);
  const boundary = options.boundary;
  next = withSections(next, boundary === null ? shiftedSections : [
    ...shiftedSections,
    {
      ...(boundary ?? content.section),
      ...(content.freshIds ? { id: nextId('sect') } : {}),
      startSec: at,
    },
  ]);
  return { session: next, problems };
}

/**
 * Double a section: copy its contents and lay them down immediately after.
 *
 * "Make the last chorus twice as long" is one thought and this is one action.
 * The copy carries the clips, the automation, the markers, the chords AND the
 * section's own tempo events — so a chorus that speeds up still speeds up the
 * second time round.
 */
export function duplicateSection(
  session: DawSession, sectionId: string,
): RippleResult {
  const range = rangeFor(session, sectionId);
  if (!range) return { session, problems: ['구간을 찾을 수 없습니다'] };
  const content = liftSection(session, range);
  if (!(content.lengthSec > 0)) return { session, problems: ['구간의 길이가 0 입니다'] };
  return dropSection(session, content, range.endSec);
}

// ── Reordering ────────────────────────────────────────────────────────────────

/**
 * Move a section to a different place in the running order.
 *
 * "Put the second chorus before the bridge" is one thought, and doing it by
 * hand is a morning: select the range, cut with ripple, find the new spot,
 * paste with ripple, fix the automation that did not come, notice the tempo
 * ramp stayed behind.
 *
 * It is a LIFT and a DROP — the same two halves duplicate is built from — so
 * everything that rides along there rides along here: clips, automation,
 * markers, chords, and the section's own tempo events.
 *
 * `toIndex` is the position the section should END UP at, which is what a
 * drag lands on.  It is read against the order WITHOUT the moved section, so
 * dragging the 3rd of 4 sections to index 1 gives A · C · B · D.
 */
export function moveSection(
  session: DawSession, sectionId: string, toIndex: number,
): RippleResult {
  const sections = sectionsOf(session);
  const ranges = sectionRanges(sections, songEnd(session));
  const from = ranges.findIndex((r) => r.section.id === sectionId);
  if (from < 0) return { session, problems: ['구간을 찾을 수 없습니다'] };

  const range = ranges[from]!;
  // Moved, not copied: everything keeps the id it had.
  const content = liftSection(session, range, { freshIds: false });
  if (!(content.lengthSec > 0)) return { session, problems: ['구간의 길이가 0 입니다'] };

  // Where it lands is expressed as "before this section", resolved BEFORE the
  // cut so it survives everything shifting backwards afterwards.  Null means
  // the end of the song.
  const remaining = ranges.filter((r) => r.section.id !== sectionId);
  const clamped = Math.max(0, Math.min(remaining.length, Math.round(toIndex)));
  if (clamped === from && remaining.length > 0) {
    // Landing where it already is: not an error, just nothing to do.  Doing
    // the cut-and-splice anyway would renumber every id for no change.
    return { session, problems: [] };
  }
  const beforeId = remaining[clamped]?.section.id ?? null;

  // Cut the section's time out.  Its boundary goes with it — the copy that
  // lands at the destination carries the label.
  const cut = rippleDelete(session, range.startSec, range.endSec);
  const withoutMarker = withSections(
    cut.session, removeSectionMarker(sectionsOf(cut.session), sectionId));

  // The destination, read in the shortened timeline.
  const after = sectionsOf(withoutMarker);
  const target = beforeId ? after.find((sec) => sec.id === beforeId) ?? null : null;
  const atSec = target ? target.startSec : songEnd(withoutMarker);

  const dropped = dropSection(withoutMarker, content, atSec, { boundary: range.section });
  return {
    session: dropped.session,
    problems: [...cut.problems, ...dropped.problems],
  };
}

/**
 * Swap a section with its neighbour — the keyboard version of a drag.
 *
 * Expressed in terms of `moveSection` rather than as its own splice: two ways
 * of reordering would be two chances to disagree about what rides along.
 */
export function nudgeSection(
  session: DawSession, sectionId: string, direction: -1 | 1,
): RippleResult {
  const ranges = sectionRanges(sectionsOf(session), songEnd(session));
  const from = ranges.findIndex((r) => r.section.id === sectionId);
  if (from < 0) return { session, problems: ['구간을 찾을 수 없습니다'] };
  const to = from + direction;
  if (to < 0 || to >= ranges.length) {
    return { session, problems: [direction < 0 ? '첫 구간입니다' : '마지막 구간입니다'] };
  }
  return moveSection(session, sectionId, to);
}

/**
 * The order as text — "인트로 · 벌스 · 코러스" — for the toast after a move.
 *
 * The point of saying it is that a reorder is invisible until the playhead
 * gets there; reading the new running order back confirms what happened.
 */
export function describeOrder(session: DawSession): string {
  return sectionRanges(sectionsOf(session), songEnd(session))
    .map((r) => sectionLabel(r.section))
    .join(' · ');
}

/**
 * Cut a section out of the song, and its time with it.
 *
 * Distinct from deleting the boundary, which only changes where the labels are.
 * This is the one that makes the song shorter.
 */
export function deleteSectionTime(
  session: DawSession, sectionId: string,
): RippleResult {
  const range = rangeFor(session, sectionId);
  if (!range) return { session, problems: ['구간을 찾을 수 없습니다'] };
  if (!(range.endSec - range.startSec > 0)) {
    return { session, problems: ['구간의 길이가 0 입니다'] };
  }
  const cut = rippleDelete(session, range.startSec, range.endSec);
  // `rippleDelete` keeps a boundary that sits exactly on the cut's start; this
  // one is the section being removed, so it goes too.
  return {
    ...cut,
    session: withSections(cut.session, removeSectionMarker(sectionsOf(cut.session), sectionId)),
  };
}

/** The time range a section covers — what "select the chorus" selects. */
export function selectionForSection(
  session: DawSession, sectionId: string,
): { startSec: number; endSec: number; trackIds: string[] } | null {
  const range = rangeFor(session, sectionId);
  if (!range) return null;
  return {
    startSec: range.startSec,
    endSec: range.endSec,
    trackIds: session.tracks.map((t) => t.id),
  };
}

/** True when a track has anything at all inside a section. */
export function sectionHasContent(
  session: DawSession, trackId: string, range: SectionRange,
): boolean {
  const track = findTrack(session, trackId);
  if (!track) return false;
  return track.playlists.some((p) => p.clips.some(
    (c) => clipEnd(c) > range.startSec + EPS && c.startSec < range.endSec - EPS));
}
