/**
 * note-length-selftest.ts — a note you can hold, and a key you can hear.
 *
 * Two defects, one editor.
 *
 * A drawn note was ALWAYS exactly one grid cell.  `placeNote` created it at
 * `durationBeat: gridBeat` and returned, so the only way to a longer note was
 * a six-pixel handle on its right edge that nothing on screen mentioned.  At
 * the 1/16 grid the editor opens on, a whole note meant sixteen cells drawn
 * one at a time, or one cell and a hunt for six pixels — on an instrument
 * layer whose whole point is that a piano holds.
 *
 * And the piano keyboard down the left side was decoration.  Its handler
 * cleared the selection and returned, under a comment that said it
 * auditioned.  That comment is why it lasted: the behaviour existed in the
 * prose describing it and nowhere else.  This repository has now written that
 * exact bug — a check, or a claim, matching the words rather than the code —
 * often enough that the source checks below run over COMMENT-STRIPPED text.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  draggedDuration, MIN_NOTE_BEATS,
} from '../src/renderer/daw/edit/midi-edit.js';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed += 1; console.log(`[PASS] ${name}`); }
  else    { failed += 1; console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

function near(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

function read(rel: string): string {
  return fs.readFileSync(path.join(DESKTOP, rel), 'utf8');
}

/**
 * Block and line comments removed.
 *
 * Every source check below reads this, never the raw file.  The bug this
 * suite exists for lived in a comment; a check that can be satisfied by prose
 * would be the same bug wearing a test's clothes.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ── 1. The arithmetic ───────────────────────────────────────────────────────

const GRID = 0.25;   // a sixteenth, the grid the editor opens on

check('an edge pulled one cell past the start gives one cell',
  near(draggedDuration(0, 0.25, GRID, true), 0.25),
  `got ${draggedDuration(0, 0.25, GRID, true)}`);

check('an edge pulled to beat 4 from beat 0 gives a whole note',
  near(draggedDuration(0, 4, GRID, true), 4),
  `got ${draggedDuration(0, 4, GRID, true)}`);

// The whole point of the feature: a note longer than one cell has to be
// reachable in one gesture.  If this is 0.25 the editor is back where it was.
check('a drag is not silently clamped to one cell',
  draggedDuration(0, 2, GRID, true) > GRID,
  `got ${draggedDuration(0, 2, GRID, true)}`);

// ROUNDS, unlike drawStartBeat's floor.  Past the half-way point of a cell
// you are aiming at the NEXT line, and flooring would make the last half of
// every cell unreachable — you could never pull a note to it.
check('past half a cell the edge rounds up to the next line',
  near(draggedDuration(0, 0.9, GRID, true), 1),
  `got ${draggedDuration(0, 0.9, GRID, true)}`);

check('before half a cell the edge rounds down',
  near(draggedDuration(0, 0.8, GRID, true), 0.75),
  `got ${draggedDuration(0, 0.8, GRID, true)}`);

check('with snap off the edge lands exactly where it was dropped',
  near(draggedDuration(0, 1.234, GRID, false), 1.234),
  `got ${draggedDuration(0, 1.234, GRID, false)}`);

// A negative-length note draws as a sliver pointing the wrong way and plays
// as nothing at all.
check('an edge dragged back past its own start leaves a real note',
  draggedDuration(2, 0.5, GRID, true) >= MIN_NOTE_BEATS,
  `got ${draggedDuration(2, 0.5, GRID, true)}`);

check('a note that starts late measures from ITS start, not from zero',
  near(draggedDuration(8, 12, GRID, true), 4),
  `got ${draggedDuration(8, 12, GRID, true)}`);

// A grid of 0 is what a division control reaches while being typed into.
check('a zero grid does not divide by zero',
  Number.isFinite(draggedDuration(0, 1.5, 0, true))
    && draggedDuration(0, 1.5, 0, true) > 0,
  `got ${draggedDuration(0, 1.5, 0, true)}`);

// ── 2. The editor actually uses it ──────────────────────────────────────────

const editor = stripComments(read('src/renderer/components/daw/midi/KeyEditor.tsx'));

check('the resize drag computes length with draggedDuration',
  /draggedDuration\s*\(/.test(editor));

// The fix itself: placeNote hands the new note to the resize drag, so the
// press that made it keeps going as the drag that lengthens it.
const drawsByDragging =
  /const\s+made\s*=\s*placeNote\s*\(/.test(editor)
  && /setDrag\s*\(\s*\{\s*kind:\s*'resize'[^}]*made/.test(editor);
check('drawing a note starts a resize drag, so the length is one gesture',
  drawsByDragging);

// ── 3. The keyboard sounds ──────────────────────────────────────────────────

const runtime = stripComments(read('src/renderer/daw/engine/daw-runtime.ts'));

check('the runtime exposes previewNote',
  /previewNote\s*\(\s*\n?\s*session/.test(runtime) || /\bpreviewNote\s*\(/.test(runtime));

// A preview that only looked the channel up would return false on a freshly
// opened project, where nothing has built the graph yet — a key that does
// nothing, which is the state we started from.
check('previewNote builds the graph rather than failing quietly',
  /previewNote[\s\S]{0,900}?this\.ensure\s*\(\s*\)/.test(runtime)
  && /previewNote[\s\S]{0,900}?this\.sync\s*\(\s*session\s*\)/.test(runtime));

check('previewNote actually plays a note on the instrument',
  /previewNote[\s\S]{0,1200}?instrument\.playNote\s*\(/.test(runtime));

// Finite, so a finger run down the keyboard cannot leave a chord hanging.
check('an auditioned note has a duration and cannot hang',
  /previewNote[\s\S]{0,1200}?durationSec,/.test(runtime));

// The key itself.  Anchored on the handler, not on the word "audition"
// appearing somewhere in the file.
check('a piano key calls the audition when pressed',
  /onMouseDown=\{\(\)\s*=>\s*\{[^}]*audition\s*\(\s*pitch\s*\)/.test(editor));

check('the audition goes through the runtime',
  /dawRuntime\.previewNote\s*\(/.test(editor));

// The one thing worse than a silent key is a silent key that says nothing.
check('a key that cannot sound says so',
  /previewNote[\s\S]{0,300}?notify\s*\(/.test(editor));

check('a drum row sounds its own slot, not a pitch read off a name',
  /audition\s*\(\s*slot\.pitch\s*\)/.test(editor));

// ── 4. The sweep is looking at the real thing ───────────────────────────────

check('the editor source was actually read',
  editor.length > 20_000, `${editor.length} chars`);

check('stripComments removes comments but keeps code',
  !stripComments('// audition(pitch)\nconst x = 1;').includes('audition')
  && stripComments('// audition(pitch)\nconst x = 1;').includes('const x = 1'));

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
