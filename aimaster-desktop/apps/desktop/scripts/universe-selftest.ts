/**
 * universe-selftest.ts — the whole song at a glance.
 *
 * Every bug this can have is a confusion between three coordinate spaces —
 * seconds, strip pixels, and the arrange window's own pixels — and every one
 * of them looks the same from the outside: "the little rectangle is in the
 * wrong place".  On a five-minute song at a hundred pixels wide that is
 * unfalsifiable by eye and trivial in a test, which is the whole reason this
 * arithmetic lives in a module.
 *
 * The properties that matter:
 *
 *   • The round trip.  A rectangle drawn from a scroll must map back to that
 *     same scroll, or dragging it by zero pixels moves the view.
 *   • The clamps.  A rectangle that hangs off the end, or is a third of a
 *     pixel wide, is the ONE control the strip has.
 *   • The empty session.  A strip scaled to a song of length zero either
 *     divides by zero or — worse — draws one clip filling the whole width as
 *     though it were the entire song.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:universe
 */

import {
  MIN_ROW_PX, MIN_SPAN_SEC, MIN_VIEW_PX, describeUniverse, fitWholeSong, rowHeightPx,
  scrollForStripClick, scrollForStripX, secToStripPx, spanSeconds, stripPxToSec,
  universeRows, universeScale, universeSpan, viewRect, zoomForStripEdge,
} from '../src/renderer/daw/model/universe.js';
import { MAX_PX_PER_SEC, MIN_PX_PER_SEC, type Viewport } from '../src/renderer/daw/model/viewport.js';
import {
  addTrack, createClip, createSession, createTrack, updateClips,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { DawSession } from '../src/renderer/daw/model/types.js';

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

const STRIP = 600;

/** A song with three tracks; `[trackIndex, startSec, durationSec]` per clip. */
function song(spec: readonly [number, number, number][], trackCount = 3): DawSession {
  resetIds();
  let session = createSession('song');
  const ids: string[] = [];
  for (let i = 0; i < trackCount; i++) {
    const track = createTrack(`T${i + 1}`, 'audio');
    session = addTrack(session, track);
    ids.push(track.id);
  }
  for (let i = 0; i < trackCount; i++) {
    const mine = spec.filter(([ti]) => ti === i);
    if (mine.length === 0) continue;
    session = updateClips(session, ids[i] as string, () => mine.map(([, startSec, durationSec]) =>
      createClip('f', 'c', { startSec, offsetSec: 0, durationSec })));
  }
  return session;
}
const view = (over: Partial<Viewport> = {}): Viewport =>
  ({ scrollSec: 0, pxPerSec: 60, widthPx: 900, ...over });

// ── The span ────────────────────────────────────────────────────────────────

check('the strip always starts at zero, whatever the first clip does', () => {
  // A song does not start at its first clip.  A left edge that moved as you
  // deleted the opening bar would make every position on the strip mean
  // something different from one minute to the next.
  const late = song([[0, 120, 10]]);
  near(universeSpan(late).startSec, 0, 1e-9, 'still zero');
});

check('an empty session gets a real span, not a division by zero', () => {
  const empty = song([]);
  const span = universeSpan(empty);
  assert(spanSeconds(span) >= MIN_SPAN_SEC, `${spanSeconds(span)} seconds`);
  assert(Number.isFinite(universeScale(span, STRIP)), 'and a real scale');
  // The failure this guards is worse than a crash: one clip drawn filling the
  // entire width as though it were the whole song.
  const oneShort = song([[0, 0, 0.5]]);
  const rows = universeRows(oneShort, STRIP);
  const block = rows[0]?.blocks[0];
  assert((block?.width ?? STRIP) < STRIP * 0.1,
    `a half-second clip is a sliver, not the song: ${block?.width}`);
});

check('the span leaves room past the last sound', () => {
  const s = song([[0, 0, 100]]);
  assert(universeSpan(s).endSec > 100, 'there is somewhere to drag to');
});

// ── Seconds ↔ strip pixels ──────────────────────────────────────────────────

check('seconds and strip pixels round-trip exactly', () => {
  const span = universeSpan(song([[0, 0, 240]]));
  for (const sec of [0, 1, 30, 120, 239.5]) {
    near(stripPxToSec(span, STRIP, secToStripPx(span, STRIP, sec)), sec, 1e-9, `at ${sec}s`);
  }
});

check('a zero-width strip does not produce infinities', () => {
  const span = universeSpan(song([[0, 0, 60]]));
  assert(Number.isFinite(secToStripPx(span, 0, 30)), 'px');
  assert(Number.isFinite(stripPxToSec(span, 0, 100)), 'and back');
});

// ── Rows ────────────────────────────────────────────────────────────────────

check('a track with no clips STILL gets a row', () => {
  // The strip is read against the track names beside it.  Skipping an empty
  // track would put every row below the gap next to the wrong name.
  const s = song([[0, 0, 10], [2, 20, 10]]);
  const rows = universeRows(s, STRIP);
  assert(rows.length === 3, `three tracks, three rows — got ${rows.length}`);
  assert(rows[1]?.blocks.length === 0, 'the middle one is empty');
  assert(rows.map((r) => r.name).join() === 'T1,T2,T3', 'in session order');
});

check('the master gets no row, because it can never hold a clip', () => {
  // Aux, master and VCA channels carry no clips by design.  A row for them is
  // always blank and pushes every real row thinner to make space for it.
  const s = song([[0, 0, 10]]);
  assert(s.tracks.some((t) => t.kind === 'master'), 'the session has a master');
  const rows = universeRows(s, STRIP);
  assert(!rows.some((r) => r.name === 'Master'), 'and the strip does not draw it');
  assert(rows.length === 3, `only the three clip tracks — got ${rows.length}`);
});

check('a clip narrower than a pixel is still drawn', () => {
  // A strip that rounds a short take away is lying about what is in the song.
  const s = song([[0, 0, 600], [1, 300, 0.05]]);
  const short = universeRows(s, STRIP)[1]?.blocks[0];
  assert((short?.width ?? 0) >= 1, `${short?.width}px, not zero`);
});

check('blocks land where the clips are', () => {
  const s = song([[0, 0, 60], [1, 120, 60]]);
  const span = universeSpan(s);
  const rows = universeRows(s, STRIP);
  near(rows[0]?.blocks[0]?.x ?? -1, 0, 1e-9, 'the first at the left edge');
  near(rows[1]?.blocks[0]?.x ?? -1, secToStripPx(span, STRIP, 120), 1e-9,
    'the second at two minutes');
});

check('a hidden track has no row at all', () => {
  const s = song([[0, 0, 10], [1, 0, 10], [2, 0, 10]]);
  const all = universeRows(s, STRIP);
  const hidden = new Set([all[1]?.trackId as string]);
  const some = universeRows(s, STRIP, { hiddenTrackIds: hidden });
  assert(some.length === 2, `two rows left — got ${some.length}`);
  assert(!some.some((r) => r.trackId === all[1]?.trackId), 'and not that one');
});

check('rows share the height, down to a floor', () => {
  near(rowHeightPx(4, 80), 20, 1e-9, 'four rows in eighty pixels');
  assert(rowHeightPx(200, 80) >= MIN_ROW_PX, 'and two hundred still draw something');
  assert(rowHeightPx(0, 80) >= MIN_ROW_PX, 'no rows is not a division by zero');
});

// ── The window rectangle ────────────────────────────────────────────────────

check('the rectangle round-trips through a scroll', () => {
  // The property everything else rests on: draw the rectangle from a scroll,
  // read the scroll back off the rectangle, get the same number.  Without it
  // grabbing the rectangle and not moving it still moves the view.
  const s = song([[0, 0, 300]]);
  const span = universeSpan(s);
  for (const scrollSec of [0, 15, 60, 150]) {
    const v = view({ scrollSec });
    const rect = viewRect(v, span, STRIP);
    near(scrollForStripX(v, span, STRIP, rect.x), scrollSec, 1e-6, `at ${scrollSec}s`);
  }
});

check('the rectangle never hangs off either end', () => {
  const s = song([[0, 0, 300]]);
  const span = universeSpan(s);
  for (const scrollSec of [-100, 0, 200, 10_000]) {
    const rect = viewRect(view({ scrollSec }), span, STRIP);
    assert(rect.x >= -1e-9, `left edge inside: ${rect.x}`);
    assert(rect.x + rect.width <= STRIP + 1e-9,
      `right edge inside: ${rect.x + rect.width} of ${STRIP}`);
  }
});

check('the rectangle is never too thin to grab', () => {
  // A five-minute song at a close zoom: the window is a fraction of a pixel.
  const s = song([[0, 0, 600]]);
  const rect = viewRect(view({ pxPerSec: MAX_PX_PER_SEC }), universeSpan(s), STRIP);
  assert(rect.width >= MIN_VIEW_PX, `${rect.width}px is grabbable`);
});

check('a window showing everything says so, and fills the strip', () => {
  const s = song([[0, 0, 60]]);
  const span = universeSpan(s);
  const wide = view({ pxPerSec: 900 / spanSeconds(span) });
  const rect = viewRect(wide, span, STRIP);
  assert(rect.coversAll, 'it says it covers the song');
  near(rect.width, STRIP, 1, 'and fills the strip');
  assert(!viewRect(view({ pxPerSec: 60 }), span, STRIP).coversAll, 'a normal zoom does not');
});

// ── Dragging ────────────────────────────────────────────────────────────────

check('dragging the rectangle past the end stops at the end', () => {
  // Not "keeps going and leaves the arrange window looking at nothing".
  const s = song([[0, 0, 300]]);
  const span = universeSpan(s);
  const v = view();
  const visible = v.widthPx / v.pxPerSec;
  const atEnd = scrollForStripX(v, span, STRIP, STRIP * 2);
  near(atEnd, span.endSec - visible, 1e-6, 'the last full window');
  near(scrollForStripX(v, span, STRIP, -500), span.startSec, 1e-9, 'and back at zero');
});

check('clicking centres the window on what was clicked', () => {
  // A click means "show me this".  Putting it at the very edge of the window
  // is the one place it is hardest to see.
  const s = song([[0, 0, 600]]);
  const span = universeSpan(s);
  const v = view();
  const visible = v.widthPx / v.pxPerSec;
  const target = 300;
  const scroll = scrollForStripClick(v, span, STRIP, secToStripPx(span, STRIP, target));
  near(scroll + visible / 2, target, 1e-6, 'the click is in the middle');
});

check('clicking near the start does not scroll before zero', () => {
  const s = song([[0, 0, 600]]);
  const span = universeSpan(s);
  const scroll = scrollForStripClick(view(), span, STRIP, 2);
  assert(scroll >= span.startSec - 1e-9, `${scroll} is not negative`);
});

// ── Zooming by the edges ────────────────────────────────────────────────────

check('dragging an edge keeps the OTHER edge still', () => {
  // That is what makes it a handle rather than a slider: the side you are not
  // touching does not move, so you can open the view onto exactly the passage
  // you want instead of chasing it.
  const s = song([[0, 0, 600]]);
  const span = universeSpan(s);
  const v = view({ scrollSec: 100 });
  const before = viewRect(v, span, STRIP);
  const rightEdgeSec = stripPxToSec(span, STRIP, before.x + before.width);

  const change = zoomForStripEdge(v, span, STRIP, 'left', before.x - 40);
  assert(change !== null, 'it produced a change');
  const after = { ...v, ...change };
  const afterRight = after.scrollSec + after.widthPx / after.pxPerSec;
  near(afterRight, rightEdgeSec, 0.5, 'the right edge stayed put');
  assert(after.scrollSec < v.scrollSec, 'and the left edge moved out');
});

check('dragging the right edge holds the left one', () => {
  const s = song([[0, 0, 600]]);
  const span = universeSpan(s);
  const v = view({ scrollSec: 100 });
  const before = viewRect(v, span, STRIP);
  const change = zoomForStripEdge(v, span, STRIP, 'right', before.x + before.width + 40);
  assert(change !== null, 'a change');
  near((change as { scrollSec: number }).scrollSec, v.scrollSec, 0.5, 'the left edge stayed');
});

check('dragging an edge past the other one is refused, not inverted', () => {
  // The user is still holding the mouse down and will drag back.  A flipped
  // window in the meantime is a view that jumps somewhere else entirely.
  const s = song([[0, 0, 600]]);
  const span = universeSpan(s);
  const v = view({ scrollSec: 100 });
  const rect = viewRect(v, span, STRIP);
  assert(zoomForStripEdge(v, span, STRIP, 'left', rect.x + rect.width) === null,
    'exactly onto the other edge');
  assert(zoomForStripEdge(v, span, STRIP, 'right', rect.x) === null, 'and the other way');
});

check('an edge drag cannot zoom past the engine’s own limits', () => {
  const s = song([[0, 0, 3600]]);
  const span = universeSpan(s);
  const v = view({ scrollSec: 0 });
  const tiny = zoomForStripEdge(v, span, STRIP, 'right', 0.0001);
  if (tiny) {
    assert(tiny.pxPerSec <= MAX_PX_PER_SEC + 1e-9, `${tiny.pxPerSec} is within the ceiling`);
  }
  const huge = zoomForStripEdge(v, span, STRIP, 'right', STRIP);
  assert((huge?.pxPerSec ?? MIN_PX_PER_SEC) >= MIN_PX_PER_SEC, 'and the floor');
});

check('an edge drag leaves the window inside the song', () => {
  const s = song([[0, 0, 300]]);
  const span = universeSpan(s);
  const v = view({ scrollSec: 200 });
  const rect = viewRect(v, span, STRIP);
  const change = zoomForStripEdge(v, span, STRIP, 'right', STRIP);
  assert(change !== null, 'a change');
  const c = change as { scrollSec: number; pxPerSec: number };
  assert(c.scrollSec >= span.startSec - 1e-9, 'not before the start');
  assert(c.scrollSec + v.widthPx / c.pxPerSec <= span.endSec + 1e-6,
    'and the window ends inside the song');
  assert(rect.width > 0, 'the rectangle was real to begin with');
});

// ── Fit ─────────────────────────────────────────────────────────────────────

check('fit shows the whole song and nothing past it', () => {
  const s = song([[0, 0, 240]]);
  const span = universeSpan(s);
  const change = fitWholeSong(view(), span);
  assert(change !== null, 'a change');
  const c = change as { scrollSec: number; pxPerSec: number };
  near(c.scrollSec, span.startSec, 1e-9, 'from the top');
  // As much of the song as the engine's own zoom floor allows.  At 4 px/sec a
  // 900 px window tops out at 225 seconds, so a long song fits as far as it
  // can rather than pretending to a zoom the transport would refuse.
  const most = Math.min(spanSeconds(span), 900 / MIN_PX_PER_SEC);
  near(900 / c.pxPerSec, most, 0.5, 'as much as the zoom allows');
});

check('fit refuses a window with no width rather than dividing by it', () => {
  assert(fitWholeSong(view({ widthPx: 0 }), universeSpan(song([[0, 0, 60]]))) === null,
    'null, not Infinity');
});

// ── Reading it back ─────────────────────────────────────────────────────────

check('the strip says what it is showing', () => {
  const s = song([[0, 0, 60], [1, 60, 60]]);
  const text = describeUniverse(s, view());
  assert(text.includes('3개 트랙') && text.includes('클립 2개'), text);
  assert(/\d+%/.test(text), `and how much of the song: ${text}`);
});

check('the percentage is never zero or over a hundred', () => {
  const s = song([[0, 0, 3600]]);
  const close = describeUniverse(s, view({ pxPerSec: MAX_PX_PER_SEC }));
  assert(close.includes('1%'), `a tiny window still reads as 1%: ${close}`);
  const all = describeUniverse(s, view({ pxPerSec: 0.01 }));
  assert(all.includes('100%'), `and a huge one stops at 100%: ${all}`);
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Universe view: the whole song at a glance ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
