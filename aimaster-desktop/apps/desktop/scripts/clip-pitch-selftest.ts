/**
 * clip-pitch-selftest.ts — transposing an audio clip without moving its length.
 *
 * `daw.transposeUp` has always been MIDI-only, so an audio clip could be
 * warped to any tempo and could not be moved a single semitone.  For a
 * session built out of generated audio that is the more common problem: the
 * take is in the right tempo and the wrong key.
 *
 * The claim worth testing is the one the whole feature rests on — that pitch
 * moves and LENGTH DOES NOT.  So the render cases measure both: the frequency
 * that comes out, in cents, and the sample count.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:clip-pitch
 */

import {
  clipPitch, describePitch, hasPitch, semitoneRatio, withClipPitch,
  MAX_CLIP_SEMITONES, PITCH_EPS,
} from '../src/renderer/daw/model/clip-pitch.js';
import { shiftChannels } from '../src/renderer/daw/audio/pitch-clip.js';
import { createClip } from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { Clip } from '../src/renderer/daw/model/types.js';

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

const SR = 48000;
const clip = (over: Partial<Clip> = {}): Clip =>
  ({ ...createClip('f', 'take', { startSec: 0, offsetSec: 0, durationSec: 2 }), ...over });

function tone(hz: number, lengthSec = 2): Float32Array {
  const out = new Float32Array(Math.round(lengthSec * SR));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / SR) * 0.5;
  return out;
}

/**
 * Fundamental, by autocorrelation.
 *
 * The FIRST peak above 80 % of the global maximum, not the global maximum
 * itself.  Plain autocorrelation slides onto a sub-harmonic — the first
 * version of this measured a +7 semitone shift as −1902 cents, which is
 * exactly one third of the right answer — and that would have been read as a
 * bug in the renderer instead of in the probe.
 */
function measureHz(x: Float32Array): number {
  const from = Math.round(SR * 0.5);
  const n = 8192;
  const lo = Math.round(SR / 1400);
  const hi = Math.round(SR / 60);
  const r: number[] = [];
  for (let lag = lo; lag <= hi; lag++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += (x[from + i] ?? 0) * (x[from + i + lag] ?? 0);
    r.push(sum);
  }
  const peak = Math.max(...r);
  for (let i = 1; i < r.length - 1; i++) {
    if (r[i]! > r[i - 1]! && r[i]! >= r[i + 1]! && r[i]! > peak * 0.8) return SR / (lo + i);
  }
  return SR / (lo + r.indexOf(peak));
}

const centsOff = (got: number, want: number): number => 1200 * Math.log2(got / want);

// ── The value ────────────────────────────────────────────────────────────────

check('a clip with no field reads as no transpose', () => {
  const c = clip();
  assert(c.pitchSemitones === undefined, 'the fixture has none');
  assert(clipPitch(c) === 0, 'and it reads as zero');
  assert(!hasPitch(c), 'so it needs no render');
});

check('NaN and infinity read as no transpose', () => {
  assert(clipPitch(clip({ pitchSemitones: Number.NaN })) === 0, 'NaN');
  assert(clipPitch(clip({ pitchSemitones: Number.POSITIVE_INFINITY })) === 0, 'infinity');
});

check('a value past an octave is held, not refused', () => {
  // It can arrive from a saved session or an import, neither of which has
  // anywhere to put an error.
  assert(clipPitch(clip({ pitchSemitones: 40 })) === MAX_CLIP_SEMITONES, 'up');
  assert(clipPitch(clip({ pitchSemitones: -40 })) === -MAX_CLIP_SEMITONES, 'down');
});

check('an inaudible transpose is no transpose', () => {
  assert(clipPitch(clip({ pitchSemitones: PITCH_EPS / 2 })) === 0, 'below the threshold');
  assert(hasPitch(clip({ pitchSemitones: 0.5 })), 'half a semitone is not');
});

check('setting it holds the range too', () => {
  assert(clipPitch(withClipPitch(clip(), 99)) === MAX_CLIP_SEMITONES, 'up');
  assert(withClipPitch(clip(), 0).pitchSemitones === 0, 'and zero is stored, not deleted');
});

