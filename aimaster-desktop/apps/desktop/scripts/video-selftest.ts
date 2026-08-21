/**
 * video-selftest — picture that stays with the music.
 *
 * Two things here are arithmetic that is easy to get subtly wrong, and both
 * fail in the same expensive way: they look fine at the start of the reel and
 * are seconds off by the end.
 *
 *   DROP-FRAME TIMECODE.  29.97 counts thirty frames a second but only
 *   receives 29.97, so non-drop timecode runs 3.6 seconds ahead over an hour.
 *   Drop-frame fixes it by skipping frame NUMBERS — never picture — at the top
 *   of every minute except every tenth.  The canonical checkpoints are here.
 *
 *   THE SYNC LADDER.  The naive "set currentTime every tick" is unwatchable:
 *   a seek restarts the decoder at a keyframe, so correcting twenty times a
 *   second is a slideshow.  These tests are mostly about the corrections that
 *   must NOT happen.
 *
 * A fake element stands in for `<video>`, so this runs with no DOM, no codec
 * and no file.
 *
 * Run: pnpm --filter @aimaster/desktop test:video
 */

import {
  FRAME_RATES, describeVideo, formatTimecode, frameAt, frameSec, nearestFrameRate,
  parseTimecode, snapToFrame, timecodeAt, timelineTimeAt, videoOf, videoTimeAt,
  withVideo, type VideoRef,
} from '../src/renderer/daw/model/video.js';
import {
  DEFAULT_SYNC, VideoFollower, describeSync, syncDecision,
  type VideoElementLike,
} from '../src/renderer/daw/engine/video-sync.js';
import { createSession } from '../src/renderer/daw/model/session-ops.js';
import type { DawSession } from '../src/renderer/daw/model/types.js';

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

const FPS_2997 = 30000 / 1001;
const FPS_2398 = 24000 / 1001;

// ── Drop-frame timecode ───────────────────────────────────────────────────────

check('the two frames at the top of a minute are skipped', () => {
  const at = (frames: number): string => formatTimecode(frames / FPS_2997, FPS_2997, true);
  eq(at(1799), '00:00:59;29', 'the last frame of the first minute');
  eq(at(1800), '00:01:00;02', 'and the next one is ;02, not ;00');
});

check('the tenth minute does NOT skip', () => {
  const at = (frames: number): string => formatTimecode(frames / FPS_2997, FPS_2997, true);
  eq(at(17981), '00:09:59;29', 'the last frame of the ninth minute');
  eq(at(17982), '00:10:00;00', 'and the tenth starts at ;00');
});

check('drop-frame timecode tracks the wall clock over an hour', () => {
  // This is the entire reason drop-frame exists.
  eq(formatTimecode(3600, FPS_2997, true), '01:00:00;00', 'an hour of real time reads an hour');
});

check('non-drop drifts by exactly 108 frames over that hour', () => {
  eq(formatTimecode(3600, FPS_2997, false), '00:59:56:12', 'the famous 3.6 seconds');
  // 3 s 18 f at a nominal 30 = 108 frames.  If this number moves, the
  // drop-frame correction above is wrong by the same amount.
  eq(3 * 30 + 18, 108, 'and 108 is what drop-frame gives back');
});

check('drop-frame is marked with a semicolon, non-drop with a colon', () => {
  assert(formatTimecode(60, FPS_2997, true).includes(';'), 'DF uses ;');
  assert(!formatTimecode(60, FPS_2997, false).includes(';'), 'NDF does not');
});

check('a whole-number rate needs no dropping at all', () => {
  eq(formatTimecode(3600, 25, false), '01:00:00:00', '25 fps is exact');
  eq(formatTimecode(1.04, 25, false), '00:00:01:01', 'and one frame past a second');
  eq(formatTimecode(3600, 24, false), '01:00:00:00', 'so is 24');
});

