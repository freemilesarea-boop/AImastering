/**
 * transport-loop-selftest — does a loop repeat on time?
 *
 * The transport used to wrap by polling: every 50 ms it asked the scheduler
 * where it had got to, and when that had passed the loop end it stopped every
 * voice and started again 60 ms later.  Measured in the running app against
 * the audio clock, that loop was a constant ~99 ms too long — 1.000 s ran
 * 1.0999, 2.000 s ran 2.0997, 4.000 s ran 4.0960 — which is the restart lead
 * plus the average of the poll, and not a rate error.  A loop that is a tenth
 * of a second long at every length drifts against the click by that much every
 * pass, so it cannot be played to.
 *
 * The scheduler wraps its own look-ahead window now, and this measures the
 * result the only way that settles it: RENDER the transport and find the notes.
 *
 * Offline and deterministic.  `ClipPlayer` takes any `BaseAudioContext`, so the
 * whole scheduler runs inside an `OfflineAudioContext` with the look-ahead set
 * to the length of the render — one `tick` then places every pass at once,
 * which is the same code path the live transport walks 50 ms at a time.
 *
 * AUDIO clips are rendered here too, and the reason is worth recording: this
 * file used to say the audio path was out of reach because priming the cache
 * "needs a decoded file and there is no seam to hand it one".  That was wrong
 * — `analyzeBuffer` IS the seam, it takes any `AudioBuffer` and the cache does
 * not care where it came from.  The cost of believing it was a real bug that
 * shipped past a green suite: the check that stops a clip being scheduled
 * twice was keyed by pass while the register was still keyed by clip alone, so
 * the two never matched and every 50 ms tick started the clip again — 229
 * overlapping copies in seven seconds, found by probing the running app.  A
 * claim that something cannot be tested has to be checked as hard as a claim
 * that it works.
 *
 * What this canNOT reach is `advancePass`, which rolls the heard origin forward
 * so `position()` reports somewhere inside the loop rather than running off
 * the end of it.  An `OfflineAudioContext` renders in one go — its clock does
 * not advance between calls — so one `tick` with a long look-ahead places every
 * pass and nothing ever observes a moving position.  Disabling `advancePass`
 * leaves this file green, which was checked rather than assumed; it is measured
 * in the running app instead, where the clock moves.
 *
 * Run:  pnpm --filter @aimaster/desktop test:transport-loop
 */

import { OfflineAudioContext } from 'node-web-audio-api';
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { MixerEngine } from '../src/renderer/daw/engine/mixer-engine.js';
import { ClipPlayer, type LoopSpan } from '../src/renderer/daw/engine/clip-player.js';
import {
  addFile, addTrack, createClip, createSession, createTrack, updateClips,
} from '../src/renderer/daw/model/session-ops.js';
import { analyzeBuffer, clearAudioCache } from '../src/renderer/daw/engine/audio-cache.js';
import { createNote } from '../src/renderer/daw/model/midi.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { Clip, DawSession } from '../src/renderer/daw/model/types.js';

const SR = 48_000;

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(cond: unknown, detail: string): void { if (!cond) throw new Error(detail); }

/**
 * A part with notes on beats 0 and 1.5 — 0 s and 0.75 s at 120 bpm.
 *
 * Uneven on purpose.  Evenly spaced notes repeat into a pattern that a loop
 * cannot be told apart from simply playing on, so a broken loop would pass.
 */
function song(beats: readonly number[] = [0, 1.5]): DawSession {
  resetIds();
  let s = createSession('loop test', SR);
  const keys = createTrack('Keys', 'instrument');
  s = addTrack(s, keys);
  s = updateClips(s, keys.id, () => [{
    ...createClip('', 'part', { startSec: 0, offsetSec: 0, durationSec: 8 }),
    kind: 'midi' as const,
    notes: beats.map((b) => createNote({
      pitch: 72, startBeat: b, durationBeat: 0.25, velocity: 0.9,
    })),
  }]);
  return s;
}

/**
 * A session with one AUDIO clip, eight seconds long, on an audio track.
 *
 * `fill` writes the samples, so a test can choose an envelope it can read
 * back: a RAMP shows where the clip was cut, a FLAT tone shows how many
 * copies of it are playing.
 */
