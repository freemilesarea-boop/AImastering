/**
 * session-slot-selftest — a Session View slot that is held keeps playing.
 *
 * The bug this was written for: a looping MIDI slot was scheduled four passes
 * deep and left there, under a comment claiming the passes were "topped up by
 * the tick".  Nothing topped them up, and nothing could have — a slot is
 * fired by hand, with the play head parked, and the transport's 50 ms tick
 * only runs while the transport is moving.
 *
 * Measured in the running app before the fix, with a two-second part on a
 * looping slot: four passes, at 0.03, 2.03, 4.03 and 6.03 seconds, then
 * silence for the remaining twelve seconds of the measurement, while the grid
 * still showed the cell playing.  An AUDIO slot in the same grid loops inside
 * the source node and really does go on for ever, so one button had two
 * behaviours depending on what kind of clip was in the cell.
 *
 * `SlotPlayer` owns the shape of the repeat and takes its clock as an
 * argument, which is what makes this testable without an audio context at
 * all: the clock is moved by hand here, so twenty seconds of holding a slot
 * costs nothing and is exact.  Making a sound is the caller's job and is
 * stubbed — what is under test is how many passes are placed, when, and what
 * a release does to the ones already scheduled.
 *
 * Run:  pnpm --filter @aimaster/desktop test:session-slot
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SlotPlayer, type SlotVoice } from '../src/renderer/daw/engine/slot-player.js';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const TICK = 0.05;
const LOOKAHEAD = 1.0;

/** A SlotPlayer on a clock that is moved by hand, and a record of every pass. */
function rig(): {
  player: SlotPlayer;
  placed: { at: number; pass: number }[];
  stopped: { at: number; pass: number }[];
  setNow: (t: number) => void;
  schedule: (lengthSec: number) => (at: number, pass: number) => SlotVoice[];
  run: (toSec: number) => void;
} {
  let now = 0;
  const placed: { at: number; pass: number }[] = [];
  const stopped: { at: number; pass: number }[] = [];
  const player = new SlotPlayer(() => now, LOOKAHEAD);
  const schedule = (lengthSec: number) => (at: number, pass: number): SlotVoice[] => {
    placed.push({ at: +at.toFixed(6), pass });
    return [{
      endsAt: at + Math.min(lengthSec, 0.25),
      stop: (stopAt: number) => { stopped.push({ at: +stopAt.toFixed(6), pass }); },
    }];
  };
  const run = (toSec: number): void => {
    for (let t = now + TICK; t <= toSec + 1e-9; t = +(t + TICK).toFixed(6)) {
      now = t;
      player.tick();
    }
  };
  return { player, placed, stopped, setNow: (t: number) => { now = t; }, schedule, run };
}

// ── The repeat ────────────────────────────────────────────────────────────────

check('a looping slot keeps going for as long as it is held', () => {
  const r = rig();
  r.player.start('keys', { lengthSec: 2, loop: true, startAt: 0, schedule: r.schedule(2) });
  r.run(20);
  // Twenty seconds of a two-second part is ten passes, plus whatever the
  // look-ahead has already placed past the end of the watch.
  assert(r.placed.length >= 10,
    `${r.placed.length} passes in 20 s of a 2 s part — four is the bug this file exists for`);
  const last = r.placed[r.placed.length - 1]!.at;
  assert(last >= 18, `the last pass was placed at ${last} s; the slot stopped being fed`);
});

check('every pass lands exactly one part-length after the one before', () => {
  // The pass time comes from the clock, not from counting ticks: a slot held
  // through a whole take must not drift the way the transport's loop used to.
  const r = rig();
  r.player.start('keys', { lengthSec: 1.5, loop: true, startAt: 0.03, schedule: r.schedule(1.5) });
  r.run(12);
  for (let i = 0; i < r.placed.length; i += 1) {
    const want = +(0.03 + i * 1.5).toFixed(6);
    eq(r.placed[i]!.at, want, `pass ${i}`);
    eq(r.placed[i]!.pass, i, `pass ${i} is numbered in order`);
  }
  assert(r.placed.length >= 8, `${r.placed.length} passes in 12 s of a 1.5 s part`);
});

