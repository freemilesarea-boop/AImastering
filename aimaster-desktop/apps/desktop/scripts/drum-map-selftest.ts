/**
 * drum-map-selftest.ts — a kit instead of a wall of numbers.
 *
 * The tests worth writing here are about the two things a drum map can get
 * wrong WITHOUT anybody noticing until they listen:
 *
 *   • The out-pitch rewrite.  Applied to the stored part instead of the
 *     output, the original pitches are gone and the map can never be changed
 *     again.  Applied twice, the kick moves twice.
 *   • Choke groups.  An open hi-hat that is not choked rings on underneath
 *     the closed one for its whole sample.  It does not sound like a bug; it
 *     sounds like a kit with two hi-hats.
 *
 * And one that is quiet in the other direction: a note whose pitch the map
 * does not name has to still get a row, or it is invisible in the editor and
 * cannot be selected, moved or deleted.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:drum-map
 */

import {
  GM_DRUM_MAP, MIN_DRUM_CELL_PX, applyChokes, applyDrumMap, createDrumMap,
  describeMap, describeSlot, drumCellPx, moveSlot, outPitchOf, quantizeByMap,
  remapPitch, rowOf, rowsFor, setSlot, slotFor, usedSlots, type DrumMap,
} from '../src/renderer/daw/model/drum-map.js';
import { createNote, resetNoteIds, type MidiNote } from '../src/renderer/daw/model/midi.js';
import {
  assignDrumMap, drumMapFor, drumMapsOf, ensureDefaultDrumMap, findDrumMap,
  removeDrumMap, setSessionDrumMap, tracksUsingDrumMap,
} from '../src/renderer/daw/model/drum-map-session.js';
import { cachedFor, playedNotes } from '../src/renderer/daw/model/drum-map-play.js';
import { addTrack, createSession, createTrack, findTrack } from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function near(a: number, b: number, eps: number, m: string): void {
  if (!(Math.abs(a - b) <= eps)) throw new Error(`${m} — got ${a}, want ${b} ±${eps}`);
}
const KICK = 36, SNARE = 38, CLOSED = 42, PEDAL = 44, OPEN = 46, RIDE = 51;

function hits(spec: readonly [number, number, number?][]): MidiNote[] {
  resetNoteIds();
  return spec.map(([pitch, startBeat, durationBeat]) =>
    createNote({ pitch, startBeat, durationBeat: durationBeat ?? 0.25 }));
}
const pitches = (notes: readonly MidiNote[]): number[] => notes.map((n) => n.pitch);
const idOf = (notes: readonly MidiNote[], i: number): string => (notes[i] as MidiNote).id;
const byId = (notes: readonly MidiNote[], id: string): MidiNote =>
  notes.find((n) => n.id === id) as MidiNote;

// ── Names and order ─────────────────────────────────────────────────────────

check('the map names the pitches a kit actually uses', () => {
  assert(slotFor(GM_DRUM_MAP, KICK)?.name === '킥', 'note 36 is a kick');
  assert(slotFor(GM_DRUM_MAP, SNARE)?.name === '스네어', 'note 38 is a snare');
  assert(slotFor(GM_DRUM_MAP, 99) === null, 'and a pitch it does not name says so');
});

check('the rows are in KIT order, not pitch order', () => {
  const rows = rowsFor(GM_DRUM_MAP, []);
  assert(rowOf(rows, KICK) < rowOf(rows, SNARE), 'kick above snare');
  assert(rowOf(rows, SNARE) < rowOf(rows, CLOSED), 'snare above the hats');
  assert(rowOf(rows, CLOSED) < rowOf(rows, RIDE), 'hats above the ride');
  // Which is emphatically not what sorting by pitch gives.
  const sorted = [...rows].map((s) => s.pitch).sort((a, b) => a - b);
  assert(rows.map((s) => s.pitch).join() !== sorted.join(), 'and not merely pitch order');
});

check('a pitch the map does not name still gets a row', () => {
  // The failure this guards: an editor that silently hides part of the part.
  // A note with no row cannot be seen, selected, moved or deleted.
  const notes = hits([[KICK, 0], [99, 1]]);
  const rows = rowsFor(GM_DRUM_MAP, notes);
  assert(rowOf(rows, 99) >= 0, 'note 99 has somewhere to draw');
  assert(rowOf(rows, 99) > rowOf(rows, RIDE), 'appended after the named kit, not mixed in');
  assert((rows[rowOf(rows, 99)] as { name: string }).name === '99', 'named by its number');
});

