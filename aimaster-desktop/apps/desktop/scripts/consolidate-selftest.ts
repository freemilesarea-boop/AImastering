/**
 * consolidate-selftest.ts — Bounce Selection, and the silence between events.
 *
 * The verb takes the fragments left on a track after comping and merges them
 * into one file.  The arithmetic that decides WHAT gets merged and WHERE the
 * holes are is what this covers; the holes themselves being digital zero is a
 * property of the render and is measured in the running app, not here.
 *
 * The cases that go wrong quietly:
 *
 *   · the bounds are the EVENTS', not the selection's — a loose drag must not
 *     print its own slack, and must not truncate an event it half covers
 *   · an unselected clip sitting inside the span survives — it is the take
 *     that was deliberately left out, and a filter on time would eat it
 *   · a clip contained inside another does not invent a gap
 *   · one file PER TRACK; a four-track selection is not a mixdown
 *
 * Run via:  pnpm --filter @aimaster/desktop test:consolidate
 */

import {
  applyConsolidatedSpan, consolidationSpans, describeOutcome, gapsBetween, isSilentAt,
  outcomeOf, silenceSec, spanDurationSec, spanForTrack,
} from '../src/renderer/daw/edit/consolidate.js';
import { trackBand, type TimeSelection } from '../src/renderer/daw/edit/clip-edit.js';
import {
  addTrack, createClip, createSession, createTrack, findTrack, trackClips,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { Clip, DawSession, TrackId } from '../src/renderer/daw/model/types.js';

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

function piece(startSec: number, durationSec: number, name = 'piece'): Clip {
  return createClip('f1', name, { startSec, offsetSec: 0, durationSec });
}

/** A track carrying the given clips, plus a second track to prove isolation. */
function sessionWith(clips: Clip[], second: Clip[] = []): {
  session: DawSession; a: TrackId; b: TrackId;
} {
  resetIds();
  let s = createSession('bounce test');
  s = addTrack(s, createTrack('A', 'audio'));
  s = addTrack(s, createTrack('B', 'audio'));
  const [ta, tb] = s.tracks.filter((t) => t.kind === 'audio');
  assert(ta && tb, 'fixture needs two audio tracks');
  const put = (id: TrackId, list: Clip[]): void => {
    s = {
      ...s,
      tracks: s.tracks.map((t) => (t.id === id
        ? { ...t, playlists: t.playlists.map((p) => (p.id === t.activePlaylistId ? { ...p, clips: list } : p)) }
        : t)),
    };
  };
  put(ta!.id, clips);
  if (second.length > 0) put(tb!.id, second);
  return { session: s, a: ta!.id, b: tb!.id };
}

const all = (session: DawSession, ...trackIds: TrackId[]): TimeSelection =>
  ({ startSec: 0, endSec: 1000, trackIds });

// ── The holes ────────────────────────────────────────────────────────────────

check('two separated events leave exactly one gap, of the right length', () => {
  const gaps = gapsBetween([piece(0, 2), piece(5, 3)]);
  assert(gaps.length === 1, `one gap, got ${gaps.length}`);
  near(gaps[0]!.startSec, 2, 1e-9, 'gap starts where the first event ends');
  near(gaps[0]!.endSec, 5, 1e-9, 'gap ends where the second begins');
});

check('events that touch leave no gap at all', () => {
  assert(gapsBetween([piece(0, 2), piece(2, 3)]).length === 0, 'butt-joined is not a hole');
});

check('overlapping events leave no gap', () => {
  assert(gapsBetween([piece(0, 3), piece(2, 3)]).length === 0, 'an overlap is not a hole');
});

check('a clip wholly inside another does not invent a gap', () => {
  // Comparing each clip to the one BEFORE it reports a hole from 1 to 4 here,
  // which the containing clip is covering the whole time.
  const gaps = gapsBetween([piece(0, 10), piece(1, 1), piece(4, 1)]);
  assert(gaps.length === 0, `contained clips are covered, got ${JSON.stringify(gaps)}`);
});

check('the clips need not arrive in order', () => {
  const gaps = gapsBetween([piece(5, 3), piece(0, 2)]);
  assert(gaps.length === 1, 'sorted before walking');
  near(gaps[0]!.startSec, 2, 1e-9, 'gap start');
});

check('three events leave two gaps, and the silence adds up', () => {
  const span = spanForTrack(...(() => {
    const f = sessionWith([piece(0, 1), piece(3, 1), piece(7, 1)]);
    return [f.session, f.a, all(f.session, f.a)] as const;
  })())!;
  assert(span.gaps.length === 2, `two gaps, got ${span.gaps.length}`);
  near(silenceSec(span), 2 + 3, 1e-9, '1→3 is 2 s and 4→7 is 3 s');
});

check('isSilentAt answers for the holes and not for the events', () => {
  const f = sessionWith([piece(0, 1), piece(3, 1)]);
  const span = spanForTrack(f.session, f.a, all(f.session, f.a))!;
  assert(!isSilentAt(span, 0.5), 'inside the first event');
  assert(isSilentAt(span, 2), 'in the hole');
  assert(!isSilentAt(span, 3.5), 'inside the second event');
  assert(isSilentAt(span, 1), 'the hole starts AT the first event\'s end');
  assert(!isSilentAt(span, 3), 'and stops AT the second event\'s start');
});

// ── The bounds ───────────────────────────────────────────────────────────────

check('the span runs from the first event to the last, not the selection', () => {
  const f = sessionWith([piece(2, 1), piece(6, 1)]);
  // A deliberately sloppy drag: starts in empty space, ends in empty space.
  const span = spanForTrack(f.session, f.a, { startSec: 0, endSec: 20, trackIds: [f.a] })!;
  near(span.startSec, 2, 1e-9, 'Total_Start is the first event');
  near(span.endSec, 7, 1e-9, 'Total_End is the last event');
  near(spanDurationSec(span), 5, 1e-9, 'and the file is that long');
});

check('an event the selection only half covers is merged whole', () => {
  const f = sessionWith([piece(0, 10)]);
  const span = spanForTrack(f.session, f.a, { startSec: 4, endSec: 6, trackIds: [f.a] })!;
  near(span.startSec, 0, 1e-9, 'not truncated at the selection start');
  near(span.endSec, 10, 1e-9, 'nor at its end');
});

check('a single event is still work — its gain and fades get baked', () => {
  const f = sessionWith([piece(3, 2)]);
  const span = spanForTrack(f.session, f.a, all(f.session, f.a));
  assert(span !== null, 'one clip is a valid bounce');
  assert(span!.clipIds.length === 1, 'one clip in it');
  assert(span!.gaps.length === 0, 'and no holes');
});

check('a selection that touches no audio is not work', () => {
  const f = sessionWith([piece(10, 1)]);
  assert(spanForTrack(f.session, f.a, { startSec: 0, endSec: 5, trackIds: [f.a] }) === null,
    'nothing overlapping means nothing to do');
});

check('an empty track is not work', () => {
  const f = sessionWith([]);
  assert(spanForTrack(f.session, f.a, all(f.session, f.a)) === null, 'no clips, no span');
});

// ── One file per track ───────────────────────────────────────────────────────

check('two selected tracks give two spans, each with its own bounds', () => {
  const f = sessionWith([piece(0, 1), piece(4, 1)], [piece(10, 1), piece(12, 1)]);
  const spans = consolidationSpans(f.session, all(f.session, f.a, f.b));
  assert(spans.length === 2, `two spans, got ${spans.length}`);
  near(spans[0]!.startSec, 0, 1e-9, 'track A starts at its own first event');
  near(spans[1]!.startSec, 10, 1e-9, 'track B at its own');
  assert(spans[0]!.trackId !== spans[1]!.trackId, 'and they are different tracks');
});

check('a track with nothing in the selection is skipped, not counted', () => {
  const f = sessionWith([piece(0, 1)], []);
  const spans = consolidationSpans(f.session, all(f.session, f.a, f.b));
  assert(spans.length === 1, `only the track with audio, got ${spans.length}`);
});

// ── Putting the file back ────────────────────────────────────────────────────

check('the merged clips are replaced by exactly one clip, at Total_Start', () => {
  const f = sessionWith([piece(2, 1), piece(6, 1)]);
  const span = spanForTrack(f.session, f.a, all(f.session, f.a))!;
  const after = applyConsolidatedSpan(f.session, span, 'rendered', 'A (consolidated)');
  const clips = trackClips(findTrack(after, f.a)!);
  assert(clips.length === 1, `one clip left, got ${clips.length}`);
  near(clips[0]!.startSec, 2, 1e-9, 'placed at Total_Start');
  near(clips[0]!.durationSec, 5, 1e-9, 'as long as the whole span');
  near(clips[0]!.offsetSec, 0, 1e-9, 'reading its new file from the top');
  assert(clips[0]!.fileId === 'rendered', 'and backed by the rendered file');
});

check('an unselected clip inside the span survives', () => {
  // The take that was left out of the comp.  Removing "everything that
  // overlaps" instead of "the clips we merged" would delete it.
  const f = sessionWith([piece(0, 1), piece(2, 1, 'left out'), piece(4, 1)]);
  const kept = trackClips(findTrack(f.session, f.a)!).find((c) => c.name === 'left out')!;
  const span = {
    ...spanForTrack(f.session, f.a, all(f.session, f.a))!,
    clipIds: trackClips(findTrack(f.session, f.a)!).filter((c) => c.name !== 'left out').map((c) => c.id),
  };
  const after = applyConsolidatedSpan(f.session, span, 'rendered', 'A (consolidated)');
  const clips = trackClips(findTrack(after, f.a)!);
  assert(clips.length === 2, `the merge plus the survivor, got ${clips.length}`);
  assert(clips.some((c) => c.id === kept.id), 'the unselected take is still there');
});

check('the other track is untouched', () => {
  const f = sessionWith([piece(0, 1), piece(4, 1)], [piece(0, 1), piece(4, 1)]);
  const span = spanForTrack(f.session, f.a, all(f.session, f.a))!;
  const after = applyConsolidatedSpan(f.session, span, 'rendered', 'A (consolidated)');
  assert(trackClips(findTrack(after, f.b)!).length === 2, 'track B keeps both fragments');
});

check('the new clip carries no fade and no offset of its own', () => {
  const f = sessionWith([piece(0, 1), piece(4, 1)]);
  const span = spanForTrack(f.session, f.a, all(f.session, f.a))!;
  const c = trackClips(findTrack(
    applyConsolidatedSpan(f.session, span, 'rendered', 'A'), f.a,
  )!)[0]!;
  near(c.fadeIn.durationSec, 0, 1e-9, 'the fades are IN the file now');
  near(c.fadeOut.durationSec, 0, 1e-9, 'both of them');
  near(c.gainDb, 0, 1e-9, 'and so is the gain');
});

// ── The marquee's track band ─────────────────────────────────────────────────
//
// What a vertical drag actually selects.  Before this the band was fixed to
// the row the drag started on, so dragging a box down through three tracks
// selected one — which reads as "drag does nothing".

check('a drag inside one row selects that row', () => {
  assert(JSON.stringify(trackBand(['a', 'b', 'c'], 'b', 'b')) === JSON.stringify(['b']), 'just b');
});

check('a drag down three rows selects all three', () => {
  assert(JSON.stringify(trackBand(['a', 'b', 'c', 'd'], 'a', 'c')) === JSON.stringify(['a', 'b', 'c']),
    'a through c, including the row in between');
});

check('dragging UP gives the same band as dragging down', () => {
  const down = trackBand(['a', 'b', 'c', 'd'], 'a', 'c');
  const up = trackBand(['a', 'b', 'c', 'd'], 'c', 'a');
  assert(JSON.stringify(down) === JSON.stringify(up), `${JSON.stringify(down)} vs ${JSON.stringify(up)}`);
});

check('the band is in screen order, not drag order', () => {
  assert(JSON.stringify(trackBand(['a', 'b', 'c'], 'c', 'a')) === JSON.stringify(['a', 'b', 'c']),
    'top to bottom either way');
});

check('a row that is not on screen leaves the anchor selected', () => {
  // A collapsed stack member.  Returning nothing here would make the drag
  // look like it cleared the selection.
  assert(JSON.stringify(trackBand(['a', 'b'], 'a', 'hidden')) === JSON.stringify(['a']), 'anchor survives');
});

check('an anchor that is not on screen selects nothing', () => {
  assert(trackBand(['a', 'b'], 'gone', 'b').length === 0, 'no anchor, no band');
});

// ── What it reports ──────────────────────────────────────────────────────────

check('the outcome counts tracks, clips merged and silence', () => {
  const f = sessionWith([piece(0, 1), piece(3, 1)], [piece(0, 1)]);
  const outcome = outcomeOf(consolidationSpans(f.session, all(f.session, f.a, f.b)));
  assert(outcome.tracks === 2, `two tracks, got ${outcome.tracks}`);
  assert(outcome.clipsMerged === 3, `three clips, got ${outcome.clipsMerged}`);
  assert(outcome.gaps === 1, `one hole, got ${outcome.gaps}`);
  near(outcome.silenceSec, 2, 1e-9, 'two seconds of it');
});

check('a bounce with no holes does not mention silence', () => {
  const f = sessionWith([piece(0, 1), piece(1, 1)]);
  const text = describeOutcome(outcomeOf(consolidationSpans(f.session, all(f.session, f.a))));
  assert(!text.includes('무음'), `nothing to say about silence — "${text}"`);
});

check('a bounce with holes says how much silence it wrote', () => {
  const f = sessionWith([piece(0, 1), piece(3, 1)]);
  const text = describeOutcome(outcomeOf(consolidationSpans(f.session, all(f.session, f.a))));
  assert(text.includes('무음 1구간'), `should name the hole — "${text}"`);
  assert(text.includes('2.00초'), `and its length — "${text}"`);
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Consolidate / Bounce Selection ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
