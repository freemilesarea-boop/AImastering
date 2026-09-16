/**
 * struck-string-selftest.ts — whether the piano is a piano.
 *
 * `struck-string.ts` makes four claims that the plucked string cannot make,
 * and all four are the difference between an instrument and a filtered buzz.
 * Each one is checked here against the AUDIO where that is possible and
 * against `struckModes` where it is not, and the reason for choosing one or
 * the other is written at each check.
 *
 *   1. the partials are stretched, by an amount that matches a real piano
 *   2. the hammer's strike point notches out a partial, and moving it moves
 *      which partial
 *   3. velocity is brightness, not volume
 *   4. the decay has two stages, not one
 *
 * Plus the two things that are true of the implementation rather than of the
 * instrument: the recursion equals the closed form it stands in for, and the
 * same note renders to the same samples every time.
 *
 * ── Why a Goertzel and not an FFT ───────────────────────────────────────────
 *
 * Several checks need the level AT one exact frequency — "is partial 8 gone",
 * "is partial 10 where the stiffness says it is".  An FFT answers a different
 * question: it gives every frequency on ITS grid, and a 4096-point transform
 * at 48 kHz has bins 11.7 Hz apart, which at middle C is a third of the gap
 * between partial 10 and where an ideal string would have put it.  A Goertzel
 * evaluates one frequency exactly, costs nothing, and does not need the
 * answer rounded to a bin to be read.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:struck-string
 */

import {
  inharmonicity, modeSample, partialFrequency, renderModes, ringSeconds,
  stretchCents, stringsForPitch, struckModes, struckString,
  type Mode, type StruckStringSpec,
} from '../src/renderer/daw/engine/struck-string.js';

const SR = 48000;
const results: Array<{ name: string; pass: boolean; detail?: string }> = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true }); } catch (err) {
    results.push({ name, pass: false, detail: (err as Error).message });
  }
}

