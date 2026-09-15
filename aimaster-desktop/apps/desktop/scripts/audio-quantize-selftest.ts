/**
 * audio-quantize-selftest.ts — moving the hits onto the grid, partway.
 *
 * Auto-Warp already snapped every transient hard to a sixteenth.  That is the
 * part nobody uses on a real take: a 100 % snap deletes the microtiming that
 * reads as feel.  What this adds is the four numbers that make it usable, and
 * each of them has a way of being subtly wrong:
 *
 *   · strength applied to the DESTINATION instead of the DISTANCE flattens a
 *     ritardando into a click track
 *   · a straight grid quantised onto a swung part destroys the swing
 *   · a tolerance that scales with strength means "close enough" changes
 *     meaning every time the strength slider moves
 *   · markers that stop increasing are a divide by zero in the warp map
 *
 * Run via:  pnpm --filter @aimaster/desktop test:audio-quantize
 */

import {
  clampQuantize, describeQuantize, quantizeHits, quantizeWarp, summariseQuantize, swungTarget,
  DEFAULT_QUANTIZE, GRID_CHOICES, QUANTIZE_LIMITS, type QuantizeOptions,
} from '../src/renderer/daw/edit/audio-quantize.js';
import { buildWarpMap, sourceToDest } from '../src/renderer/daw/model/warp.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function near(a: number, b: number, eps: number, m: string): void {
  if (!(Math.abs(a - b) <= eps)) throw new Error(`${m} — ${a} vs ${b}`);
}

const BPM = 120;                 // one beat = 0.5 s, one sixteenth = 0.125 s
const BEAT = 60 / BPM;
const opts = (over: Partial<QuantizeOptions> = {}): QuantizeOptions =>
  ({ ...DEFAULT_QUANTIZE, toleranceMs: 0, ...over });

/** Sixteenths, each pushed late by the given ms. */
function take(lateMs: readonly number[]): number[] {
  return lateMs.map((ms, i) => (i + 1) * 0.25 * BEAT + ms / 1000);
}

// ── The grid, with swing ─────────────────────────────────────────────────────

check('a straight grid rounds to the nearest division', () => {
  near(swungTarget(0.26, 0.25, 0), 0.25, 1e-9, 'just past a sixteenth');
  // Halfway between 0.25 and 0.5 is 0.375 — 0.37 is still nearer the lower
  // one, and the first version of this test asserted otherwise.
  near(swungTarget(0.37, 0.25, 0), 0.25, 1e-9, 'just under halfway stays');
  near(swungTarget(0.38, 0.25, 0), 0.5, 1e-9, 'just over it rounds up');
});

check('swing moves the off-beats late and leaves the on-beats alone', () => {
  // Eighth grid, one-third swing: 0, 0.666, 1, 1.666 …
  near(swungTarget(0.02, 0.5, 1 / 3), 0, 1e-9, 'the downbeat does not move');
  near(swungTarget(0.64, 0.5, 1 / 3), 0.5 + 0.5 / 3, 1e-9, 'the off-beat sits late');
  near(swungTarget(1.02, 0.5, 1 / 3), 1, 1e-9, 'and the next downbeat is straight again');
});

check('a hit between a straight and a swung slot goes to whichever is nearer', () => {
  // Rounding the nominal index would always claim the straight one.
  const swung = 0.5 + 0.5 / 3;                   // 0.6667
  near(swungTarget(0.62, 0.5, 1 / 3), swung, 1e-9, 'nearer the swung slot');
  // There is no slot at 0.5 in a swung grid — that is what swing MEANS: the
  // off-beat moved to 0.667.  So 0.30 belongs to the downbeat, not to a
  // straight eighth that no longer exists.  Asserting 0.5 here was asking
  // for the un-swung grid back.
  near(swungTarget(0.30, 0.5, 1 / 3), 0, 1e-9, 'nearer the downbeat');
});

