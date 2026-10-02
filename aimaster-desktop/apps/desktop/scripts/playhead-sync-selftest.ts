/**
 * playhead-sync-selftest.ts — the cursor and the sound, on the same clock.
 *
 * Reported as "the sound does not line up with the waveform — a very slight
 * latency".  It is not the audio that is late; it is the CURSOR that is
 * early, and by a fixed amount.
 *
 * `AudioContext.currentTime` is the WRITE head — the moment the graph is
 * filling into the output buffer.  What reaches the speaker right now was
 * written `outputLatency` seconds ago.  The play position was taken straight
 * off `currentTime`, so the cursor ran ahead of the music by exactly that,
 * and the waveform under it had already been heard.  Small, constant, and
 * precisely the kind of wrong that reads as the app not being in time with
 * itself.
 *
 * The repository already computed this number.  `input-latency.ts` reads
 * `baseLatency + outputLatency` off the live context to put recorded takes
 * back where they were played — and playback never asked it anything.
 *
 * TWO CLOCKS, and keeping them apart is the whole design:
 *
 *   · the WRITE clock schedules.  The look-ahead window, the loop's pass walk,
 *     the punch-out and the click all decide what to hand the audio thread
 *     NEXT,
 *     so they must reason about the moment being written.  Moving them would
 *     schedule everything late by the latency — the bug, facing the other way.
 *   · the AUDIBLE clock draws.  Only the cursor.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  playbackLatency, reportedLatency, MAX_LATENCY_SEC,
} from '../src/renderer/daw/model/input-latency.js';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed += 1; console.log(`[PASS] ${name}`); }
  else    { failed += 1; console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

function read(rel: string): string {
  return fs.readFileSync(path.join(DESKTOP, rel), 'utf8');
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
    .join('\n');
}

// ── 1. The number ───────────────────────────────────────────────────────────

check('a reported output latency is what the cursor is moved by',
  near(playbackLatency({ outputLatency: 0.021 }), 0.021));

// The distinction from the recording number, which is the reason this is its
// own function rather than a second caller of `reportedLatency`.  A take has
// to move by everything between the player and the file; the cursor only by
// what sits between the graph's output and the air.  Adding baseLatency here
// would overshoot and put the cursor BEHIND the sound instead.
check('baseLatency is NOT added — that would overshoot the other way',
  near(playbackLatency({ baseLatency: 0.01, outputLatency: 0.02 }), 0.02),
  `got ${playbackLatency({ baseLatency: 0.01, outputLatency: 0.02 })}`);

check('the recording number still sums both, and the two differ',
  near(reportedLatency({ baseLatency: 0.01, outputLatency: 0.02 }), 0.03)
  && reportedLatency({ baseLatency: 0.01, outputLatency: 0.02 })
     !== playbackLatency({ baseLatency: 0.01, outputLatency: 0.02 }));

// A browser that says nothing leaves the cursor no worse than it was.
check('a context that reports nothing gives no correction',
  near(playbackLatency({}), 0) && near(playbackLatency(null), 0)
  && near(playbackLatency(undefined), 0));

check('an offline context, which has no speakers, gets zero',
  near(playbackLatency({ baseLatency: 0.005 }), 0));

check('a nonsense latency cannot drag the cursor somewhere it never was',
  near(playbackLatency({ outputLatency: 99 }), MAX_LATENCY_SEC));

check('a negative reading is refused rather than pushing the cursor forward',
  near(playbackLatency({ outputLatency: -0.05 }), 0));

check('NaN is refused',
  near(playbackLatency({ outputLatency: Number.NaN }), 0));

// ── 2. Two clocks, kept apart ───────────────────────────────────────────────

const player  = stripComments(read('src/renderer/daw/engine/clip-player.ts'));
const runtime = stripComments(read('src/renderer/daw/engine/daw-runtime.ts'));

check('the player offers an audible clock as well as a write clock',
  /audiblePosition\s*\(\s*\)/.test(player) && /\n  position\s*\(\s*\)/.test(player));

check('the audible clock is the write clock minus the output latency',
  /audiblePosition[\s\S]{0,500}?this\.position\s*\(\s*\)\s*-\s*playbackLatency\s*\(/.test(player));

// It must not go negative at the very top of a song, where the correction is
// larger than the position.
check('the audible clock cannot report a position before the start',
  /audiblePosition[\s\S]{0,500}?Math\.max\s*\(\s*0\s*,/.test(player));

check('the cursor is fed the audible clock',
  /onPosition\?\.\(\s*player\.audiblePosition\s*\(\s*\)\s*\)/.test(runtime));

// The half that is easy to get wrong: moving the scheduler onto the audible
// clock would schedule everything late by the latency.
//
// What this pins is the CLOCK, not the distance.  It used to require the
// literal `player.tick(session, LOOKAHEAD_SEC)`, and that broke the day the
// transport started reaching a growing distance instead of a fixed one —
// `start` schedules a short window so the first sound is not waiting on a
// second of work, and the rest is filled in steps (see `FIRST_WINDOW_SEC`).
// The distance is still bounded by LOOKAHEAD_SEC; what must never happen is
// an audible position being handed to the scheduler.  Which clock the
// window planner itself reads is held by 'the click still rides the write
// clock' below.
check('the scheduler still runs on the write clock',
  /player\.tick\(session, (?:LOOKAHEAD_SEC|this\.reachSec)\)/.test(runtime)
  && /Math\.min\(LOOKAHEAD_SEC,/.test(runtime)
  && !/player\.tick\([^)]*audiblePosition/.test(runtime));

// Anchored past the nested call in the first argument — `[^)]*` stops at the
// closing paren of `tempoMapOf(session)` and never reaches the argument this
// is actually about.
// The click used to be handed `pos` and a lookahead and work out its own
// window.  It is now handed the windows the clip player just placed material
// in, which is a stronger form of the same requirement: not merely the same
// CLOCK as the clips but the same windows and the same per-pass origins.  What
// must not come back is the click reading the audible clock — that would
// schedule every click late by the output latency.  Measured in the app with
// notes on beats the click also marks: ten of ten notes share their moment
// with a click.
check('the click still rides the write clock, so a beat and a kick agree',
  /metronome\.tickWindows\(tempoMapOf\(session\),\s*player\.lastWindows\)/.test(runtime)
  && /planWindows\([^)]*\)[^{]*\{\s*const now = this\.position\(\)/.test(player)
  && !/planWindows[\s\S]{0,600}?audiblePosition/.test(player));

// ── The other half ─────────────────────────────────────────────────────────
//
// Correcting the latency alone would have been a fix that measures worse.
// The cursor was ALSO up to TICK_MS stale, because scheduling and drawing
// shared one 50 ms timer — and that error points the other way, so removing
// only the latency leaves the staleness uncancelled.

check('the cursor is driven by frames, not by the scheduling tick',
  /startPositionFrames\s*\(\s*\)/.test(runtime)
  && /requestAnimationFrame\s*\(/.test(runtime));

check('the cursor is reported from the frame loop and nowhere else',
  (runtime.match(/onPosition\?\.\(\s*player\.audiblePosition/g) ?? []).length === 1);

// `pos` is the write clock.  Reporting it to the cursor from inside the
// interval is the state this started in, and it must not come back.
check('the scheduling tick no longer reports the write clock to the cursor',
  !/onPosition\?\.\(\s*pos\s*\)/.test(runtime));

// A loop that is never cancelled keeps the window awake and keeps calling
// into a stopped transport.
check('the frame loop is stopped with the transport',
  /stopPositionFrames\s*\(\s*\)/.test(runtime)
  && /cancelAnimationFrame\s*\(/.test(runtime)
  && /stopTicking[\s\S]{0,300}?stopPositionFrames\s*\(\s*\)/.test(runtime));

// Node and the offline render have no frames at all.
check('a host without animation frames is handled rather than assumed',
  /typeof requestAnimationFrame === 'undefined'/.test(runtime));

// A bounce is rendered offline and must be sample-identical to what was
// scheduled — the correction is a DISPLAY correction and nothing else.
check('nothing in the scheduling path was moved',
  !/scheduleWindow\([^)]*audiblePosition/.test(runtime)
  && !/scheduleAutomation\([^)]*audiblePosition/.test(runtime));

// ── 3. The sweep is looking at the real thing ──────────────────────────────

check('the sources were actually read',
  player.length > 10_000 && runtime.length > 20_000,
  `${player.length}/${runtime.length}`);

check('stripComments removes comments but keeps code',
  !stripComments('// audiblePosition()\nconst x = 1;').includes('audiblePosition')
  && stripComments('// audiblePosition()\nconst x = 1;').includes('const x = 1'));

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