check('timecode round-trips through parsing', () => {
  for (const tc of ['01:00:00;00', '00:01:00;02', '00:10:00;00', '00:00:59;29']) {
    const sec = parseTimecode(tc, FPS_2997);
    assert(sec !== null, `${tc} parses`);
    eq(formatTimecode(sec!, FPS_2997, true), tc, `${tc} survives the round trip`);
  }
  for (const tc of ['01:00:00:00', '00:00:12:07']) {
    const sec = parseTimecode(tc, 25);
    assert(sec !== null, `${tc} parses at 25`);
    eq(formatTimecode(sec!, 25, false), tc, `${tc} round-trips`);
  }
});

check('nonsense is refused rather than coerced', () => {
  eq(parseTimecode('hello', 25), null, 'not timecode');
  eq(parseTimecode('00:99:00:00', 25), null, 'ninety-nine minutes is not a time');
  eq(parseTimecode('00:00:00:30', 25), null, 'frame 30 does not exist at 25 fps');
  eq(parseTimecode('00:00:00:24', 25) !== null, true, 'but frame 24 does');
});

check('a missing hours field is accepted — nobody types the leading zeros', () => {
  const sec = parseTimecode('01:30:00', 25);
  assert(sec !== null, 'parsed');
  close(sec!, 90, 'one minute thirty', 1e-6);
});

// ── Frame maths ───────────────────────────────────────────────────────────────

check('snapping puts a time on a frame boundary, at the real rate', () => {
  const snapped = snapToFrame(1.0, FPS_2398);
  close(snapped * FPS_2398, Math.round(snapped * FPS_2398), 'lands on a whole frame', 1e-9);
  // At 23.976 the frames are 41.7 ms apart, so a second is NOT on a boundary.
  assert(Math.abs(snapped - 1.0) > 1e-9, `23.976 moved it: ${snapped}`);
  close(snapToFrame(1.0, 25), 1.0, '25 fps leaves a whole second alone');
});

check('one frame is one frame', () => {
  close(frameSec(25), 0.04, '25 fps');
  close(frameSec(FPS_2398), 1001 / 24000, '23.976 is the rational, not the rounding', 1e-12);
  eq(frameAt(1, 25), 25, 'the 25th frame is at one second');
  eq(frameSec(0), 0, 'and a zero rate does not divide by zero');
});

check('the nearest standard rate is recognised, not rounded away', () => {
  eq(nearestFrameRate(23.976).label, '23.976', 'a 23.976 file is not called 24');
  eq(nearestFrameRate(24).label, '24', 'and 24 is not called 23.976');
  eq(nearestFrameRate(25).label, '25', '25');
  eq(nearestFrameRate(59.94).fps, 60000 / 1001, '59.94');
  assert(FRAME_RATES.length >= 8, 'the list covers what people deliver');
});

// ── Placing the picture ───────────────────────────────────────────────────────

function reel(over: Partial<VideoRef> = {}): VideoRef {
  return {
    id: 'vid1', path: '/v/reel.mov', name: 'reel.mov',
    startSec: 0, offsetSec: 0, durationSec: 120,
    // 01:00:00:00 at 23.976 is NOT 3600 seconds — see the test below.
    fps: FPS_2398, startTimecodeSec: parseTimecode('01:00:00:00', FPS_2398) ?? 0,
    width: 1920, height: 1080,
    ...over,
  };
}

check('the timeline maps into the file through start and offset', () => {
  const v = reel({ startSec: 10, offsetSec: 5 });
  close(videoTimeAt(v, 10)!, 5, 'the picture starts 5 s into the file');
  close(videoTimeAt(v, 20)!, 15, 'and runs from there');
  close(timelineTimeAt(v, 15), 20, 'and the inverse agrees');
});

check('outside the picture is null, not a clamped edge frame', () => {
  // Clamping would freeze the last frame over the credits and read as
  // "still playing", which is the one thing a scoring session cannot afford
  // to be confused about.
  const v = reel({ startSec: 10, offsetSec: 0, durationSec: 30 });
  eq(videoTimeAt(v, 9.9), null, 'before it starts');
  eq(videoTimeAt(v, 41), null, 'after it ends');
  assert(videoTimeAt(v, 10) !== null, 'the first frame is inside');
  assert(videoTimeAt(v, 40) !== null, 'and so is the last');
});

