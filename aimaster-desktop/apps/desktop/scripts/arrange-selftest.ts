/**
 * arrange-selftest — editing the song by the section.
 *
 * Sections are cheap; the ripple edits are not.  A ripple is only correct if
 * EVERYTHING anchored to the timeline moves together, and the failure mode when
 * one of them is forgotten is the worst kind: the session looks fine and is
 * quietly wrong three edits later.  So the bulk of this file is one question
 * asked six ways — did the clips, the automation, the markers, the chords, the
 * sections AND the tempo map all move?
 *
 * The tempo map is the one that cannot be checked by looking at a number: a
 * tempo event lives on a BEAT, so the proof is that a later event's SECONDS
 * moved by exactly the length of the ripple.  That only comes out right if the
 * shift was done in beats.
 *
 * Run: pnpm --filter @aimaster/desktop test:arrange
 */

import {
  MIN_SECTION_SEC, addSection, createSection, describeArrangement, kindLabel,
  moveSectionStart, nextSectionStart, previousSectionStart, rangeOf, removeSectionMarker,
  renameSection, sectionAt, sectionLabel, sectionRanges, sectionsOf, setSectionKind,
  shiftSections, withSections,
} from '../src/renderer/daw/model/arrangement.js';
import {
  deleteSectionTime, duplicateSection, rippleDelete, rippleInsert,
  selectionForSection, songEnd,
} from '../src/renderer/daw/edit/arrange-ops.js';
import {
  addFile, addTrack, createClip, createSession, createTrack, findTrack, updateClips,
  updateTrack,
} from '../src/renderer/daw/model/session-ops.js';
import {
  addTempoEvent, beatToSec, defaultTempoMap, secToBeat, tempoMapOf, withTempoMap,
} from '../src/renderer/daw/model/tempo-map.js';
import { createLane } from '../src/renderer/daw/model/automation.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { DawSession, Section } from '../src/renderer/daw/model/types.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function eq<T>(a: T, b: T, m: string): void {
  if (a !== b) throw new Error(`${m} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}
function close(a: number, b: number, m: string, tol = 1e-6): void {
  if (Math.abs(a - b) > tol) throw new Error(`${m} — got ${a}, want ${b} ±${tol}`);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * A song at 120 bpm with four eight-second clips back to back, boundaries at
 * 0 / 8 / 16 / 24, and a marker, a chord and an automation point inside each.
 * Eight seconds is four bars at 120 in 4/4, so every ripple here is whole bars.
 */
function song(): { session: DawSession; trackId: string; sections: Section[] } {
  resetIds();
  let session = createSession('arrange test', 48000);
  const track = createTrack('Vox', 'audio');
  session = addTrack(session, track);
  session = addFile(session, {
    id: 'f1', path: '/virtual/f1.wav', name: 'f1',
    durationSec: 40, sampleRate: 48000, channels: 2,
  });
  session = updateClips(session, track.id, () => [0, 8, 16, 24].map((at) =>
    createClip('f1', `clip@${at}`, { startSec: at, offsetSec: at, durationSec: 8 })));

  // One volume lane with a point in each block.
  const lane = createLane({ kind: 'volume' }, 0);
  session = updateTrack(session, track.id, (t) => ({
    ...t,
    automation: [{
      ...lane,
      points: [
        { timeSec: 0, value: 0 }, { timeSec: 8, value: -6 },
        { timeSec: 16, value: -12 }, { timeSec: 24, value: -3 },
      ],
    }],
  }));

  session = {
    ...session,
    markers: [0, 8, 16, 24].map((at, i) => ({ id: `mk${i}`, name: `m${i}`, timeSec: at })),
    chordTrack: [0, 8, 16, 24].map((at, i) => ({
      id: `ch${i}`, timeSec: at,
      chord: { root: i, quality: 'maj' as const, bass: null, extensions: [] },
    })),
  } as unknown as DawSession;

  const sections = [
    createSection('intro', 0),
    createSection('verse', 8),
    createSection('chorus', 16),
    createSection('outro', 24),
  ];
  return { session: withSections(session, sections), trackId: track.id, sections };
}

const clipsOf = (session: DawSession, trackId: string): { startSec: number; durationSec: number }[] =>
  (findTrack(session, trackId)?.playlists[0]?.clips ?? [])
    .map((c) => ({ startSec: c.startSec, durationSec: c.durationSec }))
    .sort((a, b) => a.startSec - b.startSec);

const laneOf = (session: DawSession, trackId: string): { timeSec: number; value: number }[] =>
  (findTrack(session, trackId)?.automation[0]?.points ?? [])
    .map((p) => ({ timeSec: p.timeSec, value: p.value }));

// ── 1. The section list ───────────────────────────────────────────────────────

check('a section ends where the next one starts', () => {
  const { sections } = song();
  const ranges = sectionRanges(sections, 32);
  eq(ranges.length, 4, 'four sections');
  eq(ranges.map((r) => `${r.startSec}-${r.endSec}`).join(','), '0-8,8-16,16-24,24-32',
    'no gaps and no overlaps are representable');
  eq(ranges[3]?.endSec, 32, 'the last one runs to the end of the song');
});

check('every moment has exactly one section, and before the first there is none', () => {
  const { sections } = song();
  eq(sectionAt(sections, 0)?.kind, 'intro', 'at the very start');
  eq(sectionAt(sections, 7.9)?.kind, 'intro', 'just before the boundary');
  eq(sectionAt(sections, 8)?.kind, 'verse', 'on the boundary it is the new one');
  eq(sectionAt(sections, 100)?.kind, 'outro', 'past the end it is the last');
  eq(sectionAt(sections.slice(1), 2), null, 'before the first section there is nothing');
});

check('two boundaries cannot land on top of each other', () => {
  const { sections } = song();
  const clash = addSection(sections, createSection('bridge', 8 + MIN_SECTION_SEC / 2));
  assert(!clash.ok, 'refused — a zero-length section is a row nobody can click');
  const fine = addSection(sections, createSection('bridge', 12));
  assert(fine.ok, 'somewhere else is fine');
  eq(fine.ok ? fine.sections.length : 0, 5, 'and it lands sorted');
  eq(fine.ok ? fine.sections[2]?.kind : '', 'bridge', 'between the verse and the chorus');
});

check('a boundary cannot overtake its neighbours', () => {
  const { sections } = song();
  const verse = sections[1]!;
  const past = moveSectionStart(sections, verse.id, 100);
  eq(past.find((s) => s.id === verse.id)?.startSec, 16 - MIN_SECTION_SEC,
    'clamped just short of the chorus — dragging a line never reorders the song');
  const before = moveSectionStart(sections, verse.id, -5);
  eq(before.find((s) => s.id === verse.id)?.startSec, MIN_SECTION_SEC, 'and short of the intro');
  const ok = moveSectionStart(sections, verse.id, 10);
  eq(ok.find((s) => s.id === verse.id)?.startSec, 10, 'and moves freely in between');
});

check('names, kinds and the shape read back', () => {
  const { sections } = song();
  eq(sectionLabel(sections[0]!), '인트로', 'an unnamed section uses its kind');
  const named = renameSection(sections, sections[0]!.id, '  긴   인트로  ');
  eq(sectionLabel(named[0]!), '긴 인트로', 'a named one uses its name, tidied');
  const rekinded = setSectionKind(sections, sections[1]!.id, 'bridge');
  eq(rekinded[1]?.kind, 'bridge', 'the kind changes');
  eq(kindLabel('chorus'), '코러스', 'kinds have names');
  assert(describeArrangement(sections).startsWith('인트로 · 벌스'), 'the shape reads in one line');
  eq(describeArrangement([]), '구간 없음', 'and an empty song says so');
});

check('jumping lands on boundaries, not between them', () => {
  const { sections } = song();
  eq(nextSectionStart(sections, 0), 8, 'forward');
  eq(nextSectionStart(sections, 23.9), 24, 'to the next one');
  eq(nextSectionStart(sections, 24), null, 'and nothing past the last');
  eq(previousSectionStart(sections, 20), 16, 'back');
  eq(previousSectionStart(sections, 0), null, 'and nothing before the first');
});

check('shifting the list moves only what is at or after the point', () => {
  const { sections } = song();
  const shifted = shiftSections(sections, 16, 4);
  eq(shifted.map((s) => s.startSec).join(','), '0,8,20,28', 'the first two stay put');
  eq(shiftSections(sections, 0, 0).map((s) => s.startSec).join(','), '0,8,16,24', 'zero is a no-op');
});

// ── 2. Ripple insert ──────────────────────────────────────────────────────────

check('inserting time pushes everything after it later, and splits what straddles', () => {
  const { session, trackId } = song();
  // Four seconds at 12 s — inside the third clip.
  const { session: next, problems } = rippleInsert(session, 12, 4);
  eq(problems.length, 0, `nothing was left behind — ${problems.join(' | ')}`);

  const clips = clipsOf(next, trackId);
  eq(clips.length, 5, 'the straddled clip became two');
  eq(clips.map((c) => `${c.startSec}+${c.durationSec}`).join(','),
    '0+8,8+4,16+4,20+8,28+8',
    'the head stays at 8, its tail moves to 16, and the rest follow');

  eq(laneOf(next, trackId).map((p) => p.timeSec).join(','), '0,8,20,28', 'the lane moved with it');
  eq(next.markers.map((m) => m.timeSec).join(','), '0,8,20,28', 'and the markers');
  eq(next.chordTrack.map((c) => c.timeSec).join(','), '0,8,20,28', 'and the chords');
  eq(sectionsOf(next).map((s) => s.startSec).join(','), '0,8,20,28', 'and the sections');
});

check('inserting time moves the tempo map in BEATS, so later bars keep their bars', () => {
  const { session } = song();
  // A tempo change at 16 s = beat 32 at 120 bpm.
  const map = addTempoEvent(tempoMapOf(session), 32, 90);
  const withTempo = withTempoMap(session, map);
  const before = beatToSec(tempoMapOf(withTempo), 32);
  close(before, 16, 'the change is at 16 s to start with');

  const { session: next } = rippleInsert(withTempo, 8, 4);
  const after = tempoMapOf(next);
  const event = after.tempos.find((t) => Math.abs(t.bpm - 90) < 1e-9);
  assert(event !== undefined, 'the tempo change survived');
  close(event!.beat, 40, 'it moved by the eight beats that four seconds is at 120');
  close(beatToSec(after, event!.beat), 20,
    'which puts it four seconds later — exactly the length of the insert');
});

check('an insert that is not a whole number of bars says the meter was left', () => {
  const { session } = song();
  // Three seconds at 120 in 4/4 is one and a half bars.
  const { problems } = rippleInsert(session, 8, 3);
  eq(problems.length, 1, 'one problem');
  assert(problems[0]?.includes('마디'), `and it names the reason — ${problems[0]}`);
});

check('inserting nothing is refused rather than silently doing nothing', () => {
  const { session } = song();
  const zero = rippleInsert(session, 8, 0);
  eq(zero.session, session, 'unchanged');
  eq(zero.problems.length, 1, 'and reported');
});

// ── 3. Ripple delete ──────────────────────────────────────────────────────────

check('deleting time removes what is inside and pulls the rest back', () => {
  const { session, trackId } = song();
  const { session: next, problems } = rippleDelete(session, 8, 16);
  eq(problems.length, 0, `nothing left behind — ${problems.join(' | ')}`);

  eq(clipsOf(next, trackId).map((c) => `${c.startSec}+${c.durationSec}`).join(','),
    '0+8,8+8,16+8', 'the second block is gone and the rest closed up');
  eq(next.markers.map((m) => m.timeSec).join(','), '0,8,16', 'the marker inside went with it');
  eq(next.chordTrack.map((c) => c.timeSec).join(','), '0,8,16', 'and the chord');
  eq(sectionsOf(next).map((s) => s.startSec).join(','), '0,8,16', 'and the section boundary');
  close(songEnd(next), 24, 'the song is eight seconds shorter');
});

check('a clip spanning the whole cut becomes two neighbours', () => {
  resetIds();
  let session = createSession('span', 48000);
  const track = createTrack('T', 'audio');
  session = addTrack(session, track);
  session = addFile(session, {
    id: 'f', path: '/v/f.wav', name: 'f', durationSec: 40, sampleRate: 48000, channels: 2,
  });
  session = updateClips(session, track.id, () => [
    createClip('f', 'long', { startSec: 0, offsetSec: 0, durationSec: 20 }),
  ]);

  const { session: next } = rippleDelete(session, 5, 10);
  const clips = clipsOf(next, track.id);
  eq(clips.length, 2, 'two pieces');
  eq(clips.map((c) => `${c.startSec}+${c.durationSec}`).join(','), '0+5,5+10',
    'and they are adjacent — the cut closed');
});

check('a clip straddling one edge is trimmed, not dropped', () => {
  const { session, trackId } = song();
  // Cut 4–12: the front of clip A survives, the back of clip B survives.
  const { session: next } = rippleDelete(session, 4, 12);
  eq(clipsOf(next, trackId).map((c) => `${c.startSec}+${c.durationSec}`).join(','),
    '0+4,4+4,8+8,16+8', 'both straddlers kept their surviving halves');
});

check('the lane is re-anchored at the splice rather than ramping across it', () => {
  const { session, trackId } = song();
  // Cut 10–20, which removes the point at 16 and lands mid-ramp both sides.
  const { session: next } = rippleDelete(session, 10, 20);
  const points = laneOf(next, trackId);
  const atCut = points.find((p) => Math.abs(p.timeSec - 10) < 1e-6);
  assert(atCut !== undefined, 'a point was pinned where the cut happened');
  // At 10 s the lane was ramping from −6 (at 8) to −12 (at 16): a quarter of
  // the way, so −7.5.
  close(atCut!.value, -7.5, 'holding the value the lane actually had there', 1e-9);
  eq(points.map((p) => p.timeSec).join(','), '0,8,10,14',
    'and everything after came back by the length of the cut');
});

check('deleting time moves the tempo map in beats too', () => {
  const { session } = song();
  const map = addTempoEvent(tempoMapOf(session), 48, 90);   // beat 48 = 24 s
  const withTempo = withTempoMap(session, map);

  const { session: next } = rippleDelete(withTempo, 8, 16);
  const after = tempoMapOf(next);
  const event = after.tempos.find((t) => Math.abs(t.bpm - 90) < 1e-9);
  assert(event !== undefined, 'the change survived');
  close(event!.beat, 32, 'it came back by the sixteen beats that eight seconds is');
  close(beatToSec(after, event!.beat), 16, 'which is eight seconds earlier');
});

check('a tempo change INSIDE the cut goes with it', () => {
  const { session } = song();
  const map = addTempoEvent(tempoMapOf(session), 24, 90);   // beat 24 = 12 s
  const withTempo = withTempoMap(session, map);
  const { session: next } = rippleDelete(withTempo, 8, 16);
  assert(!tempoMapOf(next).tempos.some((t) => Math.abs(t.bpm - 90) < 1e-9),
    'the change that lived in the deleted bars is gone');
});

// ── 4. Section operations ─────────────────────────────────────────────────────

check('duplicating a section doubles it and pushes the rest later', () => {
  const { session, trackId, sections } = song();
  const chorus = sections[2]!;                    // 16 → 24
  const { session: next, problems } = duplicateSection(session, chorus.id);
  eq(problems.length, 0, `clean — ${problems.join(' | ')}`);

  eq(clipsOf(next, trackId).map((c) => `${c.startSec}+${c.durationSec}`).join(','),
    '0+8,8+8,16+8,24+8,32+8', 'five blocks now — the chorus twice, then the outro');
  close(songEnd(next), 40, 'the song grew by exactly the section length');

  const after = sectionsOf(next);
  eq(after.map((s) => s.startSec).join(','), '0,8,16,24,32', 'a new boundary at the copy');
  eq(after[3]?.kind, 'chorus', 'and it is another chorus');
  eq(after[4]?.kind, 'outro', 'with the outro pushed out');
});

check('the duplicate carries the automation, markers and chords', () => {
  const { session, trackId, sections } = song();
  const { session: next } = duplicateSection(session, sections[2]!.id);

  // The chorus had a point at 16 (−12); the copy should have one at 24.
  const points = laneOf(next, trackId);
  const copied = points.find((p) => Math.abs(p.timeSec - 24) < 1e-6);
  assert(copied !== undefined, 'the copy has a point where the original did');
  close(copied!.value, -12, 'with the same value');
  eq(next.markers.filter((m) => Math.abs(m.timeSec - 24) < 1e-6).length, 1, 'a copied marker');
  eq(next.chordTrack.filter((c) => Math.abs(c.timeSec - 24) < 1e-6).length, 1, 'and a copied chord');
  eq(next.markers.length, 5, 'four originals plus one copy');
});

check('the duplicate carries the section’s own tempo change', () => {
  const { session, sections } = song();
  // A change at 20 s (beat 40) — inside the chorus, halfway through.
  const withTempo = withTempoMap(session, addTempoEvent(tempoMapOf(session), 40, 90));
  const { session: next } = duplicateSection(withTempo, sections[2]!.id);
  const after = tempoMapOf(next);
  const nineties = after.tempos.filter((t) => Math.abs(t.bpm - 90) < 1e-9);
  eq(nineties.length, 2, 'the change happens twice now');
  const beats = nineties.map((t) => t.beat).sort((a, b) => a - b);
  close(beats[0]!, 40, 'the original stays where it was');
  // The section's length in BEATS is read from the map that actually has the
  // change in it — 16 to 24 seconds is fourteen beats, not sixteen, precisely
  // because it slows down halfway through.
  const sectionBeats = secToBeat(tempoMapOf(withTempo), 24) - secToBeat(tempoMapOf(withTempo), 16);
  close(sectionBeats, 14, 'the chorus is fourteen beats long once it slows down');
  close(beats[1]! - beats[0]!, sectionBeats,
    'and the copy is exactly one section further on, in beats');
});

check('deleting a section removes its time and its boundary', () => {
  const { session, trackId, sections } = song();
  const { session: next, problems } = deleteSectionTime(session, sections[1]!.id);
  eq(problems.length, 0, `clean — ${problems.join(' | ')}`);

  eq(clipsOf(next, trackId).map((c) => c.startSec).join(','), '0,8,16', 'three blocks left');
  close(songEnd(next), 24, 'eight seconds shorter');
  const after = sectionsOf(next);
  eq(after.length, 3, 'and one fewer boundary');
  eq(after.map((s) => s.kind).join(','), 'intro,chorus,outro', 'the verse is gone');
  eq(after.map((s) => s.startSec).join(','), '0,8,16', 'and the rest closed up');
});

check('duplicate then delete puts the song back where it started', () => {
  const { session, trackId, sections } = song();
  const doubled = duplicateSection(session, sections[2]!.id);
  const copyId = sectionsOf(doubled.session)[3]!.id;
  const back = deleteSectionTime(doubled.session, copyId);

  eq(clipsOf(back.session, trackId).map((c) => `${c.startSec}+${c.durationSec}`).join(','),
    clipsOf(session, trackId).map((c) => `${c.startSec}+${c.durationSec}`).join(','),
    'the clips are where they were');
  eq(sectionsOf(back.session).map((s) => `${s.kind}@${s.startSec}`).join(','),
    sectionsOf(session).map((s) => `${s.kind}@${s.startSec}`).join(','),
    'and so is the arrangement');
  eq(back.session.markers.map((m) => m.timeSec).join(','),
    session.markers.map((m) => m.timeSec).join(','), 'and the markers');
  close(songEnd(back.session), songEnd(session), 'and the song is its old length');
});

check('a section that is not there is an error, not a silent no-op', () => {
  const { session } = song();
  const missing = duplicateSection(session, 'nope');
  eq(missing.session, session, 'unchanged');
  assert(missing.problems[0]?.includes('구간'), `and reported — ${missing.problems[0]}`);
  eq(deleteSectionTime(session, 'nope').problems.length, 1, 'the same for delete');
});

check('selecting a section covers its range on every track', () => {
  const { session, sections } = song();
  const selection = selectionForSection(session, sections[2]!.id);
  assert(selection !== null, 'there is a selection');
  close(selection!.startSec, 16, 'from the chorus start');
  close(selection!.endSec, 24, 'to the next boundary');
  eq(selection!.trackIds.length, session.tracks.length, 'across everything');
  eq(selectionForSection(session, 'nope'), null, 'and nothing for a section that is gone');
});

check('the last section runs to the end of the audio, not to nowhere', () => {
  const { session, sections } = song();
  const range = rangeOf(sections, sections[3]!.id, songEnd(session));
  close(range!.endSec, 32, 'the outro ends where the last clip does');
  // Remove the boundary only: the labels change, the audio does not.
  const fewer = withSections(session, removeSectionMarker(sections, sections[3]!.id));
  eq(sectionsOf(fewer).length, 3, 'one boundary fewer');
  close(songEnd(fewer), 32, 'and the audio is untouched — that is the other operation');
});

// ── 5. Old sessions ───────────────────────────────────────────────────────────

check('a session written before sections existed reads as none', () => {
  resetIds();
  const old = createSession('old', 48000);
  eq(sectionsOf(old).length, 0, 'no sections');
  eq(describeArrangement(sectionsOf(old)), '구간 없음', 'and it says so rather than throwing');
  // And the ripple edits still work on it.
  const { problems } = rippleInsert(old, 0, 4);
  eq(problems.length, 0, 'inserting time into a sectionless song is fine');
});

check('a hand-edited section list is filtered rather than trusted', () => {
  resetIds();
  const broken = {
    ...createSession('broken', 48000),
    sections: [
      { id: 'a', name: '', kind: 'verse', startSec: 8 },
      { id: 'b', name: '', kind: 'verse', startSec: Number.NaN },
      null,
      { name: '', kind: 'verse', startSec: 0 },
    ],
  } as unknown as DawSession;
  const sections = sectionsOf(broken);
  eq(sections.length, 1, 'only the well-formed one survives');
  eq(sections[0]?.id, 'a', 'and it is the right one');
});

// ── Report ────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Arrangement: sections · ripple · duplicate · delete ===');
for (const r of results) {
  console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