check('the used-instrument list is what the part plays, in display order', () => {
  const notes = hits([[RIDE, 0], [KICK, 0], [KICK, 1]]);
  assert(usedSlots(GM_DRUM_MAP, notes).map((s) => s.pitch).join() === `${KICK},${RIDE}`,
    'kick first because the KIT order says so, though the ride was written first');
  assert(describeMap(GM_DRUM_MAP, notes).includes('악기 2개'), describeMap(GM_DRUM_MAP, notes));
  assert(describeMap(GM_DRUM_MAP, hits([[99, 0]])).includes('이름 없는 노트 1개'),
    'and an unnamed note is counted out loud');
});

// ── The out-pitch, which is not cosmetic ────────────────────────────────────

check('the map rewrites the pitch on the way OUT', () => {
  const map = setSlot(GM_DRUM_MAP, KICK, { outPitch: 24 });
  near(outPitchOf(map, KICK), 24, 0, 'the kick plays 24');
  near(outPitchOf(map, SNARE), SNARE, 0, 'and a slot with no out-pitch plays itself');
  near(outPitchOf(map, 99), 99, 0, 'as does a pitch with no slot at all');
});

check('applying the map does NOT touch the written part', () => {
  // The whole point of I-note / O-note.  Rewrite the stored notes and the
  // original pitches are gone, the editor rows move, and the map can never be
  // changed again.
  const map = setSlot(GM_DRUM_MAP, KICK, { outPitch: 24 });
  const notes = hits([[KICK, 0], [SNARE, 1]]);
  const played = applyDrumMap(map, notes);
  assert(pitches(played).join() === '24,38', pitches(played).join());
  assert(pitches(notes).join() === '36,38', 'the part is untouched');
  // And applying it again to the SAME source gives the same answer.
  assert(pitches(applyDrumMap(map, notes)).join() === '24,38', 'idempotent on the source');
});

check('a muted slot drops out of playback but stays in the part', () => {
  const map = setSlot(GM_DRUM_MAP, RIDE, { muted: true });
  const notes = hits([[KICK, 0], [RIDE, 0], [SNARE, 1]]);
  assert(pitches(applyDrumMap(map, notes)).join() === '36,38', 'the ride is silent');
  assert(notes.length === 3, 'and still there to un-mute');
});

// ── Choke groups ────────────────────────────────────────────────────────────

check('closing the hi-hat stops the open one', () => {
  // An open hat on beat 0 lasting a whole beat, closed on beat 0.5.  Without
  // the choke both ring together for half a beat and it sounds like two hats.
  const notes = hits([[OPEN, 0, 1], [CLOSED, 0.5, 0.25]]);
  const played = applyDrumMap(GM_DRUM_MAP, notes);
  near(byId(played, idOf(notes, 0)).durationBeat, 0.5, 1e-9, 'the open hat is cut at the close');
  near(byId(played, idOf(notes, 1)).durationBeat, 0.25, 1e-9, 'the closed hat is untouched');
  near((notes[0] as MidiNote).durationBeat, 1, 1e-9, 'and the written part still says 1 beat');
});

check('the pedal hat chokes the open one too — they are one instrument', () => {
  const notes = hits([[OPEN, 0, 2], [PEDAL, 1, 0.25]]);
  const played = applyDrumMap(GM_DRUM_MAP, notes);
  near(byId(played, idOf(notes, 0)).durationBeat, 1, 1e-9, 'cut by the pedal');
});

check('instruments in different groups do not touch each other', () => {
  const notes = hits([[OPEN, 0, 2], [RIDE, 0.5, 2], [KICK, 0.5, 2]]);
  const played = applyDrumMap(GM_DRUM_MAP, notes);
  near(byId(played, idOf(notes, 0)).durationBeat, 2, 1e-9, 'the ride does not choke the hat');
  near(byId(played, idOf(notes, 1)).durationBeat, 2, 1e-9, 'the ride rings');
  near(byId(played, idOf(notes, 2)).durationBeat, 2, 1e-9, 'so does the kick');
});