check('the read-out shows the reel’s own timecode, not the session’s', () => {
  // Post delivers starting at 01:00:00:00, and a spotting note quotes that.
  const v = reel({ startSec: 0 });
  eq(timecodeAt(v, 0), '01:00:00:00', 'the first frame reads one hour');
  eq(timecodeAt(v, 999), '--:--:--:--', 'and off the end reads nothing');
});

check('an hour of TIMECODE is not an hour of SECONDS at a pulldown rate', () => {
  // The trap this fixture fell into.  01:00:00:00 at 23.976 is 86400 frames,
  // and 86400 frames take 3603.6 seconds — 3.6 seconds more than an hour.
  // Storing the start as seconds is only safe because the rate converts it.
  const oneHourOfTimecode = parseTimecode('01:00:00:00', FPS_2398);
  assert(oneHourOfTimecode !== null, 'parsed');
  close(oneHourOfTimecode!, 86400 / FPS_2398, 'frames over the real rate', 1e-9);
  assert(Math.abs(oneHourOfTimecode! - 3600) > 3, `and it is ${oneHourOfTimecode!.toFixed(1)} s, not 3600`);
  eq(formatTimecode(3600, FPS_2398, false), '00:59:56:10', '3600 seconds reads as less than an hour');
});

check('the video round-trips through the session, and an old session has none', () => {
  const session: DawSession = createSession('picture', 48000);
  eq(videoOf(session), null, 'a session written before video has none');
  const withIt = withVideo(session, reel());
  eq(videoOf(withIt)?.name, 'reel.mov', 'and one that has it reads back');
  eq(videoOf(withVideo(withIt, null)), null, 'and it can be removed');
  // A malformed entry is refused rather than half-used.
  eq(videoOf({ ...session, video: { path: 5 } } as unknown as DawSession), null, 'garbage is null');
  assert(describeVideo(reel()).includes('1920×1080'), 'and it describes itself');
});

// ── The sync ladder: what must NOT happen ─────────────────────────────────────

check('a drift nobody can see is left alone', () => {
  const d = syncDecision(10.0, 10.01, true);
  eq(d.action, 'hold', 'under the dead band');
  eq(d.rate, 1, 'and the rate is untouched');
});

check('a visible-but-catchable drift is a RATE nudge, never a seek', () => {
  // This is the test that stops the slideshow.  A seek here would tear down
  // the decode pipeline for a gap of a tenth of a second.
  const behind = syncDecision(10.0, 10.1, true);
  eq(behind.action, 'rate', 'behind → rate');
  assert(behind.rate > 1, `speeds up: ${behind.rate}`);

  const ahead = syncDecision(10.1, 10.0, true);
  eq(ahead.action, 'rate', 'ahead → rate');
  assert(ahead.rate < 1, `slows down: ${ahead.rate}`);
});

check('the rate correction stays invisible', () => {
  const d = syncDecision(10.0, 10.49, true);
  eq(d.action, 'rate', 'still a nudge just under the threshold');
  assert(Math.abs(d.rate - 1) <= DEFAULT_SYNC.maxRateDeviation + 1e-9,
    `clamped to ±${DEFAULT_SYNC.maxRateDeviation}: got ${d.rate}`);
});

check('a real jump IS a seek — a nudge could never catch it', () => {
  const d = syncDecision(10, 95, true);
  eq(d.action, 'seek', 'a locate');
  close(d.seekTo, 95, 'straight there');
  eq(d.rate, 1, 'and the rate goes back to normal');
});

check('parked, anything past the dead band is a seek', () => {
  // Scrubbing must show the right frame; there is no rate to nudge.
  eq(syncDecision(10, 10.2, false).action, 'seek', 'stopped → seek');
  eq(syncDecision(10, 10.005, false).action, 'hold', 'unless it is already there');
});

check('a NaN never becomes a seek to NaN', () => {
  eq(syncDecision(Number.NaN, 10, true).action, 'hold', 'unknown position');
  eq(syncDecision(10, Number.NaN, true).action, 'hold', 'unknown target');
});

