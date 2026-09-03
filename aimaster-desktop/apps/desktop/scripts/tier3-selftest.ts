/**
 * tier3-selftest.ts — memory locations, snap modes, fill, rename, history.
 *
 * Five features that share nothing except being the last of the Cubase /
 * Pro Tools list, so one suite covers all five rather than five suites of
 * fifteen lines each.
 *
 * What is worth testing in each is the decision the feature turns on:
 *
 *   • Memory locations — that storing on a taken slot REPLACES, that a slot
 *     with a dead track recalls as a position rather than as a selection over
 *     nothing, and that `nextFreeSlot` reuses a hole.
 *   • Snap modes — that Relative keeps the offset the clip was dragged in with
 *     (that IS the mode), that Magnetic does nothing when you are far away,
 *     and that Events lands on the edge next door, which is not on the grid.
 *   • Repeat fill — that the last copy never damages the bar past the
 *     selection, which is the bug the trim-the-clipboard design exists to
 *     prevent.
 *   • Batch rename — that the preview is a preview, and that `#` padding and
 *     numbering-within-the-selection work.
 *   • History log — that the diff names the right thing, and names the FIRST
 *     right thing when several are true.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:tier3
 */

import {
  MEMORY_SLOTS, clearLocation, describeLocation, hasSlot, locationAt, memoryLocations,
  moveLocation, nextFreeSlot, recallLocation, renameLocation, slotForKey, slotKey,
  storeLocation,
} from '../src/renderer/daw/model/memory-locations.js';
import {
  SNAP_RADIUS_PX, cycleSnap, describeSnap, eventTimes, nearestOf, radiusSec,
  snapDelta, snapMove, snapTime, type SnapContext, type SnapMode,
} from '../src/renderer/daw/model/snap-modes.js';
import {
  MAX_FILL_COPIES, describeFill, planFill, repeatFill, trimClipboard,
} from '../src/renderer/daw/edit/repeat-fill.js';
import {
  DEFAULT_RENAME, describeRename, expandPattern, planRename, renameMap, renameOne,
} from '../src/renderer/daw/edit/batch-rename.js';
import {
  describeChange, diffSessions, focusSecOf, historyEntries, stepsTo,
} from '../src/renderer/daw/edit/history-log.js';
import { copyRange } from '../src/renderer/daw/edit/clipboard.js';
import {
  addTrack, clipEnd, createClip, createSession, createTrack, findTrack, removeTrack,
  trackClips, updateClips, updateTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { defaultTempoMap } from '../src/renderer/daw/model/tempo-map.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { DawSession, TrackId } from '../src/renderer/daw/model/types.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function near(a: number, b: number, eps: number, m: string): void {
  if (!(Math.abs(a - b) <= eps)) throw new Error(`${m} — ${a} vs ${b}`);
}

/**
 * Two AUDIO tracks, each with a clip at 0-4 s and another at 8-12 s.
 *
 * Picked by name, not by index: `createSession` puts a Master at index 0, and
 * a fixture that hangs clips off the master would still pass most of these
 * while testing something that cannot happen.
 */
function twoTracks(): { session: DawSession; a: TrackId; b: TrackId } {
  resetIds();
  let s = createSession('tier3', 48_000);
  for (const name of ['Vox', 'Gtr']) s = addTrack(s, createTrack(name, 'audio'));
  const byName = (n: string): TrackId => s.tracks.find((t) => t.name === n)!.id;
  const a = byName('Vox');
  const b = byName('Gtr');
  for (const id of [a, b]) {
    s = updateClips(s, id, () => [
      createClip('f1', 'one', { startSec: 0, offsetSec: 0, durationSec: 4 }),
      createClip('f1', 'two', { startSec: 8, offsetSec: 0, durationSec: 4 }),
    ]);
  }
  return { session: s, a, b };
}

// ── Memory locations ────────────────────────────────────────────────────────

check('a stored slot comes back with its time', () => {
  const { session } = twoTracks();
  const s = storeLocation(session, 3, { timeSec: 12.5 });
  const loc = locationAt(s, 3);
  assert(loc !== null, 'slot 3 is filled');
  near(loc!.timeSec, 12.5, 1e-9, 'the time it was given');
  assert(loc!.endSec === undefined, 'a bare position stores no range');
});

check('storing on a taken slot replaces, keeping the id', () => {
  const { session } = twoTracks();
  const first = storeLocation(session, 1, { timeSec: 4, name: 'A' });
  const id = locationAt(first, 1)!.id;
  const second = storeLocation(first, 1, { timeSec: 9, name: 'B' });
  assert(memoryLocations(second).length === 1, 'still one location, not two');
  near(locationAt(second, 1)!.timeSec, 9, 1e-9, 'moved to the new time');
  assert(locationAt(second, 1)!.id === id, 'the same marker, moved');
});

check('a range slot recalls as a selection, a bare one does not', () => {
  const { session, a } = twoTracks();
  const withRange = storeLocation(session, 2, { timeSec: 1, endSec: 5, trackIds: [a] });
  const r1 = recallLocation(withRange, 2)!;
  assert(r1.selection !== undefined, 'the range comes back');
  near(r1.selection!.endSec, 5, 1e-9, 'to its end');
  const bare = storeLocation(session, 4, { timeSec: 7 });
  assert(recallLocation(bare, 4)!.selection === undefined, 'a position leaves the selection alone');
});

check('a slot whose tracks are gone recalls as a position', () => {
  const { session, a } = twoTracks();
  const stored = storeLocation(session, 5, { timeSec: 2, endSec: 6, trackIds: [a] });
  const gone = removeTrack(stored, a);
  const recall = recallLocation(gone, 5)!;
  near(recall.playheadSec, 2, 1e-9, 'the time survives');
  assert(recall.selection === undefined, 'no selection over a track that is not there');
});

check('a slot keeps the tracks that are still there', () => {
  const { session, a, b } = twoTracks();
  const stored = storeLocation(session, 6, { timeSec: 0, endSec: 4, trackIds: [a, b] });
  const recall = recallLocation(removeTrack(stored, b), 6)!;
  assert(recall.selection?.trackIds.length === 1, 'one of the two survives');
  assert(recall.selection?.trackIds[0] === a, 'and it is the right one');
});

check('nextFreeSlot fills the hole, not the end', () => {
  const { session } = twoTracks();
  let s = session;
  for (const n of [1, 2, 3, 4]) s = storeLocation(s, n, { timeSec: n });
  s = clearLocation(s, 2);
  assert(nextFreeSlot(s) === 2, `the hole at 2, got ${nextFreeSlot(s)}`);
});

check('all ten full means no free slot', () => {
  const { session } = twoTracks();
  let s = session;
  for (let n = 1; n <= MEMORY_SLOTS; n++) s = storeLocation(s, n, { timeSec: n });
  assert(nextFreeSlot(s) === null, 'nothing free');
  assert(memoryLocations(s).length === MEMORY_SLOTS, 'ten locations');
  assert(memoryLocations(s)[0]!.slot === 1, 'listed in slot order');
});

check('slot 0 is the tenth key, and a letter is no slot', () => {
  assert(slotForKey('0') === 10, 'zero is ten');
  assert(slotForKey('1') === 1, 'one is one');
  assert(slotForKey('k') === null, 'a letter recalls nothing');
  assert(slotKey(10) === '0', 'and back again');
  assert(slotKey(11) === null, 'eleven is out of range');
});

check('an out-of-range slot changes nothing', () => {
  const { session } = twoTracks();
  assert(storeLocation(session, 0, { timeSec: 1 }) === session, 'slot 0 is not a slot');
  assert(storeLocation(session, 11, { timeSec: 1 }) === session, 'nor is 11');
  assert(clearLocation(session, 3) === session, 'clearing an empty slot is identity');
});

check('a plain marker is not a memory location', () => {
  const { session } = twoTracks();
  const s = { ...session, markers: [{ id: 'm1', name: 'chorus', timeSec: 30 }] };
  assert(memoryLocations(s).length === 0, 'no slot, no location');
  assert(!hasSlot(s.markers[0]!), 'and hasSlot says so');
  const stored = storeLocation(s, 1, { timeSec: 5 });
  assert(stored.markers.length === 2, 'the named marker survives storing a slot');
});

check('moving a slot keeps its name and its range length', () => {
  const { session, a } = twoTracks();
  const s = storeLocation(session, 7, { timeSec: 2, endSec: 6, trackIds: [a], name: '후렴' });
  const moved = moveLocation(s, 7, 10);
  const loc = locationAt(moved, 7)!;
  near(loc.timeSec, 10, 1e-9, 'the new start');
  near(loc.endSec!, 14, 1e-9, 'the same four seconds');
  assert(loc.name === '후렴', 'the name it was given');
});

check('rename refuses an empty name and reports the range', () => {
  const { session } = twoTracks();
  const s = storeLocation(session, 1, { timeSec: 1, endSec: 3 });
  assert(renameLocation(s, 1, '   ') === s, 'whitespace is not a name');
  const named = renameLocation(s, 1, 'A');
  assert(locationAt(named, 1)!.name === 'A', 'a real name lands');
  assert(describeLocation(locationAt(named, 1)!).includes('+2.00s'), 'the line shows the length');
});

// ── Snap modes ──────────────────────────────────────────────────────────────

/** 120 BPM: one beat = 0.5 s, one 4/4 bar = 2 s. */
function ctx(over: Partial<SnapContext> = {}): SnapContext {
  return { tempoMap: defaultTempoMap(120, [4, 4]), gridDivision: 1, pxPerSec: 50, ...over };
}

check('off returns the time untouched', () => {
  near(snapTime('off', ctx(), 3.317), 3.317, 1e-9, 'no snap');
});

check('grid rounds to the beat', () => {
  near(snapTime('grid', ctx(), 1.3), 1.5, 1e-6, 'up to beat 3');
  near(snapTime('grid', ctx(), 1.2), 1.0, 1e-6, 'down to beat 2');
});

check('relative moves by whole grid units, keeping the offset', () => {
  // A clip sitting 0.12 s late.  Dragged 2.1 s to the right.
  const to = snapMove('relative', ctx(), 1.12, 3.22);
  near(to, 3.12, 1e-6, 'four beats later, still 0.12 late');
  assert(Math.abs(to - snapTime('grid', ctx(), 3.22)) > 1e-6, 'and NOT on the grid line');
});

check('relative with no drag is no move', () => {
  near(snapMove('relative', ctx(), 1.12, 1.12), 1.12, 1e-6, 'zero steps');
  near(snapDelta('relative', ctx(), 1.12, 1.3), 0, 1e-6, 'a nudge under half a beat rounds to nothing');
});

check('relative snaps a bare time as grid — there is nothing to be relative to', () => {
  near(snapTime('relative', ctx(), 1.3), 1.5, 1e-6, 'falls back to absolute');
});

check('magnetic snaps when close and lets go when far', () => {
  // 50 px/s → the 12 px radius is 0.24 s.
  const c = ctx();
  near(radiusSec(c), SNAP_RADIUS_PX / 50, 1e-9, 'the radius in seconds');
  near(snapTime('magnetic', c, 1.4), 1.5, 1e-6, '0.1 s away: snaps');
  near(snapTime('magnetic', c, 1.25), 1.25, 1e-6, '0.25 s away: free');
});

check('magnetic radius follows the zoom', () => {
  // Zoomed in ten times, 12 px is 0.024 s and the same drag is now far away.
  near(snapTime('magnetic', ctx({ pxPerSec: 500 }), 1.4), 1.4, 1e-6, 'no longer close enough');
});

check('events lands on a clip edge that is not on the grid', () => {
  const c = ctx({ events: [3.37, 8, 12] });
  near(snapTime('events', c, 3.3), 3.37, 1e-6, 'the edge, not the beat');
  near(snapTime('events', c, 5.0), 5.0, 1e-6, 'nothing near: free');
});

check('nearestOf breaks a tie toward the earlier time', () => {
  assert(nearestOf([2, 4], 3) === 2, 'the earlier of the two');
  assert(nearestOf([], 3) === null, 'nothing to land on');
});

check('eventTimes dedupes and sorts, dropping negatives', () => {
  const t = eventTimes([8, 0, 4], [4, 12], [-1]);
  assert(t.join(',') === '0,4,8,12', `got ${t.join(',')}`);
});

check('a zero grid disables the musical modes but not events', () => {
  const c = ctx({ gridDivision: 0, events: [4] });
  near(snapTime('grid', c, 1.3), 1.3, 1e-9, 'no division, no grid');
  near(snapMove('relative', c, 1, 3.3), 3.3, 1e-9, 'nor relative');
  near(snapTime('events', c, 4.1), 4, 1e-6, 'events do not need a grid');
});

check('snap never returns a negative time', () => {
  // Relative grid CANNOT put this clip earlier: it sits 0.2 s past the line,
  // and one step left is -0.3 s, which does not exist.  So it stays — that is
  // the mode working, not a failure to clamp.
  near(snapMove('relative', ctx(), 0.2, -5), 0.2, 1e-9, 'no earlier step exists');
  near(snapMove('relative', ctx(), 2.2, -5), 0.2, 1e-6, 'from further out it walks back to the last legal step');
  near(snapTime('grid', ctx(), -3), 0, 1e-9, 'a bare time clamps to zero');
  near(snapTime('events', ctx({ events: [-4] }), 0.05), 0.05, 1e-9, 'and a negative event is never landed on');
});

check('cycling reaches every mode and comes back', () => {
  let m: SnapMode = 'off';
  const seen = new Set<SnapMode>([m]);
  for (let i = 0; i < 5; i++) { m = cycleSnap(m); seen.add(m); }
  assert(seen.size === 5, `all five, got ${seen.size}`);
  assert(m === 'off', 'five steps returns to the start');
});

check('describeSnap names the grid in musical units', () => {
  assert(describeSnap('grid', 4).includes('1마디'), 'a bar');
  assert(describeSnap('grid', 0.25).includes('1/16'), 'a sixteenth');
  assert(describeSnap('off', 1) === '스냅 끔', 'off says nothing about the grid');
});

// ── Repeat fill ─────────────────────────────────────────────────────────────

check('an exact multiple needs no trimmed copy', () => {
  const plan = planFill(2, 8)!;
  assert(plan.whole === 4 && !plan.partial, `4 whole, got ${plan.whole}/${plan.partial}`);
  assert(describeFill(plan).includes('딱 맞음'), 'and says so');
});

check('a remainder becomes one trimmed copy', () => {
  const plan = planFill(2, 7)!;
  assert(plan.whole === 3 && plan.partial, '3 whole plus a partial');
  near(plan.partialSec, 1, 1e-9, 'one second of the fourth');
  assert(plan.total === 4, 'four copies in all');
});

check('a range shorter than one copy is refused', () => {
  const plan = planFill(4, 1)!;
  assert(plan.total === 1 && plan.partial, 'one trimmed copy, not zero');
  assert(planFill(0, 8) === null, 'an empty clipboard fills nothing');
  assert(planFill(2, 0) === null, 'nor does an empty range');
});

check('the copy count is capped', () => {
  const plan = planFill(0.01, 60)!;
  assert(plan.capped, 'the cap fired');
  assert(plan.total === MAX_FILL_COPIES, `stopped at ${MAX_FILL_COPIES}`);
});

check('trimClipboard cuts the clips, not just the length', () => {
  const { session, a } = twoTracks();
  const board = copyRange(session, { startSec: 0, endSec: 12, trackIds: [a] })!;
  const cut = trimClipboard(board, 3);
  near(cut.lengthSec, 3, 1e-9, 'the new length');
  const clips = cut.lanes[0]!.clips;
  assert(clips.length === 1, `the 8 s clip is gone, got ${clips.length}`);
  near(clipEnd(clips[0]!), 3, 1e-6, 'the survivor is cut to the edge');
});

check('a fill lays down the planned number of copies', () => {
  const { session, a } = twoTracks();
  const board = copyRange(session, { startSec: 0, endSec: 4, trackIds: [a] })!;
  const empty = updateClips(session, a, () => []);
  const out = repeatFill(empty, board, { startSec: 0, endSec: 12, trackIds: [a] });
  assert(out.plan?.total === 3, `three copies, got ${out.plan?.total}`);
  assert(trackClips(findTrack(out.session, a)!).length === 3, 'three clips on the track');
});

check('the trimmed last copy stops at the selection edge', () => {
  const { session, a } = twoTracks();
  const board = copyRange(session, { startSec: 0, endSec: 4, trackIds: [a] })!;
  const empty = updateClips(session, a, () => []);
  const out = repeatFill(empty, board, { startSec: 0, endSec: 10, trackIds: [a] });
  const clips = trackClips(findTrack(out.session, a)!);
  assert(clips.length === 3, `two whole plus a half, got ${clips.length}`);
  near(clipEnd(clips[2]!), 10, 1e-6, 'the last one ends ON the edge');
});

check('a fill never touches what is past the selection', () => {
  // The bug the trim-the-clipboard design exists to prevent: a full-length
  // final copy would CLEAR 8-12 s to land on it, then be trimmed off, leaving
  // the guard clip destroyed.
  const { session, a } = twoTracks();
  const board = copyRange(session, { startSec: 0, endSec: 4, trackIds: [a] })!;
  const guard = updateClips(session, a, () => [
    createClip('f1', 'guard', { startSec: 10, offsetSec: 0, durationSec: 4 }),
  ]);
  const out = repeatFill(guard, board, { startSec: 0, endSec: 10, trackIds: [a] });
  const survivor = trackClips(findTrack(out.session, a)!).find((c) => c.name === 'guard');
  assert(survivor !== undefined, 'the guard clip is still there');
  near(survivor!.startSec, 10, 1e-6, 'still at 10 s');
  near(survivor!.durationSec, 4, 1e-6, 'still four seconds long');
});

check('a fill with no range or no tracks says so instead of guessing', () => {
  const { session, a } = twoTracks();
  const board = copyRange(session, { startSec: 0, endSec: 4, trackIds: [a] })!;
  const none = repeatFill(session, board, { startSec: 3, endSec: 3, trackIds: [a] });
  assert(none.session === session, 'nothing happened');
  assert(none.problems.length > 0, 'and it was reported');
});

// ── Batch rename ────────────────────────────────────────────────────────────

check('a # run sets the padding width', () => {
  assert(expandPattern('Gtr ##', 7) === 'Gtr 07', expandPattern('Gtr ##', 7));
  assert(expandPattern('Gtr #', 7) === 'Gtr 7', expandPattern('Gtr #', 7));
  assert(expandPattern('Gtr', 7) === 'Gtr 7', 'a pattern with no # gets the counter appended');
});

check('numbering counts within the selection, not the session', () => {
  const items = [{ id: 'x', name: 'a' }, { id: 'y', name: 'b' }, { id: 'z', name: 'c' }];
  const plan = planRename(items, { kind: 'pattern', pattern: 'Gtr #' });
  assert(plan.lines.map((l) => l.to).join(',') === 'Gtr 1,Gtr 2,Gtr 3', plan.lines.map((l) => l.to).join(','));
});

check('start and step move the counter', () => {
  const items = [{ id: 'x', name: 'a' }, { id: 'y', name: 'b' }];
  const plan = planRename(items, { kind: 'pattern', pattern: 'T #', start: 5, step: 2 });
  assert(plan.lines[1]!.to === 'T 7', plan.lines[1]!.to);
});

check('replace is literal, not a regex', () => {
  assert(renameOne('a.b.c', { kind: 'replace', find: '.', replace: '-' }, 0) === 'a-b-c', 'the dot is a dot');
  assert(renameOne('AudioX', { kind: 'replace', find: 'audio', replace: 'V', ignoreCase: true }, 0) === 'VX',
    'case-insensitive when asked');
  assert(renameOne('AudioX', { kind: 'replace', find: 'audio', replace: 'V' }, 0) === 'AudioX',
    'and case-sensitive when not');
});

check('an empty find changes nothing', () => {
  assert(renameOne('keep', { kind: 'replace', find: '', replace: 'X' }, 0) === 'keep', 'no needle, no change');
});

check('affix wraps and trims', () => {
  assert(renameOne('Vox', { kind: 'affix', prefix: 'BV ', suffix: ' L' }, 0) === 'BV Vox L', 'both ends');
  assert(renameOne('Vox', { kind: 'affix', suffix: '  ' }, 0) === 'Vox', 'trailing space trimmed away');
  assert(DEFAULT_RENAME.trim, 'trimming is the default');
});

check('a rename that empties the name keeps the old one', () => {
  assert(renameOne('Vox', { kind: 'replace', find: 'Vox', replace: '' }, 0) === 'Vox', 'never nameless');
});

check('the plan is a preview — it names the collisions', () => {
  const items = [{ id: 'x', name: 'a' }, { id: 'y', name: 'b' }];
  const plan = planRename(items, { kind: 'pattern', pattern: 'Same' });
  assert(plan.duplicates.length === 0, 'the counter keeps them apart');
  const collide = planRename(items, { kind: 'replace', find: 'a', replace: 'b' });
  assert(collide.duplicates.includes('b'), `two b's, got ${collide.duplicates.join(',')}`);
  assert(describeRename(collide).includes('같은 이름'), 'and the line warns');
});

check('unchanged lines are marked and left out of the map', () => {
  const items = [{ id: 'x', name: 'Vox' }, { id: 'y', name: 'Gtr' }];
  const plan = planRename(items, { kind: 'replace', find: 'Vox', replace: 'Lead' });
  assert(plan.changed === 1, `one changed, got ${plan.changed}`);
  assert(plan.lines[1]!.same, 'the guitar is unchanged');
  const map = renameMap(plan);
  assert(map.size === 1 && map.get('x') === 'Lead', 'only the one that moved');
});

// ── History log ─────────────────────────────────────────────────────────────

check('adding a track is named as adding a track', () => {
  const { session } = twoTracks();
  const after = addTrack(session, createTrack('Bass', 'audio'));
  const change = diffSessions(session, after);
  assert(change.kind === 'tracks-added', change.kind);
  assert(change.name === 'Bass', 'and names it');
  assert(describeChange(change).includes('Bass'), describeChange(change));
});

check('removing a track, renaming one, reordering them', () => {
  const { session, a, b } = twoTracks();
  assert(diffSessions(session, removeTrack(session, a)).kind === 'tracks-removed', 'removed');
  assert(diffSessions(session, updateTrack(session, a, (t) => ({ ...t, name: 'Lead' }))).kind
    === 'track-renamed', 'renamed');
  const order = session.tracks.map((t) => t.id);
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  const tracks = [...session.tracks];
  [tracks[ia], tracks[ib]] = [tracks[ib]!, tracks[ia]!];
  const swapped = { ...session, tracks };
  assert(swapped.tracks.length === session.tracks.length, 'a swap loses no track');
  assert(diffSessions(session, swapped).kind === 'track-order', diffSessions(session, swapped).kind);
});

check('a move and a trim are told apart', () => {
  const { session, a } = twoTracks();
  const moved = updateClips(session, a, (cs) => cs.map((c, i) => (i === 0 ? { ...c, startSec: 2 } : c)));
  assert(diffSessions(session, moved).kind === 'clips-moved', 'a start that moved');
  const trimmed = updateClips(session, a, (cs) => cs.map((c, i) => (i === 0 ? { ...c, durationSec: 3 } : c)));
  assert(diffSessions(session, trimmed).kind === 'clips-trimmed', 'a length that changed');
});

check('a head trim is a trim, not a move', () => {
  // Both the start AND the length change.  Length is asked about first for
  // exactly this case.
  const { session, a } = twoTracks();
  const head = updateClips(session, a, (cs) => cs.map((c, i) =>
    (i === 0 ? { ...c, startSec: 1, offsetSec: 1, durationSec: 3 } : c)));
  assert(diffSessions(session, head).kind === 'clips-trimmed', diffSessions(session, head).kind);
});

check('clip gain and fades are named separately', () => {
  const { session, a } = twoTracks();
  const gain = updateClips(session, a, (cs) => cs.map((c, i) => (i === 0 ? { ...c, gainDb: -3 } : c)));
  assert(diffSessions(session, gain).kind === 'clip-gain', 'gain');
  const fade = updateClips(session, a, (cs) => cs.map((c, i) =>
    (i === 0 ? { ...c, fadeIn: { durationSec: 0.5, shape: 'equalPower' as const } } : c)));
  assert(diffSessions(session, fade).kind === 'clip-fades', 'fades');
});

check('mix moves and automation are named', () => {
  const { session, a } = twoTracks();
  assert(diffSessions(session, updateTrack(session, a, (t) => ({ ...t, volumeDb: -6 }))).kind === 'mix', 'fader');
  assert(diffSessions(session, updateTrack(session, a, (t) => ({ ...t, mute: true }))).kind === 'mix', 'mute');
});

check('a structural change outranks an incidental one', () => {
  // The track is added AND a fader moved.  "Track added" is the headline.
  const { session, a } = twoTracks();
  const both = updateTrack(addTrack(session, createTrack('Bass', 'audio')), a, (t) => ({ ...t, volumeDb: -6 }));
  assert(diffSessions(session, both).kind === 'tracks-added', diffSessions(session, both).kind);
});

check('an identical session is no change', () => {
  const { session } = twoTracks();
  assert(diffSessions(session, session).kind === 'none', 'the same object');
  assert(diffSessions(session, { ...session }).kind === 'other', 'a copy with nothing different');
});

check('markers and tempo are named, and rank below the edits', () => {
  const { session } = twoTracks();
  const marked = storeLocation(session, 1, { timeSec: 4 });
  assert(diffSessions(session, marked).kind === 'markers', diffSessions(session, marked).kind);
  assert(diffSessions(session, { ...session, tempoBpm: 140 }).kind === 'tempo', 'tempo');
});

check('the list marks the present and dims the future', () => {
  const { session, a } = twoTracks();
  const one = addTrack(session, createTrack('Bass', 'audio'));
  const two = updateTrack(one, a, (t) => ({ ...t, volumeDb: -6 }));
  const entries = historyEntries({ past: [session], present: one, future: [two] });
  assert(entries.length === 3, `three steps, got ${entries.length}`);
  assert(entries[0]!.label === '세션 열기', 'the oldest is the opening state');
  assert(entries[1]!.current && !entries[1]!.future, 'the present is marked');
  assert(entries[2]!.future, 'the redo branch is future');
  assert(entries[1]!.label.includes('트랙 추가'), entries[1]!.label);
});

check('stepsTo says which way and how far to walk', () => {
  assert(stepsTo(3, 1) === -2, 'two undos back');
  assert(stepsTo(3, 5) === 2, 'two redos forward');
  assert(stepsTo(3, 3) === 0, 'already there');
});

check('focusSecOf points where the step STARTED, not where it landed', () => {
  const { session, a } = twoTracks();
  // Moved LATER, so "where it was" and "where it is" are different numbers —
  // moving it earlier would make both rules agree and test nothing.
  const later = updateClips(session, a, (cs) => cs.map((c, i) => (i === 1 ? { ...c, startSec: 14 } : c)));
  near(focusSecOf(session, later)!, 8, 1e-6, 'the earlier of the two, so the move is on screen');
  const earlier = updateClips(session, a, (cs) => cs.map((c, i) => (i === 1 ? { ...c, startSec: 6 } : c)));
  near(focusSecOf(session, earlier)!, 6, 1e-6, 'and the same rule the other way');
  assert(focusSecOf(session, session) === null, 'nothing moved, nowhere to look');
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Tier 3: locations, snap, fill, rename, history ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
