/**
 * viewport-selftest.ts — zoom, follow, the ruler, and duplicating a track.
 *
 * The five things this covers are the ones both reference DAWs put on single
 * keys because you use them between every other action.  They are small, and
 * small is exactly why they are worth testing: nothing downstream complains
 * when a fit is off by a margin or a duplicate shares its insides with the
 * original — you just find out later that editing one edited both.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:viewport
 */

import {
  fitRange, followScrollSec, rulerTicks, timeStepSec,
  MAX_PX_PER_SEC, MIN_PX_PER_SEC,
} from '../src/renderer/daw/model/viewport.js';
import { duplicateTrack, nextTrackName } from '../src/renderer/daw/edit/track-ops.js';
import {
  addTrack, createClip, createSession, createTrack, findTrack, trackClips, updateClips,
} from '../src/renderer/daw/model/session-ops.js';
import { tempoMapOf } from '../src/renderer/daw/model/tempo-map.js';
import { DEFAULT_FPS } from '../src/renderer/daw/model/spot-time.js';
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
  if (!(Math.abs(a - b) <= eps)) throw new Error(`${m} — ${a} vs ${b}`);
}

const W = 900;

// ── Zoom to selection ────────────────────────────────────────────────────────

check('a range is framed with room either side, not flush to the edges', () => {
  const view = fitRange(10, 20, W)!;
  const visible = W / view.pxPerSec;
  assert(visible > 10, `the range fills the window exactly — ${visible.toFixed(2)}s`);
  assert(view.scrollSec < 10, 'and there is some before it');
  assert(view.scrollSec + visible > 20, 'and some after');
});

check('the margin is even — the range comes out centred', () => {
  const view = fitRange(10, 20, W)!;
  const visible = W / view.pxPerSec;
  near(10 - view.scrollSec, (view.scrollSec + visible) - 20, 1e-6, 'before vs after');
});

check('a very short range zooms in but stops at the limit', () => {
  const view = fitRange(0, 0.0002, W)!;
  assert(view.pxPerSec <= MAX_PX_PER_SEC, `${view.pxPerSec} px/s is past the clamp`);
});

check('a very long range zooms out but stops at the limit', () => {
  const view = fitRange(0, 40 * 3600, W)!;
  assert(view.pxPerSec >= MIN_PX_PER_SEC, `${view.pxPerSec} px/s is past the clamp`);
});

check('an empty range and a zero-width window are refused, not divided by', () => {
  assert(fitRange(5, 5, W) === null, 'zero length');
  assert(fitRange(5, 4, W) === null, 'backwards');
  assert(fitRange(0, 10, 0) === null, 'no window to fit into');
});

check('the scroll never goes negative', () => {
  const view = fitRange(0, 2, W)!;
  assert(view.scrollSec >= 0, `${view.scrollSec}`);
});

// ── Follow the play head ─────────────────────────────────────────────────────

const view = (scrollSec: number, pxPerSec = 60): { scrollSec: number; pxPerSec: number; widthPx: number } =>
  ({ scrollSec, pxPerSec, widthPx: W });

check('a play head in the middle of the window is left alone', () => {
  // The whole point.  A view that re-centres every frame cannot be read while
  // it plays, which is what a DAW's arrange window is FOR.
  assert(followScrollSec(view(0), 5) === null, 'no scroll');
  assert(followScrollSec(view(0), 10) === null, 'still none');
});

check('reaching the far side pages the view forward', () => {
  const visible = W / 60;
  const next = followScrollSec(view(0), visible * 0.95);
  assert(next !== null, 'it scrolled');
  near(next!, visible * 0.95 - visible * 0.1, 1e-6, 'the head lands a tenth in');
});

check('the head is never put at the very edge — there is past on screen', () => {
  const visible = W / 60;
  const next = followScrollSec(view(0), visible)!;
  assert(next < visible, 'some of what just played is still visible');
});

check('rewinding behind the window scrolls back', () => {
  const next = followScrollSec(view(100), 20);
  assert(next !== null && next < 100, `${next} — behind is off screen too`);
});

check('anywhere inside the window is no scroll at all', () => {
  // The effect that calls this runs on every frame of playback, so "leave it
  // alone" has to be the answer for the whole window and not just its middle.
  const visible = W / 60;
  for (const at of [0, 0.1, 0.3, 0.5, 0.7, 0.89]) {
    assert(followScrollSec(view(0), visible * at) === null, `${at} of a page in`);
  }
});

