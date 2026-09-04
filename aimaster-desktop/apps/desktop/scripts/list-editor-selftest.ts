/**
 * list-editor-selftest.ts — the part as a table of numbers.
 *
 * What is worth testing hard here is the arithmetic that stands between what
 * a row SHOWS and what the part STORES, because every one of those conversions
 * is invisible until it is wrong:
 *
 *   • Bar|beat|tick round-tripping.  Someone who reads `9|3|480`, puts the
 *     cursor in it and presses enter without changing a character must not
 *     find the note has moved by a tick.  And a song that changes signature
 *     must not make bar 9 mean two different beats depending on which
 *     direction you asked.
 *   • Per-note curve points.  Their time is stored relative to their NOTE and
 *     shown relative to the PART; getting the direction wrong moves a bend to
 *     twice the note's position and looks like the curve "jumped".
 *   • Unipolar curves are 0…1 stored, 0…127 typed.  Bend is −1…1 in both.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:list-editor
 */

import {
  deleteRows, describeList, editRow, formatLength, formatPosition, formatValue,
  listRows, parseLength, parsePosition, parseValue, toggleRowMute,
  type ListInput, type ListRow,
} from '../src/renderer/daw/edit/list-events.js';
import {
  createNote, findExpression, from7bit, resetNoteIds, to7bit,
  type ControllerLane, type MidiNote,
} from '../src/renderer/daw/model/midi.js';
import {
  TICKS_PER_BEAT, barBeatAt, beatAtBarBeat, defaultTempoMap, normaliseTempoMap,
  type TempoMap,
} from '../src/renderer/daw/model/tempo-map.js';

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

const FOUR = defaultTempoMap(120, [4, 4]);
const rowOf = (rows: readonly ListRow[], id: string): ListRow =>
  rows.find((r) => r.id === id) as ListRow;

function part(spec: readonly [number, number, number?, number?][]): MidiNote[] {
  resetNoteIds();
  return spec.map(([pitch, startBeat, vel, len]) => createNote({
    pitch, startBeat, velocity: from7bit(vel ?? 100), durationBeat: len ?? 1,
  }));
}

// ── Bar|beat|tick, both directions ──────────────────────────────────────────

check('a position typed back unchanged does not move the event', () => {
  // The whole reason `beatAtBarBeat` exists.  Read a position, press enter,
  // and nothing moves — otherwise every glance at the list is an edit.
  for (const beat of [0, 0.25, 1, 3.5, 8, 12.75, 33.125, 100.5]) {
    const text = formatPosition(FOUR, 0, beat);
    const back = parsePosition(FOUR, 0, text) as number;
    near(back, beat, 1 / TICKS_PER_BEAT / 2, `round trip at ${text}`);
  }
});

check('the inverse agrees with the reader at every tick of a bar', () => {
  for (let tick = 0; tick < TICKS_PER_BEAT; tick += 37) {
    const at = { bar: 3, beat: 2, tick };
    const beat = beatAtBarBeat(FOUR, at);
    const back = barBeatAt(FOUR, beat);
    assert(back.bar === at.bar && back.beat === at.beat, `${back.bar}|${back.beat}`);
    near(back.tick, tick, 1, `tick ${tick} → ${back.tick}`);
  }
});

check('a signature change is honoured in both directions', () => {
  // 4/4 for two bars, then 3/4.  Bar 3 beat 1 is beat 8; bar 4 beat 1 is 11,
  // not 12 — the arithmetic that assumes a constant bar width gets this wrong
  // and every position after the change is off by a beat per bar.
  const map: TempoMap = normaliseTempoMap({
    tempos: [{ id: 't', beat: 0, bpm: 120, curve: 'jump' }],
    meters: [
      { id: 'm1', bar: 1, numerator: 4, denominator: 4 },
      { id: 'm2', bar: 3, numerator: 3, denominator: 4 },
    ],
  });
  near(beatAtBarBeat(map, { bar: 3, beat: 1, tick: 0 }), 8, 1e-9, 'bar 3 starts at beat 8');
  near(beatAtBarBeat(map, { bar: 4, beat: 1, tick: 0 }), 11, 1e-9, 'and bar 4 at 11, not 12');
  const back = barBeatAt(map, 11);
  assert(back.bar === 4 && back.beat === 1, `${back.bar}|${back.beat}`);
});