check('swing never pushes an off-beat past the next on-beat', () => {
  // Passed RAW, not through clampQuantize.  swungTarget is exported on its
  // own, so it has to be total by itself — testing it through the clamp only
  // proves the clamp works, which the bounds test already does.
  for (const swing of [0.5, 0.9, 5, -3]) {
    const off = swungTarget(0.5, 0.5, swing);
    assert(off >= 0.5 && off < 1, `swing ${swing} put the off-beat at ${off}`);
  }
});

// ── Strength ─────────────────────────────────────────────────────────────────

check('full strength puts the hit on the grid', () => {
  const [hit] = quantizeHits(take([30]), BPM, 0, 4, opts({ strength: 1 }));
  near(hit!.toBeat, 0.25, 1e-9, 'on the sixteenth');
  near(hit!.moveMs, -30, 0.5, 'moved back the full 30 ms');
});

check('half strength halves the error — it does not halve the position', () => {
  // The distinguishing case.  Applied to the destination, a hit at beat 0.31
  // would end up near 0.28 regardless of where the grid line is; applied to
  // the distance, it ends up 15 ms late instead of 30.
  const [hit] = quantizeHits(take([30]), BPM, 0, 4, opts({ strength: 0.5 }));
  near(hit!.moveMs, -15, 0.5, 'half the correction');
  near((hit!.toBeat - 0.25) * BEAT * 1000, 15, 0.5, 'still 15 ms late');
});

check('zero strength moves nothing at all', () => {
  const hits = quantizeHits(take([30, -20, 45]), BPM, 0, 4, opts({ strength: 0 }));
  for (const h of hits) near(h.moveMs, 0, 1e-9, 'untouched');
  assert(summariseQuantize(hits).moved === 0, 'and none counted as moved');
});

check('a slowing performance stays slowing at partial strength', () => {
  // Each hit later than the last.  At 50 % they must all still be late, in
  // the same order — a strength that flattened this would be the machine.
  //
  // All four stay under half a division (62.5 ms at this grid and tempo).
  // A hit past that belongs to the NEXT division and quantize pulls it
  // forward, which reverses its sign — correct behaviour, and the reason the
  // first version of this test used 70 ms and failed itself.
  const hits = quantizeHits(take([10, 25, 45, 58]), BPM, 0, 4, opts({ strength: 0.5 }));
  const late = hits.map((h) => (h.toBeat - Math.round(h.toBeat / 0.25) * 0.25) * BEAT * 1000);
  for (let i = 1; i < late.length; i++) {
    assert(late[i]! > late[i - 1]! - 1e-6, `hit ${i} is not still later: ${late.join(', ')}`);
  }
});

// ── Tolerance ────────────────────────────────────────────────────────────────

check('a hit inside the tolerance is not touched', () => {
  const hits = quantizeHits(take([4, 40]), BPM, 0, 4, opts({ toleranceMs: 10 }));
  assert(!hits[0]!.moved, 'the 4 ms one stayed');
  near(hits[0]!.moveMs, 0, 1e-9, 'exactly zero');
  assert(hits[1]!.moved, 'the 40 ms one moved');
});

check('the tolerance does not change meaning when strength does', () => {
  // Measured against the FULL correction.  Scaled by strength, a hit 12 ms
  // out would be "close enough" at 40 % and not at 100 %, so lowering the
  // strength would silently change WHICH hits are considered wrong.
  const at = (strength: number): boolean =>
    quantizeHits(take([12]), BPM, 0, 4, opts({ strength, toleranceMs: 10 }))[0]!.moved;
  assert(at(1) === at(0.4), 'the same hit is judged the same way at both strengths');
  assert(at(1), 'and 12 ms is outside a 10 ms tolerance');
});

// ── Bounds and reporting ─────────────────────────────────────────────────────

check('every number is held to what the algorithm can act on', () => {
  const wild = clampQuantize({ gridBeats: -1, strength: 9, swing: 9, toleranceMs: -5, maxMarkers: 0 });
  assert(wild.gridBeats > 0, 'a grid of zero divides by zero');
  near(wild.strength, QUANTIZE_LIMITS.strength.max, 1e-9, 'strength');
  near(wild.swing, QUANTIZE_LIMITS.swing.max, 1e-9, 'swing');
  near(wild.toleranceMs, 0, 1e-9, 'tolerance');
  assert(wild.maxMarkers >= 2, 'at least a start and an end');
});

