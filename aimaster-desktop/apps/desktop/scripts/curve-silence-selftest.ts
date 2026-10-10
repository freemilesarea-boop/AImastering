/**
 * curve-silence-selftest — what every transfer curve does with nothing.
 *
 * A WaveShaper maps x in [−1, 1] onto index `(x + 1) / 2 * (n - 1)` and
 * interpolates between neighbours.  That grid is symmetric at ANY length —
 * index i and n − 1 − i hold exactly opposite inputs — so a smooth odd shape
 * answers zero with silence whatever the point count, and measured, both
 * `tapeCurve` at 4096 and a biased tanh at 2048 do (the latter to 5e-8).
 *
 * The count bites where the SLOPE JUMPS at the origin.  `pickupCurve`'s gain
 * differs by polarity, so its two neighbours either side of zero are
 * −1.489e-3 and +2.385e-3, and an even length hands back their midpoint:
 * 4.48e-4 at amount 0.35.  That was a constant on the bus for as long as a
 * Rhodes voice stayed connected, and it is the reason that curve carries 1025
 * points.  Three comments in this codebase had the rule backwards — they said
 * the count decided it, rather than the shape — and two of those were written
 * while fixing the clipper and the saturator.
 *
 * An audio-path curve has to answer zero.  A CONTROL curve does not: its
 * input is a rectified envelope and its output is a gain, so what silence
 * gets is that device's floor — an expander's residual, a gate's range, an
 * upward compressor's refusal to lift noise.  Those are pinned here too,
 * because a floor that drifts is a device changing what it does to the
 * quietest part of a mix, and nothing else would notice.
 *
 * Run:  pnpm --filter @aimaster/desktop test:curve-silence
 */

import {
  halfWaveGainCurve, makeDbReductionCurve, makeExpanderCurve, tanhCurve,
} from '../src/renderer/daw/engine/plugin-kit.js';
import {
  bitCurve, clipCurve, gateGainCurve, tapeCurve, tapeKink, tubeCurve, tubeSmallSignalGain,
} from '../src/renderer/daw/engine/plugins-extended.js';
import { pickupCurve } from '../src/renderer/daw/engine/instruments.js';
import { upwardCurve } from '../src/renderer/daw/engine/upward.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

/** Read a curve exactly as a WaveShaper reads it. */
function readAt(curve: Float32Array, x: number): number {
  const t = ((Math.max(-1, Math.min(1, x)) + 1) / 2) * (curve.length - 1);
  const i = Math.max(0, Math.min(curve.length - 2, Math.floor(t)));
  return curve[i]! + (curve[i + 1]! - curve[i]!) * (t - i);
}

/** Every curve that becomes a WaveShaper in the signal path. */
const AUDIO: ReadonlyArray<readonly [string, Float32Array]> = [
  ['tanhCurve(0, 0)', tanhCurve(0, 0)],
  ['tanhCurve(0, 24)', tanhCurve(0, 24)],
  ['tanhCurve(0.4, 12)', tanhCurve(0.4, 12)],
  ['tanhCurve(1.5, 12)', tanhCurve(1.5, 12)],
  ['clipCurve(0.891, 0)', clipCurve(0.891, 0)],
  ['clipCurve(0.891, 0.5)', clipCurve(0.891, 0.5)],
  ['clipCurve(0.891, 1)', clipCurve(0.891, 1)],
  ['tubeCurve(0, 0.05)', tubeCurve(0, 0.05)],
  ['tubeCurve(0.3, 0.15)', tubeCurve(0.3, 0.15)],
  ['tubeCurve(1, 0.5)', tubeCurve(1, 0.5)],
  ['tapeCurve(kink 0)', tapeCurve(tapeKink(0))],
  ['tapeCurve(kink 0.5)', tapeCurve(tapeKink(0.5))],
  ['tapeCurve(kink 1)', tapeCurve(tapeKink(1))],
  ['bitCurve(16)', bitCurve(16)],
  ['bitCurve(8)', bitCurve(8)],
  ['bitCurve(4)', bitCurve(4)],
  ['pickupCurve(0)', pickupCurve(0)],
  ['pickupCurve(0.35)', pickupCurve(0.35)],
  ['pickupCurve(1)', pickupCurve(1)],
];

/**
 * Control curves, with the gain silence is supposed to get and why.
 *
 * These are read with a rectified envelope, so only the positive half is ever
 * reached and the value at zero is what the device does to nothing at all.
 */