check('a choke never lengthens a note and never inverts one', () => {
  // The closed hat lands AFTER the open one has already finished.
  const late = hits([[OPEN, 0, 0.25], [CLOSED, 1, 0.25]]);
  near(byId(applyDrumMap(GM_DRUM_MAP, late), idOf(late, 0)).durationBeat, 0.25, 1e-9,
    'a hat that already stopped is not stretched to the next hit');
  // Two hits at the same instant are simultaneous, not a choke of zero length.
  const together = hits([[OPEN, 1, 0.5], [CLOSED, 1, 0.5]]);
  near(byId(applyDrumMap(GM_DRUM_MAP, together), idOf(together, 0)).durationBeat, 0.5, 1e-9,
    'a simultaneous hit does not cut the other to nothing');
});

check('three hats in a row choke in sequence, not all onto the last', () => {
  const notes = hits([[OPEN, 0, 4], [CLOSED, 1, 4], [OPEN, 2, 4]]);
  const played = applyDrumMap(GM_DRUM_MAP, notes);
  near(byId(played, idOf(notes, 0)).durationBeat, 1, 1e-9, 'first cut at the second');
  near(byId(played, idOf(notes, 1)).durationBeat, 1, 1e-9, 'second cut at the third');
  near(byId(played, idOf(notes, 2)).durationBeat, 4, 1e-9, 'and the last rings on');
});

check('the choke follows the WRITTEN pitch, not the rewritten one', () => {
  // Two UNGROUPED instruments — a ride and its bell — both rewritten onto the
  // closed hat's pitch, which IS in a choke group.  Grouping by the rewritten
  // pitch would make them start choking each other because of a coincidence
  // of the output map; the map never said they were one instrument.
  const BELL = 53;
  const map: DrumMap = setSlot(setSlot(GM_DRUM_MAP, RIDE, { outPitch: CLOSED }),
    BELL, { outPitch: CLOSED });
  const notes = hits([[RIDE, 0, 2], [BELL, 1, 2]]);
  const played = applyDrumMap(map, notes);
  assert(pitches(played).join() === `${CLOSED},${CLOSED}`, pitches(played).join());
  near(byId(played, idOf(notes, 0)).durationBeat, 2, 1e-9,
    'the ride rings its full length — the map never grouped it with anything');
});

check('a map with no groups at all is left exactly alone', () => {
  const plain = createDrumMap('플레인', 'plain', [
    { pitch: KICK, name: '킥' }, { pitch: SNARE, name: '스네어' },
  ]);
  const notes = hits([[KICK, 0, 4], [KICK, 1, 4]]);
  const played = applyChokes(plain, notes);
  near((played[0] as MidiNote).durationBeat, 4, 1e-9, 'nothing is shortened');
});

// ── Editing ─────────────────────────────────────────────────────────────────

check('each instrument quantizes to its OWN grid', () => {
  const map = setSlot(setSlot(GM_DRUM_MAP, CLOSED, { quantizeBeat: 0.25 }),
    KICK, { quantizeBeat: 0.5 });
  // A hat at 0.30 and a kick at 0.30: the hat goes to 0.25, the kick to 0.5.
  const notes = hits([[CLOSED, 0.30], [KICK, 0.30]]);
  const done = quantizeByMap(map, notes);
  near((done.find((n) => n.pitch === CLOSED) as MidiNote).startBeat, 0.25, 1e-9, 'hat to 1/16');
  near((done.find((n) => n.pitch === KICK) as MidiNote).startBeat, 0.5, 1e-9, 'kick to 1/8');
});

check('a slot with no grid is not quantized by somebody else’s', () => {
  // The ghost note the player meant.  Falling back to a part-wide grid would
  // flatten exactly the thing that was played on purpose.
  const map = setSlot(GM_DRUM_MAP, CLOSED, { quantizeBeat: 0.25 });
  const notes = hits([[SNARE, 0.31]]);
  near((quantizeByMap(map, notes)[0] as MidiNote).startBeat, 0.31, 1e-9, 'left where it was');
});

check('dragging a lane moves every hit of that instrument', () => {
  const notes = hits([[CLOSED, 0], [CLOSED, 1], [KICK, 0]]);
  const moved = remapPitch(notes, CLOSED, RIDE);
  assert(moved.filter((n) => n.pitch === RIDE).length === 2, 'both hats became rides');
  assert(moved.filter((n) => n.pitch === KICK).length === 1, 'the kick stayed');
  assert(remapPitch(notes, CLOSED, CLOSED)[0]?.pitch === CLOSED, 'a move to itself is a no-op');
});

