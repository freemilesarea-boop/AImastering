/**
 * section-reorder-selftest — putting the chorus before the bridge.
 *
 * "Move the second chorus earlier" is one thought, and doing it by hand is a
 * morning: select the range, ripple-cut, find the new spot, ripple-paste, fix
 * the automation that did not come, notice the tempo ramp stayed behind.
 *
 * So the tests are about what RIDES ALONG.  A reorder that moves the clips
 * and leaves the automation is worse than none, because the mix is now wrong
 * in a way nobody will look for.  The properties:
 *
 *   • The song is exactly as long afterwards.  Nothing was lost or gained.
 *   • Every clip, automation point, marker, chord and tempo event that was
 *     inside the section is inside it at its new place, and at the same
 *     offset within it.
 *   • Everything OUTSIDE the section is where the new order puts it, and
 *     nowhere else.
 *
 * Run: pnpm --filter @aimaster/desktop test:section-reorder
 */

import {
  addFile, addTrack, createClip, createSession, createTrack, findTrack,
  updateClips, updateTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import {
  addSection, createSection, sectionRanges, sectionsOf, withSections,
} from '../src/renderer/daw/model/arrangement.js';
import {
  describeOrder, moveSection, nudgeSection, songEnd,
} from '../src/renderer/daw/edit/arrange-ops.js';
import { createLane } from '../src/renderer/daw/model/automation.js';
import { tempoMapOf, withTempoMap, addTempoEvent, defaultTempoMap, secToBeat }
  from '../src/renderer/daw/model/tempo-map.js';
import { makeChord } from '../src/renderer/daw/model/chords.js';
import { setChordTrack } from '../src/renderer/daw/model/session-ops.js';
import { pointValueAt } from '../src/renderer/daw/model/automation.js';
import type { DawSession } from '../src/renderer/daw/model/types.js';

const results: { name: string; pass: boolean }[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true }); console.log(`[PASS] ${name}`); }
  catch (err) {
    results.push({ name, pass: false });
    console.log(`[FAIL] ${name} — ${err instanceof Error ? err.message : String(err)}`);
  }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function eq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg} — got ${String(a)}, want ${String(b)}`);
}
function close(a: number, b: number, msg: string, tol = 1e-6): void {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg} — got ${a}, want ${b} ±${tol}`);
}

const BLOCK = 8;
const NAMES = ['A', 'B', 'C', 'D'] as const;

/**
 * Four eight-second sections, each carrying one of everything.
 *
 * Every item is stamped so it can be recognised after it has moved: clip `c2`
 * belongs to section C, wherever C ends up.
 */
function build(): DawSession {
  resetIds();
  let session = createSession('order', 48000);
  const track = createTrack('T', 'audio');
  session = addTrack(session, track);
  session = addFile(session, {
    id: 'f', path: '/virtual/f.wav', name: 'f',
    durationSec: NAMES.length * BLOCK, sampleRate: 48000, channels: 2,
  });

  session = updateClips(session, track.id, () => NAMES.map((name, i) =>
    createClip('f', `c${name}`, {
      startSec: i * BLOCK, offsetSec: i * BLOCK, durationSec: BLOCK,
    })));

  // One automation point per section, two seconds in, at a telltale value.
  const lane = createLane({ kind: 'volume' }, 0);
  session = updateTrack(session, track.id, (t) => ({
    ...t,
    automation: [{
      ...lane, mode: 'read',
      points: NAMES.map((_, i) => ({ timeSec: i * BLOCK + 2, value: -i })),
    }],
  }));

  session = {
    ...session,
    markers: NAMES.map((name, i) => ({
      id: `mk-${name}`, name: `m${name}`, timeSec: i * BLOCK + 3,
    })),
  };
  session = setChordTrack(session, NAMES.map((name, i) => ({
    id: `ch-${name}`, timeSec: i * BLOCK + 4, chord: makeChord(i, 'maj'),
  })));

  let sections = sectionsOf(session);
  for (const [i, name] of NAMES.entries()) {
    const edit = addSection(sections, createSection('custom', i * BLOCK, name));
    if (!edit.ok) throw new Error(edit.reason);
    sections = edit.sections;
  }
  return withSections(session, sections);
}