const CONTROL: ReadonlyArray<readonly [string, Float32Array, number, string]> = [
  ['makeExpanderCurve(-30, 2)', makeExpanderCurve(-30, 2), 0.05,
    'the default floor: a denoiser pushes the noise down, it does not mute it'],
  ['makeExpanderCurve(-30, 2, 0.2)', makeExpanderCurve(-30, 2, 0.2), 0.2,
    'and the floor is the caller\'s to set'],
  ['makeDbReductionCurve(-20, 4, -6)', makeDbReductionCurve(-20, 4, -6), 0,
    'nothing below the threshold is cut, and silence is below every threshold'],
  ['gateGainCurve(-30, 25)', gateGainCurve(-30, 25), 10 ** (-25 / 20),
    'a closed gate sits at its range, 25 dB down, not at silence'],
  ['gateGainCurve(-30, 0)', gateGainCurve(-30, 0), 1,
    'and a range of zero is a gate that does nothing'],
  ['upwardCurve(-30, 2, 12, -60)', upwardCurve(-30, 2, 12, -60), 1,
    'an upward compressor refuses to lift what is under its floor'],
  // The one control curve that is KINKED at zero — it reacts to a single
  // polarity — and the one with an even length, so silence lands on the
  // midpoint of two neighbours that are not opposites: 7.33e-4 rather than 0.
  // Left alone on purpose.  It is a gain DELTA summed onto a VCA, so what it
  // multiplies at silence is silence, and 2048 → 2049 would move the
  // interpolation grid everywhere to buy a number that cannot be heard.
  ['halfWaveGainCurve(3, positive)', halfWaveGainCurve(3, 'positive'), 7.33e-4,
    'a one-sided delta, even-length, and inaudible because it scales silence'],
  ['halfWaveGainCurve(3, negative)', halfWaveGainCurve(3, 'negative'), 7.33e-4,
    'the other polarity, the same way'],
];

check('every audio-path curve answers silence with silence', () => {
  // pickupCurve measured 4.48e-4 here before it was given an odd length.
  for (const [name, curve] of AUDIO) {
    const got = readAt(curve, 0);
    assert(Math.abs(got) < 1e-7, `${name} maps silence to ${got.toExponential(3)}`);
  }
});

check('the grid is symmetric, so a smooth shape needs no particular length', () => {
  // The claim three comments had backwards.  Built at four lengths, two even
  // and two odd, an odd-symmetric shape gives zero at all of them — so a
  // length is not what makes a curve safe, and saying it is sends the next
  // person to the wrong place.
  const odd = (n: number): Float32Array => {
    const c = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * 1.6) / Math.tanh(1.6);
    }
    return c;
  };
  for (const n of [2048, 2049, 4096, 4097]) {
    const got = readAt(odd(n), 0);
    assert(got === 0, `length ${n} gives ${got.toExponential(2)}`);
  }
  // And the same shape is antisymmetric to the last entry at an even length.
  const even = odd(2048);
  let worst = 0;
  for (let i = 0; i < even.length; i += 1) {
    worst = Math.max(worst, Math.abs(even[i]! + even[even.length - 1 - i]!));
  }
  assert(worst === 0, `an even length is still antisymmetric, worst ${worst}`);
});

check('a slope that JUMPS at the origin is what an odd length is for', () => {
  // pickupCurve's gain differs by polarity.  Rebuilt here at both lengths
  // because the shipped one is 1025 and the point is what 1024 would cost:
  // the midpoint of two neighbours that are not opposites.
  const pickupAt = (n: number, amount: number): Float32Array => {
    const c = new Float32Array(n);
    const k = 1 + 4 * amount;
    for (let i = 0; i < n; i += 1) {
      const x = (i / (n - 1)) * 2 - 1;
      const bias = x >= 0 ? k : k * 0.55;
      c[i] = Math.tanh(x * bias) / Math.tanh(bias);
    }
    return c;
  };
  assert(readAt(pickupAt(1025, 0.35), 0) === 0, 'odd is exact');
  const cost = readAt(pickupAt(1024, 0.35), 0);
  assert(Math.abs(cost - 4.48e-4) < 1e-5,
    `even costs the midpoint, measured 4.48e-4, got ${cost.toExponential(3)}`);
  // It grows with the kink, which is why the number is worth having.
  const steeper = readAt(pickupAt(1024, 1), 0);
  assert(steeper > cost * 2, `a steeper kink costs more: ${steeper.toExponential(2)}`);
  // The shipped curve is the odd one.
  assert(pickupCurve(0.35).length % 2 === 1, 'pickupCurve ships odd');
});