check('rows can be reordered, and a move off the end does nothing', () => {
  const rows = (m: DrumMap): number[] => m.slots.map((s) => s.pitch);
  const first = (GM_DRUM_MAP.slots[0] as { pitch: number }).pitch;
  const down = moveSlot(GM_DRUM_MAP, first, 1);
  assert(rows(down)[1] === first, 'moved down one');
  assert(rows(moveSlot(GM_DRUM_MAP, first, -1)).join() === rows(GM_DRUM_MAP).join(),
    'and off the top is refused rather than wrapping');
  assert(rows(moveSlot(GM_DRUM_MAP, 999, 1)).join() === rows(GM_DRUM_MAP).join(),
    'as is moving a row that is not there');
});

check('editing a slot leaves the rest of the map alone', () => {
  const map = setSlot(GM_DRUM_MAP, SNARE, { name: '레이어드 스네어' });
  assert(slotFor(map, SNARE)?.name === '레이어드 스네어', 'renamed');
  assert(slotFor(GM_DRUM_MAP, SNARE)?.name === '스네어', 'and the original is untouched');
  assert(map.slots.length === GM_DRUM_MAP.slots.length, 'no row added');
  const added = setSlot(GM_DRUM_MAP, 99, { name: '샘플' });
  assert(added.slots.length === GM_DRUM_MAP.slots.length + 1, 'a new pitch appends a row');
});

check('the row header says the pitch, the name, and any rewrite', () => {
  assert(describeSlot({ pitch: 36, name: '킥' }) === '36 킥', describeSlot({ pitch: 36, name: '킥' }));
  const remapped = describeSlot({ pitch: 36, name: '킥', outPitch: 24 });
  assert(remapped.includes('→ 24'), `a rewrite is visible: ${remapped}`);
});

// ── The shape, and the target that has to match it ──────────────────────────

check('a hit fills its CELL, so its width is one grid step', () => {
  // The pattern is read as a row of filled boxes, not as points balanced on
  // lines.  A box is also a whole step to aim at rather than a few pixels.
  const ppb = 160, grid = 0.25;          // a 1/16 cell is 40px wide
  near(drumCellPx(0.25, grid, ppb), 40, 1e-9, 'exactly one cell');
});

check('a hit SHORTER than the cell still fills it', () => {
  // The cell IS the step the note lives in; a 1/32 hit on a 1/16 grid is on
  // that step, and half a box would read as a different position.
  near(drumCellPx(1 / 32, 0.25, 160), 40, 1e-9, 'still a full 1/16 cell');
});

check('a hit LONGER than the cell shows its real length', () => {
  // A ringing crash should read as a ringing crash, not be cut back to a step.
  near(drumCellPx(2, 0.25, 160), 320, 1e-9, 'two beats stay two beats');
});

check('a cell is never too small to aim at', () => {
  // Zoomed far out, one step can be under a pixel.  The target must not be.
  assert(drumCellPx(1 / 32, 1 / 32, 4) >= MIN_DRUM_CELL_PX,
    `${drumCellPx(1 / 32, 1 / 32, 4)} is at least the floor`);
  assert(drumCellPx(0, 0, 0) >= MIN_DRUM_CELL_PX, 'and so is a degenerate one');
});

check('with no grid the hit falls back to its own length', () => {
  // Snap off, so there is no step to fill — the note's length is all there is.
  near(drumCellPx(0.5, 0, 160), 80, 1e-9, 'its own half beat');
});

check('the cell follows the grid, so changing the grid changes the boxes', () => {
  const eighth = drumCellPx(0.25, 0.5, 160);
  const sixteenth = drumCellPx(0.25, 0.25, 160);
  assert(eighth > sixteenth, `${eighth} > ${sixteenth}`);
});

// ── Where the kit lives ─────────────────────────────────────────────────────

function drumSession() {
  resetIds();
  let session = createSession('kit');
  const drums = createTrack('Drums', 'instrument');
  const piano = createTrack('Piano', 'instrument');
  session = addTrack(addTrack(session, drums), piano);
  return { session, drums: drums.id, piano: piano.id };
}

check('a map is stored once and referenced, not copied onto tracks', () => {
  const { session, drums } = drumSession();
  const assigned = assignDrumMap(session, drums, GM_DRUM_MAP);
  assert(drumMapsOf(assigned).length === 1, 'one copy in the session');
  assert(findDrumMap(assigned, 'gm') !== null, 'findable by id');
  assert(drumMapFor(assigned, findTrack(assigned, drums)) === findDrumMap(assigned, 'gm'),
    'and the track points at that one copy');
});