function order(session: DawSession): string {
  return sectionRanges(sectionsOf(session), songEnd(session))
    .map((r) => r.section.name).join('');
}

function sectionIdOf(session: DawSession, name: string): string {
  const found = sectionsOf(session).find((s) => s.name === name);
  if (!found) throw new Error(`no section ${name}`);
  return found.id;
}

/** Where a named block's content sits now, and how it is spaced inside itself. */
function contentOf(session: DawSession, name: string): {
  clip: number; point: number; marker: number; chord: number;
} {
  const track = session.tracks.find((t) => t.kind === 'audio')!;
  const clip = track.playlists[0]!.clips.find((c) => c.name === `c${name}`);
  const index = NAMES.indexOf(name as typeof NAMES[number]);
  const point = track.automation[0]!.points.find((p) => p.value === -index);
  const marker = session.markers.find((m) => m.name === `m${name}`);
  const chord = session.chordTrack.find((c) => c.id === `ch-${name}`);
  assert(clip && point && marker && chord, `${name} still has all four of its things`);
  return {
    clip: clip!.startSec, point: point!.timeSec,
    marker: marker!.timeSec, chord: chord!.timeSec,
  };
}

// ── The order ─────────────────────────────────────────────────────────────────

check('a section lands where the drop says, and the rest close up behind it', () => {
  const base = build();
  eq(order(base), 'ABCD', 'the starting order');
  const move = (name: string, to: number): string =>
    order(moveSection(base, sectionIdOf(base, name), to).session);

  eq(move('C', 1), 'ACBD', 'the third dropped at index 1');
  eq(move('A', 3), 'BCDA', 'the first dragged to the end');
  eq(move('D', 0), 'DABC', 'the last dragged to the front');
  eq(move('B', 2), 'ACBD', 'and one that only moves by a place');
});

check('an out-of-range drop lands at the nearest end rather than failing', () => {
  const base = build();
  eq(order(moveSection(base, sectionIdOf(base, 'B'), -5).session), 'BACD', 'clamped to the front');
  eq(order(moveSection(base, sectionIdOf(base, 'B'), 99).session), 'ACDB', 'clamped to the end');
});

check('dropping a section where it already is changes nothing at all', () => {
  const base = build();
  const result = moveSection(base, sectionIdOf(base, 'C'), 2);
  eq(result.session, base, 'the same session object — no ids were renumbered');
  eq(result.problems.length, 0, 'and it is not an error either');
});

check('nudging is the keyboard version of the same move', () => {
  const base = build();
  eq(order(nudgeSection(base, sectionIdOf(base, 'C'), -1).session), 'ACBD', 'one place earlier');
  eq(order(nudgeSection(base, sectionIdOf(base, 'C'), 1).session), 'ABDC', 'one place later');
});

check('nudging past the end is refused by name, not silently', () => {
  const base = build();
  const first = nudgeSection(base, sectionIdOf(base, 'A'), -1);
  eq(first.session, base, 'nothing moved');
  assert(first.problems[0]?.includes('첫'), `and it says why — ${first.problems[0]}`);
  const last = nudgeSection(base, sectionIdOf(base, 'D'), 1);
  assert(last.problems[0]?.includes('마지막'), `the other end too — ${last.problems[0]}`);
});

check('a section that is not there is an error, not a no-op', () => {
  const base = build();
  const result = moveSection(base, 'sect-nope', 0);
  eq(result.session, base, 'unchanged');
  assert(result.problems.length > 0, 'and it says so');
});

// ── What rides along ──────────────────────────────────────────────────────────

check('the song is exactly as long afterwards', () => {
  const base = build();
  const before = songEnd(base);
  for (const [name, to] of [['C', 0], ['A', 3], ['B', 2], ['D', 1]] as const) {
    const after = songEnd(moveSection(base, sectionIdOf(base, name), to).session);
    close(after, before, `${name}→${to}: nothing was lost or gained`);
  }
});