check('a bias is what makes a smooth curve need the odd length too', () => {
  // Small — 5e-8 — and the reason it is small is that the slope is
  // continuous.  Recorded so the two numbers are not confused: a kink costs
  // four orders of magnitude more than an asymmetry.
  const biasedAt = (n: number): Float32Array => {
    const c = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const x = (i / (n - 1)) * 2 - 1;
      const b = x + 0.4 * x * x * 0.5;
      c[i] = Math.tanh(b * 1.6) / Math.tanh(1.6);
    }
    return c;
  };
  assert(readAt(biasedAt(2049), 0) === 0, 'odd is exact');
  const cost = Math.abs(readAt(biasedAt(2048), 0));
  assert(cost > 0, 'even is not exact');
  assert(cost < 1e-6, `and it is tiny: ${cost.toExponential(2)}`);
  // The curves that CAN be biased ship odd anyway.
  assert(tanhCurve(0.4, 12).length % 2 === 1, 'tanhCurve ships odd');
  assert(tubeCurve(0.3, 0.15).length % 2 === 1, 'tubeCurve ships odd');
});

check('every control curve sits at the floor its device declares', () => {
  for (const [name, curve, want, why] of CONTROL) {
    const got = readAt(curve, 0);
    assert(Math.abs(got - want) < 1e-4,
      `${name} gives ${got.toFixed(5)}, want ${want.toFixed(5)} — ${why}`);
  }
});

check('no curve carries a value that is not a number', () => {
  // A single NaN in a WaveShaper's curve is a device that answers silence or
  // noise and says nothing about why.
  for (const [name, curve] of [...AUDIO, ...CONTROL.map((c) => [c[0], c[1]] as const)]) {
    for (let i = 0; i < curve.length; i += 1) {
      assert(Number.isFinite(curve[i]!), `${name} entry ${i} is ${curve[i]}`);
    }
  }
});

check('a curve that reaches past full scale has a gain behind it that says so', () => {
  // Everything here stays inside ±1 except the tube, which overshoots on its
  // negative half by exactly the amount its bias is centred by:
  //
  //     f(−1) = (tanh(−k + bias) − tanh(bias)) / tanh(k),  k = 1 + 24·drive
  //
  // so the extreme approaches (1 + tanh(bias)) / tanh(k) — measured 1.0370 at
  // drive 0 and bias 0.05, and 1.4621 at bias 0.5, which is +3.3 dB past full
  // scale.  Not a defect, and not nothing either: it is only harmless because
  // the device divides by `tubeSmallSignalGain`, which is bigger.  Measured
  // through the real device at full drive and full bias with a full-scale tone
  // in, the output peaks at ±1.0004.  A change that raised the overshoot
  // without raising the normalisation would be audible and silent in the code.
  for (const [name, curve] of AUDIO) {
    if (name.startsWith('tubeCurve')) continue;
    for (let i = 0; i < curve.length; i += 1) {
      assert(Math.abs(curve[i]!) <= 1 + 1e-6, `${name} entry ${i} is ${curve[i]}`);
    }
  }
  for (const [drive, bias] of [[0, 0.05], [0.3, 0.15], [0.3, 0.5], [1, 0.5]] as const) {
    const curve = tubeCurve(drive, bias);
    let peak = 0;
    for (let i = 0; i < curve.length; i += 1) peak = Math.max(peak, Math.abs(curve[i]!));
    const k = 1 + drive * 24;
    const bound = (1 + Math.tanh(bias)) / Math.tanh(k);
    assert(peak <= bound + 1e-3,
      `tube(${drive}, ${bias}) peaks at ${peak.toFixed(4)}, over its own bound ${bound.toFixed(4)}`);
    // And the normalisation the device applies is larger than the overshoot,
    // which is the whole reason it never leaves the device.
    assert(tubeSmallSignalGain(drive, bias) > peak,
      `tube(${drive}, ${bias}) normalises by ${tubeSmallSignalGain(drive, bias).toFixed(3)} `
      + `against a peak of ${peak.toFixed(3)}`);
  }
});

let pass = 0;
for (const r of results) {
  if (r.pass) { pass += 1; console.log(`  PASS  ${r.name}`); }
  else console.log(`  FAIL  ${r.name}\n        ${r.detail}`);
}
console.log(`\ncurve-silence-selftest: ${pass}/${results.length}`);
if (pass !== results.length) process.exit(1);