check('a track with no kit gets NO kit, not a default one', () => {
  // Applying General MIDI to a piano part would transpose it.  Null is the
  // right answer here and has to survive being convenient to override.
  const { session, drums, piano } = drumSession();
  const assigned = assignDrumMap(session, drums, GM_DRUM_MAP);
  assert(drumMapFor(assigned, findTrack(assigned, piano)) === null, 'the piano has none');
  assert(drumMapFor(assigned, undefined) === null, 'and neither does no track at all');
});

check('a track pointing at a map that is gone reads null, not a substitute', () => {
  const { session, drums } = drumSession();
  const assigned = assignDrumMap(session, drums, GM_DRUM_MAP);
  // The map is deleted but the reference is left behind — the state a session
  // reaches when a kit is removed by an older build.
  const orphan = { ...assigned, drumMaps: [] };
  assert(drumMapFor(orphan, findTrack(orphan, drums)) === null,
    'silently substituting a kit would move every instrument in the part');
});

check('removing a map clears it off the tracks that used it', () => {
  const { session, drums } = drumSession();
  const assigned = assignDrumMap(session, drums, GM_DRUM_MAP);
  assert(tracksUsingDrumMap(assigned, 'gm').length === 1, 'one user');
  const gone = removeDrumMap(assigned, 'gm');
  assert(drumMapsOf(gone).length === 0, 'the map is gone');
  assert(tracksUsingDrumMap(gone, 'gm').length === 0, 'and so is the dangling id');
  assert(drumMapFor(gone, findTrack(gone, drums)) === null, 'the track has no kit');
});

check('assigning null takes the kit off without touching the session library', () => {
  const { session, drums } = drumSession();
  const on = assignDrumMap(session, drums, GM_DRUM_MAP);
  const off = assignDrumMap(on, drums, null);
  assert(drumMapFor(off, findTrack(off, drums)) === null, 'the track is clear');
  assert(drumMapsOf(off).length === 1, 'but the kit is still there to re-assign');
});

check('editing a map in the session replaces it rather than adding a second', () => {
  const { session, drums } = drumSession();
  const on = assignDrumMap(session, drums, GM_DRUM_MAP);
  const edited = setSessionDrumMap(on, setSlot(GM_DRUM_MAP, SNARE, { name: '바뀐 스네어' }));
  assert(drumMapsOf(edited).length === 1, 'still one map');
  assert(slotFor(drumMapFor(edited, findTrack(edited, drums)) as DrumMap, SNARE)?.name
    === '바뀐 스네어', 'and the track sees the edit');
});

check('a session with no maps can be given the built-in kit, once', () => {
  const { session } = drumSession();
  const first = ensureDefaultDrumMap(session);
  assert(drumMapsOf(first).length === 1, 'added');
  assert(ensureDefaultDrumMap(first) === first, 'and not added again');
});

// ── What the instrument is handed ───────────────────────────────────────────

check('a part with no kit is handed back BY REFERENCE', () => {
  // A non-drum track must not pay for any of this — not a walk, not an array.
  const notes = hits([[60, 0], [64, 1]]);
  assert(playedNotes(null, notes) === notes, 'the same array, untouched');
});

check('the played part is computed once and reused', () => {
  const map = setSlot(GM_DRUM_MAP, KICK, { outPitch: 24 });
  const notes = hits([[KICK, 0], [OPEN, 1, 2], [CLOSED, 1.5]]);
  const first = playedNotes(map, notes);
  assert(playedNotes(map, notes) === first, 'a second read is the same object');
  assert(cachedFor(notes) === first, 'because it was cached');
});

check('the cache is a cache, not a source of truth', () => {
  // The two things it depends on, changed one at a time.  Getting this wrong
  // means an edited kit or an edited part keeps playing the old one — which
  // is exactly the kind of bug that looks like the map "not working".
  const map = setSlot(GM_DRUM_MAP, KICK, { outPitch: 24 });
  const notes = hits([[KICK, 0]]);
  const first = playedNotes(map, notes);

  const editedMap = setSlot(map, KICK, { outPitch: 25 });
  const second = playedNotes(editedMap, notes);
  assert(second !== first, 'a changed kit is recomputed');
  near((second[0] as MidiNote).pitch, 25, 0, 'and plays the new pitch');

  const editedNotes = hits([[KICK, 0], [SNARE, 1]]);
  assert(playedNotes(editedMap, editedNotes).length === 2, 'a changed part is recomputed');
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Drum map: a kit, not a wall of numbers ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
