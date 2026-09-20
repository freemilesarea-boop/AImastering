/**
 * view-window-selftest — the DAW builds what you can see, and no more.
 *
 * Two windows, the same finding, two shapes.
 *
 * The console built every channel strip in the session whether or not it was
 * on screen.  Measured in the PRODUCTION build (the dev server's React spends
 * a third of its time in `jsxWithValidation` and would have made this look
 * worse than it is), clicking MIX and waiting for the frame it appears on:
 *
 *      8 tracks    48 ms
 *     24 tracks   125 ms
 *     48 tracks   248 ms      5687 DOM nodes
 *
 * Linear, at 5.2 ms a track, for a window switch — and all but thirteen of
 * those strips were off the side of the scroller while it happened.  It is
 * not React doing it: the click handler returns in 0.6 ms and a forced layout
 * straight after costs 0.1 ms, so the frame is spent in the browser building
 * and laying out five thousand nodes at 113 nodes a strip.
 *
 * After, on the same build and the same sessions: 51 / 80 / 79 ms — and the
 * scaling is gone, which is the part that mattered.  1580 nodes instead of
 * 5687.
 *
 * The maths is here rather than in the component because the invariant a
 * window has to hold is arithmetic: the two spacers plus the strips that ARE
 * built have to come to exactly the width of the strips that would have been,
 * or the scrollbar changes length under the hand holding it.
 *
 * The Edit window is the same story one window over, and the difference
 * decides its fix.  Clicking EDIT, on the same builds and sessions:
 *
 *      8 tracks    28 ms
 *     24 tracks    53 ms
 *     48 tracks    94 ms
 *
 * Linear at 1.6 ms a track — but a track row is only thirteen DOM nodes, so
 * it is not the markup.  Every row owns a CANVAS, and a canvas that exists is
 * one the browser allocates and paints: 927 × 96 a lane, forty-eight of them,
 * four and a third million pixels.  And the rows are not one size, so that
 * window walks the heights instead of dividing by one.
 *
 * After: 34 / 32 / 34 ms, and 323 DOM nodes whatever the session holds.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:view-window
 */

import { readFileSync } from 'node:fs';

import {
  STRIP_OVERSCAN, STRIP_PX, stripWindow,
} from '../src/renderer/daw/model/strip-window.js';
import { LANE_OVERSCAN_PX, laneWindow } from '../src/renderer/daw/model/lane-window.js';

const results: { name: string; pass: boolean }[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true }); console.log(`[PASS] ${name}`); }
  catch (e) {
    results.push({ name, pass: false });
    console.log(`[FAIL] ${name} — ${e instanceof Error ? e.message : String(e)}`);
  }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function eq(a: unknown, b: unknown, m: string): void {
  if (a !== b) throw new Error(`${m} — got ${String(a)}, want ${String(b)}`);
}

const VIEW = 1100;            // the scroller's width in the window measured above

check('the width the scroller spans never changes', () => {
  // THE invariant.  A window that builds fewer strips has to leave exactly
  // the space the missing ones took, or the scrollbar grows and shrinks as
  // you drag it and the position under the thumb is not the position you
  // released it at.
  for (const count of [0, 1, 7, 13, 24, 48, 200]) {
    const full = count * STRIP_PX;
    for (const left of [0, 1, 123, 124, 500, 3038, 4976, 999999]) {
      const w = stripWindow(count, left, VIEW);
      const built = (w.last - w.first) * STRIP_PX;
      eq(w.padLeft + built + w.padRight, full,
        `${count} tracks at ${left}px spans the wrong width`);
    }
  }
});

check('everything inside the scroller is built', () => {
  // The whole point, and the way it fails is silent: a strip that is on
  // screen and not built is a blank column, not an error.
  for (const count of [1, 13, 48]) {
    for (const left of [0, 62, 124, 1000, count * STRIP_PX - VIEW]) {
      const at = Math.max(0, left);
      const w = stripWindow(count, at, VIEW);
      const firstVisible = Math.floor(at / STRIP_PX);
      const lastVisible = Math.min(count - 1, Math.floor((at + VIEW - 1) / STRIP_PX));
      assert(w.first <= firstVisible,
        `${count} tracks at ${at}px: strip ${firstVisible} is on screen and not built`);
      assert(w.last > lastVisible,
        `${count} tracks at ${at}px: strip ${lastVisible} is on screen and not built`);
    }
  }
});

check('and a few either side of it, so a flick has something to land on', () => {
  const w = stripWindow(48, 20 * STRIP_PX, VIEW);
  eq(w.first, 20 - STRIP_OVERSCAN, 'overscan to the left');
  const lastVisible = Math.ceil((20 * STRIP_PX + VIEW) / STRIP_PX);
  eq(w.last, lastVisible + STRIP_OVERSCAN, 'overscan to the right');
});

