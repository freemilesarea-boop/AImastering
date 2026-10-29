/**
 * wheel-nav-selftest — the gesture that must not move what it points at.
 *
 * Anchored zoom has one job: the time under the cursor stays under the
 * cursor.  Get it slightly wrong and nothing looks broken — the timeline just
 * creeps sideways a little on every notch, which is worst precisely when
 * somebody is at full zoom trying to place an edit to the millisecond.
 *
 * So the arithmetic is checked by asking it back: zoom, then recompute what
 * time sits at the same pixel, and refuse if it moved.  Including at the ends
 * of the zoom range, where the store's clamp fires and a function holding its
 * own copy of the limits would divide by a zoom that was never applied.
 *
 * The listener itself is checked by reading the source, because what makes it
 * work cannot be seen from the outside: it has to be a native listener
 * registered `{ passive: false }`, since React registers wheel on the root as
 * passive and `preventDefault()` in an `onWheel` prop is ignored.
 *
 * Note on how much that preventDefault is worth, because it was measured:
 * making the listener passive on purpose did NOT make Ctrl + wheel page-zoom
 * the window in this build — Electron does not arm Chrome's wheel-zoom
 * accelerator on a plain BrowserWindow.  So these are design assertions, not
 * a reproduction of a live bug; the packaged smoke still measures that the
 * window's CSS width does not move while the timeline zooms, which is the
 * collision that would matter if it ever were armed.
 */
export {};

import { readFileSync } from 'node:fs';

import { wheelNav, ZOOM_PER_WHEEL_PX } from '../src/renderer/daw/edit/wheel-nav.js';
import { PX_PER_SEC_MIN, PX_PER_SEC_MAX } from '../src/renderer/stores/dawStore.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

/** What time sits at `offsetPx` for a given viewport. */
function timeAt(scrollSec: number, pxPerSec: number, offsetPx: number): number {
  return scrollSec + offsetPx / pxPerSec;
}

const BASE = { deltaX: 0, deltaY: 0, zoomModifier: false, shiftKey: false, offsetPx: 0 };

console.log('\n=== 타임라인 휠 ===\n');

// ── The anchor ───────────────────────────────────────────────────────────
{
  const cases: { label: string; scrollSec: number; pxPerSec: number; offsetPx: number; deltaY: number }[] = [
    { label: 'zoom in, mid-lane',        scrollSec: 12,  pxPerSec: 60,   offsetPx: 400, deltaY: -100 },
    { label: 'zoom out, mid-lane',       scrollSec: 12,  pxPerSec: 60,   offsetPx: 400, deltaY: 100 },
    { label: 'zoom in at the left edge', scrollSec: 0,   pxPerSec: 60,   offsetPx: 0,   deltaY: -100 },
    { label: 'zoom in far down the song', scrollSec: 900, pxPerSec: 240, offsetPx: 733, deltaY: -40 },
    { label: 'trackpad-sized delta',     scrollSec: 31.5, pxPerSec: 97,  offsetPx: 210, deltaY: -7 },
  ];
  const drifted: string[] = [];
  for (const c of cases) {
    const before = timeAt(c.scrollSec, c.pxPerSec, c.offsetPx);
    const out = wheelNav({ scrollSec: c.scrollSec, pxPerSec: c.pxPerSec },
      { ...BASE, zoomModifier: true, deltaY: c.deltaY, offsetPx: c.offsetPx });
    if (out.kind !== 'zoom') { drifted.push(`${c.label}: outcome ${out.kind}`); continue; }
    const after = timeAt(out.scrollSec, out.pxPerSec, c.offsetPx);
    if (Math.abs(after - before) > 1e-9) {
      drifted.push(`${c.label}: ${before.toFixed(6)}s → ${after.toFixed(6)}s`);
    }
  }
  check(
    'the time under the cursor does not move when zooming',
    drifted.length === 0,
    drifted.length === 0 ? `${cases.length} cases, anchor held to 1e-9 s` : drifted.join(' | '),
  );
}

