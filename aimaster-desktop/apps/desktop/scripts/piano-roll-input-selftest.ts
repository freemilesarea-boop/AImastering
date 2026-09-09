/**
 * piano-roll-input-selftest.ts — you can get a note in.
 *
 * The bug this exists for: on a fresh instrument track the Key Editor opened
 * correctly, with a part, and nothing anyone tried put a note in it.
 * Measured in the running app at the time:
 *
 *     click        → 0 notes
 *     double-click → 0 notes      (it moved the playhead instead)
 *     Ctrl+click   → 1 note
 *
 * `tool === 'draw'` had always worked, but the Key Editor's toolbar offered
 * no way to select a tool, so the only people who found it were the ones who
 * happened to switch tools in the arrange window first.  A feature nobody can
 * reach is indistinguishable from one that is not there.
 *
 * So these are two different guarantees:
 *
 *   · the arithmetic — a drawn note starts in the cell you clicked
 *   · the reachability — the editor offers a way in that is not a modifier
 *     nobody mentioned
 *
 * The second is checked against the SOURCE, because the thing that broke was
 * not a function returning the wrong number; it was a handler that was never
 * wired and a button that was never drawn, and no unit test of the model
 * would have noticed either.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:piano-roll-input
 */

import { readFileSync } from 'node:fs';
import { drawStartBeat } from '../src/renderer/stores/midiEditorStore.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

/** The component, with comments stripped so a check reads code and not prose. */
const editor = readFileSync('src/renderer/components/daw/midi/KeyEditor.tsx', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
  .join('\n');

// ── The arithmetic ──────────────────────────────────────────────────────────

check('a drawn note starts in the cell the pointer is in, never the next one', () => {
  const grid = 0.25;
  // The exact case that was wrong: past the half-way point of a cell.
  assert(drawStartBeat(2.94, grid, true) === 2.75,
    `2.94 on a 0.25 grid started at ${drawStartBeat(2.94, grid, true)}, not 2.75`);
  // And every point inside a cell has to land on that cell's own line.
  for (const raw of [2.75, 2.80, 2.94, 2.99]) {
    assert(drawStartBeat(raw, grid, true) === 2.75, `${raw} landed elsewhere`);
  }
  for (let raw = 0; raw < 8; raw += 0.031) {
    const start = drawStartBeat(raw, grid, true);
    assert(start <= raw + 1e-9, `note at ${start} starts AFTER the pointer at ${raw}`);
    assert(raw - start < grid + 1e-9, `note at ${start} is more than a cell before ${raw}`);
  }
});

check('snap off puts the note exactly where the pointer was', () => {
  assert(drawStartBeat(2.94, 0.25, false) === 2.94, 'snap-off moved the note');
  assert(drawStartBeat(2.94, 0, true) === 2.94, 'a zero grid moved the note');
});

check('a note never starts before the part', () => {
  assert(drawStartBeat(-3, 0.25, true) === 0, 'negative beat leaked through');
  assert(drawStartBeat(-3, 0.25, false) === 0, 'negative beat leaked through with snap off');
});

// ── The reachability ────────────────────────────────────────────────────────

check('double-click writes a note rather than only moving the playhead', () => {
  const at = editor.indexOf('onDoubleClick');
  assert(at >= 0, 'the grid has no double-click handler at all');
  const body = editor.slice(at, at + 700);
  assert(body.includes('placeNote'),
    'double-click does not place a note — it was seek-only, which is what made '
    + 'the piano roll look broken');
});

check('the toolbar offers the pencil, so drawing is not a secret', () => {
  assert(editor.includes('setTool'),
    'the Key Editor cannot change tools, so `draw` is only reachable from another window');
  for (const id of ["'select'", "'draw'", "'erase'"]) {
    assert(editor.includes(id), `the toolbar does not offer ${id}`);
  }
});

check('a modifier is not the only way in', () => {
  // The original failure, stated directly.  Creating a note on empty grid
  // must not depend on metaKey/ctrlKey alone — the pencil has to satisfy the
  // same branch, or the only route in is one nothing on screen mentions.
  //
  // The first version of this check counted `placeNote(` call sites and
  // demanded three.  That was a proxy that did not mean what it claimed: the
  // pencil and the modifier are the SAME call site, reached through one
  // condition, so the true count is two and the check failed working code.
  const at = editor.indexOf('const onGridDown');
  assert(at >= 0, 'the grid has no mousedown handler');
  const body = editor.slice(at, at + 1200);
  const branch = /if\s*\(([^)]*placeNote[\s\S]{0,80}?)\)/.exec(body)
    ?? /if\s*\(([^{]*)\)\s*{\s*placeNote/.exec(body);
  assert(branch, 'nothing on the grid places a note');
  const condition = branch![1]!;
  assert(/tool\s*===\s*'draw'/.test(condition),
    `the draw condition is "${condition.trim()}" — it does not honour the `
    + 'pencil, so a modifier is the only way in');
  assert(/metaKey|ctrlKey/.test(condition),
    'the modifier shortcut was dropped; people who learned it lose it');
});

console.log('\n=== Piano roll — you can get a note in ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
