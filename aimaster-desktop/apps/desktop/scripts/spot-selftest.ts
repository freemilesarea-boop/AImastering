/**
 * spot-selftest — typing a position in, in four languages.
 *
 * Spot mode was a selectable edit mode that did nothing: 'grid' drove
 * snapping, 'shuffle' drove ripple, and 'spot' fell through to the same free
 * drag as 'slip'.  What it means is "stop dragging, say where it goes", and
 * "where" gets said in whichever units the job is being talked about in.
 *
 * Almost everything here is conversion, and conversion is where this kind of
 * feature fails silently:
 *
 *   • A reel starts at 01:00:00:00, so a spotting note is an hour off unless
 *     the picture's own clock is honoured.
 *   • A beat in this codebase is a quarter note, but bars|beats counts in
 *     the SIGNATURE's unit — 6/8 has six beats and three quarter notes to a
 *     bar, and converting without the meter lands every compound-time
 *     position in the wrong place.
 *   • A mistyped position must come back as null, never as zero.  Zero is a
 *     legal position, so nothing looks wrong until the cue plays.
 *
 * Run: pnpm --filter @aimaster/desktop test:spot
 */

import {
  DEFAULT_FPS, TIME_FORMATS, barBeatToBeat, describeAllFormats, formatHint,
  formatLabel, formatPosition, parsePosition,
  type SpotContext, type TimeFormat,
} from '../src/renderer/daw/model/spot-time.js';
import {
  addMeterEvent, addTempoEvent, barBeatAt, beatToSec, defaultTempoMap, secToBeat,
} from '../src/renderer/daw/model/tempo-map.js';
import type { TempoMap } from '../src/renderer/daw/model/tempo-map.js';
import { parseTimecode } from '../src/renderer/daw/model/video.js';
import {
  anchorSec, describeDelta, spotClip, spotDeltaSec, spotProblem,
} from '../src/renderer/daw/edit/spot-actions.js';
import {
  addFile, addTrack, createClip, createSession, createTrack, findTrack, trackClips,
  updateClips,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { DawSession } from '../src/renderer/daw/model/types.js';

const results: { name: string; pass: boolean }[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true }); console.log(`[PASS] ${name}`); }
  catch (err) {
    results.push({ name, pass: false });
    console.log(`[FAIL] ${name} — ${err instanceof Error ? err.message : String(err)}`);
  }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function eq(a: unknown, b: unknown, m: string): void {
  if (a !== b) throw new Error(`${m} — got ${String(a)}, want ${String(b)}`);
}
function close(a: number, b: number, m: string, tol = 1e-6): void {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${m} — got ${a}, want ${b} ±${tol}`);
}

const FPS_2398 = 24000 / 1001;

function context(over: Partial<SpotContext> = {}): SpotContext {
  return {
    sampleRate: 48_000,
    tempoMap: defaultTempoMap(120, [4, 4]),
    fps: FPS_2398,
    dropFrame: false,
    timecodeOffsetSec: 0,
    ...over,
  };
}

// ── Round trips ───────────────────────────────────────────────────────────────

check('every format reads back what it wrote', () => {
  const ctx = context();
  for (const format of TIME_FORMATS) {
    for (const sec of [0, 1.5, 12.345, 63.999, 600]) {
      const text = formatPosition(sec, format, ctx);
      const back = parsePosition(text, format, ctx);
      assert(back !== null, `${format} parsed back "${text}"`);
      // Timecode and bars quantise; seconds and samples do not.
      const tolerance = format === 'timecode' ? 1 / FPS_2398
        : format === 'barsBeats' ? 60 / 120 / 960 * 2
        : format === 'minSec' ? 0.001 : 1 / 48_000;
      close(back!, sec, `${format} round trip of ${sec}`, tolerance);
    }
  }
});

check('samples are exact — that is the whole reason they are offered', () => {
  const ctx = context();
  eq(formatPosition(1, 'samples', ctx), '48000', 'one second');
  close(parsePosition('48000', 'samples', ctx)!, 1, 'and back', 0);
  close(parsePosition('1', 'samples', ctx)!, 1 / 48_000, 'a single sample', 0);
  // Typed with the separators people use.
  close(parsePosition('4,032,000', 'samples', ctx)!, 84, 'commas are tolerated', 0);
});

// ── Timecode against the picture's own clock ──────────────────────────────────

check('a reel starting at one hour spots against the burn-in, not the session', () => {
  // The picture sits at timeline 0 and its first frame reads 01:00:00:00.
  const offset = parseTimecode('01:00:00:00', FPS_2398)!;
  const ctx = context({ timecodeOffsetSec: offset });
  eq(formatPosition(0, 'timecode', ctx), '01:00:00:00', 'timeline zero reads one hour');
  const note = parseTimecode('01:00:30:00', FPS_2398)!;
  close(parsePosition('01:00:30:00', 'timecode', ctx)!, note - offset, 'and a note converts back', 1e-9);
  close(parsePosition('01:00:30:00', 'timecode', ctx)!, 30.03, 'thirty seconds of film', 0.05);
});

check('without a picture the rate is stated, not guessed silently', () => {
  const ctx = context({ fps: DEFAULT_FPS });
  eq(DEFAULT_FPS, 25, 'the fallback is 25');
  eq(formatPosition(1, 'timecode', ctx), '00:00:01:00', 'one second is one second');
  eq(formatPosition(0.04, 'timecode', ctx), '00:00:00:01', 'and a frame is 40 ms');
});

// ── Bars and beats, through the tempo map ─────────────────────────────────────

check('bar|beat|tick is the exact inverse of the read-out', () => {
  const map = defaultTempoMap(120, [4, 4]);
  for (const beat of [0, 1, 3.5, 16, 41.25]) {
    const at = barBeatAt(map, beat);
    const back = barBeatToBeat(map, at.bar, at.beat, at.tick);
    close(back, beat, `beat ${beat} through ${at.bar}|${at.beat}|${at.tick}`, 1 / 960 + 1e-9);
  }
});

check('a compound signature counts in ITS beats, not in quarter notes', () => {
  // 6/8: six beats to a bar, three quarter notes to a bar.  Converting
  // without the meter puts beat 4 a whole bar out.
  const map = addMeterEvent(defaultTempoMap(120, [4, 4]), 2, 6, 8);
  const ctx = context({ tempoMap: map });
  const barTwo = barBeatToBeat(map, 2, 1, 0);
  close(barTwo, 4, 'bar 2 still starts after four quarter notes', 1e-9);
  const beatFour = barBeatToBeat(map, 2, 4, 0);
  // Three eighths into a 6/8 bar is one and a half quarter notes.
  close(beatFour - barTwo, 1.5, 'beat 4 of 6/8 is an eighth-note count', 1e-9);
  // And the round trip agrees.
  const at = barBeatAt(map, beatFour);
  eq(`${at.bar}|${at.beat}`, '2|4', 'reads back as 2|4');
  assert(formatPosition(beatToSec(map, beatFour), 'barsBeats', ctx).startsWith('2|4'),
    formatPosition(beatToSec(map, beatFour), 'barsBeats', ctx));
});

check('a tempo change moves the seconds but not the bar', () => {
  const map: TempoMap = addTempoEvent(defaultTempoMap(120, [4, 4]), 8, 60);
  const ctx = context({ tempoMap: map });
  // Bar 3 is beat 8, which is where the tempo halves.
  const atBarThree = parsePosition('3|1|000', 'barsBeats', ctx)!;
  close(atBarThree, beatToSec(map, 8), 'bar 3 is where the map says', 1e-9);
  // Bar 4 is four beats later, at 60 BPM — four seconds, not two.
  const atBarFour = parsePosition('4|1|000', 'barsBeats', ctx)!;
  close(atBarFour - atBarThree, 4, 'a bar at 60 BPM is four seconds', 1e-6);
});

check('bars are forgiving about separators and strict about nonsense', () => {
  const ctx = context();
  const want = parsePosition('5|3|480', 'barsBeats', ctx);
  assert(want !== null, 'the canonical form');
  close(parsePosition('5.3.480', 'barsBeats', ctx)!, want!, 'dots too', 1e-9);
  close(parsePosition('5 3 480', 'barsBeats', ctx)!, want!, 'and spaces', 1e-9);
  close(parsePosition('5|3', 'barsBeats', ctx)!, parsePosition('5|3|0', 'barsBeats', ctx)!,
    'a missing tick is zero', 1e-9);
  eq(parsePosition('0|1|0', 'barsBeats', ctx), null, 'there is no bar zero');
  eq(parsePosition('5|3|960', 'barsBeats', ctx), null, 'a tick is 0…959');
  eq(parsePosition('banana', 'barsBeats', ctx), null, 'and words are not positions');
});

// ── Refusing ──────────────────────────────────────────────────────────────────

check('nonsense is null in every format — never zero', () => {
  const ctx = context();
  // Zero is a legal position, so returning it for a typo hides the mistake
  // until the cue plays.
  for (const format of TIME_FORMATS) {
    eq(parsePosition('', format, ctx), null, `${format}: empty`);
    eq(parsePosition('   ', format, ctx), null, `${format}: spaces`);
    eq(parsePosition('nope', format, ctx), null, `${format}: a word`);
  }
  eq(parsePosition('1:2:3:4:5', 'timecode', ctx), null, 'too many timecode fields');
  eq(parsePosition('1:2:3:4', 'minSec', ctx), null, 'too many min:sec fields');
  eq(parsePosition('-5', 'samples', ctx), null, 'a negative sample count');
  eq(parsePosition('1.5', 'samples', ctx), null, 'half a sample');
});

check('min:sec accepts the three ways people write it', () => {
  const ctx = context();
  close(parsePosition('90', 'minSec', ctx)!, 90, 'bare seconds', 1e-9);
  close(parsePosition('1:30', 'minSec', ctx)!, 90, 'minutes and seconds', 1e-9);
  close(parsePosition('0:01:30', 'minSec', ctx)!, 90, 'and hours too', 1e-9);
  close(parsePosition('1:23.456', 'minSec', ctx)!, 83.456, 'with milliseconds', 1e-9);
});

// ── Spotting a clip ───────────────────────────────────────────────────────────

function session(): { session: DawSession; trackId: string; clipId: string } {
  resetIds();
  let s = createSession('spot', 48_000);
  const track = createTrack('SFX', 'audio');
  s = addTrack(s, track);
  s = addFile(s, {
    id: 'f1', path: '/v/gun.wav', name: 'gun.wav',
    durationSec: 10, sampleRate: 48_000, channels: 2,
  });
  const clip = createClip('f1', 'gunshot', { startSec: 5, offsetSec: 0, durationSec: 2 });
  s = updateClips(s, track.id, () => [clip]);
  return { session: s, trackId: track.id, clipId: clip.id };
}

const clipOf = (s: DawSession, trackId: string) => trackClips(findTrack(s, trackId)!)[0]!;

check('spotting by the start puts the start there', () => {
  const { session: s, trackId, clipId } = session();
  const result = spotClip(s, trackId, clipId, 12.5, 'start');
  assert(result.applied, `applied: ${result.reason}`);
  close(clipOf(result.session, trackId).startSec, 12.5, 'exactly there', 1e-9);
  close(result.startSec, 12.5, 'and it says so', 1e-9);
});

check('spotting by the END is a different sum, and the one a hit point needs', () => {
  // "The gunshot lands at 12.5" usually means the sound ENDS there.
  const { session: s, trackId, clipId } = session();
  const result = spotClip(s, trackId, clipId, 12.5, 'end');
  assert(result.applied, `applied: ${result.reason}`);
  close(clipOf(result.session, trackId).startSec, 10.5, 'the start is the length before it', 1e-9);
  close(anchorSec(clipOf(result.session, trackId), 'end'), 12.5, 'and the end is on the mark', 1e-9);
});

check('a spot that would land before zero is refused with the amount', () => {
  const { session: s, trackId, clipId } = session();
  const result = spotClip(s, trackId, clipId, 1, 'end');   // 2 s clip, ends at 1
  eq(result.applied, false, 'refused');
  assert(result.reason?.includes('1.000초'), `naming the shortfall: ${result.reason}`);
  close(clipOf(result.session, trackId).startSec, 5, 'and nothing moved', 1e-9);
});

check('the refusal is readable before the button is pressed, not after', () => {
  const { session: s, trackId } = session();
  const clip = clipOf(s, trackId);              // 2 s long, starts at 5 s
  // The dialog asks on every keystroke, so what it shows has to be the same
  // answer the commit would give — otherwise it invites a click it will
  // then reject.
  eq(spotProblem(clip, 1, 'end')?.includes('1.000초'), true,
    `the same shortfall the commit reports: ${spotProblem(clip, 1, 'end')}`);
  eq(spotClip(s, trackId, clip.id, 1, 'end').reason, spotProblem(clip, 1, 'end'),
    'word for word the same reason');
  eq(spotProblem(clip, 1, 'start'), null, 'a position that fits has no complaint');
  eq(spotProblem(clip, 0, 'start'), null, 'zero itself is a position');
  eq(spotProblem(clip, Number.NaN, 'start') !== null, true, 'and a non-number is one too');
});

check('spotting where it already is changes nothing, and says nothing', () => {
  const { session: s, trackId, clipId } = session();
  const result = spotClip(s, trackId, clipId, 5, 'start');
  eq(result.applied, false, 'no move');
  eq(result.reason, null, 'and no complaint');
  eq(result.session, s, 'the same session object');
});

check('a clip that is not there is refused rather than crashing', () => {
  const { session: s, trackId } = session();
  const result = spotClip(s, trackId, 'nope', 1, 'start');
  eq(result.applied, false, 'refused');
  assert(result.reason?.includes('찾을 수 없습니다'), `named: ${result.reason}`);
  eq(spotClip(s, trackId, 'nope', Number.NaN, 'start').applied, false, 'and so is NaN');
});

check('the move is reported before it happens, in the unit it is felt in', () => {
  const { session: s, trackId } = session();
  const clip = clipOf(s, trackId);
  close(spotDeltaSec(clip, 5.412, 'start'), 0.412, 'the delta', 1e-9);
  eq(describeDelta(0.412), '+412 ms', 'milliseconds when it is small');
  eq(describeDelta(-0.412), '−412 ms', 'signed');
  eq(describeDelta(4.5), '+4.500 초', 'and seconds when it is not');
  eq(describeDelta(0), '제자리', 'and nothing when it is nothing');
});

check('the dialog can show one position in all four languages at once', () => {
  const ctx = context({ timecodeOffsetSec: parseTimecode('01:00:00:00', FPS_2398)! });
  const line = describeAllFormats(30, ctx);
  for (const format of TIME_FORMATS) {
    assert(line.includes(formatLabel(format)), `${formatLabel(format)} is in "${line}"`);
  }
  // Thirty SECONDS is not thirty timecode-seconds at 23.976: it is
  // 29 seconds and 23 frames, and the read-out says the true thing.
  assert(line.includes('01:00:29:23'), `the picture's clock: ${line}`);
  assert(line.includes('1440000'), `and the sample count: ${line}`);
});

check('every format offers an example of itself', () => {
  const ctx = context();
  for (const format of TIME_FORMATS) {
    const hint = formatHint(format);
    assert(parsePosition(hint, format, ctx) !== null,
      `the hint for ${format} ("${hint}") is not parseable by ${format}`);
  }
});

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed${passed === results.length ? '' : `, ${results.length - passed} FAILED`}`);
if (passed !== results.length) process.exit(1);