check('6/8 counts eighth notes, both ways', () => {
  const map = defaultTempoMap(120, [6, 8]);
  // One bar of 6/8 is three quarter-note beats; its fourth eighth is 1.5.
  near(beatAtBarBeat(map, { bar: 1, beat: 4, tick: 0 }), 1.5, 1e-9, 'bar 1 beat 4');
  const back = barBeatAt(map, 1.5);
  assert(back.bar === 1 && back.beat === 4, `${back.bar}|${back.beat}`);
});

check('a part that starts at bar 9 does not call its first bar 1', () => {
  // Bar numbers belong to the SONG.  A list showing a part's own bar 1 would
  // be unusable next to a transport that says 9.
  const partStart = 32;   // bar 9 in 4/4
  assert(formatPosition(FOUR, partStart, 0).startsWith('9|1|'),
    formatPosition(FOUR, partStart, 0));
  near(parsePosition(FOUR, partStart, '9|1|000') as number, 0, 1e-9, 'and back to 0');
  near(parsePosition(FOUR, partStart, '10|1|000') as number, 4, 1e-9, 'bar 10 is a bar later');
});

check('a half-typed position is refused rather than moving the event to bar 0', () => {
  assert(parsePosition(FOUR, 0, '') === null, 'empty');
  assert(parsePosition(FOUR, 0, 'abc') === null, 'not a number');
  assert(parsePosition(FOUR, 0, '1|2|3|4') === null, 'too many fields');
  near(parsePosition(FOUR, 0, '3') as number, 8, 1e-9, 'but a bar on its own is a position');
  near(parsePosition(FOUR, 0, '3|2') as number, 9, 1e-9, 'and so is bar|beat');
});

check('a position before the part is clamped, not made negative', () => {
  // An event at a negative beat is unreachable in every editor here.
  near(parsePosition(FOUR, 32, '1|1|000') as number, 0, 1e-9, 'held at the part start');
});

check('lengths are ticks, not bars', () => {
  assert(formatLength(2) === '2', formatLength(2));
  assert(formatLength(2.5) === '2.480', formatLength(2.5));
  near(parseLength('2.5') as number, 2.5, 1e-9, 'and back');
  assert(parseLength('-1') === null, 'a negative length is not a length');
});

// ── Rows ────────────────────────────────────────────────────────────────────

function withCurve(): { input: ListInput; note: MidiNote } {
  const notes = part([[60, 12, 100, 2]]);
  const note = notes[0] as MidiNote;
  const withBend = {
    ...note,
    expression: [{
      target: { kind: 'pitchBend' as const },
      points: [{ timeBeat: 0, value: 0 }, { timeBeat: 1, value: 0.5 }],
    }],
  };
  return { input: { notes: [withBend] }, note: withBend };
}

check('every event in the part gets a row', () => {
  const { input } = withCurve();
  const rows = listRows(input);
  assert(rows.length === 3, `one note plus two bend points, got ${rows.length}`);
  assert(rows.filter((r) => r.kind === 'note').length === 1, 'one note row');
  assert(rows.filter((r) => r.kind === 'expression').length === 2, 'two curve rows');
  assert(describeList(rows).includes('커브 포인트 2개'), describeList(rows));
});

check('a curve point is shown where it ACTUALLY is, not where it is stored', () => {
  // Stored at 1 beat into a note that starts at beat 12.  Showing "beat 1"
  // would be true of the storage and useless to a reader.
  const { input } = withCurve();
  const rows = listRows(input);
  const points = rows.filter((r) => r.kind === 'expression');
  near((points[0] as ListRow).beat, 12, 1e-9, 'the first point sits on the note');
  near((points[1] as ListRow).beat, 13, 1e-9, 'the second a beat later, in PART time');
});

