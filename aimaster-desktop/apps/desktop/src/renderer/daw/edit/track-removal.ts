// track-removal.ts — what deleting a track is about to cost.
//
// `removeTrack` has been in session-ops.ts, tested, since the sessions model
// was written, with NO caller anywhere in the app: five ways to add a channel
// — audio, instrument, Aux, VCA, duplicate — and none to take one away.  The
// undo history even carries a label for it, `tracks-removed: 트랙 삭제`, ready
// to describe something that could not happen.
//
// Deleting a track is the most destructive single action in the arrangement —
// it takes the clips, the automation, the whole insert chain, and it is not
// obvious from the outside how much of that there is on a lane that happens
// to be scrolled out of view.  So the confirmation says the number, and the
// numbers come from here rather than from a component, so they can be checked.
//
// It also says what SURVIVES, which is the half people get wrong: deleting a
// folder promotes its children rather than deleting them, and a confirmation
// that only counted losses would read as though the takes were going too.

import type { DawSession, TrackId } from '../model/types.js';

export interface RemovalCost {
  /** Names of the tracks that would go, in session order. */
  names: string[];
  /** The master, if it was asked for — it is refused, and that is worth saying. */
  refused: string[];
  clips: number;
  inserts: number;
  sends: number;
  automationLanes: number;
  /** Folder children that would be promoted rather than deleted. */
  promoted: string[];
  /** Summing buses that would go with their folder. */
  buses: string[];
  /** Groups that would lose at least one member. */
  groups: string[];
  /** Tracks that would lose the VCA controlling them. */
  freedFromVca: string[];
}

export function removalCost(session: DawSession, ids: readonly TrackId[]): RemovalCost {
  const wanted = new Set(ids);
  const going = session.tracks.filter((t) => wanted.has(t.id) && t.kind !== 'master');
  const goingIds = new Set(going.map((t) => t.id));

  let clips = 0, inserts = 0, sends = 0, automationLanes = 0;
  for (const t of going) {
    // Every playlist, not just the active one: an alternate take is still a
    // recording somebody made, and it goes with the track.
    for (const p of t.playlists) clips += p.clips.length;
    inserts += t.inserts.length;
    sends += t.sends.length;
    automationLanes += t.automation.length;
  }

  const buses = going
    .filter((t) => t.kind === 'folder' && t.input !== null)
    .map((t) => session.buses.find((b) => b.id === t.input)?.name ?? t.input as string);

  // Children of a folder that is going, that are not themselves going.
  const promoted = session.tracks
    .filter((t) => !goingIds.has(t.id) && t.parentId !== null && goingIds.has(t.parentId))
    .map((t) => t.name);

  return {
    names: going.map((t) => t.name),
    refused: session.tracks
      .filter((t) => wanted.has(t.id) && t.kind === 'master').map((t) => t.name),
    clips, inserts, sends, automationLanes, promoted, buses,
    groups: session.groups
      .filter((g) => g.memberIds.some((m) => goingIds.has(m))).map((g) => g.name),
    freedFromVca: session.tracks
      .filter((t) => !goingIds.has(t.id) && t.vcaId !== null && goingIds.has(t.vcaId))
      .map((t) => t.name),
  };
}

/**
 * The confirmation's second line: what goes, and what does not.
 *
 * Zero counts are left out rather than printed as "클립 0개" — a list of
 * zeroes is noise, and the one number that matters gets lost in it.
 */
export function describeRemoval(cost: RemovalCost): string {
  if (cost.names.length === 0) {
    return cost.refused.length > 0 ? '마스터는 지울 수 없습니다' : '지울 트랙이 없습니다';
  }
  const losing: string[] = [];
  if (cost.clips) losing.push(`클립 ${cost.clips}개`);
  if (cost.inserts) losing.push(`인서트 ${cost.inserts}개`);
  if (cost.sends) losing.push(`센드 ${cost.sends}개`);
  if (cost.automationLanes) losing.push(`오토메이션 ${cost.automationLanes}줄`);
  if (cost.buses.length) losing.push(`버스 ${cost.buses.length}개`);

  const parts = [losing.length > 0 ? losing.join(' · ') : '비어 있는 트랙입니다'];
  if (cost.promoted.length) parts.push(`안의 트랙 ${cost.promoted.length}개는 남습니다`);
  if (cost.groups.length) parts.push(`그룹 ${cost.groups.length}개에서 빠집니다`);
  if (cost.freedFromVca.length) parts.push(`VCA ${cost.freedFromVca.length}개 해제`);
  if (cost.refused.length) parts.push('마스터는 제외');
  return parts.join(' · ');
}

/** The confirmation's first line. */
export function removalTitle(cost: RemovalCost): string {
  if (cost.names.length === 0) return '지울 트랙이 없습니다';
  return cost.names.length === 1
    ? `${cost.names[0]} 삭제할까요?`
    : `트랙 ${cost.names.length}개 삭제할까요? — ${cost.names.slice(0, 3).join(', ')}${
      cost.names.length > 3 ? ` 외 ${cost.names.length - 3}개` : ''}`;
}
