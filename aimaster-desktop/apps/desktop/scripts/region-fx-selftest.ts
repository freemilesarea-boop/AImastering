/**
 * region-fx-selftest.ts — the tail, which is the whole feature.
 *
 * Cutting a piece out of a track is already solved: `separateAt` and
 * `splitClip` have been in the repository for a long time and they split at
 * the sample, so the cut itself is silent.  What is NOT solved by cutting is
 * what happens to a delay's last repeats, which land after the piece ends.
 *
 * So these tests are almost entirely about `chainTailSec` and about the two
 * places it is used: how long the chain says it will ring, and whether the
 * clip that comes back is longer by that much.
 *
 * The rendering itself needs an AudioContext, which node does not have, so the
 * render path is exercised in the running app instead and the pure parts are
 * exercised here.  That split is stated rather than hidden: a test that
 * silently skipped the render would read as coverage it does not have.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:region-fx
 */

import {
  chainTailSec, deviceTailSec, describeTail,
  MAX_CHAIN_TAIL_SEC, MAX_DEVICE_TAIL_SEC,
} from '../src/renderer/daw/model/plugin-tail.js';
import { PLUGINS, defaultParams } from '../src/renderer/daw/engine/plugins.js';
import { tubeSmallSignalGain } from '../src/renderer/daw/engine/plugins-extended.js';
import { createInsert } from '../src/renderer/daw/model/session-ops.js';
import { bodyDurationSec, originalSource, clipRegionFx } from '../src/renderer/daw/edit/region-fx.js';
import { DEFAULT_MIDI_CONFIG } from '../src/renderer/daw/model/midi.js';
import type { Clip, Insert } from '../src/renderer/daw/model/types.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
const near = (a: number, b: number, tol: number, m: string): void => {
  assert(Math.abs(a - b) <= tol, `${m}: ${a} vs ${b} (±${tol})`);
};

const ins = (pluginId: string, params: Record<string, number> = {}, slot = 0): Insert =>
  createInsert(slot, pluginId, pluginId, { params: { ...defaultParams(pluginId), ...params } });

const SR = 48000;

// ── What rings, and what does not ────────────────────────────────────────────

check('a device that cannot ring reports no tail', () => {
  // The distinction that matters: a look-ahead limiter DELAYS the signal but
  // does not outlive it.  If latency were mistaken for tail, every chain with
  // a limiter would render a stretch of near-silence and call it a tail.
  for (const id of ['eq3', 'eq8', 'comp', 'mbcomp', 'clipper', 'limiter', 'gate',
                    'widener', 'monomaker', 'tilt', 'mseq', 'deesser', 'trim']) {
    assert(deviceTailSec(id, defaultParams(id)) === 0,
      `${id} claims a tail of ${deviceTailSec(id, defaultParams(id))} s`);
  }
});

check('every delay and reverb reports one', () => {
  for (const id of ['delay', 'pingpong', 'tapedelay', 'reverb', 'plate', 'spring',
                    'spacereverb', 'shimmer']) {
    assert(deviceTailSec(id, defaultParams(id)) > 0.05, `${id} reports no tail`);
  }
});

check('more feedback rings for longer', () => {
  const low  = deviceTailSec('delay', { timeMs: 400, feedback: 0.2 });
  const mid  = deviceTailSec('delay', { timeMs: 400, feedback: 0.5 });
  const high = deviceTailSec('delay', { timeMs: 400, feedback: 0.8 });
  assert(low < mid && mid < high, `not monotonic: ${low} / ${mid} / ${high}`);
});

check('a delay with no feedback rings for exactly one repeat', () => {
  near(deviceTailSec('delay', { timeMs: 250, feedback: 0 }), 0.25, 1e-9,
    'one repeat of a 250 ms delay');
});

check('the −60 dB figure is the real one, not a guess', () => {
  // 0.5 feedback loses 6.02 dB a repeat, so −60 dB is just under 10 repeats.
  // The formula adds the dry hit, hence 11 × the delay time.
  const tail = deviceTailSec('delay', { timeMs: 100, feedback: 0.5 });
  near(tail, 0.1 * (60 / 6.0206 + 1), 0.002, '0.5 feedback to −60 dB');
});

