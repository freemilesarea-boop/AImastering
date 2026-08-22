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
import { videoSpan } from '../src/renderer/daw/model/video.js';
import {
  describeVideoPosition, moveVideoTo, nudgeVideoFrames, nudgeVideoTrim,
  resetVideoPosition, spotVideoTimecode, spotVideoToPlayhead, trimVideoHead,
  videoOffsetFrames,
} from '../src/renderer/daw/edit/video-move.js';
import {
  addFile, addTrack, createClip, createSession, createTrack, findTrack, trackClips, updateClips,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import {
  alignVideoAudio, describeVideoAudio, hasVideoAudio, importVideoAudio,
  videoAudioOffsetSec, videoAudioTracks,
} from '../src/renderer/daw/edit/video-audio.js';
import type { DawSession } from '../src/renderer/daw/model/types.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
/**
 * Every check, sync or async, and the summary waits for all of them.
 *
 * The synchronous-only version of this silently PASSED every async test: an
 * `async` function returns a promise, the try block sees no throw, and the
 * rejection surfaced after the summary had already printed a clean score.
 * Anything that can pass without running is worse than no test at all.
 */
const pending: Promise<void>[] = [];
function check(name: string, fn: () => void | Promise<void>): void {
  const done = (e?: unknown): void => {
    if (e === undefined) results.push({ name, pass: true, detail: '' });
    else results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
  };
  try {
    const result = fn();
    if (result instanceof Promise) pending.push(result.then(() => done(), (e: unknown) => done(e)));
    else done();
  } catch (e) { done(e); }
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

// ── Moving the picture ────────────────────────────────────────────────────────

const placed = (over: Partial<VideoRef> = {}): DawSession =>
  withVideo(createSession('score', 48_000), reel(over));

check('a trimmed head does not play the frames that were trimmed off', () => {
  // The bound that matters is the TRIM, not zero.  Reading from zero shows
  // the part of the reel the user explicitly cut, which looks exactly like
  // the picture being out of sync.
  const v = reel({ startSec: 10, offsetSec: 5, durationSec: 30 });
  eq(videoTimeAt(v, 9.9), null, 'nothing before the picture starts');
  close(videoTimeAt(v, 10)!, 5, 'and the first thing shown is the trim point');
  const span = videoSpan(v);
  close(span.startSec, 10, 'the span starts where it sits');
  close(span.endSec, 35, 'and is shorter by the trim');
});

check('the picture lands on a frame, never between two', () => {
  // A picture at an arbitrary second shows the wrong image for up to a
  // frame, and every hit point measured from it inherits the error.
  const frame = frameSec(FPS_2398);
  const moved = moveVideoTo(placed(), 1.7);
  assert(moved.applied, 'moved');
  const at = videoOf(moved.session)!.startSec;
  close(at / frame, Math.round(at / frame), 'a whole number of frames', 1e-9);
  close(at, Math.round(1.7 * FPS_2398) / FPS_2398, 'the nearest one to what was asked');
  assert(Math.abs(at - 1.7) < frame, 'and within half a frame of it');
});

check('a nudge is a frame, and it accumulates exactly', () => {
  let s = placed();
  for (let i = 0; i < 24; i++) s = nudgeVideoFrames(s, 1).session;
  eq(videoOffsetFrames(s), 24, 'twenty-four nudges are twenty-four frames');
  close(videoOf(s)!.startSec, 24 / FPS_2398, 'and the seconds follow the rate', 1e-9);
  for (let i = 0; i < 24; i++) s = nudgeVideoFrames(s, -1).session;
  close(videoOf(s)!.startSec, 0, 'and back is exactly back', 1e-9);
});

check('the picture cannot go before zero, and the refusal says what to do', () => {
  const r = moveVideoTo(placed({ startSec: 1 }), -2);
  eq(r.applied, false, 'refused');
  assert(r.reason?.includes('헤드 트림'), `and points at the trim: ${r.reason}`);
  close(videoOf(r.session)!.startSec, 1, 'and nothing moved');
});

check('trimming changes WHAT plays at the start, not WHERE the start is', () => {
  const before = placed({ startSec: 12 });
  const after = trimVideoHead(before, 3);
  assert(after.applied, 'trimmed');
  const v = videoOf(after.session)!;
  close(v.startSec, 12, 'the picture did not move');
  // 3 seconds is 71.93 frames at 23.976, so the trim lands on frame 72 —
  // asking for a round number of seconds does not make one.
  const trim = 72 / FPS_2398;
  close(v.offsetSec, trim, 'the trim is a whole frame', 1e-9);
  close(videoTimeAt(v, 12)!, trim, 'and that is what plays at the start');
  close(videoSpan(v).endSec, 12 + 120 - trim, 'and it runs out that much earlier', 1e-9);
});

check('a trim is a whole number of frames, and cannot eat the whole file', () => {
  const frame = frameSec(FPS_2398);
  const t = trimVideoHead(placed(), 1.7);
  const off = videoOf(t.session)!.offsetSec;
  close(off / frame, Math.round(off / frame), 'on a frame', 1e-9);
  const tooMuch = trimVideoHead(placed({ durationSec: 10 }), 30);
  eq(tooMuch.applied, false, 'refused');
  assert(tooMuch.reason?.includes('파일보다'), `for the right reason: ${tooMuch.reason}`);
  let s = placed({ durationSec: 10 });
  s = nudgeVideoTrim(s, 5).session;
  eq(Math.round(videoOf(s)!.offsetSec * FPS_2398), 5, 'and nudging the trim counts frames too');
});

check('spotting solves for the placement — the number a spotting note carries', () => {
  // "The door slams at 01:02:14:07, and that is 40 seconds into the music."
  const s = placed();
  const target = parseTimecode('01:00:14:07', FPS_2398)!;
  const r = spotVideoTimecode(s, target, 40);
  assert(r.applied, `spotted: ${r.reason}`);
  const v = videoOf(r.session)!;
  // The whole point: read the timecode back at that moment and it is the one
  // that was asked for.
  eq(timecodeAt(v, 40), '01:00:14:07', 'the frame is where it was put');
});

check('spotting with a trimmed head still lands on the right frame', () => {
  const s = trimVideoHead(placed(), 6).session;
  const target = parseTimecode('01:00:30:00', FPS_2398)!;
  const r = spotVideoTimecode(s, target, 40);
  assert(r.applied, `spotted: ${r.reason}`);
  eq(timecodeAt(videoOf(r.session)!, 40), '01:00:30:00', 'the trim did not throw the maths off');
});

check('a timecode outside the reel is refused, not placed anyway', () => {
  const s = placed();
  const before = parseTimecode('00:59:00:00', FPS_2398)!;
  const r = spotVideoTimecode(s, before, 10);
  eq(r.applied, false, 'refused');
  assert(r.reason?.includes('이 픽처 안에 없습니다'), `and says why: ${r.reason}`);
});

check('spotting that would push the picture before zero is refused with the amount', () => {
  const s = placed();
  const late = parseTimecode('01:01:00:00', FPS_2398)!;
  const r = spotVideoTimecode(s, late, 1);      // 60 s of film, 1 s of timeline
  eq(r.applied, false, 'refused');
  assert(r.reason?.includes('타임라인 0 보다 앞'), `and says what is wrong: ${r.reason}`);
  close(videoOf(r.session)!.startSec, 0, 'and the picture is where it was');
});

check('the play head and the picture are moved by different verbs', () => {
  const s = spotVideoToPlayhead(placed(), 30);
  assert(s.applied, 'moved');
  close(videoOf(s.session)!.startSec, Math.round(30 * FPS_2398) / FPS_2398, 'to the play head, on a frame');
  const back = resetVideoPosition(s.session);
  close(videoOf(back.session)!.startSec, 0, 'and reset puts it at zero');
  close(videoOf(back.session)!.offsetSec, 0, 'with the trim released');
});

check('moving nothing is a no-op with no complaint, not an error', () => {
  // Frame-aligned to begin with: asking for 5.000 s would MOVE a picture
  // that is already there, because five seconds is not a frame boundary at
  // 23.976 and the snap is not optional.
  const onGrid = 120 / FPS_2398;
  const s = placed({ startSec: onGrid });
  const same = moveVideoTo(s, onGrid);
  eq(same.applied, false, 'nothing changed');
  eq(same.reason, null, 'and there was nothing to say about it');
  const none = moveVideoTo(createSession('empty', 48_000), 5);
  eq(none.applied, false, 'no picture');
  assert(none.reason?.includes('픽처가 없습니다'), `and that IS worth saying: ${none.reason}`);
});

check('the read-out is where the picture is, and what came off the front', () => {
  eq(describeVideoPosition(createSession('empty', 48_000)), '픽처 없음', 'nothing loaded');
  const s = trimVideoHead(moveVideoTo(placed(), 65).session, 4).session;
  const line = describeVideoPosition(s);
  // 65 s snaps to frame 1558, which is 64.98 s — the read-out shows where the
  // picture IS, not where it was asked to go.
  assert(line.includes('1:04.98'), `where it starts: ${line}`);
  assert(line.includes('96프레임 잘림'), `and the trim in frames: ${line}`);
});

// ── The film's own sound ──────────────────────────────────────────────────────
//
// No demuxed WAV: the audio track's file reference points AT THE FILM, and
// the existing decode path pulls its first audio stream.  So "is this the
// picture's audio" is answered by a shared path rather than by a flag — and
// that link is what makes a re-align possible after the picture is moved.

/** A decode that succeeds, standing in for the codec. */
const fakeDecode = (durationSec = 120) => ({
  decode: async () => ({ failed: [] as string[] }),
  meta: () => ({ durationSec, sampleRate: 48_000, channels: 2 }),
});

async function importedSession(over: Partial<VideoRef> = {}, durationSec = 120) {
  resetIds();
  const session = withVideo(createSession('score', 48_000), reel(over));
  const result = await importVideoAudio(session, fakeDecode(durationSec));
  return result;
}

check('the imported track plays the FILM, not a copy of it', async () => {
  const result = await importedSession();
  assert(result.trackId, `imported: ${result.reason}`);
  const track = findTrack(result.session, result.trackId!)!;
  const clip = trackClips(track)[0]!;
  const file = result.session.files.find((f) => f.id === clip.fileId)!;
  eq(file.path, '/v/reel.mov', 'the file reference IS the video file');
  eq(result.session.files.length, 1, 'and there is only one of it');
  assert(hasVideoAudio(result.session), 'which is how it is recognised later');
  eq(videoAudioTracks(result.session).length, 1, 'one such track');
});

check('the audio lands where the picture is, trimmed the same way', async () => {
  const result = await importedSession({ startSec: 12, offsetSec: 3 });
  const clip = trackClips(findTrack(result.session, result.trackId!)!)[0]!;
  close(clip.startSec, 12, 'starts with the picture', 1e-9);
  close(clip.offsetSec, 3, 'and as far into the file as the picture is', 1e-9);
  close(clip.durationSec, 117, 'running to the end of the audio', 1e-9);
  close(videoAudioOffsetSec(result.session) ?? -1, 0, 'so there is no drift', 1e-9);
});

check('a film with no readable audio says so instead of making an empty track', async () => {
  resetIds();
  const session = withVideo(createSession('score', 48_000), reel());
  const result = await importVideoAudio(session, {
    decode: async () => ({ failed: ['/v/reel.mov'] }),
    meta: () => undefined,
  });
  eq(result.trackId, null, 'nothing imported');
  assert(result.reason?.includes('꺼내지 못했습니다'), `and says why: ${result.reason}`);
  eq(result.session.tracks.length, 1, 'no track was left behind');
});

check('audio of zero length is refused too', async () => {
  resetIds();
  const session = withVideo(createSession('score', 48_000), reel());
  const result = await importVideoAudio(session, {
    decode: async () => ({ failed: [] }),
    meta: () => ({ durationSec: 0, sampleRate: 48_000, channels: 2 }),
  });
  eq(result.trackId, null, 'nothing imported');
  assert(result.reason?.includes('길이가 0'), `named: ${result.reason}`);
});

check('importing twice does not give you the dialogue twice', async () => {
  const first = await importedSession();
  const again = await importVideoAudio(first.session, fakeDecode());
  eq(again.trackId, null, 'refused');
  assert(again.reason?.includes('이미'), `and says why: ${again.reason}`);
  eq(videoAudioTracks(again.session).length, 1, 'still one');
  // Unless it is asked for deliberately.
  const forced = await importVideoAudio(first.session, { ...fakeDecode(), force: true });
  assert(forced.trackId, 'forced through');
  eq(videoAudioTracks(forced.session).length, 2, 'two tracks now');
});

check('with no picture there is nothing to import', async () => {
  const result = await importVideoAudio(createSession('empty', 48_000), fakeDecode());
  eq(result.trackId, null, 'nothing');
  assert(result.reason?.includes('픽처가 없습니다'), `and says so: ${result.reason}`);
});

// ── Drift, and putting it back ────────────────────────────────────────────────

check('moving the picture leaves the audio behind — visibly', async () => {
  const imported = await importedSession();
  const moved = moveVideoTo(imported.session, 8);
  assert(moved.applied, 'the picture moved');
  const drift = videoAudioOffsetSec(moved.session)!;
  // The audio is now EARLY relative to the picture by however far it moved.
  close(drift, -videoOf(moved.session)!.startSec, 'and the drift is exactly that far', 1e-9);
  assert(describeVideoAudio(moved.session).includes('빠름'), describeVideoAudio(moved.session));
});

check('one button puts it back under the picture', async () => {
  const imported = await importedSession();
  const moved = moveVideoTo(imported.session, 8).session;
  const aligned = alignVideoAudio(moved);
  eq(aligned.moved, 1, 'one clip moved');
  eq(aligned.reason, null, 'no complaint');
  close(videoAudioOffsetSec(aligned.session) ?? -1, 0, 'and the drift is gone', 1e-9);
  const clip = trackClips(videoAudioTracks(aligned.session)[0]!)[0]!;
  close(clip.startSec, videoOf(aligned.session)!.startSec, 'sitting with the picture', 1e-9);
  // Already aligned: nothing to do, and it says nothing.
  eq(alignVideoAudio(aligned.session).moved, 0, 'a second press does nothing');
});

check('a trimmed picture takes its audio trim with it', async () => {
  const imported = await importedSession();
  const trimmed = trimVideoHead(imported.session, 4).session;
  const aligned = alignVideoAudio(trimmed);
  const clip = trackClips(videoAudioTracks(aligned.session)[0]!)[0]!;
  const video = videoOf(aligned.session)!;
  close(clip.offsetSec, video.offsetSec, 'the same frames came off both', 1e-9);
  close(clip.startSec, video.startSec, 'and it did not move', 1e-9);
});

check('audio that has been EDITED is not silently reassembled', async () => {
  // Split into two clips means somebody made a decision.  A re-align button
  // that put them both back at the picture would delete that decision, so it
  // refuses and names the track instead.
  const imported = await importedSession();
  const trackId = imported.trackId!;
  const split = updateClips(imported.session, trackId, (clips) => {
    const c = clips[0]!;
    return [
      { ...c, durationSec: 30 },
      createClip(c.fileId, 'tail', { startSec: 40, offsetSec: 30, durationSec: 30 }),
    ];
  });
  const result = alignVideoAudio(split);
  eq(result.moved, 0, 'nothing was moved');
  assert(result.reason?.includes('여러 클립'), `and it says why: ${result.reason}`);
  eq(result.session, split, 'the session is untouched');
});

check('a session with no picture audio has nothing to align or describe', () => {
  resetIds();
  const bare = withVideo(createSession('score', 48_000), reel());
  eq(hasVideoAudio(bare), false, 'nothing imported');
  eq(videoAudioOffsetSec(bare), null, 'no drift to report');
  eq(describeVideoAudio(bare), '영상 오디오 없음', 'and the read-out says so');
  eq(alignVideoAudio(bare).reason, '영상 오디오 트랙이 없습니다', 'aligning refuses');
});

check('an ordinary audio track is not mistaken for the film’s', async () => {
  const imported = await importedSession();
  let s = addFile(imported.session, {
    id: 'other', path: '/music/gtr.wav', name: 'gtr',
    durationSec: 10, sampleRate: 48_000, channels: 2,
  });
  const gtr = createTrack('Gtr', 'audio');
  s = addTrack(s, gtr);
  s = updateClips(s, gtr.id, () => [createClip('other', 'gtr', { startSec: 0, durationSec: 10 })]);
  eq(videoAudioTracks(s).length, 1, 'still just the one');
  eq(videoAudioTracks(s)[0]!.id, imported.trackId, 'and it is the right one');
});

async function report(): Promise<void> {
  await Promise.all(pending);

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n=== Video: timecode · placement · sync ladder · 영상 오디오 ===');
  for (const r of results) {
    console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  if (failed > 0) process.exit(1);
}

void report();
