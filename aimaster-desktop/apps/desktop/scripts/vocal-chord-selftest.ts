/**
 * vocal-chord-selftest — editing one note, and editing the progression.
 *
 * The pitch analyser and the PSOLA renderer already worked; what did not exist
 * was a way to touch ONE segment or ONE chord.  Most of this file is about the
 * seam that opens up once you can:
 *
 *   RENDERING TWICE MUST NOT CORRECT TWICE.  `renderClipPitch` re-points the
 *   clip at a new file and used to leave the edits in place, so the second
 *   render applied every correction again on top of audio that already had it.
 *   Shortcut-only, nobody hit it; with an editor, "fix one more note, press
 *   render" is the normal way to work.  Half these tests are that one claim
 *   said different ways.
 *
 * The pitch fixtures are synthesised segments with a known median, a known
 * drift and a known vibrato, so every assertion is arithmetic rather than a
 * judgement about audio.
 *
 * Run: pnpm --filter @aimaster/desktop test:vocal-chord
 */

import {
  bakeSegment, bakeSegments, correctedLine, describeSegment, editedPitch,
  findClipSegments, hasPendingEdits, isEdited, mapSegments, moveToPitch,
  nudgeCents, patchSegment, performanceLine, pitchName, pitchRange,
  resetSegment, segmentAt, segmentsInSpan, tuningErrorCents,
} from '../src/renderer/daw/edit/vocal-edit.js';
import {
  MIN_CHORD_GAP_SEC, addChord, chordGrid, chordRanges, describeChords,
  moveChord, parseChordInput, removeChord, setChord, shiftChords, sortedChords,
  transposeChords, withChords,
} from '../src/renderer/daw/edit/chord-edit.js';
import {
  NEUTRAL_EDIT, targetPitchAt, curveCentsAt, type VariSegment,
} from '../src/renderer/daw/audio/pitch-analysis.js';
import { formatChord, makeChord, parseChord } from '../src/renderer/daw/model/chords.js';
import {
  addTrack, createClip, createSession, createTrack, updateClips,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { DawSession, TrackId, ClipId } from '../src/renderer/daw/model/types.js';

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
 * One sung note: median A3 + `flatCents`, a slow upward drift, and a vibrato
 * written into the curve so vibratoScale has something real to act on.
 */
function segment(
  id: string, startSec: number, lengthSec: number,
  flatCents = -30, driftCentsPerSec = 40, vibratoDepthCents = 30,
): VariSegment {
  const curve: { timeSec: number; cents: number }[] = [];
  for (let t = 0; t <= lengthSec + 1e-9; t += 0.01) {
    curve.push({
      timeSec: t,
      cents: driftCentsPerSec * t + vibratoDepthCents * Math.sin(2 * Math.PI * 5 * t),
    });
  }
  return {
    id,
    startSec,
    endSec: startSec + lengthSec,
    measured: {
      medianPitch: 57 + flatCents / 100,
      curve,
      confidence: 0.9,
      vibratoRateHz: 5,
      vibratoDepthCents,
      driftCentsPerSec,
    },
    edit: { ...NEUTRAL_EDIT },
  };
}

function clipWith(segments: VariSegment[]): {
  session: DawSession; trackId: TrackId; clipId: ClipId;
} {
  resetIds();
  let session = createSession('vocal test', 48000);
  const track = createTrack('Lead Vox', 'audio');
  session = addTrack(session, track);
  const clip = createClip('f1', 'take', { startSec: 0, offsetSec: 0, durationSec: 4 });
  session = updateClips(session, track.id, () => [{ ...clip, pitchSegments: segments }]);
  return { session, trackId: track.id, clipId: clip.id };
}

// ── Reading a segment ─────────────────────────────────────────────────────────

check('the edited pitch is the measured pitch plus the offset, and nothing else', () => {
  const s = segment('a', 0, 0.5, -30);
  close(editedPitch(s), 56.7, 'unedited reads what was sung');
  close(editedPitch(nudgeCents(s, 30)), 57, 'nudged up 30 cents lands on A3');
});

check('the tuning error is signed, so flat and sharp are different', () => {
  close(tuningErrorCents(segment('a', 0, 0.5, -30)), -30, 'flat reads negative');
  close(tuningErrorCents(segment('a', 0, 0.5, 45)), 45, 'sharp reads positive');
});

check('an unedited segment reports itself unedited, in every field', () => {
  const s = segment('a', 0, 0.5);
  eq(isEdited(s), false, 'clean');
  for (const patch of [
    { pitchOffsetCents: 1 }, { vibratoScale: 0.5 }, { driftScale: 0 },
    { curveScale: 0.9 }, { formantSemitones: 1 }, { timeOffsetSec: 0.01 },
  ]) {
    eq(isEdited(patchSegment(s, patch)), true, `${Object.keys(patch)[0]} counts as an edit`);
  }
});

check('reset restores exactly what was sung', () => {
  const s = patchSegment(segment('a', 0, 0.5), { pitchOffsetCents: 120, vibratoScale: 0 });
  const back = resetSegment(s);
  eq(isEdited(back), false, 'clean again');
  close(editedPitch(back), editedPitch(segment('a', 0, 0.5)), 'and back where it started');
});

check('dragging to a pitch puts the note at that pitch', () => {
  const s = segment('a', 0, 0.5, -30);
  const moved = moveToPitch(s, 59);
  close(editedPitch(moved), 59, 'lands where the pointer was');
  close(moved.edit.pitchOffsetCents, 230, 'and the offset says how far it travelled');
  eq(isEdited(moveToPitch(s, Number.NaN)), false, 'a NaN drag does nothing at all');
});

// ── Drawing ───────────────────────────────────────────────────────────────────

check('the pitch range covers both what was sung and where it was dragged', () => {
  const low = segment('a', 0, 0.5, 0);
  const dragged = moveToPitch(segment('b', 1, 0.5, 0), 76);
  const range = pitchRange([low, dragged]);
  assert(range.lowPitch <= 57 && range.highPitch >= 76,
    `covers 57…76, got ${range.lowPitch}…${range.highPitch}`);
});

check('a single-note clip still gets a grid with height', () => {
  const range = pitchRange([segment('a', 0, 0.5)]);
  assert(range.highPitch - range.lowPitch >= 4, `got ${range.highPitch - range.lowPitch} semitones`);
});

check('no segments draws a sane default octave', () => {
  const range = pitchRange([]);
  assert(range.highPitch > range.lowPitch, 'and not an inverted one');
});

check('the performance line follows the measured curve; the corrected line follows the edit', () => {
  const s = segment('a', 2, 0.4, -30, 40, 30);
  const sung = performanceLine(s);
  const fixed = correctedLine(moveToPitch(s, 57));
  assert(sung.length > 10 && fixed.length > 10, 'both are drawn');
  close(sung[0]!.timeSec, 2, 'the performance starts at the segment start');
  // The sung line wobbles; the corrected line wobbles the same way one
  // semitone up, because moving a note does not remove its vibrato.
  const sungSpread = Math.max(...sung.map((p) => p.pitch)) - Math.min(...sung.map((p) => p.pitch));
  const fixedSpread = Math.max(...fixed.map((p) => p.pitch)) - Math.min(...fixed.map((p) => p.pitch));
  close(fixedSpread, sungSpread, 'the performance survives the move', 1e-3);
});

check('a time-nudged segment draws where it will actually land', () => {
  const s = patchSegment(segment('a', 2, 0.4), { timeOffsetSec: 0.05 });
  close(correctedLine(s)[0]!.timeSec, 2.05, 'the corrected line moved with it');
  close(performanceLine(s)[0]!.timeSec, 2, 'the performance line did not');
});

// ── Selection ─────────────────────────────────────────────────────────────────

check('a rubber band picks up everything it touches, including partial overlaps', () => {
  const segments = [segment('a', 0, 0.5), segment('b', 1, 0.5), segment('c', 2, 0.5)];
  eq(segmentsInSpan(segments, 0.4, 1.2).map((s) => s.id).join(), 'a,b', 'both edges count');
  eq(segmentsInSpan(segments, 1.2, 0.4).map((s) => s.id).join(), 'a,b', 'dragging backwards is the same span');
  eq(segmentsInSpan(segments, 5, 6).length, 0, 'and empty air selects nothing');
});

check('a click between phrases selects nothing rather than the nearest note', () => {
  const segments = [segment('a', 0, 0.5), segment('b', 1, 0.5)];
  eq(segmentAt(segments, 0.2)?.id, 'a', 'inside a note');
  eq(segmentAt(segments, 0.75), null, 'between two');
});

check('an edit applies to the selection and to nothing else', () => {
  const { session, trackId, clipId } = clipWith([
    segment('a', 0, 0.5), segment('b', 1, 0.5), segment('c', 2, 0.5),
  ]);
  const after = mapSegments(session, trackId, clipId, new Set(['a', 'c']),
    (s) => nudgeCents(s, 50));
  const segments = findClipSegments(after, trackId, clipId);
  close(segments[0]!.edit.pitchOffsetCents, 50, 'a moved');
  close(segments[1]!.edit.pitchOffsetCents, 0, 'b did not');
  close(segments[2]!.edit.pitchOffsetCents, 50, 'c moved');
});

check('an empty selection is a no-op, not a whole-clip edit', () => {
  const { session, trackId, clipId } = clipWith([segment('a', 0, 0.5)]);
  const after = mapSegments(session, trackId, clipId, new Set(), (s) => nudgeCents(s, 100));
  eq(findClipSegments(after, trackId, clipId).some(isEdited), false, 'nothing moved');
  eq(after, session, 'and the session object itself is untouched');
});

// ── Baking: the bug this feature exposes ──────────────────────────────────────

check('baking leaves the note where the render put it', () => {
  const s = moveToPitch(segment('a', 0, 0.5, -30), 57);
  const target = targetPitchAt(s, 0.25);
  const baked = bakeSegment(s);
  close(targetPitchAt(baked, 0.25), target,
    'the same moment still sounds at the same pitch', 1e-9);
});

check('baking clears the edit, so a second render changes nothing', () => {
  const s = moveToPitch(segment('a', 0, 0.5, -30), 57);
  const once = bakeSegment(s);
  eq(isEdited(once), false, 'nothing pending after a render');
  const twice = bakeSegment(once);
  close(targetPitchAt(twice, 0.25), targetPitchAt(once, 0.25),
    'baking again is a no-op', 1e-9);
});

check('WITHOUT baking, a second render would double every correction', () => {
  // The bug, stated as arithmetic.  Re-analysing tuned audio measures the
  // TUNED pitch; leaving the old edit on top of that is the double.
  const original = moveToPitch(segment('a', 0, 0.5, -30), 57);
  const rendered = targetPitchAt(original, 0);
  const naive: VariSegment = {
    ...original,
    measured: { ...original.measured, medianPitch: rendered },   // what the file now is
    // …and the edit still sitting there, which is what used to happen
  };
  const doubled = targetPitchAt(naive, 0);
  assert(Math.abs(doubled - rendered) > 0.25,
    `the un-baked path really does drift: ${(doubled - rendered).toFixed(3)} semitones`);
  // With the bake, it does not.
  close(targetPitchAt(bakeSegment(original), 0), rendered, 'baked stays put', 1e-9);
});

check('baking folds a flattened vibrato into the measurement', () => {
  const s = patchSegment(segment('a', 0, 0.5, 0, 0, 40), { vibratoScale: 0 });
  const baked = bakeSegment(s);
  close(baked.measured.vibratoDepthCents, 0, 'the editor stops drawing a wobble that is gone');
  const spread = (seg: VariSegment): number => {
    const line = performanceLine(seg);
    return Math.max(...line.map((p) => p.pitch)) - Math.min(...line.map((p) => p.pitch));
  };
  assert(spread(baked) < spread(segment('a', 0, 0.5, 0, 0, 40)) / 4,
    'and the drawn performance is flat too');
  // The curve itself must be flat, or the next render would scale it again.
  for (const point of baked.measured.curve) close(point.cents, 0, 'curve flattened', 1e-9);
});

check('baking folds a halved drift into the measurement', () => {
  const s = patchSegment(segment('a', 0, 0.5, 0, 60, 0), { driftScale: 0.5 });
  const baked = bakeSegment(s);
  close(baked.measured.driftCentsPerSec, 30, 'half the slide is now what was recorded');
  close(curveCentsAt(baked.measured.curve, 0.4), 12, 'and the curve agrees', 1e-6);
});

check('baking moves a time-nudged segment to where it now sits', () => {
  const s = patchSegment(segment('a', 2, 0.4), { timeOffsetSec: 0.05 });
  const baked = bakeSegment(s);
  close(baked.startSec, 2.05, 'the segment moved with the audio');
  close(baked.edit.timeOffsetSec, 0, 'and will not move again');
});

check('baking a clean segment is the identity', () => {
  const s = segment('a', 1, 0.5);
  const baked = bakeSegment(s);
  close(baked.measured.medianPitch, s.measured.medianPitch, 'pitch untouched');
  close(baked.startSec, s.startSec, 'position untouched');
  eq(bakeSegments([s]).length, 1, 'and the list form works');
});

// ── Chords: typing ────────────────────────────────────────────────────────────

check('typing a chord is the primary input, and a typo says so', () => {
  const good = parseChordInput('  Fmaj7 ');
  assert(good.ok, 'whitespace is not an error');
  eq(good.ok ? formatChord(good.chord) : '', 'Fmaj7', 'and it round-trips');

  const bad = parseChordInput('Hmaj9999');
  eq(bad.ok, false, 'nonsense is refused');
  assert(!bad.ok && bad.reason.includes('Hmaj9999'), `and quoted back: ${!bad.ok && bad.reason}`);
  assert(!bad.ok && bad.reason.includes('Am'), 'with examples');
});

check('an empty box is a cancel, not a malformed chord', () => {
  const empty = parseChordInput('   ');
  eq(empty.ok, false, 'nothing to add');
  eq(empty.ok ? '' : empty.reason, '', 'and no scolding');
});

check('a slash chord survives the round trip', () => {
  const parsed = parseChordInput('D/F#');
  assert(parsed.ok, 'parsed');
  eq(parsed.ok ? formatChord(parsed.chord) : '', 'D/F#', 'and prints the same');
});

// ── Chords: the list ──────────────────────────────────────────────────────────

const C = makeChord(0);
const Am = makeChord(9, 'min');
const F = makeChord(5);

check('a chord lands where it was put, and the list stays sorted', () => {
  const first = addChord([], 4, Am);
  assert(first.ok, 'added');
  const second = first.ok ? addChord(first.events, 0, C) : null;
  assert(second?.ok, 'added before it');
  eq(second!.ok ? second!.events.map((e) => formatChord(e.chord)).join() : '', 'C,Am',
    'sorted by time, not by insertion');
});

check('a second chord on top of an existing one is refused', () => {
  const first = addChord([], 4, C);
  const clash = first.ok ? addChord(first.events, 4 + MIN_CHORD_GAP_SEC / 2, Am) : null;
  eq(clash?.ok, false, 'refused');
  assert(!clash?.ok && clash?.reason.includes('이미'), 'and says why');
});

check('a chord runs until the next one, and the last runs to the end of the song', () => {
  const events = [
    { id: 'a', timeSec: 0, chord: C },
    { id: 'b', timeSec: 4, chord: Am },
  ];
  const ranges = chordRanges(events, 12);
  close(ranges[0]!.endSec, 4, 'the first ends where the second starts');
  close(ranges[1]!.endSec, 12, 'the last runs to the end');
  eq(ranges[1]!.index, 1, 'and knows where it is in the list');
});

check('a change cannot be dragged past its neighbours', () => {
  const events = [
    { id: 'a', timeSec: 0, chord: C },
    { id: 'b', timeSec: 4, chord: Am },
    { id: 'c', timeSec: 8, chord: F },
  ];
  const pushed = moveChord(events, 'b', 99);
  const moved = pushed.find((e) => e.id === 'b');
  close(moved!.timeSec, 8 - MIN_CHORD_GAP_SEC, 'clamped under the next one');
  const pulled = moveChord(events, 'b', -99);
  close(pulled.find((e) => e.id === 'b')!.timeSec, MIN_CHORD_GAP_SEC, 'and over the previous one');
  eq(pushed.map((e) => e.id).join(), 'a,b,c', 'the order never changes');
});

check('retyping one chord leaves the others alone', () => {
  const events = [
    { id: 'a', timeSec: 0, chord: C },
    { id: 'b', timeSec: 4, chord: Am },
  ];
  const fixed = setChord(events, 'b', parseChord('Am7')!);
  eq(describeChords(fixed), 'C · Am7', 'only the named one changed');
  eq(removeChord(fixed, 'a').length, 1, 'and one can be deleted');
});

check('transposing moves every chord, or only the chosen ones', () => {
  const events = [
    { id: 'a', timeSec: 0, chord: C },
    { id: 'b', timeSec: 4, chord: Am },
  ];
  eq(describeChords(transposeChords(events, 2)), 'D · Bm', 'the whole progression');
  eq(describeChords(transposeChords(events, 2, new Set(['b']))), 'C · Bm', 'or a selection');
  eq(describeChords(transposeChords(events, 0)), 'C · Am', 'and zero does nothing');
});

check('shifting moves only what is at or after the splice', () => {
  const events = [
    { id: 'a', timeSec: 0, chord: C },
    { id: 'b', timeSec: 4, chord: Am },
    { id: 'c', timeSec: 8, chord: F },
  ];
  const shifted = shiftChords(events, 4, 2);
  close(shifted.find((e) => e.id === 'a')!.timeSec, 0, 'before the splice, untouched');
  close(shifted.find((e) => e.id === 'b')!.timeSec, 6, 'at the splice, moved');
  close(shifted.find((e) => e.id === 'c')!.timeSec, 10, 'after it, moved');
});

check('a grid gives a songwriter something to type over', () => {
  resetIds();
  const grid = chordGrid(0, 2, 4);
  eq(grid.length, 4, 'four bars');
  close(grid[3]!.timeSec, 6, 'evenly spaced');
  eq(new Set(grid.map((e) => e.id)).size, 4, 'each with its own id');
  eq(chordGrid(0, 2, 0).length, 0, 'zero is zero');
  assert(chordGrid(0, 2, 10_000).length <= 256, 'and a runaway count is capped');
});

check('the chord track round-trips through the session', () => {
  resetIds();
  let session = createSession('chords', 48000);
  const added = addChord([], 4, Am);
  session = withChords(session, added.ok ? added.events : []);
  eq(sortedChords(session).length, 1, 'stored');
  eq(describeChords(sortedChords(session)), 'Am', 'and reads back');
  eq(describeChords([]), '코드 없음', 'an empty progression says so');
});

check('a window of the progression describes only that window', () => {
  const events = [
    { id: 'a', timeSec: 0, chord: C },
    { id: 'b', timeSec: 4, chord: Am },
    { id: 'c', timeSec: 8, chord: F },
  ];
  eq(describeChords(events, 3, 9), 'Am · F', 'only what is inside');
});

// ── Describing ────────────────────────────────────────────────────────────────

check('a segment describes itself in note names, not MIDI numbers', () => {
  eq(pitchName(57), 'A3', 'A3 is 57');
  eq(pitchName(60), 'C4', 'and middle C is 60');
  const text = describeSegment(segment('a', 0, 0.5, -30, 40, 30));
  assert(text.includes('A3'), `names the note: ${text}`);
  assert(text.includes('-30') || text.includes('−30'), `and how far off: ${text}`);
  assert(text.includes('비브라토'), 'and mentions a vibrato it measured');
});

check('a segment with no vibrato does not claim one', () => {
  const text = describeSegment(segment('a', 0, 0.5, 0, 0, 0));
  eq(text.includes('비브라토'), false, `quiet about what is not there: ${text}`);
  eq(text.includes('드리프트'), false, 'and about drift too');
});

check('an edited segment says it moved', () => {
  const text = describeSegment(moveToPitch(segment('a', 0, 0.5, -30), 57));
  assert(text.includes('이동'), `says so: ${text}`);
});

// ── Report ────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Vocal segments · chord track: editing one thing at a time ===');
for (const r of results) {
  console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