check('the drift read-out says which way and how far', () => {
  assert(describeSync(syncDecision(10, 10.012, true)).includes('+12 ms'), 'signed, in ms');
  assert(describeSync(syncDecision(10, 10.1, true)).includes('속도'), 'and names the correction');
  eq(describeSync(null), '픽처 없음', 'and says when there is no picture');
});

// ── The follower ──────────────────────────────────────────────────────────────

class FakeVideo implements VideoElementLike {
  currentTime = 0;
  playbackRate = 1;
  seeking = false;
  paused = true;
  seeks = 0;
  plays = 0;
  pauses = 0;

  play(): Promise<void> { this.plays++; this.paused = false; return Promise.resolve(); }
  pause(): void { this.pauses++; this.paused = true; }
  /** Assigning currentTime is a seek — count it the way the DOM would. */
  seekTo(t: number): void { this.currentTime = t; this.seeks++; }
}

/** currentTime assignment has to be observable, so wrap it in a proxy. */
function follower(): { fake: FakeVideo; element: VideoElementLike; f: VideoFollower } {
  const fake = new FakeVideo();
  const element: VideoElementLike = {
    get currentTime() { return fake.currentTime; },
    set currentTime(t: number) { fake.seekTo(t); },
    get playbackRate() { return fake.playbackRate; },
    set playbackRate(r: number) { fake.playbackRate = r; },
    get seeking() { return fake.seeking; },
    get paused() { return fake.paused; },
    play: () => fake.play(),
    pause: () => { fake.pause(); },
  };
  const f = new VideoFollower();
  f.attach(element);
  return { fake, element, f };
}

check('twenty ticks of tiny drift produce ZERO seeks', () => {
  // The failure this whole design exists to prevent.
  const { fake, f } = follower();
  fake.paused = false;
  fake.currentTime = 10;
  for (let i = 0; i < 20; i++) {
    fake.currentTime += 0.05;
    f.follow(10 + (i + 1) * 0.05 + 0.004, true);
  }
  eq(fake.seeks, 0, `no seeks, got ${fake.seeks}`);
});

check('a locate seeks once and does not thrash', () => {
  const { fake, f } = follower();
  fake.paused = false;
  fake.currentTime = 10;
  f.follow(80, true);
  eq(fake.seeks, 1, 'one seek');
  close(fake.currentTime, 80, 'to the right place');
  // The element reports `seeking` until it lands; following again must wait.
  fake.seeking = true;
  f.follow(80.02, true);
  f.follow(80.04, true);
  eq(fake.seeks, 1, 'and no more while it is still seeking');
  fake.seeking = false;
});

check('outside the picture the element is paused, not parked on a frame', () => {
  const { fake, f } = follower();
  fake.paused = false;
  f.follow(null, true);
  eq(fake.paused, true, 'paused');
  eq(fake.playbackRate, 1, 'and back to normal speed');
  eq(f.decision, null, 'with nothing to report');
});

check('the follower starts and stops with the transport', () => {
  const { fake, f } = follower();
  f.follow(5, true);
  eq(fake.plays, 1, 'play follows play');
  f.follow(5, false);
  eq(fake.pauses >= 1, true, 'and pause follows stop');
});

check('locate goes straight there, ladder or no ladder', () => {
  const { fake, f } = follower();
  fake.currentTime = 10;
  f.locate(10.01);   // inside the dead band, but this is a user locate
  close(fake.currentTime, 10.01, 'moved anyway');
  eq(fake.seeks, 1, 'exactly once');
});

check('a detached follower is inert rather than a null crash', () => {
  const f = new VideoFollower();
  f.follow(10, true);
  f.locate(10);
  eq(f.decision, null, 'nothing to report and nothing thrown');
  const { fake, f: f2 } = follower();
  f2.detach();
  f2.follow(50, true);
  eq(fake.seeks, 0, 'and a detached one stops driving its old element');
});

// ── Report ────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Video: timecode · placement · sync ladder ===');
for (const r of results) {
  console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