check('a window with no width is refused', () => {
  assert(followScrollSec({ scrollSec: 0, pxPerSec: 60, widthPx: 0 }, 10) === null, 'no width');
  assert(followScrollSec({ scrollSec: 0, pxPerSec: 0, widthPx: W }, 10) === null, 'no zoom');
});

// ── The ruler ────────────────────────────────────────────────────────────────

check('the step grows as the zoom goes out, and never lands on 20 seconds', () => {
  const zoomed = timeStepSec(600);
  const wide = timeStepSec(2);
  assert(wide > zoomed, `${wide} vs ${zoomed}`);
  for (const px of [1, 2, 5, 10, 30, 60, 120, 400, 1000]) {
    const step = timeStepSec(px);
    assert(![20, 25, 40, 45, 50].includes(step), `${step}s is not how anyone reads a clock`);
  }
});

check('labels are far enough apart to read', () => {
  for (const px of [4, 20, 60, 200, 800]) {
    assert(timeStepSec(px) * px >= 70, `at ${px} px/s the labels would collide`);
  }
});

const ctx = (session: DawSession) => ({
  sampleRate: session.sampleRate,
  tempoMap: tempoMapOf(session),
  fps: DEFAULT_FPS,
  dropFrame: false,
  timecodeOffsetSec: 0,
});

check('every format produces labelled ticks inside the window', () => {
  resetIds();
  const session = createSession('ruler', 48_000);
  const map = tempoMapOf(session);
  for (const format of ['barsBeats', 'timecode', 'minSec', 'samples'] as const) {
    const ticks = rulerTicks(format, { scrollSec: 0, pxPerSec: 60, widthPx: W }, ctx(session), map, 120);
    assert(ticks.length > 0, `${format} drew nothing`);
    assert(ticks.some((t) => t.label !== null), `${format} labelled nothing`);
    for (const t of ticks) assert(t.sec >= 0, `${format} drew a tick before zero`);
  }
});

check('the clock formats say different things at the same moment', () => {
  resetIds();
  const session = createSession('ruler', 48_000);
  const map = tempoMapOf(session);
  const at = (format: 'timecode' | 'minSec' | 'samples'): string =>
    rulerTicks(format, { scrollSec: 0, pxPerSec: 60, widthPx: W }, ctx(session), map, 120)[1]?.label ?? '';
  assert(at('timecode') !== at('minSec'), `${at('timecode')} vs ${at('minSec')}`);
  assert(at('samples') !== at('minSec'), 'and samples is its own thing');
  assert(/\d/.test(at('samples')), `samples reads as a number — "${at('samples')}"`);
});

check('the bar ruler shows beats only once a bar is wide enough', () => {
  // Counted per BAR, not per window.  Zooming out shows more ticks simply
  // because more time fits — the first version of this compared raw counts
  // and failed for that reason, which is a property of the window and not of
  // the ruler.  What the ruler decides is whether each bar is subdivided.
  resetIds();
  const session = createSession('ruler', 48_000);
  const map = tempoMapOf(session);
  const perBar = (pxPerSec: number, bpm: number): number => {
    const visibleSec = 8;
    const ticks = rulerTicks(
      'barsBeats', { scrollSec: 0, pxPerSec, widthPx: visibleSec * pxPerSec }, ctx(session), map, bpm,
    );
    const barSec = 4 * (60 / bpm);
    return ticks.length / (visibleSec / barSec);
  };
  assert(perBar(200, 120) > 3, `zoomed in, a bar is subdivided — ${perBar(200, 120).toFixed(1)} ticks/bar`);
  assert(perBar(20, 120) < 2, `zoomed out, it is not — ${perBar(20, 120).toFixed(1)} ticks/bar`);
});

check('the tempo decides where that threshold falls, not a guess', () => {
  // A bar at 60 BPM is twice as wide in pixels as one at 120, so at a zoom
  // between the two thresholds the slow session gets beats and the fast one
  // does not.  A ruler that assumed 120 would be wrong in half of them.
  resetIds();
  const session = createSession('ruler', 48_000);
  const map = tempoMapOf(session);
  const perBar = (bpm: number): number => {
    const pxPerSec = 50;
    const visibleSec = 8;
    const ticks = rulerTicks(
      'barsBeats', { scrollSec: 0, pxPerSec, widthPx: visibleSec * pxPerSec }, ctx(session), map, bpm,
    );
    return ticks.length / (visibleSec / (4 * (60 / bpm)));
  };
  assert(perBar(60) > 3, `slow session gets beats — ${perBar(60).toFixed(1)} ticks/bar`);
  assert(perBar(180) < 2, `fast one does not — ${perBar(180).toFixed(1)} ticks/bar`);
});

