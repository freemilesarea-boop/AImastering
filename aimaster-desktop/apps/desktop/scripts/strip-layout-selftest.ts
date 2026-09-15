/**
 * strip-layout-selftest — how much of a channel strip a window has to hold.
 *
 * The console drew all five insert slots and all five send slots on every
 * channel whether or not anything was in them.  Measured in the running app on
 * a session with one send and no inserts:
 *
 *   app chrome above the console      186 px
 *   strip chrome above the fader      476 px   (inserts 131 + sends 131 = 262)
 *   nameplate below it                 38 px
 *   ─────────────────────────────────────────
 *   700 px before a single pixel of fader
 *
 * Ten of the strip's thirteen selectors showed "—".  At a 720 px window that
 * left 53 px of a 134 px fader and put the track's own NAME 123 px below the
 * bottom of the screen — unreachable, because a flex item defaults to
 * `min-height: auto` and the strip overflowed past the window instead of
 * scrolling.
 *
 * After: 306 px of chrome, the fader 175 px of 175 at that same 720 px window,
 * and below about 680 px the section above the fader scrolls while the fader,
 * the solo and mute buttons and the nameplate stay put.
 *
 * The geometry itself is CSS and is verified by driving the app.  What is
 * pinned here is the rule the geometry follows, because that rule is what
 * decides how many rows exist.
 *
 * Run: pnpm --filter @aimaster/desktop test:strip-layout
 */

import { SLOTS, slotLetter, slotsToShow } from '../src/renderer/daw/model/strip-slots.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); } catch (e: unknown) {
    results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
  }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function same(a: number[], b: number[], m: string): void {
  if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
    throw new Error(`${m} — got [${a.join(',')}], want [${b.join(',')}]`);
  }
}

check('an empty section is one row, not five', () => {
  // The 170 px, in one assertion.  Five rows of "—" per section, twice per
  // strip, was the majority of everything above the fader.
  same(slotsToShow([], false), [0], 'empty inserts');
  assert(slotsToShow([], false).length * 2 < SLOTS, 'no better than drawing them all');
});

check('and always offers exactly one free slot, so it can be added to', () => {
  // A section with nothing empty in it is a section you cannot use.
  for (const used of [[], [0], [0, 1], [0, 1, 2], [0, 1, 2, 3]]) {
    const shown = slotsToShow(used, false);
    const free = shown.filter((slot) => !used.includes(slot));
    assert(free.length === 1, `used [${used.join(',')}] offered ${free.length} free slots`);
  }
});

check('a full section offers none, because there is nothing left to offer', () => {
  const full = [0, 1, 2, 3, 4];
  same(slotsToShow(full, false), full, 'a full section');
});

check('the free slot is the FIRST free one, not the one after the last used', () => {
  // A chain with a hole in it: C and E occupied, A B D free.  Offering F would
  // be offering nothing, and offering D would skip past two empty slots the
  // user can see the letters of.
  same(slotsToShow([2, 4], false), [0, 2, 4], 'the first gap should be offered, above the occupied ones');
});

check('occupied slots are never hidden, however they arrive', () => {
  // The order the session hands them over is not the order they are drawn in.
  same(slotsToShow([4, 0, 2], false), [0, 1, 2, 4], 'out-of-order input');
  for (const used of [[4], [3, 4], [1, 3]]) {
    const shown = slotsToShow(used, false);
    for (const slot of used) assert(shown.includes(slot), `slot ${slot} vanished`);
  }
});

check('expanded shows all five, whatever is in them', () => {
  const all = [0, 1, 2, 3, 4];
  same(slotsToShow([], true), all, 'expanded and empty');
  same(slotsToShow([2], true), all, 'expanded with one used');
  same(slotsToShow(all, true), all, 'expanded and full');
});

check('expanded is a superset of collapsed — the toggle only ever reveals', () => {
  // The property that makes the collapse safe: nothing is reachable collapsed
  // and unreachable expanded, so a user who opens the section never loses a
  // row they were looking at.
  for (const used of [[], [0], [2, 4], [0, 1, 2, 3, 4]]) {
    const collapsed = slotsToShow(used, false);
    const expanded = slotsToShow(used, true);
    for (const slot of collapsed) {
      assert(expanded.includes(slot), `slot ${slot} is visible collapsed and not expanded`);
    }
  }
});

check('every drawn slot is a real slot', () => {
  for (const used of [[], [4], [2, 4], [0, 1, 2, 3, 4], [0, 3]]) {
    for (const expanded of [false, true]) {
      for (const slot of slotsToShow(used, expanded)) {
        assert(Number.isInteger(slot) && slot >= 0 && slot < SLOTS, `slot ${slot} is off the strip`);
      }
    }
  }
});

check('a slot out of range is ignored rather than drawn', () => {
  // A session file, an import or an older version could carry one.  Drawing it
  // would put a row on the strip that no engine slot corresponds to.
  const shown = slotsToShow([9, -1, 0], false);
  assert(!shown.includes(9) && !shown.includes(-1), `drew a phantom slot: [${shown.join(',')}]`);
  assert(shown.includes(0), 'and lost the real one with it');
});

check('the letters are A through E, in order', () => {
  const letters = Array.from({ length: SLOTS }, (_, i) => slotLetter(i));
  assert(letters.join('') === 'ABCDE', letters.join(''));
});

check('a collapsed row still says which slot it is', () => {
  // The trade being made: hiding empty rows is only acceptable if the visible
  // ones still carry their position.  "The compressor is in C" has to survive
  // A and B not being drawn.
  const shown = slotsToShow([2], false);
  assert(shown.includes(2), 'setup');
  assert(slotLetter(2) === 'C', `slot 2 is ${slotLetter(2)}`);
  assert(slotLetter(shown[0]!) === 'A', 'and the offered free slot names itself too');
});

const failed = results.filter((r) => !r.pass);
for (const r of results) {
  // eslint-disable-next-line no-console
  console.log(`${r.pass ? '[PASS]' : '[FAIL]'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
// eslint-disable-next-line no-console
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