function midiHz(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

/** A grand-piano note as the instrument builds one. */
function grand(pitch: number, velocity: number, seconds: number): StruckStringSpec {
  const f0 = midiHz(pitch);
  const bloom = 8;
  return {
    freqHz: f0, sampleRate: SR, seconds, B: inharmonicity(pitch), velocity,
    strikePosition: 1 / 8, hammerHz: 4600,
    t60: ringSeconds(f0) / bloom, aftersound: bloom, aftersoundLevel: 0.28,
    hfDamping: 0.015, unisonCents: 1.2, strings: stringsForPitch(pitch),
  };
}

/**
 * The energy at one exact frequency, over a window of samples.
 *
 * Goertzel — see the header.  Returns a magnitude in the same units as the
 * samples, so only the RATIO of two of these means anything.
 */
function toneAt(buf: Float32Array, freqHz: number, from: number, len: number): number {
  const n = Math.min(len, buf.length - from);
  if (n <= 8) return 0;
  const w = (2 * Math.PI * freqHz) / SR;
  const coeff = 2 * Math.cos(w);
  let s1 = 0; let s2 = 0;
  for (let i = 0; i < n; i++) {
    // Hann, so a partial a few hertz away does not leak into this one.
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s0 = (buf[from + i] ?? 0) * win + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  const re = s1 - s2 * Math.cos(w);
  const im = s2 * Math.sin(w);
  return Math.sqrt(re * re + im * im) / n;
}

/** Peak amplitude over a window, for envelope work. */
function peakIn(buf: Float32Array, from: number, len: number): number {
  let peak = 0;
  const end = Math.min(buf.length, from + len);
  for (let i = Math.max(0, from); i < end; i++) peak = Math.max(peak, Math.abs(buf[i] ?? 0));
  return peak;
}

/** Where the energy sits, in hertz — one number for "how bright". */
function centroid(modes: readonly Mode[]): number {
  let num = 0; let den = 0;
  for (const m of modes) { num += m.freqHz * m.amp * m.amp; den += m.amp * m.amp; }
  return den > 0 ? num / den : 0;
}

// ── 1. The partials are stretched ───────────────────────────────────────────

check('an ideal string is harmonic and a stiff one is not', () => {
  for (let n = 1; n <= 20; n++) {
    assert(Math.abs(partialFrequency(100, n, 0) - n * 100) < 1e-9,
      `at B=0 partial ${n} moved, so the formula is not n·f0 when it should be`);
  }
  let previous = 0;
  for (let n = 2; n <= 20; n++) {
    const cents = stretchCents(100, n, 4e-4);
    assert(cents > previous,
      `partial ${n} is stretched ${cents.toFixed(1)}c, no more than partial ${n - 1}'s ${previous.toFixed(1)}c`);
    previous = cents;
  }
});

check('middle C is stretched by about as much as a real piano', () => {
  // The number a tuner would recognise.  Published measurements of the 10th
  // partial of a grand's middle C cluster around 20 cents sharp, with the
  // spread between a concert grand and a parlour grand wider than this band.
  const cents = stretchCents(midiHz(60), 10, inharmonicity(60));
  assert(cents > 15 && cents < 28,
    `the 10th partial of middle C is ${cents.toFixed(1)} cents sharp, which is outside 15–28`);
  // And the octave above it is stretched considerably more, which is why a
  // piano is tuned with stretched octaves rather than to a calculator.
  const upper = stretchCents(midiHz(72), 10, inharmonicity(72));
  assert(upper > cents * 1.8,
    `C5 is stretched ${upper.toFixed(1)}c against middle C's ${cents.toFixed(1)}c — barely more`);
});

check('inharmonicity is a V, with its floor at the bass break', () => {
  let lowest = Infinity; let lowestAt = 0;
  for (let p = 21; p <= 108; p++) {
    const B = inharmonicity(p);
    if (B < lowest) { lowest = B; lowestAt = p; }
  }
  // Wound strings and a foreshortened bass push B back up below the break, so
  // the minimum is in the middle and not at the bottom.  A straight line
  // through the treble fit would put it at MIDI 21 and this is what catches
  // that.
  assert(lowestAt > 30 && lowestAt < 50,
    `inharmonicity bottoms out at MIDI ${lowestAt}, not near the bass break`);
  assert(inharmonicity(21) > lowest * 1.8,
    `the bottom A is ${inharmonicity(21).toExponential(2)} against a floor of ${lowest.toExponential(2)} — the V is flat`);
  assert(inharmonicity(96) > inharmonicity(60) * 8,
    'the treble does not climb away from the middle');
  // An upright is the same fit with shorter strings.
  assert(inharmonicity(60, 2.4) > inharmonicity(60) * 2,
    'scaling the fit does not scale the inharmonicity');
});

check('the audio really contains the stretched partial, not the harmonic one', () => {
  // The claim the whole module exists for, checked on the SAMPLES.  A model
  // that computed the stretch and then rendered n·f0 anyway would pass every
  // check above this one.
  const pitch = 60;
  const spec = { ...grand(pitch, 0.85, 1.2), unisonCents: 0, aftersoundLevel: 0 };
  const buf = struckString(spec);
  const f0 = midiHz(pitch);
  const B = inharmonicity(pitch);
  for (const n of [8, 10, 12]) {
    if (n === 8) continue;                       // notched out — see check 2
    const stretched = partialFrequency(f0, n, B);
    const ideal = n * f0;
    const atStretched = toneAt(buf, stretched, 0, 16384);
    const atIdeal = toneAt(buf, ideal, 0, 16384);
    assert(atStretched > atIdeal * 3,
      `partial ${n} reads ${atStretched.toExponential(2)} where the stiffness puts it `
      + `and ${atIdeal.toExponential(2)} at n·f0 — not clearly the stretched one`);
  }
});

// ── 2. The hammer's strike point ────────────────────────────────────────────

check('a hammer at 1/8 of the string cannot excite the 8th partial', () => {
  const spec = { ...grand(60, 0.85, 1), strikePosition: 1 / 8, unisonCents: 0 };
  const f0 = spec.freqHz;
  const B = spec.B;
  const modes = struckModes(spec);
  const near = (hz: number): number => {
    let best = 0;
    for (const m of modes) if (Math.abs(m.freqHz - hz) < hz * 0.004) best = Math.max(best, m.amp);
    return best;
  };
  const eighth = near(partialFrequency(f0, 8, B));
  const seventh = near(partialFrequency(f0, 7, B));
  const ninth = near(partialFrequency(f0, 9, B));
  assert(eighth < seventh * 0.02 && eighth < ninth * 0.02,
    `the 8th partial is ${eighth.toExponential(2)} against neighbours `
    + `${seventh.toExponential(2)} and ${ninth.toExponential(2)} — the notch is not there`);
  assert(seventh > 0 && ninth > 0, 'the notch took its neighbours with it');
});

check('moving the hammer moves which partial disappears', () => {
  // The notch has to be a CONSEQUENCE of the strike point and not a constant
  // that happens to sit at 8.  At 1/7 it is the seventh that goes.
  const f0 = midiHz(60);
  const B = inharmonicity(60);
  const ampAt = (strike: number, n: number): number => {
    const modes = struckModes({ ...grand(60, 0.85, 1), strikePosition: strike, unisonCents: 0 });
    const want = partialFrequency(f0, n, B);
    let best = 0;
    for (const m of modes) if (Math.abs(m.freqHz - want) < want * 0.004) best = Math.max(best, m.amp);
    return best;
  };
  assert(ampAt(1 / 7, 7) < ampAt(1 / 8, 7) * 0.05,
    'striking at 1/7 did not kill the 7th partial');
  assert(ampAt(1 / 7, 8) > ampAt(1 / 8, 8) * 20,
    'striking at 1/7 did not bring the 8th partial back');
});

// ── 3. Velocity is brightness ───────────────────────────────────────────────

check('hitting harder adds partials rather than only gain', () => {
  const soft = struckModes(grand(60, 0.15, 1));
  const hard = struckModes(grand(60, 1, 1));
  const ratio = centroid(hard) / Math.max(1, centroid(soft));
  // Measured at 2.4× when this was written.  A velocity that is only a gain
  // scores exactly 1.00, and the first version of the hammer scored 1.6 —
  // which is why the bound is well above 1 and not merely above it.
  assert(ratio > 2,
    `a fortissimo's spectral centroid is only ${ratio.toFixed(2)}× a pianissimo's`);
});

check('and the level still moves too, or a pianissimo would just be dull', () => {
  const soft = struckString(grand(60, 0.15, 1));
  const hard = struckString(grand(60, 1, 1));
  const db = 20 * Math.log10(peakIn(hard, 0, hard.length) / Math.max(1e-9, peakIn(soft, 0, soft.length)));
  assert(db > 6 && db < 40,
    `a fortissimo is ${db.toFixed(1)} dB above a pianissimo, which is not a piano's range`);
});

// ── 4. The decay has two stages ─────────────────────────────────────────────

check('a piano note does not decay like one exponential', () => {
  // The prompt sound dies, and then the aftersound is still there.  Measured
  // as: the decay rate over the first half-second is steeper than the rate
  // over the following two.  A single exponential gives the same rate for
  // both, whatever its time constant.
  const spec = { ...grand(48, 0.8, 4), unisonCents: 0 };
  const buf = struckString(spec);
  const win = Math.round(SR * 0.15);
  const a = peakIn(buf, Math.round(SR * 0.02), win);
  const b = peakIn(buf, Math.round(SR * 0.5), win);
  const c = peakIn(buf, Math.round(SR * 2.5), win);
  const early = 20 * Math.log10(a / Math.max(1e-9, b)) / 0.48;
  const late = 20 * Math.log10(b / Math.max(1e-9, c)) / 2.0;
  assert(early > late * 1.8,
    `the note falls ${early.toFixed(1)} dB/s early and ${late.toFixed(1)} dB/s late — that is one exponential`);
});

check('and with no aftersound it decays like one, which is the control', () => {
  // The check above would also pass on a bug that made the early window read
  // high for some unrelated reason.  This is the same measurement with the
  // slow plane switched off: it has to come out flat, or the measurement is
  // not measuring the aftersound.
  const spec = { ...grand(48, 0.8, 4), unisonCents: 0, aftersoundLevel: 0 };
  const buf = struckString(spec);
  const win = Math.round(SR * 0.15);
  const a = peakIn(buf, Math.round(SR * 0.02), win);
  const b = peakIn(buf, Math.round(SR * 0.5), win);
  const c = peakIn(buf, Math.round(SR * 2.5), win);
  const early = 20 * Math.log10(a / Math.max(1e-9, b)) / 0.48;
  const late = 20 * Math.log10(b / Math.max(1e-9, c)) / 2.0;
  assert(early < late * 1.8,
    `with the aftersound off the note still falls ${early.toFixed(1)} then ${late.toFixed(1)} dB/s`);
});

check('what makes the envelope wander, and what does not', () => {
  // The first version of this check asserted that three detuned strings beat
  // and a perfect unison does not.  Measured, the perfect unison wanders too
  // — and it is supposed to.  Each string vibrates in two planes a third of a
  // cent apart (see the header), so one string beats with ITSELF before any
  // unison is involved.  What follows is the four measurements that actually
  // separate the causes, which is what the first version thought it was doing.
  const rises = (cents: number, after: number): number => {
    const buf = struckString({
      ...grand(60, 0.8, 9), unisonCents: cents, strings: 3, aftersoundLevel: after,
    });
    const win = Math.round(SR * 0.05);
    const env: number[] = [];
    for (let t = 0.4; t < 8; t += 0.05) env.push(peakIn(buf, Math.round(SR * t), win));
    let up = 0;
    for (let i = 1; i < env.length; i++) if ((env[i] ?? 0) > (env[i - 1] ?? 0) * 1.02) up += 1;
    return up;
  };

  // One plane, one pitch: nothing to beat against, so a pure decay.  This is
  // the control, and it is the ONLY configuration that gives zero.
  assert(rises(0, 0) === 0,
    `a single-plane unison wandered ${rises(0, 0)} times, so something other than beating is moving`);

  // Two planes a third of a cent apart, at one pitch: they beat.
  const planes = rises(0, 0.28);
  assert(planes > 10, `the two planes of one string produced only ${planes} rises`);

  // And detuning the three strings on top of that adds more.
  const unison = rises(1.2, 0.28);
  assert(unison > planes,
    `detuning the unison gave ${unison} rises against ${planes} with no detune at all`);

  // The one that is worth knowing.  A detuned unison with no aftersound does
  // not beat AT ALL: at middle C the beat period is 2.8 seconds and the fast
  // plane is down 60 dB in 1.5, so the note is gone before the first beat
  // completes.  The unison shimmer is not a separate feature from the
  // aftersound — it is audible only on the part of the note that outlives
  // one beat, which is true of a real piano as well.
  assert(rises(1.2, 0) === 0,
    'a detuned unison beat without an aftersound, so the note outlives its own beat period');
});

check('the bottom octave has one string, the top has three', () => {
  assert(stringsForPitch(21) === 1, 'the bottom A is not a single wound string');
  assert(stringsForPitch(36) === 2, 'the crossover is not a two-string unison');
  assert(stringsForPitch(60) === 3, 'middle C is not a three-string unison');
  let previous = 0;
  for (let p = 21; p <= 108; p++) {
    const s = stringsForPitch(p);
    assert(s >= previous, `the count drops back to ${s} at MIDI ${p}`);
    previous = s;
  }
});

// ── The implementation, rather than the instrument ──────────────────────────

check('the recursion is the closed form it stands in for', () => {
  // A two-pole recursion at a radius this close to 1, run for a million
  // samples, is exactly the kind of thing that is correct on paper and drifts
  // in floating point.  Measured worst case when written: 3e-8, which is
  // −150 dB.
  for (const t60 of [0.2, 3, 30]) {
    const mode: Mode = { freqHz: 261.63, amp: 1, t60 };
    const buf = renderModes([mode], SR, Math.min(6, t60));
    let worst = 0;
    for (let i = 0; i < buf.length; i += 997) {
      worst = Math.max(worst, Math.abs((buf[i] ?? 0) - modeSample(mode, SR, i)));
    }
    assert(worst < 1e-6,
      `at t60=${t60}s the recursion drifts ${worst.toExponential(2)} from the closed form`);
  }
});

check('no mode is ever placed above Nyquist', () => {
  for (const pitch of [21, 48, 60, 84, 96, 108]) {
    for (const stretch of [0.1, 1, 4]) {
      const modes = struckModes({ ...grand(pitch, 1, 1), B: inharmonicity(pitch, stretch) });
      for (const m of modes) {
        assert(m.freqHz < SR / 2,
          `MIDI ${pitch} at stretch ${stretch} placed a mode at ${m.freqHz.toFixed(0)} Hz`);
      }
    }
  }
});

check('the same note renders to the same samples, every time', () => {
  // The engine's standing rule: a bounce sounds like the preview.  Nothing
  // here may reach for Math.random().
  const spec = grand(55, 0.73, 1.5);
  const a = struckString(spec);
  const b = struckString(spec);
  assert(a.length === b.length, 'two renders of one note came out different lengths');
  for (let i = 0; i < a.length; i += 31) {
    assert(a[i] === b[i], `sample ${i} differs between two renders of the same note`);
  }
});

check('the ring time falls with pitch and is clamped where the fit runs out', () => {
  let previous = Infinity;
  for (let p = 21; p <= 108; p += 3) {
    const r = ringSeconds(midiHz(p));
    assert(r <= previous + 1e-9, `MIDI ${p} rings ${r.toFixed(2)}s, longer than the note below it`);
    previous = r;
  }
  assert(ringSeconds(midiHz(21)) === 30, 'the bass is not clamped, so the fit is extrapolating');
  assert(ringSeconds(midiHz(108)) < 1, 'the top note rings for over a second');
});

check('nothing clips, and a quiet note is still there', () => {
  for (const pitch of [24, 48, 60, 84, 100]) {
    for (const vel of [0.1, 0.5, 1]) {
      const buf = struckString(grand(pitch, vel, 1.5));
      const peak = peakIn(buf, 0, buf.length);
      assert(peak <= 1, `MIDI ${pitch} at velocity ${vel} peaks at ${peak.toFixed(3)}`);
      assert(peak > 0.002, `MIDI ${pitch} at velocity ${vel} is silent (${peak.toExponential(2)})`);
    }
  }
});

check('a note costs less than the budget it is allowed', () => {
  // Every note is computed on the thread that schedules it, so this is not a
  // benchmark, it is a limit: a ten-note chord has to fit inside the time
  // before it is due to sound.  The first version of the model spent 80 ms on
  // a four-second middle C; collapsing the unison and the aftersound above
  // the partials where they are audible brought it to 17.
  const spec = grand(60, 0.85, 4);
  const runs = 5;
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) struckString(spec);
  const ms = (performance.now() - t0) / runs;
  assert(ms < 45, `a four-second middle C takes ${ms.toFixed(1)} ms to render`);
});

console.log('');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
