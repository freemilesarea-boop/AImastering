/**
 * layout-selftest — where things are drawn, and whether a hand can land on them.
 *
 * Three defects, all found by measuring the running app rather than by reading
 * it, and none of them visible to types, lint or any test with no DOM:
 *
 *   • the mixer's Master strip did not line up with the others.  The loudness
 *     readout was the FIRST thing in the master's scroll column and only on
 *     the master, so INSERTS / SENDS / I/O / DLY sat 48 px lower there than on
 *     an audio strip — and 48 px was not constant: the block is shorter while
 *     it says 재생하면 측정합니다 than when it shows six numbers, so the offset
 *     moved the moment playback started.  A console is read by scanning ACROSS
 *     strips; that made it impossible.  Measured after: SMART 226, INSERTS 254,
 *     SENDS 297, DLY 460 on all three strips.
 *
 *   • the 루베르 watermark printed itself over whatever the DAW had in its
 *     bottom-left corner.  Measured: over the mixer's first channel name
 *     'Audio 1' (6,683 111x15) and its +0.0 readout, and over the
 *     arrangement's 스크롤 label.  `pointer-events-none` meant it never
 *     blocked a click, so the hit-test sweep never saw it — it is text on top
 *     of text, which only a person or an overlap check notices.
 *
 *   • controls too small to hit.  ♯ ♭ × on a chord block were 12x13 and 15x13
 *     with 2 px between them, revealed on hover, and one of the three DELETES
 *     the chord.  The track column had a 6x16 colour swatch and 16x16 A / ✎.
 *
 * The rules below are the ones a future edit could quietly undo.  The pixel
 * measurements are in the comments because they came from the app, not from
 * here; what this file holds is the SHAPE that produced them.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:layout
 */

import { readFileSync } from 'node:fs';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

/**
 * Source with comments removed, so a check reads code and not the prose about
 * it.  Both of the files below explain in a comment what they used to be, and
 * a plain search calls the explanation the defect — the same mistake as
 * grepping a file for a symbol and matching the sentence describing it.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
    .join('\n');
}

const MIX = readFileSync('src/renderer/components/daw/mix/MixWindow.tsx', 'utf8');
const APP = readFileSync('src/renderer/App.tsx', 'utf8');
const CSS = readFileSync('src/renderer/styles/index.css', 'utf8');
const CHORD = readFileSync('src/renderer/components/daw/edit/ChordLane.tsx', 'utf8');

/**
 * The lane height, read out of the source rather than imported.
 *
 * Importing the module pulls in the whole component and with it appStore,
 * which reads `import.meta.env` and throws outside Vite.  The number is the
 * thing being checked, so reading it is enough.
 */
const CHORD_LANE_HEIGHT = Number(
  /export const CHORD_LANE_HEIGHT = (\d+);/.exec(CHORD)?.[1] ?? NaN);

// ── 1. The mixer's strips line up ───────────────────────────────────────────

check('the master loudness block no longer pushes every shared band down', () => {
  const smart = MIX.indexOf('Smart Controls — the macro layer');
  const loud = MIX.indexOf('{isMaster && <MasterLoudness />}');
  assert(smart > 0 && loud > 0, 'the strip no longer has both a SMART button and a loudness block');
  assert(loud > smart,
    'MasterLoudness is above SMART again — every band below it shifts on the master only');
  // Last in the scroll column: after it there is nothing but the fader.
  const fader = MIX.indexOf('{/* Fader + meter */}');
  assert(fader > loud, 'the loudness block is no longer the last thing in the scroll column');
});

check('the master keeps the I/O row the other strips have', () => {
  // It has no output SELECTOR — it is the end of the chain — but without the
  // row, every band under I/O drops by its height on this strip alone.  That
  // is what made DLY 24 px out while INSERTS was 48.
  const at = MIX.indexOf('{isMaster && (');
  assert(at > 0, 'the master-only I/O row is gone');
  const row = stripComments(MIX.slice(at, MIX.indexOf('</span>', at) + 7));
  assert(row.includes('마스터 출력'), 'the master I/O row lost its label');
  assert(/inline-block/.test(row),
    'the row is block-level again — measured 2 px shorter than the <select> it stands in for');
  assert(!/<select/.test(row),
    'the row became a control — a dead dropdown invites a click that can never do anything');
});

// ── 2. The watermark steps aside ────────────────────────────────────────────

