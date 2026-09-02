/**
 * clip-fade-selftest.ts — fades you can grab.
 *
 * The model had `fadeIn`/`fadeOut`, `fadeCurve` to shape them, the drawing to
 * show them, the player to apply them, the warp to scale them and the bounce
 * to render them.  What it did not have was any way to MAKE one with a mouse:
 * `setFades` had no callers at all, and the only path in was a keyboard
 * shortcut that fades to the play head.  The fades were visible, audible and
 * unreachable.
 *
 * The geometry of a corner handle is where that goes wrong quietly, so:
 *
 *   · the handle is where the fade ENDS, which is the part you pull
 *   · the two fades share the clip and may meet, never overlap
 *   · a drag past either limit stops at the limit rather than inverting
 *   · the top strip only, so reaching for a fade cannot move the audio
 *   · a shape change keeps the length, and a length change keeps the shape
 *
 * Run via:  pnpm --filter @aimaster/desktop test:clip-fade
 */

import {
  clampFadeSec, fadeFromDrag, fadeHandleAt, fadeHandleOn, fadeOn, fadeRegionAt, maxFadeSec,
  withFade,
  FADE_HANDLE_BAND, FADE_HANDLE_PX, FADE_SHAPES, FADE_SHAPE_LABEL,
} from '../src/renderer/daw/model/clip-fade.js';
import {
  gainFromY, gainLineY, laneGrab, GAIN_HANDLE_PX, GAIN_SPAN_DB, MARQUEE_BAND,
} from '../src/renderer/daw/model/lane-grab.js';
import {
  setClipFade, CLIP_GAIN_MAX_DB, CLIP_GAIN_MIN_DB,
} from '../src/renderer/daw/edit/clip-edit.js';
import {
  addTrack, createClip, createSession, createTrack, findTrack, trackClips, updateClips,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import { fadeCurve } from '../src/renderer/daw/engine/clip-player.js';
import type { Clip } from '../src/renderer/daw/model/types.js';

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

/** A ten-second clip starting at 4 s, so start and end are different numbers. */
function clip(over: Partial<Clip> = {}): Clip {
  return {
    ...createClip('f', 'piece', { startSec: 4, offsetSec: 0, durationSec: 10 }),
    ...over,
  };
}

const PX = 40;   // 40 px per second — a handle reaches 12/40 = 0.3 s
const H = 96;    // the default lane height

// ── Where the handle is ─────────────────────────────────────────────────────

check('an untouched clip offers a handle at each corner', () => {
  const c = clip();
  assert(fadeHandleAt(c, 4, 0.1, PX) === 'in', 'the left corner');
  assert(fadeHandleAt(c, 14, 0.1, PX) === 'out', 'the right corner');
});

check('the handle follows the fade — it is the END you pull', () => {
  const c = clip({ fadeIn: { durationSec: 2, shape: 'linear' } });
  assert(fadeHandleAt(c, 6, 0.1, PX) === 'in', 'the handle moved to the end of the fade');
  assert(fadeHandleAt(c, 4, 0.1, PX) === null, 'and is no longer at the corner it came from');
});

check('the middle of a clip is not a handle — that is where you drag the audio', () => {
  const c = clip();
  for (const at of [7, 9, 11]) {
    assert(fadeHandleAt(c, at, 0.1, PX) === null, `${at}s should be free for a clip drag`);
  }
});

check('the handle lives in the TOP strip only', () => {
  const c = clip();
  assert(fadeHandleAt(c, 4, 0.05, PX) === 'in', 'near the top');
  assert(fadeHandleAt(c, 4, FADE_HANDLE_BAND - 0.01, PX) === 'in', 'to the edge of the band');
  assert(fadeHandleAt(c, 4, FADE_HANDLE_BAND + 0.05, PX) === null,
    'below the band a click must belong to the clip, not the fade');
  assert(fadeHandleAt(c, 4, 0.9, PX) === null, 'and certainly at the bottom');
});

check('the reach is in PIXELS, so zooming out does not make the handle a third of the clip', () => {
  const c = clip();
  // At 40 px/s the handle reaches 0.3 s; at 4 px/s it reaches 3 s — but both
  // are the same twelve pixels under the pointer.
  const reachAt = (px: number): number => FADE_HANDLE_PX / px;
  assert(fadeHandleAt(c, 4 + reachAt(PX) * 0.9, 0.1, PX) === 'in', 'inside the reach');
  assert(fadeHandleAt(c, 4 + reachAt(PX) * 1.5, 0.1, PX) === null, 'outside it');
  assert(fadeHandleAt(c, 4 + reachAt(4) * 0.9, 0.1, 4) === 'in', 'same pixels, zoomed out');
});

check('a clip too short for two handles still gives the nearer one', () => {
  const tiny = clip({ durationSec: 0.2 });   // 8 px wide at 40 px/s
  assert(fadeHandleAt(tiny, 4.02, 0.1, PX) === 'in', 'nearer the start');
  assert(fadeHandleAt(tiny, 4.18, 0.1, PX) === 'out', 'nearer the end');
});


check('the corner handle is reachable AT the clip edge, where clipAt says "outside"', () => {
  // `clipAt` treats a clip's end as outside it, and the fade-out handle sits
  // exactly on that end — so hit-testing through `clipAt` first put the one
  // pixel the corner occupies out of reach, and the drag fell through to the
  // range tool.
  const c = clip();
  const end = 14;   // 4 + 10
  const found = fadeHandleOn([c], end, 0.1, PX);
  assert(found?.side === 'out', `the very end must grab the fade-out, got ${found?.side}`);
  assert(found?.clip.id === c.id, 'and it belongs to that clip');
  // A shade past the end still counts — the handle has a pixel reach.
  assert(fadeHandleOn([c], end + 0.1, 0.1, PX)?.side === 'out', 'just past the edge');
  assert(fadeHandleOn([c], end + 5, 0.1, PX) === null, 'but not a mile past it');
});

check('the lane search finds the right clip out of several', () => {
  const first = clip();                                    // 4 .. 14
  const second = clip({ startSec: 20, durationSec: 6 });    // 20 .. 26
  const lane = [first, second];
  assert(fadeHandleOn(lane, 4, 0.1, PX)?.clip.id === first.id, 'the first clip start');
  assert(fadeHandleOn(lane, 26, 0.1, PX)?.clip.id === second.id, 'the second clip end');
  assert(fadeHandleOn(lane, 17, 0.1, PX) === null, 'the gap between them is nobody\'s handle');
});

// ── What a drag produces ────────────────────────────────────────────────────

check('dragging inward sets the fade to the distance dragged', () => {
  const c = clip();
  near(fadeFromDrag(c, 'in', 6.5), 2.5, 1e-9, 'fade in');
  near(fadeFromDrag(c, 'out', 11), 3, 1e-9, 'fade out');
});

check('dragging back past the corner clears the fade instead of inverting it', () => {
  const c = clip({ fadeIn: { durationSec: 3, shape: 'linear' } });
  near(fadeFromDrag(c, 'in', 2), 0, 1e-9, 'dragged before the clip start');
  near(fadeFromDrag(c, 'out', 20), 0, 1e-9, 'dragged past the clip end');
});

check('the two fades may meet but never overlap', () => {
  // A sample ramped down by one and up by the other is not a crossfade, it is
  // just quieter.
  const c = clip({ fadeOut: { durationSec: 4, shape: 'linear' } });
  near(maxFadeSec(c, 'in'), 6, 1e-9, 'the fade-in may have what the fade-out left');
  near(fadeFromDrag(c, 'in', 14), 6, 1e-9, 'dragging to the far end stops where the other begins');
  // And exactly meeting is allowed: 6 + 4 = the whole clip.
  const met = withFade(c, 'in', { durationSec: 6, shape: 'linear' });
  near(met.fadeIn.durationSec + met.fadeOut.durationSec, met.durationSec, 1e-9, 'they cover it exactly');
});

check('a fade can never be longer than the clip', () => {
  const c = clip();
  near(clampFadeSec(c, 'in', 999), 10, 1e-9, 'clamped to the clip');
  near(clampFadeSec(c, 'in', -5), 0, 1e-9, 'and never negative');
  near(clampFadeSec(c, 'in', Number.NaN), 0, 1e-9, 'nor NaN');
});

// ── The shape ───────────────────────────────────────────────────────────────

check('double-clicking inside a fade finds it; outside one finds nothing', () => {
  const c = clip({
    fadeIn: { durationSec: 2, shape: 'linear' },
    fadeOut: { durationSec: 3, shape: 'linear' },
  });
  assert(fadeRegionAt(c, 5, 0.5) === 'in', 'inside the fade-in');
  assert(fadeRegionAt(c, 12, 0.5) === 'out', 'inside the fade-out');
  assert(fadeRegionAt(c, 8, 0.5) === null, 'between them is the clip itself');
  // A clip with no fade has no fade region, so a double-click there opens the
  // editor as it always did.
  assert(fadeRegionAt(clip(), 8, 0.5) === null, 'no fade, no region');
});

check('changing the shape keeps the length, and the length keeps the shape', () => {
  resetIds();
  let session = createSession(undefined, 48_000);
  const track = createTrack('T', 'audio');
  session = addTrack(session, track);
  const c = clip({ fadeOut: { durationSec: 2.5, shape: 'linear' } });
  session = updateClips(session, track.id, () => [c]);

  const reshaped = setClipFade(session, track.id, c.id, 'out',
    { durationSec: 2.5, shape: 'sCurve' });
  const after = trackClips(findTrack(reshaped, track.id)!)[0]!;
  near(after.fadeOut.durationSec, 2.5, 1e-9, 'the length survives a shape change');
  assert(after.fadeOut.shape === 'sCurve', 'and the shape actually changed');
  // The other side is untouched.
  near(after.fadeIn.durationSec, 0, 1e-9, 'the fade-in is not involved');
});

check('every shape is a real curve, named, running 0 to 1', () => {
  for (const shape of FADE_SHAPES) {
    assert(FADE_SHAPE_LABEL[shape].trim().length > 0, `${shape} has no label`);
    const curve = fadeCurve(shape, 32);
    near(curve[0] ?? -1, 0, 1e-6, `${shape} starts silent`);
    near(curve[curve.length - 1] ?? -1, 1, 1e-6, `${shape} ends open`);
    for (let i = 1; i < curve.length; i++) {
      assert((curve[i] ?? 0) >= (curve[i - 1] ?? 0) - 1e-9, `${shape} must not dip at ${i}`);
    }
  }
  // And they are three DIFFERENT curves, not one under three names.  Compared
  // over the WHOLE curve, not at halfway: smoothstep is symmetric, so it
  // crosses 0.5 at exactly 0.5 and agrees with the straight line at the one
  // point a lazy check would sample.
  const curves = FADE_SHAPES.map((shape) => fadeCurve(shape, 65));
  for (let a = 0; a < curves.length; a++) {
    for (let b = a + 1; b < curves.length; b++) {
      let apart = 0;
      for (let i = 0; i < 65; i++) {
        apart = Math.max(apart, Math.abs((curves[a]![i] ?? 0) - (curves[b]![i] ?? 0)));
      }
      assert(apart > 0.02,
        `${FADE_SHAPES[a]} and ${FADE_SHAPES[b]} are the same curve (max gap ${apart.toFixed(4)})`);
    }
  }
});

check('fadeOn reads the side it is asked for', () => {
  const c = clip({
    fadeIn: { durationSec: 1, shape: 'linear' },
    fadeOut: { durationSec: 2, shape: 'sCurve' },
  });
  near(fadeOn(c, 'in').durationSec, 1, 1e-9, 'in');
  near(fadeOn(c, 'out').durationSec, 2, 1e-9, 'out');
  assert(fadeOn(c, 'out').shape === 'sCurve', 'and its shape');
});

// ── What a press on the lane means ───────────────────────────────────────────
//
// Before this, a selection box could only be started on empty lane: a press
// on a clip always grabbed it.  A dense arrangement has no empty lane, which
// is precisely when selecting several pieces at once matters.

check('the lower half of a clip starts a marquee, not a move', () => {
  const c = clip();
  assert(laneGrab([c], 8, 0.75, PX, H).kind === 'marquee', 'below the halfway line');
});

check('the upper half of a clip still grabs it', () => {
  const c = clip();
  const g = laneGrab([c], 8, 0.25, PX, H);
  assert(g.kind === 'move', `above it, got ${g.kind}`);
  assert(g.kind === 'move' && g.clip.id === c.id, 'and it is the right clip');
});

check('the halfway line at unity IS the gain line', () => {
  // The gain line of an untouched clip sits at the centre, which is also the
  // move/marquee boundary — and the line wins there.  That is the point: the
  // handle has to be somewhere findable before the first drag.
  assert(laneGrab([clip()], 8, MARQUEE_BAND, PX, H).kind === 'gain', 'exactly at 0.5');
});

check('just past the gain band, the lower half is a marquee again', () => {
  const below = (gainLineY(0, H) + GAIN_HANDLE_PX + 2) / H;
  assert(laneGrab([clip()], 8, below, PX, H).kind === 'marquee', `at ${below.toFixed(2)}`);
});

check('the gain line follows the gain, so the handle moves with it', () => {
  const c = { ...clip(), gainDb: 12 };            // half way to the top
  const onLine = gainLineY(12, H) / H;
  assert(laneGrab([c], 8, onLine, PX, H).kind === 'gain', 'found where it is drawn');
  assert(laneGrab([c], 8, MARQUEE_BAND, PX, H).kind !== 'gain',
    'and no longer at the centre it left');
});

check('the gain line is only a handle where there is a clip', () => {
  assert(laneGrab([clip()], 100, MARQUEE_BAND, PX, H).kind === 'marquee', 'empty lane');
});

check('pixels and decibels agree in both directions', () => {
  for (const db of [0, 6, -6, GAIN_SPAN_DB, -GAIN_SPAN_DB]) {
    near(gainFromY(gainLineY(db, H), H), db, 1e-9, `${db} dB round-trips`);
  }
});

check('a drag off either end is held to the model range', () => {
  // The lane's top pixel is worth 30 dB by the drawing's own scale — the
  // margin at the top means the +24 mark is not the last pixel — so the
  // clamp, not the geometry, is what stops the gain going past what the
  // model allows.  Getting that the wrong way round in a test is easy: the
  // first version of this asserted the raw 30.3.
  near(gainFromY(0, H), CLIP_GAIN_MAX_DB, 1e-9, 'the top is the maximum');
  near(gainFromY(-500, H), CLIP_GAIN_MAX_DB, 1e-9, 'and so is anything above it');
  near(gainFromY(5000, H), CLIP_GAIN_MIN_DB, 1e-9, 'the bottom is the minimum');
});

check('a corner handle beats both — a fade must stay reachable', () => {
  const c = clip();
  const g = laneGrab([c], c.startSec + 0.1, 0.1, PX, H);
  assert(g.kind === 'fade', `the top corner is a fade, got ${g.kind}`);
  assert(g.kind === 'fade' && g.side === 'in', 'the in side');
});

check('the corner rule does not reach into the lower half', () => {
  // Otherwise the fade band would eat the marquee at the clip edges, and the
  // one place you most want to start a box — just before a clip — would move
  // a fade instead.
  assert(laneGrab([clip()], 4.1, 0.75, PX, H).kind === 'marquee', 'low and at the edge');
});

check('empty lane is a marquee at any height', () => {
  const c = clip();
  assert(laneGrab([c], 100, 0.1, PX, H).kind === 'marquee', 'high and empty');
  assert(laneGrab([c], 100, 0.9, PX, H).kind === 'marquee', 'low and empty');
});

check('the clip under the pointer is the one that gets moved', () => {
  const a = { ...clip(), id: 'a', startSec: 0, durationSec: 2 };
  const b = { ...clip(), id: 'b', startSec: 5, durationSec: 2 };
  const g = laneGrab([a, b], 5.5, 0.2, PX, H);
  assert(g.kind === 'move' && g.clip.id === 'b', 'the second one');
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Clip fades ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