function audioSong(fill: (t: number) => number, over: Partial<Clip> = {}): DawSession {
  resetIds();
  let s = createSession('audio loop test', SR);
  const tr = createTrack('Audio', 'audio');
  s = addTrack(s, tr);
  s = addFile(s, {
    id: 'f1', path: '/virtual/f1.wav', name: 'f1',
    durationSec: 8, sampleRate: SR, channels: 1,
  });
  s = updateClips(s, tr.id, () => [
    createClip('f1', 'audio', { startSec: 0, offsetSec: 0, durationSec: 8, ...over }),
  ]);

  // The cache is what playback reads; handing it a buffer directly is the same
  // path a decoded file takes, minus the file.
  const holder = new OfflineAudioContext(1, Math.round(SR * 8), SR);
  const buf = holder.createBuffer(1, Math.round(SR * 8), SR);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = fill(i / SR);
  analyzeBuffer('f1', buf as unknown as AudioBuffer);
  return s;
}

/**
 * Render an audio-clip session, ticking the look-ahead `ticks` times.
 *
 * The extra ticks are the point of it.  An offline context's clock does not
 * move, so every tick asks for the same window — which is exactly the
 * question "does asking twice schedule it twice?", and one tick can never
 * answer it.
 */
async function renderAudio(
  session: DawSession, loop: LoopSpan | null, seconds: number, ticks = 1,
): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.round(SR * seconds), SR);
  const engine = new MixerEngine(
    ctx as unknown as BaseAudioContext, ctx.destination as unknown as AudioNode);
  engine.sync(session);
  const player = new ClipPlayer(engine);
  player.useResidentBuffers();
  player.setLoop(loop);
  player.start(session, loop ? loop.startSec : 0, 0);
  for (let i = 0; i < ticks; i++) player.tick(session, seconds);
  return (await ctx.startRendering()).getChannelData(0);
}

/** Peak magnitude of a slice, in the units the fill wrote. */
function peakBetween(ch: Float32Array, fromSec: number, toSec: number): number {
  let top = 0;
  const a = Math.max(0, Math.round(fromSec * SR));
  const b = Math.min(ch.length, Math.round(toSec * SR));
  for (let i = a; i < b; i++) top = Math.max(top, Math.abs(ch[i]!));
  return top;
}

/** Where the notes land, in seconds, read out of the rendered audio. */
async function onsetsOf(
  session: DawSession, loop: LoopSpan | null, seconds: number,
  fromSec?: number,
): Promise<number[]> {
  const ctx = new OfflineAudioContext(2, Math.round(SR * seconds), SR);
  const engine = new MixerEngine(
    ctx as unknown as BaseAudioContext, ctx.destination as unknown as AudioNode);
  engine.sync(session);
  const player = new ClipPlayer(engine);
  player.useResidentBuffers();
  player.setLoop(loop);
  player.start(session, fromSec ?? (loop ? loop.startSec : 0), 0);
  player.tick(session, seconds);
  const ch = (await ctx.startRendering()).getChannelData(0);

  // From an ENVELOPE, not the waveform: a note is a tone that crosses zero
  // every half cycle, and a level test on samples finds the crossings.
  const win = Math.round(SR * 0.002);
  const env: number[] = [];
  for (let i = 0; i + win <= ch.length; i += win) {
    let sum = 0;
    for (let k = 0; k < win; k++) sum += ch[i + k]! * ch[i + k]!;
    env.push(Math.sqrt(sum / win));
  }
  let top = 0;
  for (const v of env) top = Math.max(top, v);
  assert(top > 1e-4, 'the render is silent — nothing was scheduled');
  const out: number[] = [];
  let armed = true;
  for (let i = 0; i < env.length; i++) {
    if (armed && env[i]! > top * 0.25) { out.push((i * win) / SR); armed = false; }
    else if (!armed && env[i]! < top * 0.05) armed = true;
  }
  return out;
}

/** The envelope reads a note one window late at most; the SPACING is exact. */
function gaps(onsets: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < onsets.length; i++) out.push(onsets[i]! - onsets[i - 1]!);
  return out;
}