check('twelve semitones is exactly an octave', () => {
  near(semitoneRatio(12), 2, 1e-12, 'up');
  near(semitoneRatio(-12), 0.5, 1e-12, 'down');
  near(semitoneRatio(0), 1, 1e-12, 'and none is unity');
});

check('the label says which way and by how much', () => {
  assert(describePitch(0) === '원음', describePitch(0));
  assert(describePitch(3).includes('+3'), describePitch(3));
  assert(describePitch(-2).includes('2'), describePitch(-2));
  assert(!describePitch(-2).includes('-2'), 'a minus sign, not a hyphen');
});

// ── The render ───────────────────────────────────────────────────────────────

check('zero returns the very same arrays — a round trip that costs nothing', () => {
  const input = [tone(220)];
  const out = shiftChannels(input, SR, 0);
  assert(out[0] === input[0], 'the identity is the array itself, not a copy of it');
});

check('every transpose lands within a few cents, and the length never moves', () => {
  const cases: Array<[number, number]> = [[220, 1], [220, 3], [220, 7], [220, 12], [220, -5], [220, -12], [440, 4]];
  for (const [hz, semis] of cases) {
    const input = tone(hz);
    const out = shiftChannels([input], SR, semis)[0]!;
    assert(out.length === input.length, `${semis} semitones changed the length`);
    const off = centsOff(measureHz(out), hz * semitoneRatio(semis));
    assert(Math.abs(off) <= 15, `${semis} semitones landed ${off.toFixed(1)} cents out`);
  }
});

check('a transpose is not a resample — the events stay where they were', () => {
  // The distinguishing case, and a sine cannot make it: a resampled sine is
  // still a sine at the right new frequency, so the pitch test passes either
  // way.  What tells them apart is WHEN things happen.  Bursts at known times
  // move earlier under a resample and stay put under a transpose.
  const at = [0.2, 0.7, 1.2, 1.7];
  const input = new Float32Array(Math.round(2 * SR));
  for (const t of at) {
    const from = Math.round(t * SR);
    for (let i = from; i < Math.min(input.length, from + Math.round(0.1 * SR)); i++) {
      const k = (i - from) / SR;
      input[i] = Math.sin((2 * Math.PI * 220 * i) / SR) * 0.6 * Math.exp(-k * 20);
    }
  }
  const up = shiftChannels([input], SR, 7)[0]!;
  assert(up.length === input.length, `${(up.length / SR).toFixed(3)}s — should still be 2 s`);

  // Where did each burst land?  Anything past the second one is where a
  // resample runs visibly early: a fifth up is 1.5×, so 1.7 s would arrive at
  // 1.13 s.
  const onsets: number[] = [];
  let quietFor = SR;
  for (let i = 0; i < up.length; i++) {
    if (Math.abs(up[i]!) > 0.15) {
      if (quietFor > Math.round(0.05 * SR)) onsets.push(i / SR);
      quietFor = 0;
    } else quietFor += 1;
  }
  assert(onsets.length === at.length, `${onsets.length} bursts, wanted ${at.length}`);
  for (let k = 0; k < at.length; k++) {
    const drift = Math.abs(onsets[k]! - at[k]!) * 1000;
    assert(drift <= 30, `burst ${k} moved ${drift.toFixed(0)}ms — a resample moves the last one 570ms`);
  }
});

check('stereo stays in phase', () => {
  // Both channels have to be planned together; separate searches land them a
  // few samples apart, and a few samples of relative delay collapses the image.
  const left = tone(220);
  const right = tone(220);
  const [l, r] = shiftChannels([left, right], SR, 5);
  let worst = 0;
  for (let i = 0; i < l!.length; i++) worst = Math.max(worst, Math.abs(l![i]! - r![i]!));
  assert(worst < 1e-6, `channels drifted apart by ${worst}`);
});

check('an empty clip renders to an empty clip', () => {
  assert(shiftChannels([], SR, 3).length === 0, 'no channels');
  assert(shiftChannels([new Float32Array(0)], SR, 3)[0]!.length === 0, 'no samples');
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Clip transpose ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