check('rows are ordered so a re-read does not shuffle under the cursor', () => {
  // Two notes at the same instant, and the curve of one of them.  Position
  // alone leaves the order to the sort's stability; kind and pitch decide it.
  const notes = part([[67, 4], [60, 4], [62, 0]]);
  const rows = listRows({ notes });
  assert(rows.map((r) => r.beat).join() === '0,4,4', rows.map((r) => r.beat).join());
  const atFour = rows.filter((r) => r.beat === 4).map((r) => r.pitch);
  assert(atFour.join() === '60,67', `the lower note first, twice running: ${atFour}`);
  assert(listRows({ notes }).map((r) => r.id).join() === rows.map((r) => r.id).join(),
    'and the same order on a re-read');
});

check('a part lane gets rows too, in part time', () => {
  const lane: ControllerLane = {
    id: 'lane-1', target: { kind: 'cc', controller: 1 }, visible: true,
    points: [{ timeBeat: 0, value: 0 }, { timeBeat: 4, value: 1 }],
  };
  const rows = listRows({ notes: part([[60, 0]]), lanes: [lane] });
  const laneRows = rows.filter((r) => r.kind === 'lane');
  assert(laneRows.length === 2, 'both points');
  near((laneRows[1] as ListRow).beat, 4, 1e-9, 'at their own beats');
  assert((laneRows[0] as ListRow).label.includes('파트'), 'and named as part-level');
});

check('the kind filter narrows the table without changing what is left', () => {
  const { input } = withCurve();
  const onlyNotes = listRows(input, { kinds: ['note'] });
  assert(onlyNotes.length === 1 && onlyNotes[0]?.kind === 'note', 'just the note');
  const onlyCurves = listRows(input, { kinds: ['expression'] });
  assert(onlyCurves.length === 2, 'just the points');
  near((onlyCurves[0] as ListRow).beat, 12, 1e-9, 'still in part time');
});

// ── Units ───────────────────────────────────────────────────────────────────

check('velocity is shown and typed in 7-bit', () => {
  const notes = part([[60, 0, 77]]);
  const rows = listRows({ notes });
  assert((rows[0] as ListRow).velocity === 77, `${(rows[0] as ListRow).velocity}`);
  const done = editRow({ notes }, rows[0] as ListRow, 'velocity', 100);
  assert(to7bit((done.notes[0] as MidiNote).velocity) === 100, 'typed 100, stored as 100/127');
  near((done.notes[0] as MidiNote).velocity, from7bit(100), 1e-9, 'in the model units');
});

check('a unipolar curve is 0…127 typed, a bend is −1…1', () => {
  const lane: ControllerLane = {
    id: 'l', target: { kind: 'cc', controller: 1 }, visible: true,
    points: [{ timeBeat: 0, value: 0.5 }],
  };
  const rows = listRows({ notes: [], lanes: [lane] });
  assert(formatValue(rows[0] as ListRow) === '64', formatValue(rows[0] as ListRow));
  near(parseValue(rows[0] as ListRow, '127') as number, 1, 1e-9, 'full scale is 127');

  const { input } = withCurve();
  const bend = listRows(input).filter((r) => r.kind === 'expression')[1] as ListRow;
  assert(formatValue(bend) === '0.500', formatValue(bend));
  near(parseValue(bend, '-0.25') as number, -0.25, 1e-9, 'and a bend keeps its own units');
});

// ── Writing back ────────────────────────────────────────────────────────────

check('typing a note position moves the note there', () => {
  const notes = part([[60, 0]]);
  const rows = listRows({ notes });
  const beat = parsePosition(FOUR, 0, '3|2|480') as number;
  const done = editRow({ notes }, rows[0] as ListRow, 'position', beat);
  near((done.notes[0] as MidiNote).startBeat, 9.5, 1e-9, 'bar 3 beat 2 and a half');
  assert(done.changed, 'and it says it changed something');
});