check('the watermark is not painted where the DAW has content', () => {
  const at = APP.indexOf('function Watermark()');
  assert(at > 0, 'the watermark is unconditional again');
  const body = APP.slice(at, APP.indexOf('\n}', at));
  assert(/currentPage/.test(body), 'the watermark no longer knows which page it is on');
  assert(/return null/.test(body), 'the watermark never steps aside');
  assert(/'daw'/.test(body), 'the watermark no longer stands down on the DAW page');
  assert(/useBottomZoneHeight|bottomZone/.test(body),
    'the watermark ignores the docked bottom zone, which is fixed to EVERY page');
});

// ── 3. Controls a hand can land on ──────────────────────────────────────────

check('the hit-target rule exists and is at least a pointer wide', () => {
  const at = CSS.indexOf('.hit-target::before');
  assert(at > 0, '.hit-target::before is gone — every control wearing the class is small again');
  const rule = CSS.slice(at, CSS.indexOf('}', at));
  assert(/content:/.test(rule), 'the pseudo-element has no content and so has no box');
  assert(/position:\s*absolute/.test(rule), 'the grown area is in the flow and moves the layout');
  const px = /max\(100%,\s*(\d+)px\)/.exec(rule);
  assert(px !== null, 'the area is no longer sized against a minimum');
  assert(Number(px?.[1]) >= 24, `the minimum target is ${px?.[1]}px, under 24`);
  assert(/max\(100%/.test(rule),
    'the area can now be SMALLER than the control it belongs to');
});

check('the controls that needed it are wearing it', () => {
  // Measured in the running app after: each of these answers a click 11 px
  // off its own centre (hit 23x23) where the paint is 6x16 or 16x16.
  const wearers: [string, string][] = [
    ['src/renderer/components/daw/edit/EditWindow.tsx', '트랙 색 swatch and the A / ✎ chips'],
    ['src/renderer/components/daw/edit/TempoTrack.tsx', 'the tempo and 박자 buttons'],
    ['src/renderer/components/daw/edit/ChordLane.tsx', 'the chord lane + button'],
    ['src/renderer/components/daw/edit/SectionLane.tsx', 'the section lane + button'],
    ['src/renderer/pages/DawPage.tsx', 'the ← 홈 link'],
  ];
  for (const [file, what] of wearers) {
    assert(readFileSync(file, 'utf8').includes('hit-target'),
      `${what} lost its hit area — ${file}`);
  }
});

check('the chord lane chips are big enough and far enough apart', () => {
  // ♯ ♭ × sit side by side on a chord block and one of them deletes it.  An
  // invisible hit area is the WRONG fix here: two 24 px targets 15 px apart
  // hand the overlap to whichever paints last, which makes the delete easier
  // to hit by accident.  Real size, real gap.
  const at = CHORD.indexOf('function laneChip(');
  assert(at > 0, 'laneChip is gone');
  const body = CHORD.slice(at, CHORD.indexOf('\n}', at));
  const h = /height:\s*(\d+)/.exec(body);
  const w = /minWidth:\s*(\d+)/.exec(body);
  assert(Number(h?.[1]) >= 20, `laneChip is ${h?.[1]}px tall, under 20`);
  assert(Number(w?.[1]) >= 20, `laneChip has no 20px minimum width (${w?.[1]})`);
  assert(!/hit-target/.test(body),
    'laneChip grew an invisible area instead — adjacent targets would overlap onto 지우기');

  const trio = CHORD.indexOf("opacity-0 group-hover:opacity-100");
  assert(trio > 0, 'the per-chord chips are gone');
  const row = CHORD.slice(trio - 120, trio + 60);
  assert(!/gap-0\.5/.test(row), 'the chips are back to a 2px gap');
  const del = CHORD.indexOf('title="지우기"');
  assert(del > 0 && /className="ml-1"/.test(CHORD.slice(del - 200, del + 120)),
    '지우기 lost the extra separation that keeps a mis-click off it');
});

check('the chord lane is tall enough for the rows it holds', () => {
  // Measured: the header's three 20px rows need 75px of the 76 it has, and
  // the box does not scroll — clientHeight 75, scrollHeight 75.  At 56 with
  // 16px rows the last row's bottom was 357 inside a box ending at 358.
  assert(CHORD_LANE_HEIGHT >= 76,
    `CHORD_LANE_HEIGHT is ${CHORD_LANE_HEIGHT} — three 20px rows need 76`);
  const header = CHORD.slice(CHORD.indexOf('flex flex-wrap items-center'));
  assert(/overflow-hidden/.test(header.slice(0, 200)),
    'the header stopped clipping, so an overflowing row would paint over the lane');
  assert(!/flex-1/.test(header.slice(0, 2000)),
    'a flex-1 spacer is back in the header — it collapses in a 167px column');
  assert(!/className="h-4 /.test(CHORD),
    'a 16px control is back in the chord lane header');
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== layout: drawn where it can be reached ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