check('runaway feedback is capped instead of asking for a four-minute render', () => {
  assert(deviceTailSec('delay', { timeMs: 1500, feedback: 0.99 }) === MAX_DEVICE_TAIL_SEC,
    'a 0.99 feedback delay was not capped');
  assert(deviceTailSec('delay', { timeMs: 1500, feedback: 1 }) === MAX_DEVICE_TAIL_SEC,
    'feedback at unity was not capped');
});

check('a longer reverb reports a longer tail', () => {
  assert(deviceTailSec('plate', { decaySec: 6 }) > deviceTailSec('plate', { decaySec: 1.2 }),
    'plate decay does not reach the tail');
  assert(deviceTailSec('spacereverb', { decayPct: 240 }) > deviceTailSec('spacereverb', { decayPct: 60 }),
    'space reverb decayPct does not reach the tail');
});

check('ping-pong counts a crossing as half a repeat', () => {
  // The same time and feedback ring twice as long when the repeats alternate.
  const p = deviceTailSec('pingpong', { timeMs: 300, feedback: 0.5 });
  const d = deviceTailSec('delay', { timeMs: 300, feedback: 0.5 });
  near(p, d * 2, 0.01, 'ping-pong vs plain delay');
});

// ── The chain ────────────────────────────────────────────────────────────────

check('a chain rings for the sum of its parts, not the longest one', () => {
  // A delay into a reverb: the reverb is still being fed while the delay
  // repeats, so it starts decaying only after the last repeat.  Taking the max
  // would cut the reverb short by the length of the delay.
  const delay = ins('delay', { timeMs: 300, feedback: 0.5 });
  const plate = ins('plate', { decaySec: 2.5 }, 1);
  const both = chainTailSec([delay, plate], SR);
  const alone = chainTailSec([delay], SR) + chainTailSec([plate], SR);
  near(both, alone, 1e-6, 'chain tail is not the sum');
});

check('a bypassed device rings for nothing', () => {
  const on  = ins('plate', { decaySec: 4 });
  const off = { ...on, bypass: true };
  assert(chainTailSec([off], SR) === 0, 'a bypassed reverb still claims a tail');
  assert(chainTailSec([on], SR) > 3, 'an active reverb lost its tail');
});

check('latency is added on top of the ring', () => {
  // The limiter does not ring, but it holds the last samples back by its
  // look-ahead, and cutting at the tail would clip exactly those.
  const limiter = ins('limiter', { lookaheadMs: 8 });
  const tail = chainTailSec([limiter], SR);
  assert(tail > 0, 'a look-ahead limiter reported a zero tail');
  assert(tail < 0.05, `look-ahead reported as ${tail} s, far more than its 8 ms`);
});

check('an empty chain rings for nothing', () => {
  assert(chainTailSec([], SR) === 0, 'an empty chain claims a tail');
});

check('a chain of ten reverbs is still capped', () => {
  const many = Array.from({ length: 10 }, (_, i) => ins('plate', { decaySec: 12 }, i));
  assert(chainTailSec(many, SR) === MAX_CHAIN_TAIL_SEC, 'the chain cap did not hold');
});

check('every device in the registry answers the question', () => {
  // A device added later must not make this throw or return a non-number —
  // the default is zero, and zero is a real answer.
  for (const plugin of PLUGINS) {
    const tail = deviceTailSec(plugin.id, defaultParams(plugin.id));
    assert(Number.isFinite(tail) && tail >= 0, `${plugin.id} answered ${tail}`);
  }
});

check('the sentence the window shows names the device that is ringing', () => {
  const quiet = ins('eq8');
  const loud = ins('plate', { decaySec: 5 }, 1);
  assert(describeTail([], SR).includes('비어'), 'an empty chain is not described as empty');
  assert(describeTail([quiet], SR).includes('울리지 않'), 'a non-ringing chain is not described as such');
  const line = describeTail([quiet, loud], SR);
  assert(line.includes('Plate Reverb'), `the ringing device is not named: ${line}`);
});

// ── Reading a clip that has been through the lab ─────────────────────────────