check('NaN falls back to the default rather than poisoning the grid', () => {
  const held = clampQuantize(opts({ strength: Number.NaN }));
  near(held.strength, DEFAULT_QUANTIZE.strength, 1e-9, 'strength');
});

check('hits outside the clip are ignored', () => {
  const hits = quantizeHits([-1, 0.5, 99], BPM, 0, 2, opts());
  assert(hits.length === 1, `only the one inside, got ${hits.length}`);
});

check('the summary counts what moves and how far', () => {
  const hits = quantizeHits(take([4, 40, -60]), BPM, 0, 4, opts({ toleranceMs: 10 }));
  const s = summariseQuantize(hits);
  assert(s.total === 3, `${s.total} found`);
  assert(s.moved === 2, `${s.moved} move`);
  near(s.maxMs, 60, 1, 'the worst is the 60 ms one');
  near(s.meanMs, 50, 1, 'and the mean is over the movers only');
});

check('"nothing moves" tells the two causes apart', () => {
  // Raise the strength, or lower the tolerance — different sliders.  One
  // message for both sends people to the wrong one.
  const inTolerance = describeQuantize(summariseQuantize(
    quantizeHits(take([2, 3]), BPM, 0, 4, opts({ toleranceMs: 10 })),
  ));
  assert(inTolerance.includes('허용 오차 안'), inTolerance);
  const noStrength = describeQuantize(summariseQuantize(
    quantizeHits(take([40, 50]), BPM, 0, 4, opts({ strength: 0, toleranceMs: 5 })),
  ));
  assert(noStrength.includes('강도가 0'), noStrength);
});

check('every grid choice is a real division', () => {
  for (const g of GRID_CHOICES) assert(g.beats > 0 && g.beats <= 1, `${g.label} is ${g.beats}`);
});

// ── Into warp markers ────────────────────────────────────────────────────────

check('markers increase strictly on both axes', () => {
  resetIds();
  // Two hits that quantize onto the SAME sixteenth — the case that makes a
  // warp map divide by zero.
  const hits = quantizeHits([0.25 * BEAT - 0.01, 0.25 * BEAT + 0.01], BPM, 0, 4, opts());
  const warp = quantizeWarp(hits, BPM, 0, 4, 0.25);
  for (let i = 1; i < warp.markers.length; i++) {
    assert(warp.markers[i]!.sourceSec > warp.markers[i - 1]!.sourceSec, 'source axis');
    assert(warp.markers[i]!.beat > warp.markers[i - 1]!.beat, 'beat axis');
  }
});

check('the warp map actually lands the hit on the grid', () => {
  resetIds();
  const late = 0.25 * BEAT + 0.03;              // a sixteenth, 30 ms late
  const hits = quantizeHits([late], BPM, 0, 4, opts({ strength: 1 }));
  const warp = quantizeWarp(hits, BPM, 0, 4, 0.25);
  const map = buildWarpMap(warp, BPM);
  near(sourceToDest(map, late), 0.25 * BEAT, 1e-6, 'it plays on the sixteenth now');
});

check('at half strength the map lands it half way back', () => {
  resetIds();
  const late = 0.25 * BEAT + 0.03;
  const hits = quantizeHits([late], BPM, 0, 4, opts({ strength: 0.5 }));
  const map = buildWarpMap(quantizeWarp(hits, BPM, 0, 4, 0.25), BPM);
  near(sourceToDest(map, late), 0.25 * BEAT + 0.015, 1e-6, '15 ms late instead of 30');
});

check('a clip whose hits all sit inside the tolerance produces a flat map', () => {
  resetIds();
  const at = 0.25 * BEAT + 0.002;
  const hits = quantizeHits([at], BPM, 0, 4, opts({ toleranceMs: 10 }));
  const map = buildWarpMap(quantizeWarp(hits, BPM, 0, 4, 0.25), BPM);
  near(sourceToDest(map, at), at, 1e-6, 'nothing moved');
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Audio quantize ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