// ── The anchor at the clamp ──────────────────────────────────────────────
{
  // A huge notch at the top of the range: the clamp fires, so the scroll has
  // to be computed from the zoom that was APPLIED, not the one asked for.
  const atMax = wheelNav({ scrollSec: 40, pxPerSec: PX_PER_SEC_MAX }, {
    ...BASE, zoomModifier: true, deltaY: -5000, offsetPx: 300,
  });
  const atMin = wheelNav({ scrollSec: 40, pxPerSec: PX_PER_SEC_MIN }, {
    ...BASE, zoomModifier: true, deltaY: 5000, offsetPx: 300,
  });
  const maxHeld = atMax.kind === 'zoom'
    && atMax.pxPerSec === PX_PER_SEC_MAX
    && Math.abs(timeAt(atMax.scrollSec, atMax.pxPerSec, 300) - timeAt(40, PX_PER_SEC_MAX, 300)) < 1e-9;
  const minHeld = atMin.kind === 'zoom'
    && atMin.pxPerSec === PX_PER_SEC_MIN
    && Math.abs(timeAt(atMin.scrollSec, atMin.pxPerSec, 300) - timeAt(40, PX_PER_SEC_MIN, 300)) < 1e-9;
  check(
    'and still does not move at either end of the zoom range',
    maxHeld && minHeld,
    `max ${atMax.kind === 'zoom' ? atMax.pxPerSec : '?'} px/s, min ${atMin.kind === 'zoom' ? atMin.pxPerSec : '?'} px/s — both anchored`,
  );
  check(
    'the clamp is the store\'s own, so the two cannot disagree',
    /clampPxPerSec/.test(readFileSync('src/renderer/daw/edit/wheel-nav.ts', 'utf8'))
      && !/Math\.max\(\s*4\s*,/.test(readFileSync('src/renderer/daw/edit/wheel-nav.ts', 'utf8')),
    'wheel-nav calls clampPxPerSec and carries no copy of the numbers',
  );
}

// ── Direction ────────────────────────────────────────────────────────────
{
  const inward = wheelNav({ scrollSec: 0, pxPerSec: 60 }, { ...BASE, zoomModifier: true, deltaY: -100, offsetPx: 0 });
  const outward = wheelNav({ scrollSec: 0, pxPerSec: 60 }, { ...BASE, zoomModifier: true, deltaY: 100, offsetPx: 0 });
  check(
    'wheel up zooms in and wheel down zooms out, not the other way round',
    inward.kind === 'zoom' && outward.kind === 'zoom'
      && inward.pxPerSec > 60 && outward.pxPerSec < 60,
    `up → ${inward.kind === 'zoom' ? inward.pxPerSec.toFixed(1) : '?'} px/s, down → ${outward.kind === 'zoom' ? outward.pxPerSec.toFixed(1) : '?'} px/s from 60`,
  );
  // One notch should feel like one press of the toolbar button (1.5×), not
  // like a jump across the song.
  const step = Math.exp(100 * ZOOM_PER_WHEEL_PX);
  check(
    'and one notch is about one button press, not a jump',
    step > 1.1 && step < 1.6,
    `one notch = ${step.toFixed(2)}× (toolbar button is 1.5×)`,
  );
}

// ── Horizontal scroll ────────────────────────────────────────────────────
{
  const right = wheelNav({ scrollSec: 10, pxPerSec: 50 }, { ...BASE, shiftKey: true, deltaY: 100 });
  const left = wheelNav({ scrollSec: 10, pxPerSec: 50 }, { ...BASE, shiftKey: true, deltaY: -100 });
  check(
    'Shift + wheel scrolls sideways by the pixels asked for, converted at the current zoom',
    right.kind === 'scroll' && Math.abs(right.scrollSec - 12) < 1e-9
      && left.kind === 'scroll' && Math.abs(left.scrollSec - 8) < 1e-9,
    `100 px at 50 px/s → ±2 s (got ${right.kind === 'scroll' ? right.scrollSec : '?'} / ${left.kind === 'scroll' ? left.scrollSec : '?'})`,
  );
  const past = wheelNav({ scrollSec: 1, pxPerSec: 50 }, { ...BASE, shiftKey: true, deltaY: -500 });
  check(
    'and cannot scroll before the start of the song',
    past.kind === 'scroll' && past.scrollSec === 0,
    `1 s − 10 s → ${past.kind === 'scroll' ? past.scrollSec : '?'} s`,
  );
  // A mouse has no horizontal axis; a trackpad does.
  const mouse = wheelNav({ scrollSec: 0, pxPerSec: 50 }, { ...BASE, shiftKey: true, deltaY: 100, deltaX: 0 });
  const pad = wheelNav({ scrollSec: 0, pxPerSec: 50 }, { ...BASE, shiftKey: true, deltaY: 0, deltaX: 100 });
  check(
    'Shift uses deltaY for a mouse and deltaX when the hardware has one',
    mouse.kind === 'scroll' && pad.kind === 'scroll'
      && mouse.scrollSec === 2 && pad.scrollSec === 2,
    'both reach 2 s — the axis the device actually moved',
  );
}

// ── What must be left alone ──────────────────────────────────────────────
{
  const plain = wheelNav({ scrollSec: 5, pxPerSec: 60 }, { ...BASE, deltaY: 120 });
  check(
    'a plain vertical wheel is passed through, so the track list still scrolls',
    plain.kind === 'pass',
    'forty tracks stay scrollable',
  );
  const drifty = wheelNav({ scrollSec: 5, pxPerSec: 60 }, { ...BASE, deltaY: 120, deltaX: 9 });
  check(
    'and a mostly-vertical gesture with a little sideways drift is still vertical',
    drifty.kind === 'pass',
    'deltaY 120 vs deltaX 9 → passed through, not grabbed as a sideways swipe',
  );
  const sideways = wheelNav({ scrollSec: 5, pxPerSec: 60 }, { ...BASE, deltaX: 120, deltaY: 9 });
  check(
    'but a clearly sideways swipe scrolls the timeline with no modifier',
    sideways.kind === 'scroll' && Math.abs(sideways.scrollSec - 7) < 1e-9,
    `deltaX 120 at 60 px/s → ${sideways.kind === 'scroll' ? sideways.scrollSec : '?'} s`,
  );
}

// ── The listener ─────────────────────────────────────────────────────────
{
  const edit = readFileSync('src/renderer/components/daw/edit/EditWindow.tsx', 'utf8');
  check(
    'the arrange lane listens for wheel at all',
    /addEventListener\('wheel'/.test(edit),
    'it carried none before — the whole renderer had four, all on knobs',
  );
  check(
    'as a NATIVE listener, because React registers wheel as passive',
    /addEventListener\('wheel',\s*onWheel,\s*\{\s*passive:\s*false\s*\}\)/.test(edit)
      && !/onWheel=\{/.test(edit.slice(edit.indexOf('ref={laneRef}'), edit.indexOf('ref={laneRef}') + 400)),
    'passive: false — otherwise preventDefault is silently ignored',
  );
  check(
    'and it preventDefaults whenever it acts, so no default can fire alongside',
    /if \(outcome\.kind === 'pass'\) return;\s*\n\s*e\.preventDefault\(\);/.test(edit),
    'pass → untouched; zoom and scroll → default suppressed',
  );
  check(
    'the component does the DOM and nothing else — the maths is the pure module',
    /wheelNav\(\{ scrollSec, pxPerSec \}/.test(edit)
      && !/Math\.exp\(/.test(edit),
    'no zoom arithmetic left in the component',
  );
  check(
    'and it is removed again, so a remount does not stack listeners',
    /removeEventListener\('wheel', onWheel\)/.test(edit),
    'cleanup returned from the effect',
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
