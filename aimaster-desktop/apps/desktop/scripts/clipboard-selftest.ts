/**
 * clipboard-selftest — copy, cut, paste, and cutting where it does not click.
 *
 * The editing verbs that were already here could separate a range, clear it
 * and trim to it.  What none of them could do is move a passage somewhere
 * ELSE, which is the first thing anybody tries.
 *
 * Four claims carry most of this file, and each has a way of being silently
 * wrong:
 *
 *   A partial copy must play the RIGHT PART of the file.  Get `offsetSec`
 *   wrong and you paste the beginning of the take every time — which looks
 *   fine on the timeline and is obvious the moment you press play.
 *
 *   An empty lane must survive.  Drop it and every lane after shifts onto the
 *   wrong target: a bass line pasted onto the vocal track.
 *
 *   The files must travel.  A clip is a reference by id; paste into another
 *   session without the refs and it points at nothing.
 *
 *   A cut must not click.  Zero-crossing snap only helps if it moves the cut
 *   a LITTLE and gives up rather than jumping when there is nothing near.
 *
 * Run: pnpm --filter @aimaster/desktop test:clipboard
 */

import {
  copyRange, cutRange, describeClipboard, insertSilence, isEmptyClipboard,
  pastedClipCount, pasteAt, rippleTracks,
} from '../src/renderer/daw/edit/clipboard.js';
import { clearRange, type TimeSelection } from '../src/renderer/daw/edit/clip-edit.js';
import {
  DEFAULT_ZERO_CROSS, MAX_SEARCH_SEC, nearestZeroCrossing, snapDistanceMs, snapSecToZero,
} from '../src/renderer/daw/edit/zero-cross.js';
import {
  DEFAULT_STRIP, describeStrip, findSoundRegions, silenceShare, stripClipSilence,
} from '../src/renderer/daw/edit/strip-silence.js';
import {
  addFile, addTrack, clipEnd, createClip, createSession, createTrack, findTrack,
  sortClips, trackClips, updateClips,
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
function eq<T>(a: T, b: T, m: string): void {
  if (a !== b) throw new Error(`${m} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}
function close(a: number, b: number, m: string, tol = 1e-6): void {
  if (Math.abs(a - b) > tol) throw new Error(`${m} — got ${a}, want ${b} ±${tol}`);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Three tracks; track 2 is deliberately EMPTY over the copied range. */
function song(): { session: DawSession; vox: TrackId; gap: TrackId; bass: TrackId } {
  resetIds();
  let session = createSession('clipboard test', 48000);
  const vox = createTrack('Vox', 'audio');
  const gap = createTrack('Empty', 'audio');
  const bass = createTrack('Bass', 'audio');
  session = addTrack(addTrack(addTrack(session, vox), gap), bass);
  session = addFile(session, {
    id: 'f1', path: '/v/take.wav', name: 'take.wav',
    durationSec: 60, sampleRate: 48000, channels: 2,
  });
  session = addFile(session, {
    id: 'f2', path: '/v/bass.wav', name: 'bass.wav',
    durationSec: 60, sampleRate: 48000, channels: 1,
  });
  // One long clip on each of vox and bass; nothing at all on `gap`.
  session = updateClips(session, vox.id, () => [
    createClip('f1', 'vox take', { startSec: 0, offsetSec: 10, durationSec: 20 }),
  ]);
  session = updateClips(session, bass.id, () => [
    createClip('f2', 'bass take', { startSec: 0, offsetSec: 0, durationSec: 20 }),
  ]);
  return { session, vox: vox.id, gap: gap.id, bass: bass.id };
}

const sel = (startSec: number, endSec: number, trackIds: TrackId[]): TimeSelection =>
  ({ startSec, endSec, trackIds });

const clipsOn = (session: DawSession, trackId: TrackId): Clip[] => {
  const track = findTrack(session, trackId);
  return track ? sortClips(trackClips(track)) : [];
};

// ── Copy ──────────────────────────────────────────────────────────────────────

check('a partial copy carries the RIGHT PART of the file', () => {
  // The clip starts at timeline 0 but 10 s into its file.  Copying timeline
  // 5–9 must land at file offset 15, not 5 and not 0.
  const { session, vox } = song();
  const board = copyRange(session, sel(5, 9, [vox]));
  assert(board, 'copied');
  const clip = board!.lanes[0]!.clips[0]!;
  close(clip.offsetSec, 15, 'offset moved with the crop');
  close(clip.durationSec, 4, 'and only the selected length came');
  close(clip.startSec, 0, 'rebased so the range starts at zero');
  close(board!.lengthSec, 4, 'the clipboard knows how long it is');
});

check('an empty lane is kept, so the lanes stay lined up', () => {
  // Track 2 has nothing.  If its lane vanished, the bass would paste onto it.
  const { session, vox, gap, bass } = song();
  const board = copyRange(session, sel(2, 6, [vox, gap, bass]))!;
  eq(board.lanes.length, 3, 'three lanes for three tracks');
  eq(board.lanes[1]!.clips.length, 0, 'the middle one is empty');
  eq(board.lanes[1]!.sourceName, 'Empty', 'and still knows what it was');
  eq(board.lanes[2]!.clips[0]!.fileId, 'f2', 'so the bass is still lane 3');
});

check('the file references travel with the clips', () => {
  const { session, vox, bass } = song();
  const board = copyRange(session, sel(2, 6, [vox, bass]))!;
  eq(board.files.length, 2, 'both files came along');
  assert(board.files.some((f) => f.id === 'f1') && board.files.some((f) => f.id === 'f2'),
    'and they are the right ones');
});

check('a click with no drag leaves the clipboard alone', () => {
  // Returning an empty clipboard here would wipe what the user copied a
  // minute ago, which is worse than doing nothing.
  const { session, vox } = song();
  eq(copyRange(session, sel(5, 5, [vox])), null, 'zero length copies nothing');
  eq(copyRange(session, sel(1, 4, [])), null, 'and neither does no tracks');
  eq(isEmptyClipboard(null), true, 'null reads as empty');
  eq(describeClipboard(null), '복사된 것 없음', 'and says so');
});

// ── Paste ─────────────────────────────────────────────────────────────────────

check('paste puts the material down where the playhead is', () => {
  const { session, vox } = song();
  const board = copyRange(session, sel(5, 9, [vox]))!;
  const result = pasteAt(session, board, 30, [vox]);
  const pasted = clipsOn(result.session, vox).find((c) => c.startSec >= 29.9);
  assert(pasted, 'something landed at 30');
  close(pasted!.startSec, 30, 'at the right place');
  close(pasted!.offsetSec, 15, 'playing the right part of the file');
  close(result.selection.startSec, 30, 'and the new selection covers it');
  close(result.selection.endSec, 34, 'from end to end');
  eq(result.problems.length, 0, 'with nothing to complain about');
});

check('pasting five times makes five clips, not one clip five times', () => {
  const { session, vox } = song();
  const board = copyRange(session, sel(5, 9, [vox]))!;
  let out = session;
  for (const at of [30, 40, 50, 60, 70]) out = pasteAt(out, board, at, [vox]).session;
  const ids = new Set(clipsOn(out, vox).map((c) => c.id));
  eq(ids.size, clipsOn(out, vox).length, 'every clip has its own id');
  eq(clipsOn(out, vox).filter((c) => c.startSec >= 29.9).length, 5, 'and there are five');
});

check('overwrite clears the landing zone rather than layering on it', () => {
  const { session, vox } = song();
  const board = copyRange(session, sel(0, 4, [vox]))!;
  // Paste over the middle of the existing 20 s clip.
  const out = pasteAt(session, board, 8, [vox]).session;
  const clips = clipsOn(out, vox);
  // Nothing may overlap: head 0–8, pasted 8–12, tail 12–20.
  for (let i = 1; i < clips.length; i++) {
    assert(clips[i]!.startSec >= clipEnd(clips[i - 1]!) - 1e-6,
      `clip ${i} starts at ${clips[i]!.startSec} but the one before ends at ${clipEnd(clips[i - 1]!)}`);
  }
  close(clips.reduce((n, c) => n + c.durationSec, 0), 20, 'and the timeline is the same length');
});

check('overwrite in the middle keeps BOTH sides of what it split', () => {
  const { session, vox } = song();
  const board = copyRange(session, sel(0, 2, [vox]))!;
  const out = pasteAt(session, board, 9, [vox]).session;
  const clips = clipsOn(out, vox);
  eq(clips.length, 3, 'head, pasted, tail');
  close(clipEnd(clips[0]!), 9, 'head ends where the paste starts');
  close(clips[2]!.startSec, 11, 'tail starts where it ends');
  close(clips[2]!.offsetSec, 21, 'and the tail still plays the right part of the file');
});

check('insert ripples everything right instead of overwriting it', () => {
  const { session, vox } = song();
  const board = copyRange(session, sel(0, 4, [vox]))!;
  const before = clipsOn(session, vox).reduce((n, c) => n + c.durationSec, 0);
  const out = pasteAt(session, board, 8, [vox], 'insert').session;
  const after = clipsOn(out, vox).reduce((n, c) => n + c.durationSec, 0);
  close(after, before + 4, 'the song got exactly 4 s longer — nothing was lost');
  const tail = clipsOn(out, vox).find((c) => c.startSec >= 11.9);
  assert(tail, 'the material after the splice moved right');
  close(tail!.offsetSec, 18, 'and still plays from where it did');
});

check('lanes with no target track are reported, never dropped in silence', () => {
  const { session, vox, gap, bass } = song();
  const board = copyRange(session, sel(2, 6, [vox, gap, bass]))!;
  const result = pasteAt(session, board, 30, [vox]);   // one target, three lanes
  eq(result.problems.length, 1, 'said something');
  assert(result.problems[0]!.includes('2개'), `named how many: ${result.problems[0]}`);
});

check('pasting with no target at all refuses instead of throwing', () => {
  const { session, vox } = song();
  const board = copyRange(session, sel(2, 6, [vox]))!;
  const result = pasteAt(session, board, 10, ['trk_ghost' as TrackId]);
  eq(result.session, session, 'nothing changed');
  assert(result.problems[0]?.includes('트랙'), 'and it says why');
});

check('pasting into a session that lacks the files brings them along', () => {
  const { session, vox } = song();
  const board = copyRange(session, sel(5, 9, [vox]))!;

  resetIds();
  let other = createSession('another song', 48000);
  const track = createTrack('Import', 'audio');
  other = addTrack(other, track);
  eq(other.files.length, 0, 'the target has no files');

  const result = pasteAt(other, board, 0, [track.id]);
  eq(result.session.files.length, 1, 'the file came with the clip');
  eq(result.session.files[0]!.id, 'f1', 'and it is the right one');
  eq(clipsOn(result.session, track.id)[0]!.fileId, 'f1', 'so the clip resolves');
});

check('pasting twice does not add the same file twice', () => {
  // A duplicate entry would confuse the decode cache, which is keyed by id.
  const { session, vox } = song();
  const board = copyRange(session, sel(5, 9, [vox]))!;
  const once = pasteAt(session, board, 30, [vox]).session;
  const twice = pasteAt(once, board, 40, [vox]).session;
  eq(twice.files.length, session.files.length, 'the file list did not grow');
});

// ── Cut ───────────────────────────────────────────────────────────────────────

check('cut copies and removes, leaving a hole', () => {
  const { session, vox } = song();
  const { session: out, clipboard } = cutRange(session, sel(5, 9, [vox]));
  assert(clipboard, 'something was copied');
  close(clipboard!.lengthSec, 4, 'the right amount');
  const clips = clipsOn(out, vox);
  eq(clips.length, 2, 'the clip became two');
  close(clipEnd(clips[0]!), 5, 'with a hole from 5');
  close(clips[1]!.startSec, 9, 'to 9');
});

check('cut with ripple closes the hole, so cut+paste is a MOVE', () => {
  const { session, vox } = song();
  const { session: out, clipboard } = cutRange(session, sel(5, 9, [vox]), true);
  const clips = clipsOn(out, vox);
  eq(clips.length, 2, 'still two pieces');
  close(clips[1]!.startSec, 5, 'the tail closed up against the head');
  close(clips.reduce((n, c) => n + c.durationSec, 0), 16, 'and the song is 4 s shorter');
  // Now paste it back somewhere: nothing has been lost overall.
  const back = pasteAt(out, clipboard!, 10, [vox], 'insert').session;
  close(clipsOn(back, vox).reduce((n, c) => n + c.durationSec, 0), 20, 'move preserves the material');
});

check('cutting nothing is a no-op that keeps the old clipboard', () => {
  const { session, vox } = song();
  const result = cutRange(session, sel(5, 5, [vox]));
  eq(result.session, session, 'session untouched');
  eq(result.clipboard, null, 'and nothing claimed to be copied');
});

// ── Insert silence ────────────────────────────────────────────────────────────

check('insert silence opens a gap and moves everything after it', () => {
  const { session, vox } = song();
  const out = insertSilence(session, [vox], 8, 4);
  const clips = clipsOn(out, vox);
  eq(clips.length, 2, 'the clip was split at the splice');
  close(clipEnd(clips[0]!), 8, 'front ends at the splice');
  close(clips[1]!.startSec, 12, 'back starts 4 s later');
  close(clips[1]!.offsetSec, 18, 'and still plays from where it did');
  close(clips.reduce((n, c) => n + c.durationSec, 0), 20, 'no audio was created or lost');
});

check('insert silence and ripple delete are exact inverses', () => {
  const { session, vox } = song();
  const opened = insertSilence(session, [vox], 8, 4);
  const closed = clearRange(opened, sel(8, 12, [vox]), true);
  const before = clipsOn(session, vox);
  const after = clipsOn(closed, vox);
  close(after.reduce((n, c) => n + c.durationSec, 0),
    before.reduce((n, c) => n + c.durationSec, 0), 'same total length');
  close(after[after.length - 1]!.offsetSec + after[after.length - 1]!.durationSec,
    before[0]!.offsetSec + before[0]!.durationSec, 'and the same tail of the file');
});

check('a zero or negative insert does nothing', () => {
  const { session, vox } = song();
  eq(insertSilence(session, [vox], 8, 0), session, 'zero');
  eq(insertSilence(session, [vox], 8, -3), session, 'negative');
});

check('a negative ripple does not split a straddling clip', () => {
  // Splitting there would slide the back half into the front half.
  const { session, vox } = song();
  const out = rippleTracks(session, [vox], 8, -2);
  eq(clipsOn(out, vox).length, 1, 'left whole');
});

// ── Zero crossing ─────────────────────────────────────────────────────────────

/** One cycle of a sine every `period` samples — every crossing is arithmetic. */
function sine(lengthSamples: number, periodSamples: number): Float32Array {
  const out = new Float32Array(lengthSamples);
  for (let i = 0; i < lengthSamples; i++) out[i] = Math.sin((2 * Math.PI * i) / periodSamples);
  return out;
}

check('a cut in the middle of a cycle moves to the crossing', () => {
  const rate = 48000;
  const period = 480;                       // 100 Hz
  const wave = sine(rate, period);
  // Sample 600 is 1.25 cycles in — a quarter cycle past a rising crossing.
  const snapped = nearestZeroCrossing(wave, 600, rate);
  // Rising crossings are at multiples of the period.
  eq(snapped % period === 0 || (snapped + 1) % period === 0, true,
    `landed on a crossing, got ${snapped}`);
  assert(Math.abs(snapped - 600) <= MAX_SEARCH_SEC * rate,
    `and moved only a little: ${Math.abs(snapped - 600)} samples`);
});

check('it prefers a RISING crossing, so two edits continue each other', () => {
  const rate = 48000;
  const wave = sine(rate, 480);
  const at = nearestZeroCrossing(wave, 700, rate, { ...DEFAULT_ZERO_CROSS, preferRising: true });
  assert((wave[at + 1] ?? 0) > (wave[at] ?? 0), `the signal is going up at ${at}`);
});

check('with nothing near, the cut stays exactly where it was put', () => {
  // Dragging an edit 40 ms to find a crossing is a worse edit than the click.
  const rate = 48000;
  const flat = new Float32Array(rate).fill(0.5);   // never crosses
  eq(nearestZeroCrossing(flat, 12345, rate), 12345, 'unmoved');
  close(snapSecToZero(flat, 0.25, rate), 0.25, 'and in seconds too');
});

check('the snap is inaudible as timing', () => {
  const rate = 48000;
  const wave = sine(rate, 480);
  const from = 0.25;
  const to = snapSecToZero(wave, from, rate);
  assert(Math.abs(snapDistanceMs(from, to)) <= MAX_SEARCH_SEC * 1000 + 1e-9,
    `moved ${snapDistanceMs(from, to).toFixed(2)} ms`);
});

check('degenerate input never throws or returns nonsense', () => {
  eq(nearestZeroCrossing(new Float32Array(0), 10, 48000), 10, 'empty');
  eq(nearestZeroCrossing(new Float32Array([1]), 0, 48000), 0, 'one sample');
  // A NaN position comes back unchanged rather than becoming a real sample —
  // the snap declines to invent a cut point it was never given.
  assert(Number.isNaN(nearestZeroCrossing(sine(100, 20), Number.NaN, 48000)),
    'NaN passes through rather than snapping to 0');
  close(snapSecToZero(sine(100, 20), 0.5, 0), 0.5, 'a zero rate changes nothing');
});

// ── Strip silence ─────────────────────────────────────────────────────────────

/** Tone, gap, tone — with the gap length under our control. */
function takeWithGap(rate: number, toneSec: number, gapSec: number): Float32Array {
  const total = Math.round((toneSec * 2 + gapSec) * rate);
  const out = new Float32Array(total);
  const tone = Math.round(toneSec * rate);
  const gap = Math.round(gapSec * rate);
  for (let i = 0; i < tone; i++) out[i] = Math.sin((2 * Math.PI * i) / 200) * 0.5;
  for (let i = tone + gap; i < total; i++) out[i] = Math.sin((2 * Math.PI * i) / 200) * 0.5;
  return out;
}

check('a long gap is found; a short one is not touched', () => {
  const rate = 48000;
  const long = findSoundRegions(takeWithGap(rate, 1, 1), rate);
  eq(long.length, 2, 'a one-second gap splits the take');

  // A 0.1 s gap is a breath.  Cutting there is what makes an edit sound chopped.
  const short = findSoundRegions(takeWithGap(rate, 1, 0.1), rate);
  eq(short.length, 1, 'a breath does not');
});

check('the pad keeps attacks and tails', () => {
  const rate = 48000;
  const regions = findSoundRegions(takeWithGap(rate, 1, 1), rate);
  // The second region's tone starts at 2.0 s; the pad must reach back before it.
  assert(regions[1]!.startSec < 2.0, `padded back to ${regions[1]!.startSec.toFixed(3)}`);
  assert(regions[1]!.startSec > 1.9, 'but not so far it swallows the gap');
});

check('silence below the threshold is silence; above it is not', () => {
  const rate = 48000;
  const quiet = new Float32Array(rate).fill(0);
  eq(findSoundRegions(quiet, rate).length, 0, 'digital black is all silence');

  // Room tone at −40 dB: silence at a −48 threshold, sound at a −30 one.
  const tone = new Float32Array(rate).fill(0.01);
  eq(findSoundRegions(tone, rate, { ...DEFAULT_STRIP, thresholdDb: -30 }).length, 0,
    'below a -30 threshold');
  eq(findSoundRegions(tone, rate, { ...DEFAULT_STRIP, thresholdDb: -48 }).length, 1,
    'above a -48 one');
});

check('stripping cuts holes without retiming the performance', () => {
  const { session, vox } = song();
  const clip = clipsOn(session, vox)[0]!;
  // Two sounding regions inside the 20 s clip.
  const result = stripClipSilence(session, vox, clip.id, [
    { startSec: 0, endSec: 4 }, { startSec: 12, endSec: 20 },
  ]);
  eq(result.pieces, 2, 'two pieces');
  close(result.removedSec, 8, 'and 8 s removed');
  const clips = clipsOn(result.session, vox);
  close(clips[0]!.startSec, 0, 'the first piece did not move');
  close(clips[1]!.startSec, 12, 'and neither did the second');
  close(clips[1]!.offsetSec, 22, 'which still plays the right part of the file');
});

check('finding no sound removes nothing rather than deleting the take', () => {
  // A very confident reading of a threshold the user can still change.
  const { session, vox } = song();
  const clip = clipsOn(session, vox)[0]!;
  const result = stripClipSilence(session, vox, clip.id, []);
  eq(result.session, session, 'untouched');
  assert(describeStrip(result).includes('임계값'), 'and it suggests the fix');
});

check('the share of silence is reported before anything is cut', () => {
  close(silenceShare([{ startSec: 0, endSec: 4 }], 20), 0.8, '80% would go');
  close(silenceShare([], 0), 0, 'and an empty take is not a division by zero');
});

check('a strip result describes itself in minutes when it should', () => {
  const { session, vox } = song();
  const clip = clipsOn(session, vox)[0]!;
  const result = stripClipSilence(session, vox, clip.id, [{ startSec: 0, endSec: 1 }]);
  assert(describeStrip(result).includes('조각'), `${describeStrip(result)}`);
  eq(pastedClipCount(null), 0, 'and a null clipboard pastes nothing');
});

// ── Report ────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Clipboard · insert · zero-cross · strip silence ===');
for (const r of results) {
  console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