check('clips, automation, markers and chords all move together', () => {
  const base = build();
  const spacing = contentOf(base, 'C');
  // Inside its own block: clip at 0, point at +2, marker at +3, chord at +4.
  const moved = moveSection(base, sectionIdOf(base, 'C'), 0).session;
  eq(order(moved), 'CABD', 'C went to the front');

  const now = contentOf(moved, 'C');
  close(now.clip, 0, 'the clip is at the front');
  close(now.point - now.clip, spacing.point - spacing.clip, 'the automation point kept its offset');
  close(now.marker - now.clip, spacing.marker - spacing.clip, 'so did the marker');
  close(now.chord - now.clip, spacing.chord - spacing.clip, 'and the chord');
});

check('everything else lands where the new order puts it', () => {
  const base = build();
  const moved = moveSection(base, sectionIdOf(base, 'C'), 0).session;
  // CABD — so A is now the second block, B the third, D the fourth.
  for (const [name, index] of [['C', 0], ['A', 1], ['B', 2], ['D', 3]] as const) {
    const now = contentOf(moved, name);
    close(now.clip, index * BLOCK, `${name} is block ${index}`);
    close(now.point, index * BLOCK + 2, `${name}'s automation came with it`);
    close(now.marker, index * BLOCK + 3, `${name}'s marker too`);
    close(now.chord, index * BLOCK + 4, `${name}'s chord too`);
  }
});

check('nothing is duplicated or dropped on the way', () => {
  const base = build();
  const moved = moveSection(base, sectionIdOf(base, 'B'), 3).session;
  const track = moved.tracks.find((t) => t.kind === 'audio')!;
  eq(track.playlists[0]!.clips.length, NAMES.length, 'the same number of clips');
  eq(moved.markers.length, NAMES.length, 'and of markers');
  eq(moved.chordTrack.length, NAMES.length, 'and of chords');
  eq(sectionsOf(moved).length, NAMES.length, 'and of sections');
  // Automation is counted separately: a lane is a CURVE, and preserving a
  // curve across a splice needs a point at each new seam — see below.
});

check('every automation point survives the move, at the right offset', () => {
  // Points are exact and checkable; the curve BETWEEN sections is not, and
  // saying so is the point of splitting this in two.
  const base = build();
  const moved = moveSection(base, sectionIdOf(base, 'C'), 0).session;
  const pointsOf = (session: DawSession) =>
    session.tracks.find((t) => t.kind === 'audio')!.automation[0]!.points;

  // CABD: each block's own point is 2 s into wherever its block now is.
  for (const [name, index] of [['C', 0], ['A', 1], ['B', 2], ['D', 3]] as const) {
    const value = -NAMES.indexOf(name);
    const found = pointsOf(moved).filter((p) => Math.abs(p.value - value) < 1e-9
      && Math.abs(p.timeSec - (index * BLOCK + 2)) < 1e-6);
    eq(found.length, 1, `${name}'s point is 2 s into block ${index}, exactly once`);
  }
});

check('a moved section keeps its own curve, and the seam takes one value', () => {
  // The honest limit of moving automation.  A lane is a CONTINUOUS curve, so
  // the shape inside a section is partly written by its neighbours: the value
  // at its first moment comes from a point before it, and at its last from a
  // point after.  Both ends are therefore pinned when a section is lifted,
  // which is what makes the section itself sound the same somewhere else.
  //
  // What cannot be preserved is the seam.  Where two sections meet, the curve
  // has ONE value, and after a reorder the two sides disagree about what it
  // should be — there is no way to be both.  The section that now ENDS there
  // wins, because that is the value the moved material carried with it.
  const base = build();
  const moved = moveSection(base, sectionIdOf(base, 'C'), 0).session;
  const laneOf = (session: DawSession) =>
    session.tracks.find((t) => t.kind === 'audio')!.automation[0]!;

  // C ran 16→24 and now runs 0→8.  Its interior is preserved exactly.
  for (const offset of [0, 1, 2, 4, 6, 7.9]) {
    const was = pointValueAt(laneOf(base).points, 2 * BLOCK + offset, 0);
    const now = pointValueAt(laneOf(moved).points, offset, 0);
    close(now, was, `C at +${offset}s sounds as it did`);
  }
  // And so is the interior of everything it moved past — from its own first
  // point onward.  Before that point it is inside the seam, where the
  // preceding section's tail now leads in.
  for (const [name, index] of [['A', 1], ['B', 2], ['D', 3]] as const) {
    const from = NAMES.indexOf(name) * BLOCK;
    for (const offset of [2, 4, 6]) {
      const was = pointValueAt(laneOf(base).points, from + offset, 0);
      const now = pointValueAt(laneOf(moved).points, index * BLOCK + offset, 0);
      close(now, was, `${name} at +${offset}s sounds as it did`);
    }
  }
});

