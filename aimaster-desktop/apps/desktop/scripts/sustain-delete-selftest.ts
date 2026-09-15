/**
 * sustain-delete-selftest.ts — the pedal, and the key that deletes.
 *
 * Two reports, and the second turned out to be the larger one.
 *
 * DELETE.  Select notes, press Delete, nothing happens.  `deleteNotes` had
 * been sitting in midi-edit.ts since it was written with ZERO callers: the
 * verb existed and no route reached it.  Delete and Backspace were bound to
 * `daw.clearRange`, which wants a TIMELINE range; in the Key Editor there is
 * none, so it returned without a word.
 *
 * SUSTAIN.  "It isn't there" was generous.  A pedal reached the session three
 * ways and sounded from none:
 *
 *   · per-note `expression` with kind 'cc' — what the Key Editor's controller
 *     lane wrote.  Playback reads pitchBend, timbre and pressure, and no cc
 *     target at all.
 *   · `clip.controllers` — where midi-file.ts puts the CC64 of an imported
 *     .mid.  session-migrate carried it, the List Editor showed it, MIDI
 *     export wrote it back, and no engine code had EVER read
 *     `clip.controllers`.  A pedalled piano part made a full round trip
 *     through this app in silence.
 *   · folded into note length on recording — the one path that worked, and
 *     the one whose module already said why: "THE PEDAL IS PART OF THE NOTE".
 *
 * So the fix follows the path that worked.  The pedal becomes length before
 * anything else looks at the part, which is also the only way to reach every
 * instrument: two of the built-ins use the shared `adsr()` helper and the
 * rest do not, so an envelope-level pedal would have sustained a Rhodes and
 * left a guitar dry.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pedalSpans, sustainedNotes, PEDAL_DOWN, SUSTAIN_CC } from '../src/renderer/daw/edit/sustain.js';
import { deleteNotes } from '../src/renderer/daw/edit/midi-edit.js';
import { createNote, noteEndBeat, type MidiNote } from '../src/renderer/daw/model/midi.js';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed += 1; console.log(`[PASS] ${name}`); }
  else    { failed += 1; console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

function read(rel: string): string {
  return fs.readFileSync(path.join(DESKTOP, rel), 'utf8');
}

/** Comments out, because this repo has repeatedly written checks that matched prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
    .join('\n');
}

const note = (startBeat: number, durationBeat: number, pitch = 60): MidiNote =>
  createNote({ pitch, startBeat, durationBeat });

// ── 1. Pedal spans ──────────────────────────────────────────────────────────

check('a press and a release make one span',
  JSON.stringify(pedalSpans([{ timeBeat: 1, value: 1 }, { timeBeat: 3, value: 0 }]))
    === JSON.stringify([{ from: 1, to: 3 }]));

check('a pedal never released holds open',
  pedalSpans([{ timeBeat: 1, value: 1 }])[0]?.to === Infinity);

check('an untouched lane has no spans',
  pedalSpans([]).length === 0);

check('a lane of releases alone never goes down',
  pedalSpans([{ timeBeat: 0, value: 0 }, { timeBeat: 2, value: 0 }]).length === 0);

check('a second press while already down does not open a second span',
  pedalSpans([
    { timeBeat: 1, value: 1 }, { timeBeat: 2, value: 1 }, { timeBeat: 3, value: 0 },
  ]).length === 1);

check('points out of order are still read in time order',
  JSON.stringify(pedalSpans([{ timeBeat: 3, value: 0 }, { timeBeat: 1, value: 1 }]))
    === JSON.stringify([{ from: 1, to: 3 }]));

// A switch, not a fader: this is the threshold the whole feature turns on.
check('half way counts as down',
  pedalSpans([{ timeBeat: 0, value: PEDAL_DOWN }, { timeBeat: 1, value: 0 }]).length === 1);

check('just under half counts as up',
  pedalSpans([{ timeBeat: 0, value: PEDAL_DOWN - 0.01 }]).length === 0);

// ── 2. What the pedal does to notes ────────────────────────────────────────

const pedalDown = [{ timeBeat: 0, value: 1 }, { timeBeat: 4, value: 0 }];

check('a note ending under the pedal rings until it lifts',
  near(noteEndBeat(sustainedNotes([note(0, 1)], pedalDown)[0]!), 4),
  `got ${noteEndBeat(sustainedNotes([note(0, 1)], pedalDown)[0]!)}`);

check('a note ending after the pedal lifts is untouched',
  near(noteEndBeat(sustainedNotes([note(0, 6)], pedalDown)[0]!), 6));

// This one was written vacuously the first time and caught by breaking it.
// The original asked about a note ending OUTSIDE the span, which never
// reaches the guard at all — it is filtered out one branch earlier, so the
// check passed with the guard deleted.  The guard only matters where a note
// ends inside an open span that the part limit closes BEFORE the note does:
// the limit is there to stop an unreleased pedal scheduling forever, and it
// must not become a knife that cuts notes down to the part's length.
check('the part limit clamps the pedal, never the note',
  near(sustainedNotes([note(0, 8)], [{ timeBeat: 0, value: 1 }], 4)[0]!.durationBeat, 8),
  `got ${sustainedNotes([note(0, 8)], [{ timeBeat: 0, value: 1 }], 4)[0]!.durationBeat}`);

check('a note entirely after the pedal is untouched',
  near(noteEndBeat(sustainedNotes([note(8, 1)], pedalDown)[0]!), 9));

check('with no pedal data nothing changes',
  near(noteEndBeat(sustainedNotes([note(0, 1)], [])[0]!), 1));

check('every note under one pedal is held, not just the first',
  sustainedNotes([note(0, 0.5, 60), note(1, 0.5, 64), note(2, 0.5, 67)], pedalDown)
    .every((n) => near(noteEndBeat(n), 4)));

// The reason the span is read as a step and not as a curve: an interpolating
// read would be half-released through the middle of every span, releasing
// notes the player was holding.
check('a long span holds all the way through its middle',
  near(noteEndBeat(sustainedNotes([note(15, 1)],
    [{ timeBeat: 0, value: 1 }, { timeBeat: 32, value: 0 }])[0]!), 32));

check('an unreleased pedal is bounded by the part, not scheduled forever',
  near(noteEndBeat(sustainedNotes([note(0, 1)], [{ timeBeat: 0, value: 1 }], 8)[0]!), 8));

check('the notes come back in the same order',
  sustainedNotes([note(0, 1, 60), note(1, 1, 64)], pedalDown).map((n) => n.pitch)
    .join() === '60,64');

// ── 3. Delete ──────────────────────────────────────────────────────────────

const three = [note(0, 1, 60), note(1, 1, 64), note(2, 1, 67)];
check('deleting one note leaves the others',
  deleteNotes(three, new Set([three[1]!.id])).map((n) => n.pitch).join() === '60,67');

check('deleting nothing changes nothing',
  deleteNotes(three, new Set()).length === 3);

// ── 4. The wiring, read from code and not from comments ────────────────────

const commands = stripComments(read('src/renderer/shortcuts/daw-commands.ts'));
const player   = stripComments(read('src/renderer/daw/engine/clip-player.ts'));
const editor   = stripComments(read('src/renderer/components/daw/midi/KeyEditor.tsx'));

check('deleteNotes finally has a caller',
  /deleteNotes\s*\(/.test(commands));

// The whole point: Delete reaches it from the same chord that clears a range.
check('the Delete chord deletes notes when the Key Editor has a selection',
  /'daw\.clearRange'[\s\S]{0,900}?selectedNoteIds\.length\s*>\s*0[\s\S]{0,400}?deleteNotes\s*\(/
    .test(commands));

// midiContext falls back to EVERY note in the part when nothing is picked,
// which would make one keypress empty the part.
check('delete refuses to fall back to the whole part',
  /'daw\.clearRange'[\s\S]{0,900}?editor\.selectedNoteIds/.test(commands));

check('the timeline meaning is still there for when no notes are picked',
  /'daw\.clearRange'[\s\S]{0,1400}?needSelection\s*\(\s*\)/.test(commands));

check('the pedal is applied where playback and bounce both pass',
  /sustainedNotes\s*\(/.test(player));

// Reading the part lane is the half that had never existed.
check('the engine reads clip.controllers at last',
  /\.controllers\.find\s*\(/.test(player));

// Before the inserts, so an arp arpeggiates notes that are already the right
// length — and before the drum map, which only decides which sound a pitch
// reaches.
check('the pedal is applied before the MIDI inserts',
  player.indexOf('sustainedNotes(') < player.indexOf('insertedNotes('));

check('a pedal drawn by hand goes to the part lane, not onto a note',
  /isPedal\s*\)?\s*\{[\s\S]{0,200}?writePedal\s*\(/.test(editor));

check('the editor draws the pedal as spans',
  /pedalSpans\s*\(/.test(editor));

// Found by measuring, not by reading.  The lane's mousedown handler was
// declared ABOVE `applyLanePoint` with an empty dependency array — it had to
// be empty, because naming a `const` declared further down inside a deps
// array is a temporal-dead-zone error.  So the handler was frozen on the
// first render's closure, where `part` did not exist yet, and every press in
// the lane hit `if (!part) return;`.
//
// Nothing in the bottom half of the piano roll worked: not velocity, not a
// bend, not any CC.  It looked like "the pedal is broken" only because the
// pedal is what someone happened to try.  The cure is the ORDER — declared
// after what it calls, so the dependency can be named at all.
const laneDownAt = editor.indexOf('const onLaneDown');
const applyAt = editor.indexOf('const applyLanePoint');
check('the lane handler is declared after the thing it calls',
  laneDownAt > applyAt && applyAt >= 0, `onLaneDown@${laneDownAt} applyLanePoint@${applyAt}`);

check('the lane handler is not frozen on the first render',
  /const onLaneDown = useCallback\([\s\S]{0,300}?\}, \[applyLanePoint\]\)/.test(editor));

// ── 5. The sweep is looking at the real thing ──────────────────────────────

check('SUSTAIN_CC is the pedal MIDI actually uses', SUSTAIN_CC === 64);

check('the sources were actually read',
  commands.length > 20_000 && player.length > 10_000 && editor.length > 20_000,
  `${commands.length}/${player.length}/${editor.length}`);

check('stripComments removes comments but keeps code',
  !stripComments('// deleteNotes(x)\nconst y = 1;').includes('deleteNotes')
  && stripComments('// deleteNotes(x)\nconst y = 1;').includes('const y = 1'));

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