check('the first pass is placed when the slot is fired, not on the next tick', () => {
  // A slot is a button being pressed; the timer is up to 50 ms away.
  const r = rig();
  r.player.start('keys', { lengthSec: 2, loop: true, startAt: 0.03, schedule: r.schedule(2) });
  assert(r.placed.length >= 1, 'nothing was scheduled by the press itself');
  eq(r.placed[0]!.at, 0.03, 'and it is placed where the press put it');
});

check('a slot that is not looping sounds once, however long it is held', () => {
  const r = rig();
  r.player.start('one', { lengthSec: 2, loop: false, startAt: 0, schedule: r.schedule(2) });
  r.run(20);
  eq(r.placed.length, 1, 'one pass and no more');
});

// ── The release ───────────────────────────────────────────────────────────────

check('releasing a slot stops the passes already scheduled ahead', () => {
  const r = rig();
  r.player.start('keys', { lengthSec: 0.5, loop: true, startAt: 0, schedule: r.schedule(0.5) });
  r.run(3);
  const ahead = r.placed.filter((p) => p.at > 3);
  assert(ahead.length > 0, 'the look-ahead should be holding passes past the release');
  r.player.stop('keys', 3);
  for (const p of ahead) {
    assert(r.stopped.some((x) => x.pass === p.pass && x.at <= 3 + 1e-9),
      `pass ${p.pass}, scheduled for ${p.at}, was not stopped by the release`);
  }
  eq(r.player.liveKeys.length, 0, 'and the slot is no longer live');
});

check('firing a slot again replaces the one that was playing', () => {
  const r = rig();
  r.player.start('keys', { lengthSec: 1, loop: true, startAt: 0, schedule: r.schedule(1) });
  r.run(2);
  const before = r.placed.length;
  r.setNow(2);
  r.player.start('keys', { lengthSec: 1, loop: true, startAt: 2, schedule: r.schedule(1) });
  assert(r.stopped.length > 0, 'the first launch was left running');
  assert(r.placed.length > before, 'the new launch placed a pass of its own');
  // Pass numbering restarts: the look-ahead means a fresh launch may place
  // more than one straight away, but the first of them is pass 0.
  eq(r.placed[before]!.pass, 0, 'the new launch starts its own count');
  eq(r.placed[before]!.at, 2, 'from where it was fired');
});

check('a slot held for a long time does not pile up voices', () => {
  const r = rig();
  r.player.start('keys', { lengthSec: 0.25, loop: true, startAt: 0, schedule: r.schedule(0.25) });
  r.run(60);
  // Sixty seconds of a quarter-second part is 240 passes; what may be held is
  // the look-ahead's worth.
  assert(r.placed.length > 200, `only ${r.placed.length} passes — the slot stopped being fed`);
  assert(r.player.voicesOf('keys') <= 12,
    `${r.player.voicesOf('keys')} voices still on the books after 60 s`);
});

// ── The transport does not run while a slot does ──────────────────────────────

check('the runtime tops slots up on a timer of their own', () => {
  // The transport's tick only exists while the play head is moving, so a slot
  // cannot be fed from it — and no literal pass count may come back.
  const runtime = fs.readFileSync(
    path.join(DESKTOP, 'src/renderer/daw/engine/daw-runtime.ts'), 'utf8');
  assert(/startSlotTicking\s*\(\s*\)/.test(runtime), 'a slot timer is started');
  assert(/this\.slotPlayer\.tick\(\)/.test(runtime), 'and it tops the slots up');
  assert(!/passes\s*=\s*loop\s*\?\s*\d+/.test(runtime),
    'no fixed number of passes is scheduled up front any more');
  // And the docblock does not say the tick does it.  That sentence outlived
  // the code it described by one commit — the four-pass schedule was
  // replaced and the comment above it still claimed a top-up that had never
  // existed, which is the same lie in a quieter place.
  const slotDoc = runtime.slice(
    Math.max(0, runtime.indexOf('startSlot(session') - 700),
    runtime.indexOf('startSlot(session'));
  assert(!/topped up by the tick/.test(slotDoc),
    'the startSlot docblock still credits the transport tick');
  // Released slots must not leave a timer running in an idle window.
  assert(/stopSlotTicking\s*\(\s*\)/.test(runtime)
    && /liveKeys\.length === 0/.test(runtime),
    'and the timer stops once the last slot is released');
});

console.log('');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