check('reordering over and over does not grow the automation without bound', () => {
  // Each splice pins the value at the seam it creates, so the first few moves
  // add points.  Once every boundary has one there is nothing left to pin,
  // and the count must stop climbing — otherwise an afternoon of arranging
  // ends with a lane of thousands of points.
  const base = build();
  const counts: number[] = [];
  let current = base;
  for (let round = 0; round < 8; round++) {
    const ranges = sectionRanges(sectionsOf(current), songEnd(current));
    current = moveSection(current, ranges[2]!.section.id, 0).session;
    counts.push(current.tracks.find((t) => t.kind === 'audio')!.automation[0]!.points.length);
  }
  const settled = counts.slice(3);
  eq(new Set(settled).size, 1, `it settles — ${counts.join(', ')}`);
  // One per boundary, on top of the points that were drawn.
  assert(settled[0]! <= NAMES.length * 2, `and settles low — ${settled[0]}`);
});

check('a tempo change inside a section goes with it', () => {
  // The one that is easy to leave behind: a chorus that speeds up has to
  // still speed up after it has been moved, and the sections it moved past
  // must be back at the tempo they had.
  let base = build();
  const map = tempoMapOf(base);
  const cStartBeat = secToBeat(map, 2 * BLOCK);
  base = withTempoMap(base, addTempoEvent(map, cStartBeat, 150));

  const moved = moveSection(base, sectionIdOf(base, 'C'), 0).session;
  eq(order(moved), 'CABD', 'C is first');

  const after = tempoMapOf(moved);
  const bumps = after.tempos.filter((t) => Math.abs(t.bpm - 150) < 1e-9);
  eq(bumps.length, 1, 'the 150 bpm event exists exactly once');
  // C now starts the song, so its tempo event is at the top.
  close(bumps[0]!.beat, 0, 'and it travelled to the front with the section');
});

check('the running order reads back as text', () => {
  const base = build();
  const text = describeOrder(moveSection(base, sectionIdOf(base, 'C'), 0).session);
  eq(text, 'C · A · B · D', 'a reorder is invisible until the playhead gets there');
});

// ── Ordering of the move itself ───────────────────────────────────────────────

check('moving a section forward accounts for its own removal', () => {
  // The off-by-one this design is shaped to avoid: after the cut, everything
  // after the section has slid back, so a destination measured before the cut
  // would land a block early.
  const base = build();
  const moved = moveSection(base, sectionIdOf(base, 'A'), 2).session;
  eq(order(moved), 'BCAD', 'A sits third, not second or fourth');
  close(contentOf(moved, 'A').clip, 2 * BLOCK, 'and its clip is in the third block');
});

check('a reorder round-trips back to where it started', () => {
  const base = build();
  const there = moveSection(base, sectionIdOf(base, 'B'), 3).session;
  eq(order(there), 'ACDB', 'B to the end');
  const back = moveSection(there, sectionIdOf(there, 'B'), 1).session;
  eq(order(back), 'ABCD', 'and back again');
  // Not just the labels: the content is where it started too.
  for (const [name, index] of NAMES.map((n, i) => [n, i] as const)) {
    close(contentOf(back, name).clip, index * BLOCK, `${name} is home`);
  }
  close(songEnd(back), songEnd(base), 'and the song is the same length');
  // And it is the SAME clip, not a copy of it — a move must not renumber.
  const clipIds = (session: DawSession): string =>
    [...session.tracks.find((t) => t.kind === 'audio')!.playlists[0]!.clips]
      .sort((a, b) => a.startSec - b.startSec).map((c) => c.id).join(',');
  eq(clipIds(back), clipIds(base), 'every clip kept its identity through both moves');
});

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed${passed === results.length ? '' : `, ${results.length - passed} FAILED`}`);
if (passed !== results.length) process.exit(1);