check('the ends are clamped rather than run past', () => {
  const atStart = stripWindow(48, 0, VIEW);
  eq(atStart.first, 0, 'no negative first');
  eq(atStart.padLeft, 0, 'nothing to pad before the first strip');
  const atEnd = stripWindow(48, 48 * STRIP_PX, VIEW);
  eq(atEnd.last, 48, 'never past the last strip');
  eq(atEnd.padRight, 0, 'nothing to pad after the last one');
});

check('a session with no tracks builds nothing and pads nothing', () => {
  const w = stripWindow(0, 0, VIEW);
  eq(w.first, 0, 'first'); eq(w.last, 0, 'last');
  eq(w.padLeft, 0, 'padLeft'); eq(w.padRight, 0, 'padRight');
});

check('a scroller that has not been measured still produces a window', () => {
  // Every one of these happens on the frame the window is mounting, which is
  // the frame this exists to make cheap — so none of them may produce a NaN
  // width or an empty mixer.
  for (const [left, view] of [[NaN, VIEW], [0, NaN], [-500, VIEW], [0, 0], [0, -20]] as const) {
    const w = stripWindow(24, left, view);
    for (const v of [w.first, w.last, w.padLeft, w.padRight]) {
      assert(Number.isFinite(v), `left=${left} view=${view} produced ${v}`);
    }
    assert(w.first >= 0 && w.last <= 24 && w.first <= w.last,
      `left=${left} view=${view} produced ${w.first}..${w.last}`);
    eq(w.padLeft + (w.last - w.first) * STRIP_PX + w.padRight, 24 * STRIP_PX,
      `left=${left} view=${view} spans the wrong width`);
  }
});

check('every strip is reachable by scrolling to it', () => {
  // A window that skipped one would hide a channel from the console, which is
  // worse than the slowness it was written to fix.
  const count = 48;
  const seen = new Set<number>();
  for (let left = 0; left <= count * STRIP_PX; left += STRIP_PX / 2) {
    const w = stripWindow(count, left, VIEW);
    for (let i = w.first; i < w.last; i++) seen.add(i);
  }
  for (let i = 0; i < count; i++) assert(seen.has(i), `strip ${i} can never be built`);
});