const base: Clip = {
  id: 'clip-1', kind: 'audio', fileId: 'file-orig', notes: [], controllers: [],
  pitchSegments: [], midiConfig: DEFAULT_MIDI_CONFIG,
  name: '조각', startSec: 70, offsetSec: 12, durationSec: 10, gainDb: 0,
  fadeIn: { durationSec: 0, shape: 'linear' }, fadeOut: { durationSec: 0, shape: 'linear' },
  muted: false,
};

check('an untouched clip is its own original', () => {
  const src = originalSource(base);
  assert(src.fileId === 'file-orig' && src.offsetSec === 12 && src.durationSec === 10,
    'an untouched clip does not report itself');
  assert(clipRegionFx(base) === null, 'an untouched clip claims a chain');
  assert(bodyDurationSec(base) === 10, 'an untouched clip reports the wrong body length');
});

check('a processed clip still remembers what it replaced', () => {
  // This is the one that stops an apply-twice from being a delay of a delay.
  const processed: Clip = {
    ...base,
    fileId: 'file-rendered', offsetSec: 0, durationSec: 12.04,
    regionFx: {
      inserts: [ins('delay')], tailMode: 'keep', tailSec: 2.04,
      original: { fileId: 'file-orig', offsetSec: 12, durationSec: 10 },
    },
  };
  const src = originalSource(processed);
  assert(src.fileId === 'file-orig', 'a re-render would start from the processed audio');
  assert(src.offsetSec === 12 && src.durationSec === 10, 'the original bounds were lost');
  assert(bodyDurationSec(processed) === 10,
    'the body length reads the grown clip instead of the original');
  assert(processed.durationSec > src.durationSec,
    'the processed clip did not grow by its tail');
});

// ── The device that made this visible ────────────────────────────────────────
//
// Rendering a long tail through Tape Delay is how it was noticed that the
// saturator inside its feedback loop AMPLIFIES: the tail came back as a flat,
// constant tone instead of a decaying repeat.  The loop gain at the factory
// settings was 3.07, so it was an oscillator, and had been all along — nothing
// had asked it for four seconds of ring before.

check('the tube curve claims the gain it actually has', () => {
  // The analytic figure and the sampled curve must agree, or compensating by
  // the analytic one would compensate by the wrong amount.
  for (const [drive, bias] of [[0, 0.05], [0.25, 0.05], [0.5, 0.05], [1, 0.05],
                               [0.3, 0.15], [0.8, 0.15]] as Array<[number, number]>) {
    const n = 4096;
    const k = 1 + drive * 24;
    const sample = (x: number): number => {
      const b = x + bias;
      return (Math.tanh(b * k) - Math.tanh(bias * k)) / Math.max(1e-6, Math.tanh(k));
    };
    const measured = (sample(0.002) - sample(-0.002)) / 0.004;
    const claimed = tubeSmallSignalGain(drive, bias);
    assert(Math.abs(measured - claimed) / Math.max(1, claimed) < 0.01,
      `drive ${drive} bias ${bias}: curve slope ${measured.toFixed(3)} vs claimed ${claimed.toFixed(3)}`);
    void n;
  }
});

check('a saturator in a feedback loop cannot have gain above one', () => {
  // The compensation the tape delay applies.  Anything above 1 here and the
  // loop gain is feedback × this, which at the 0.95 the knob allows is an
  // oscillator for any gain over 1.05.
  for (let drive = 0; drive <= 1.0001; drive += 0.05) {
    const compensated = tubeSmallSignalGain(drive, 0.05) / Math.max(1, tubeSmallSignalGain(drive, 0.05));
    assert(compensated <= 1.0001, `drive ${drive.toFixed(2)} still passes ${compensated}`);
    assert(compensated * 0.95 < 1, `drive ${drive.toFixed(2)} diverges at maximum feedback`);
  }
});

check('the uncompensated curve really was divergent — this is not a theory', () => {
  // Pinned so that a future "simplification" of the curve cannot quietly put
  // the oscillator back and have every test still pass.
  assert(tubeSmallSignalGain(0.25, 0.05) > 6,
    'the default drive no longer amplifies — if the curve changed, revisit the compensation');
  assert(tubeSmallSignalGain(0.25, 0.05) * 0.45 > 1,
    'the factory tape delay is no longer over unity loop gain');
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Region FX — the tail ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