check('typing a curve point position converts back to NOTE time', () => {
  // Shown absolute, stored relative.  Getting the direction wrong here puts
  // the point at twice the note's position and looks like the curve jumped.
  const { input } = withCurve();
  const rows = listRows(input);
  const point = rows.filter((r) => r.kind === 'expression')[1] as ListRow;
  const done = editRow(input, point, 'position', 13.5);
  const curve = findExpression(done.notes[0] as MidiNote, { kind: 'pitchBend' });
  near(curve?.points[1]?.timeBeat ?? -1, 1.5, 1e-9,
    'stored 1.5 beats into a note that starts at 12');
});

check('a moved curve point is re-sorted, not left out of order', () => {
  // `curveValueAt` walks the points in order; one out of order reads as the
  // curve jumping backwards in time.  Moving the FIRST point PAST the second
  // is the case that inverts them — moving one onto another does not.
  const { input } = withCurve();
  const rows = listRows(input);
  const first = rows.filter((r) => r.kind === 'expression')[0] as ListRow;
  const done = editRow(input, first, 'position', 13.5);   // past the second, at 13
  const points = findExpression(done.notes[0] as MidiNote, { kind: 'pitchBend' })?.points ?? [];
  assert(points.length === 2, 'both points are still there');
  assert((points[0]?.timeBeat ?? 9) < (points[1]?.timeBeat ?? 0),
    `sorted after the move: ${points.map((pt) => pt.timeBeat).join()}`);
  // And the values travelled with their points rather than staying put.
  near(points[1]?.value ?? 0, 0, 1e-9, 'the point that moved kept its own value');
});

check('a moved LANE point is re-sorted too', () => {
  // Per-note curves are sorted by `setExpression` on the way in; a part lane
  // is written straight back, so this is the path where the sort in
  // `replacePoints` is the only thing keeping the curve readable.
  const lane: ControllerLane = {
    id: 'l', target: { kind: 'cc', controller: 1 }, visible: true,
    points: [{ timeBeat: 0, value: 0 }, { timeBeat: 1, value: 0.5 },
      { timeBeat: 2, value: 1 }],
  };
  const input: ListInput = { notes: [], lanes: [lane] };
  const first = listRows(input)[0] as ListRow;
  const done = editRow(input, first, 'position', 3);   // past both the others
  const times = done.lanes[0]?.points.map((p) => p.timeBeat) ?? [];
  assert(times.join() === '1,2,3', `sorted after the move: ${times.join()}`);
  near(done.lanes[0]?.points[2]?.value ?? -1, 0, 1e-9, 'and it kept its own value');
});

check('values that run off the end are held, and notes are never zero-length', () => {
  const notes = part([[60, 0]]);
  const rows = listRows({ notes });
  assert((editRow({ notes }, rows[0] as ListRow, 'pitch', 900).notes[0] as MidiNote).pitch === 127,
    'pitch held at the top of the keyboard');
  assert((editRow({ notes }, rows[0] as ListRow, 'velocity', 0).notes[0] as MidiNote).velocity
    > 0, 'velocity 0 is a note-off, not a note');
  assert((editRow({ notes }, rows[0] as ListRow, 'channel', 99).notes[0] as MidiNote).channel === 15,
    'channel held at 16');
  assert((editRow({ notes }, rows[0] as ListRow, 'length', 0).notes[0] as MidiNote).durationBeat
    > 0, 'a zero-length note is inaudible and un-clickable');
});