check('the Mix window actually uses it', () => {
  // STRUCTURAL.  The maths above is only worth something if the console asks
  // it: a MixWindow that maps over every track again passes every check in
  // this file and puts the 248 ms back.
  const source = readFileSync(
    new URL('../src/renderer/components/daw/mix/MixWindow.tsx', import.meta.url), 'utf8');
  assert(/stripWindow\(/.test(source), 'MixWindow does not call stripWindow');
  assert(/session\.tracks\.slice\(/.test(source),
    'MixWindow maps over every track rather than the window');
  assert(/padLeft/.test(source) && /padRight/.test(source),
    'MixWindow drops the spacers, so the scroll range changes with the scroll position');
});

check('the strip width the maths uses is the width the strip is', () => {
  // 124 px, measured in the running app — `w-[124px]` with Tailwind's
  // border-box, so the right border is inside it.  Read from the component so
  // the two cannot drift apart silently.
  const source = readFileSync(
    new URL('../src/renderer/components/daw/mix/MixWindow.tsx', import.meta.url), 'utf8');
  const match = /w-\[(\d+)px\]/.exec(source);
  assert(match !== null, 'no fixed strip width in MixWindow');
  eq(Number(match?.[1]), STRIP_PX, 'the strip width and STRIP_PX disagree');
});


// ── The Edit window: rows of their own heights ──────────────────────────────

const VIEW_H = 415;           // the scroller's height in the window measured above
/** A session's worth of rows: tracks at their own heights, lanes at 48. */
function heights(tracks: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < tracks; i++) {
    out.push(i % 5 === 0 ? 120 : 96);
    if (i % 7 === 3) out.push(48);            // an automation lane, now and then
  }
  return out;
}
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

check('the height the rows span never changes', () => {
  // The same invariant as the mixer's, vertically: the scrollbar may not
  // change length as it is dragged.
  for (const tracks of [0, 1, 4, 24, 48]) {
    const h = heights(tracks);
    const full = sum(h);
    for (const top of [0, 1, 95, 96, 1200, 2447, 4479, 999999, -300]) {
      const w = laneWindow(h, top, VIEW_H);
      const built = sum(h.slice(w.first, w.last));
      const got = w.padTop + built + w.padBottom;
      if (got !== full) {
        throw new Error(`${tracks} tracks at ${top}px spans ${got}, want ${full}`);
      }
    }
  }
});

check('every row inside the scroller is built', () => {
  // WITH THE OVERSCAN AT ZERO as well as at its real value, because the
  // overscan hides the mistake this is looking for.  A window that builds
  // only the rows lying ENTIRELY inside the band still passes at 240 px of
  // overscan — the band is wider than the screen, so the rows straddling the
  // screen's edges are inside it anyway — and leaves a gap at the top and
  // bottom of the viewport the moment the margin is not there to cover it.
  for (const overscan of [LANE_OVERSCAN_PX, 0]) {
    for (const tracks of [1, 12, 48]) {
      const h = heights(tracks);
      const tops: number[] = [];
      let y = 0;
      for (const v of h) { tops.push(y); y += v; }
      for (const top of [0, 50, 500, 137, Math.max(0, sum(h) - VIEW_H)]) {
        const w = laneWindow(h, top, VIEW_H, overscan);
        for (let i = 0; i < h.length; i++) {
          const onScreen = tops[i]! + h[i]! > top && tops[i]! < top + VIEW_H;
          if (!onScreen) continue;
          assert(i >= w.first && i < w.last,
            `${tracks} tracks at ${top}px, overscan ${overscan}: `
            + `row ${i} is on screen and not built`);
        }
      }
    }
  }
});

check('and a band either side of it, measured in pixels', () => {
  // Pixels, not rows: four rows of automation lane is a third of the overscan
  // four track rows would be.
  const h = heights(48);
  const w = laneWindow(h, 2000, VIEW_H);
  const above = sum(h.slice(0, w.first));
  assert(2000 - above <= LANE_OVERSCAN_PX + 120,
    `built ${2000 - above}px above the viewport, wanted about ${LANE_OVERSCAN_PX}`);
  assert(above <= 2000, 'built past the top of the viewport');
});

check('the ends of the row list are clamped', () => {
  const h = heights(48);
  const atTop = laneWindow(h, 0, VIEW_H);
  eq(atTop.first, 0, 'no negative first');
  eq(atTop.padTop, 0, 'nothing to pad above the first row');
  const atEnd = laneWindow(h, sum(h), VIEW_H);
  eq(atEnd.last, h.length, 'never past the last row');
  eq(atEnd.padBottom, 0, 'nothing to pad below the last one');
});

check('a session with no rows builds nothing and pads nothing', () => {
  const w = laneWindow([], 0, VIEW_H);
  eq(w.first, 0, 'first'); eq(w.last, 0, 'last');
  eq(w.padTop, 0, 'padTop'); eq(w.padBottom, 0, 'padBottom');
});

check('an unmeasured scroller still produces a row window', () => {
  const h = heights(24);
  for (const [top, view] of [[NaN, VIEW_H], [0, NaN], [-900, VIEW_H], [0, 0], [0, -5]] as const) {
    const w = laneWindow(h, top, view);
    for (const v of [w.first, w.last, w.padTop, w.padBottom]) {
      assert(Number.isFinite(v), `top=${top} view=${view} produced ${v}`);
    }
    eq(w.padTop + sum(h.slice(w.first, w.last)) + w.padBottom, sum(h),
      `top=${top} view=${view} spans the wrong height`);
  }
});

check('a row of no height does not empty the window', () => {
  // A collapsed folder's lane can measure zero, and a zero-height row that
  // swallowed the window would blank the timeline.
  const h = [0, 96, 0, 96, 0];
  const w = laneWindow(h, 0, VIEW_H);
  eq(w.padTop + sum(h.slice(w.first, w.last)) + w.padBottom, sum(h), 'spans the wrong height');
  assert(w.last > w.first, 'built nothing at all');
});

check('every row is reachable by scrolling to it', () => {
  const h = heights(48);
  const total = sum(h);
  const seen = new Set<number>();
  for (let top = 0; top <= total; top += 40) {
    const w = laneWindow(h, top, VIEW_H);
    for (let i = w.first; i < w.last; i++) seen.add(i);
  }
  for (let i = 0; i < h.length; i++) assert(seen.has(i), `row ${i} can never be built`);
});

check('the Edit window uses it, for both of its columns', () => {
  // STRUCTURAL, and the second half of it matters as much as the first: the
  // headers and the lanes are two renderings of one list, and a window
  // applied to one of them puts the two columns a row out of step.
  const source = readFileSync(
    new URL('../src/renderer/components/daw/edit/EditWindow.tsx', import.meta.url), 'utf8');
  assert(/laneWindow\(/.test(source), 'EditWindow does not call laneWindow');
  const built = source.match(/builtRows\.map\(/g) ?? [];
  eq(built.length, 2, 'both columns have to map over the windowed rows');
  const tops = source.match(/rowView\.padTop/g) ?? [];
  const bottoms = source.match(/rowView\.padBottom/g) ?? [];
  eq(tops.length, 2, 'both columns need the top spacer');
  eq(bottoms.length, 2, 'both columns need the bottom spacer');
  // Walking every row is fine for its HEIGHT — that is how the window is
  // computed — and not fine for rendering one.  So the rule is that there is
  // exactly one walk over the full list and it is the heights; a second is a
  // column that went back to building everything.
  const everyRow = source.match(/displayRows\.map\(/g) ?? [];
  eq(everyRow.length, 1, 'displayRows is walked more than once, so something renders every row');
  assert(/displayRows\.map\(\(r\) => r\.height\)/.test(source),
    'the one walk over every row is no longer the heights');
});

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed > 0) process.exit(1);