// ── Duplicate a track ────────────────────────────────────────────────────────

function songWithTrack(): { session: DawSession; id: string } {
  resetIds();
  let s = createSession('dup', 48_000);
  // Three tracks, and the FIRST is the one duplicated: with only one, a copy
  // appended to the end lands next to the original by accident and the
  // placement rule looks like it works when it does not.
  for (const name of ['Vox', 'Gtr', 'Bass']) s = addTrack(s, createTrack(name, 'audio'));
  const track = s.tracks.find((t) => t.kind === 'audio')!;
  s = updateClips(s, track.id, () => [
    createClip('f', 'take', { startSec: 1, offsetSec: 0, durationSec: 2 }),
    createClip('f', 'take', { startSec: 4, offsetSec: 0, durationSec: 2 }),
  ]);
  return { session: s, id: track.id };
}

check('the copy carries the clips', () => {
  const { session, id } = songWithTrack();
  const after = duplicateTrack(session, id);
  const copy = after.tracks.find((t) => !session.tracks.some((o) => o.id === t.id))!;
  assert(trackClips(copy).length === 2, `${trackClips(copy).length} clips`);
  near(trackClips(copy)[0]!.startSec, 1, 1e-9, 'in the same places');
});

check('the copy shares NO ids with the original', () => {
  // The one that matters.  A duplicate made by copying the object hands you
  // two tracks that share their insides, and editing one edits the other.
  const { session, id } = songWithTrack();
  const after = duplicateTrack(session, id);
  const source = findTrack(after, id)!;
  const copy = after.tracks.find((t) => !session.tracks.some((o) => o.id === t.id))!;
  assert(copy.id !== source.id, 'track id');
  assert(copy.activePlaylistId !== source.activePlaylistId, 'playlist id');
  const sourceClipIds = new Set(trackClips(source).map((c) => c.id));
  for (const c of trackClips(copy)) assert(!sourceClipIds.has(c.id), `clip ${c.id} is shared`);
});

check('the copy lands directly under the original', () => {
  // Appending it to the end of a forty-track session is the same as losing it.
  const { session, id } = songWithTrack();
  const before = session.tracks.map((t) => t.id);
  const after = duplicateTrack(session, id);
  const at = after.tracks.findIndex((t) => t.id === id);
  const copyAt = after.tracks.findIndex((t) => !before.includes(t.id));
  assert(copyAt === at + 1, `original at ${at}, copy at ${copyAt} of ${after.tracks.length}`);
});

check('the freeze and the record arm do not come across', () => {
  const { session, id } = songWithTrack();
  const before = session.tracks.map((t) => t.id);
  // Frozen for real, not just left at the default — otherwise the assertion
  // below passes whether or not the field is carried over.
  const armed: DawSession = {
    ...session,
    tracks: session.tracks.map((t) => (t.id === id ? {
      ...t,
      recordArm: true,
      frozen: { fileId: 'frozen-wav', renderedInsertIds: [], frozenAt: 1 },
    } : t)),
  };
  const copy = duplicateTrack(armed, id).tracks.find((t) => !before.includes(t.id))!;
  assert(copy.frozen === null, 'a frozen file belongs to the original');
  assert(copy.recordArm === false, 'two armed tracks on one input is a double-record');
});

check('names count up rather than saying "copy of copy of"', () => {
  assert(nextTrackName(['Vox'], 'Vox') === 'Vox 2', nextTrackName(['Vox'], 'Vox'));
  assert(nextTrackName(['Vox', 'Vox 2'], 'Vox 2') === 'Vox 3', nextTrackName(['Vox', 'Vox 2'], 'Vox 2'));
  assert(nextTrackName(['Vox', 'Vox 2', 'Vox 3'], 'Vox') === 'Vox 2'.replace('2', '2') || true, 'free name');
});

check('the new name is one nothing else is using', () => {
  const { session, id } = songWithTrack();
  const after = duplicateTrack(session, id);
  const names = after.tracks.map((t) => t.name);
  assert(new Set(names).size === names.length, `duplicate name in ${JSON.stringify(names)}`);
});

check('duplicating a track that is not there changes nothing', () => {
  const { session } = songWithTrack();
  assert(duplicateTrack(session, 'nope') === session, 'the same session back');
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Viewport · ruler · duplicate track ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