async function main(): Promise<void> {
  await check('a loop repeats what is inside it, at the right places', async () => {
    const onsets = await onsetsOf(song(), { startSec: 0, endSec: 1 }, 3);
    assert(onsets.length === 6, `${onsets.length} notes in three passes: ${onsets.map((x) => x.toFixed(3)).join(' ')}`);
    const want = [0.75, 0.25, 0.75, 0.25, 0.75];
    const got = gaps(onsets);
    for (let i = 0; i < want.length; i++) {
      assert(Math.abs(got[i]! - want[i]!) < 0.005,
        `gap ${i} is ${got[i]!.toFixed(4)} s, not ${want[i]!}`);
    }
  });

  await check('every pass is exactly the length of the loop', async () => {
    // The measurement the old transport failed: it added the restart lead and
    // the poll to every pass.  Three loop lengths, because a constant error
    // and a proportional one look the same at one length.
    //
    // ONE note, on the first beat, so every onset is a pass start whatever the
    // loop length is — a two-note part hides inside a loop shorter than the
    // gap between them and turns this into a measurement of the part.
    const detail: string[] = [];
    for (const [length, seconds] of [[1, 3.2], [1.5, 4.7], [0.5, 2.1]] as [number, number][]) {
      const onsets = await onsetsOf(song([0]), { startSec: 0, endSec: length }, seconds);
      assert(onsets.length >= 3, `only ${onsets.length} passes at ${length} s`);
      for (let i = 1; i < onsets.length; i++) {
        const period = onsets[i]! - onsets[i - 1]!;
        assert(Math.abs(period - length) < 0.005,
          `a ${length} s loop ran ${period.toFixed(4)} s`);
      }
      detail.push(`${length}s ok`);
    }
    console.log(`      (loop periods exact at ${detail.join(', ')})`);
  });

  await check('a loop that starts late repeats from where it starts', async () => {
    // Beats 1 and 2.5 — 0.5 s and 1.25 s — inside a loop of [0.5, 1.5).
    const onsets = await onsetsOf(song([1, 2.5]), { startSec: 0.5, endSec: 1.5 }, 3.2);
    assert(onsets.length >= 5, `${onsets.length} notes: ${onsets.map((x) => x.toFixed(3)).join(' ')}`);
    const want = [0.75, 0.25, 0.75, 0.25];
    const got = gaps(onsets);
    for (let i = 0; i < want.length; i++) {
      assert(Math.abs(got[i]! - want[i]!) < 0.005,
        `gap ${i} is ${got[i]!.toFixed(4)} s, not ${want[i]!}`);
    }
  });

  await check('nothing outside the loop is heard, however the first window falls', async () => {
    // `start` schedules a second of material before the transport has ticked
    // once.  A loop shorter than that second has to cut it, or the first pass
    // plays material from past the locator that no later pass ever plays again.
    const onsets = await onsetsOf(song(), { startSec: 0, endSec: 0.5 }, 2.1);
    // Beats 0 and 1.5 are 0 s and 0.75 s; only the first is inside [0, 0.5).
    assert(onsets.length >= 3, `${onsets.length} notes: ${onsets.map((x) => x.toFixed(3)).join(' ')}`);
    for (let i = 1; i < onsets.length; i++) {
      const period = onsets[i]! - onsets[i - 1]!;
      assert(Math.abs(period - 0.5) < 0.005,
        `a note from outside the loop sounded: ${onsets.map((x) => x.toFixed(3)).join(' ')}`);
    }
  });

  await check('playing into a loop plays the way in, then repeats', async () => {
    // Beats 0, 3 and 4 — 0 s, 1.5 s and 2 s — with the loop at [2.0, 2.5).
    // The 1.5 s note is past the second `start` schedules on its own, so it can
    // only arrive through the look-ahead, which is the path being checked: a
    // window that begins at the locator instead of at the playhead loses it.
    const onsets = await onsetsOf(song([0, 3, 4]), { startSec: 2, endSec: 2.5 }, 3.6, 0);
    assert(onsets.length >= 5, `${onsets.length} notes: ${onsets.map((x) => x.toFixed(3)).join(' ')}`);
    const heard = onsets.slice(0, 3).map((x) => +x.toFixed(2));
    assert(Math.abs(heard[1]! - 1.5) < 0.02,
      `the way in was skipped: ${onsets.map((x) => x.toFixed(3)).join(' ')}`);
    for (let i = 3; i < onsets.length; i++) {
      const period = onsets[i]! - onsets[i - 1]!;
      assert(Math.abs(period - 0.5) < 0.005, `pass ${i} ran ${period.toFixed(4)} s`);
    }
  });

  await check('without a loop it plays through once', async () => {
    // The control: the same rig, the same part, no loop.  Without this the
    // checks above would pass on a transport that repeats everything forever.
    const onsets = await onsetsOf(song(), null, 3);
    assert(onsets.length === 2,
      `${onsets.length} notes without a loop: ${onsets.map((x) => x.toFixed(3)).join(' ')}`);
  });

  await check('an audio clip longer than the loop is cut where the loop ends', async () => {
    // A tone whose amplitude RAMPS over the eight seconds of the file, so the
    // rendered level says which part of the clip is playing.  Cut at the loop
    // end and restarted, the level saws back down every pass; left to ring on,
    // it keeps climbing and the next pass plays over it.
    const ch = await renderAudio(
      audioSong((t) => Math.sin(2 * Math.PI * 220 * t) * (0.05 + (0.9 * t) / 8)),
      { startSec: 0, endSec: 1.5 }, 4.6);
    const before = peakBetween(ch, 1.30, 1.45);
    const after = peakBetween(ch, 1.55, 1.70);
    assert(before > 1e-3, 'the render is silent — the audio clip never played');
    assert(after < before * 0.6,
      `the clip rang past the loop end: ${before.toFixed(4)} before the wrap, ${after.toFixed(4)} after`);
    // Two copies at once would read about twice the ramp; the fill never
    // exceeds 0.95, so anything past that is an overlap.
    const top = peakBetween(ch, 0, 4.6);
    assert(top < 1.05, `something is playing twice: peak ${top.toFixed(4)}`);
    console.log(`      (${before.toFixed(3)} at the loop end, ${after.toFixed(3)} after the wrap)`);
    clearAudioCache();
  });

  await check('a clip the loop cuts keeps its fade where the clip ends', async () => {
    // A flat tone with a SIX-second fade-out on an eight-second clip, inside a
    // 1.5 s loop.  The fade belongs at 2 s — where the clip's own tail starts
    // — which is past the loop end, so nothing inside the loop is faded at
    // all.  Reading the loop cut as the end of the clip instead puts the whole
    // fade inside every pass: the level walks down to nothing by 1.5 s.
    const flat = 0.3;
    const faded = audioSong(() => flat, { fadeOut: { durationSec: 6, shape: 'linear' } });
    const ch = await renderAudio(faded, { startSec: 0, endSec: 1.5 }, 2.9);
    const head = peakBetween(ch, 0.1, 0.3);
    const tail = peakBetween(ch, 1.25, 1.45);
    assert(head > 1e-3, 'the render is silent');
    assert(tail > head * 0.9,
      `the fade moved to the loop cut: ${head.toFixed(4)} at the top of the pass, ${tail.toFixed(4)} at the end of it`);
    console.log(`      (level ${head.toFixed(3)} at the top of the pass, ${tail.toFixed(3)} at the loop end)`);
    clearAudioCache();
  });

  await check('asking the look-ahead twice does not start the clip twice', async () => {
    // The plainest configuration there is: NO loop, one clip, the same window
    // requested five times.  Identical copies stacked on the same start time
    // sum coherently, so five of them read five times the level — which is
    // what the register is for, and what a key the register never writes lets
    // through on every tick.
    const flat = 0.2;
    const song = audioSong((t) => Math.sin(2 * Math.PI * 220 * t) * flat);
    const once = peakBetween(await renderAudio(song, null, 2, 1), 0.2, 1.8);
    const five = peakBetween(await renderAudio(song, null, 2, 5), 0.2, 1.8);
    // A centre pan is equal-power, so one copy reads flat/√2 per side — the
    // reference is the ONE-tick render, not the number in the fill.
    assert(once > flat * 0.5, `one tick rendered ${once.toFixed(4)}, expected about ${(flat * Math.SQRT1_2).toFixed(4)}`);
    assert(five < once * 1.2,
      `five ticks rendered ${five.toFixed(4)} against ${once.toFixed(4)} — the clip was scheduled again on every tick`);
    console.log(`      (1 tick ${once.toFixed(3)}, 5 ticks ${five.toFixed(3)})`);
    clearAudioCache();
  });

  console.log('');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  const bad = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
  if (bad) process.exit(1);
}

void main();