check('a unipolar curve cannot be pushed negative, a bend can', () => {
  const lane: ControllerLane = {
    id: 'l', target: { kind: 'cc', controller: 1 }, visible: true,
    points: [{ timeBeat: 0, value: 0.5 }],
  };
  const input: ListInput = { notes: [], lanes: [lane] };
  const row = listRows(input)[0] as ListRow;
  near(editRow(input, row, 'value', -0.4).lanes[0]?.points[0]?.value ?? -1, 0, 1e-9,
    'a CC has no negative half');

  const bendInput = withCurve().input;
  const bendRow = listRows(bendInput).filter((r) => r.kind === 'expression')[1] as ListRow;
  const done = editRow(bendInput, bendRow, 'value', -0.4);
  const points = findExpression(done.notes[0] as MidiNote, { kind: 'pitchBend' })?.points ?? [];
  near(points.find((p) => p.timeBeat === 1)?.value ?? 0, -0.4, 1e-9, 'a bend does');
});

check('a field the row does not accept is refused, not half-applied', () => {
  const { input } = withCurve();
  const point = listRows(input).filter((r) => r.kind === 'expression')[0] as ListRow;
  const done = editRow(input, point, 'pitch', 40);
  assert(!done.changed, 'a curve point has no pitch');
  assert((done.notes[0] as MidiNote).pitch === 60, 'and the note it hangs off did not move');
});

check('a row pointing at something that is gone changes nothing', () => {
  const notes = part([[60, 0]]);
  const row = listRows({ notes })[0] as ListRow;
  const done = editRow({ notes: [] }, row, 'pitch', 61);
  assert(!done.changed, 'no note, no edit');
});

check('an unreadable number leaves the event alone', () => {
  const notes = part([[60, 4]]);
  const rows = listRows({ notes });
  const done = editRow({ notes }, rows[0] as ListRow, 'position', Number.NaN);
  assert(!done.changed, 'NaN is not a position');
  near((done.notes[0] as MidiNote).startBeat, 4, 1e-9, 'and the note stayed');
});

// ── Mute and delete ─────────────────────────────────────────────────────────

check('mute toggles from the list, which has no other way to say it', () => {
  const notes = part([[60, 0]]);
  const row = listRows({ notes })[0] as ListRow;
  const done = toggleRowMute({ notes }, row);
  assert((done.notes[0] as MidiNote).muted, 'muted');
  assert(!toggleRowMute(done, listRows(done)[0] as ListRow).notes[0]?.muted, 'and back');
});

check('deleting a note row removes the note and its curves with it', () => {
  const { input } = withCurve();
  const noteRow = listRows(input)[0] as ListRow;
  const done = deleteRows(input, [noteRow]);
  assert(done.notes.length === 0, 'the note is gone');
  assert(listRows(done).length === 0, 'and so are the rows that hung off it');
});

check('deleting a curve point leaves the note alone', () => {
  const { input } = withCurve();
  const point = listRows(input).filter((r) => r.kind === 'expression')[1] as ListRow;
  const done = deleteRows(input, [point]);
  assert(done.notes.length === 1, 'the note is still there');
  const points = findExpression(done.notes[0] as MidiNote, { kind: 'pitchBend' })?.points ?? [];
  assert(points.length === 1, `one point left, got ${points.length}`);
  near(points[0]?.timeBeat ?? -1, 0, 1e-9, 'and it is the one that was not deleted');
});

check('deleting several points at once drops all of them, not just the first', () => {
  // Removing by index one at a time shifts the indices under the later ones,
  // which quietly deletes the wrong points.
  const lane: ControllerLane = {
    id: 'l', target: { kind: 'cc', controller: 1 }, visible: true,
    points: [{ timeBeat: 0, value: 0 }, { timeBeat: 1, value: 0.3 },
      { timeBeat: 2, value: 0.6 }, { timeBeat: 3, value: 1 }],
  };
  const input: ListInput = { notes: [], lanes: [lane] };
  const rows = listRows(input);
  const done = deleteRows(input, [rows[0] as ListRow, rows[2] as ListRow]);
  const left = done.lanes[0]?.points.map((p) => p.timeBeat) ?? [];
  assert(left.join() === '1,3', `the first and third go: ${left}`);
});

check('deleting nothing reports nothing', () => {
  const { input } = withCurve();
  assert(!deleteRows(input, []).changed, 'an empty selection is not an edit');
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== List editor: the part as a table of numbers ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
