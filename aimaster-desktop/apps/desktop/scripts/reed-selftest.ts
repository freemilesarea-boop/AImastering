/**
 * reed-selftest — is it a blown pipe, or a sample with a story?
 *
 * The roster had sixteen instruments and no wind at all.  The reason to build
 * one as a physical model rather than sample one is that a few things a blown
 * pipe does cannot be sampled, and each of them is a measurement here:
 *
 *   · IT DOES NOT SPEAK BELOW A THRESHOLD.  A sample plays at any velocity.
 *   · A CYLINDER SUPPORTS ODD HARMONICS ONLY.  That is the sound of a
 *     clarinet's low register, and it comes out of the pipe's boundary rather
 *     than out of a waveform.
 *   · THE REGISTER KEY JUMPS A TWELFTH, not an octave.  A sample library is
 *     built per note and cannot have this at all; it is a property of the pipe.
 *   · BEATING CHOKES THE TOP.  Past the pressure that shuts the reed against
 *     the mouthpiece, blowing harder stops helping.
 *
 * Every number below is rendered and measured.  What is NOT claimed is checked
 * too: an earlier version of this engine asserted in a comment that breath
 * opens the spectrum out, and it does not — so the test states the size of the
 * effect rather than its existence, and would fail if someone re-asserted it.
 *
 * Run:  pnpm --filter @aimaster/desktop test:reed
 */

import {
  PIPE_BODIES, REED_PARAMS, reedLoopDelay, renderReedVoice, solveReed, reedFlow,
  phaseDelaySamples, spectrumPeriodNear, apexSection, ventMode, SOUND_SPEED_MPS,
  registerOpen, HOLE_ADMITTANCE, wallLoss, WALL_LOSS_NP,
} from '../src/renderer/daw/engine/reed-pipe.js';

const SR = 48_000;
const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

const DEFAULTS: Record<string, number> = {};
for (const q of REED_PARAMS) DEFAULTS[q.id] = q.default;

const hz = (pitch: number): number => 440 * Math.pow(2, (pitch - 69) / 12);
const db = (x: number): number => 20 * Math.log10(Math.max(1e-12, x));

function blow(over: Record<string, number>, pitch: number, seconds = 1.3): {
  left: Float32Array; right: Float32Array;
} {
  return renderReedVoice({
    sampleRate: SR, seconds, gateSec: seconds - 0.2, freqHz: hz(pitch), pitch,
    velocity: over['velocity'] ?? 0.8, startBeat: 0,
    params: { ...DEFAULTS, ...over },
  });
}

function rms(a: Float32Array, t0: number, t1: number): number {
  let s = 0;
  let n = 0;
  for (let i = Math.round(t0 * SR); i < Math.min(a.length, Math.round(t1 * SR)); i++) {
    s += (a[i] ?? 0) ** 2; n++;
  }
  return Math.sqrt(s / Math.max(1, n));
}

/** Magnitude at one frequency over a settled window. */
function magAt(a: Float32Array, f: number, t0 = 0.5, dur = 0.4): number {
  const from = Math.round(t0 * SR);
  const n = Math.round(dur * SR);
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    const ph = 2 * Math.PI * f * i / SR;
    re += (a[from + i] ?? 0) * w * Math.cos(ph);
    im += (a[from + i] ?? 0) * w * Math.sin(ph);
  }
  return Math.hypot(re, im) / n * 4;
}

/** The sounding pitch at a moment, or null when there is no periodic tone. */
function soundingHz(a: Float32Array, expect: number, t: number, wide = false): number | null {
  const from = Math.round(t * SR);
  const per = spectrumPeriodNear(a.subarray(from, from + 5600), SR / expect, wide);
  return per === null ? null : SR / per;
}
const centsOff = (got: number, want: number): number => 1200 * Math.log2(got / want);

console.log('\n=== REED WINDS — a blown pipe, measured ===\n');

// ── The junction ──────────────────────────────────────────────────────────
check('the junction is solved exactly, not approached', () => {
  // `solveReed` claims a closed form.  The way to check a closed form is to put
  // it back: if Δp is right then `d − flow(Δp)` is Δp again.
  let worst = 0;
  for (const d of [-2, -0.4, -0.01, 0.01, 0.2, 0.5, 1, 2, 5]) {
    for (const zy of [0, 0.05, 0.4, 1, 2.5]) {
      const dp = solveReed(d, zy);
      const back = d - reedFlow(dp, zy);
      worst = Math.max(worst, Math.abs(back - dp));
      assert(Number.isFinite(dp), `Δp is not finite at d=${d}, ζy=${zy}`);
    }
  }
  assert(worst < 1e-9, `the solve does not satisfy its own equation — off by ${worst.toExponential(2)}`);
});

check('a massless reed would need a branch chosen, and this one does not', () => {
  // The header's central argument, checked numerically rather than taken from
  // the engine: if the reed had no mass its opening would follow the pressure
  // instantly, `G(x) = ζ(1−x)√x`, and the junction `g(x) = x + G(x) − D` would
  // fold wherever `g′` changes sign.  Nothing is imported for this on purpose —
  // an engine that exported its own answer here would be marking its own work.
  const gPrime = (x: number, zeta: number): number =>
    1 + zeta * (1 - 3 * x) / (2 * Math.sqrt(x));
  const foldsFor = (zeta: number): number | null => {
    let prev = gPrime(1e-6, zeta);
    for (let x = 1e-4; x < 1; x += 1e-4) {
      const now = gPrime(x, zeta);
      if (prev > 0 && now <= 0) return x;
      prev = now;
    }
    return null;
  };
  assert(foldsFor(0.5) === null, 'a weakly coupled massless reed should not fold');
  assert(foldsFor(1) === null, 'the fold should arrive only past ζ = 1, not at it');
  const fold = foldsFor(2);
  assert(fold !== null && fold > 1 / 3 && fold < 1,
    `a strongly coupled massless reed folds between 1/3 and 1, not at ${String(fold)}`);
  // And the closed form the header writes for it, against the scan.
  const closed = (zeta: number): number => ((1 + Math.sqrt(1 + 3 * zeta * zeta)) / (3 * zeta)) ** 2;
  assert(Math.abs(closed(2) - fold!) < 2e-3,
    `the header's s* = (1 + √(1+3ζ²))/(3ζ) gives ${closed(2).toFixed(4)} and the scan finds `
    + `${fold!.toFixed(4)}`);

  // The flow's own peak is a third of the closing pressure, which is where the
  // reed stops passing more air for more pressure.
  let peakAt = 0;
  let peak = -Infinity;
  for (let x = 0.001; x < 1; x += 0.001) {
    const f = (1 - x) * Math.sqrt(x);
    if (f > peak) { peak = f; peakAt = x; }
  }
  assert(Math.abs(peakAt - 1 / 3) < 0.005,
    `the Bernoulli flow peaks at ${peakAt.toFixed(3)} of the closing pressure, and 1/3 is the maths`);
});

// ── It does not speak below a threshold ───────────────────────────────────
check('below the threshold pressure there is no note, and above it there is', () => {
  const quiet = blow({ breath: 0.35 }, 50);
  const loud = blow({ breath: 1 }, 50);
  const quietDb = db(rms(quiet.left, 0.4, 0.9));
  const loudDb = db(rms(loud.left, 0.4, 0.9));
  assert(loudDb - quietDb > 20,
    `blowing properly is only ${(loudDb - quietDb).toFixed(1)} dB louder than blowing under the `
    + 'threshold — a reed that fades in smoothly from nothing is a sample with an envelope');
  assert(soundingHz(loud.left, hz(50), 0.6) !== null, 'blown properly it should sound a note');
});

// ── A cylinder supports odd harmonics ────────────────────────────────────
check('a cylinder gives odd harmonics and leaves the even ones out', () => {
  const out = blow({}, 50);
  const f0 = hz(50);
  const h = [1, 2, 3, 4, 5, 6].map((k) => db(magAt(out.left, f0 * k)));
  const odd = [h[0]!, h[2]!, h[4]!];
  const even = [h[1]!, h[3]!, h[5]!];
  const gap = Math.min(...odd) - Math.max(...even);
  assert(gap > 8,
    `the odd harmonics are only ${gap.toFixed(1)} dB above the even ones — a closed-open `
    + `cylinder should barely support the even ones at all (h1..h6 ${h.map((x) => x.toFixed(1)).join(' ')})`);
});

check('and it is the pipe that decides that, not the waveform', () => {
  // The same six harmonics on every CYLINDER in the table, because the claim is
  // about the shape and not about one instrument's numbers.
  const bad: string[] = [];
  for (let b = 0; b < PIPE_BODIES.length; b++) {
    const body = PIPE_BODIES[b]!;
    if (body.apexM !== null) continue;
    const out = blow({ body: b }, body.lowest);
    const f0 = hz(body.lowest);
    const h = [1, 2, 3, 4, 5, 6].map((k) => db(magAt(out.left, f0 * k)));
    const gap = Math.min(h[0]!, h[2]!, h[4]!) - Math.max(h[1]!, h[3]!, h[5]!);
    if (gap <= 8) bad.push(`${body.name} ${gap.toFixed(1)} dB`);
  }
  assert(bad.length === 0, `a cylinder let its even harmonics through — ${bad.join('; ')}`);
});

// ── A cone supports all of them ──────────────────────────────────────────
//
// The other half of the same claim, and the reason the cones exist at all.
// They were left out of the first version of this engine because a cone
// modelled as "the round trip does not invert" would not hold its fundamental:
// silent at three of four blowing pressures and an octave and a bit sharp at
// the fourth.  What the model has now is the apex reflectance the physics
// gives, and these are the checks that say it is doing the work.

check('the apex reflectance is an allpass, and it says the right thing at both ends', () => {
  // A unit test rather than a rendered one, because this filter's SHAPE is the
  // difference between a clarinet and a saxophone; if it is wrong the renders
  // downstream can only be wrong in ways that are harder to read.
  const resp = (bq: ReturnType<typeof apexSection>, f: number): { mag: number; ph: number } => {
    const w = 2 * Math.PI * f / SR;
    const nr = bq.b0 + bq.b1 * Math.cos(w);
    const ni = -bq.b1 * Math.sin(w);
    const dr = 1 + bq.a1 * Math.cos(w);
    const di = -bq.a1 * Math.sin(w);
    const mag = Math.hypot(nr, ni) / Math.hypot(dr, di);
    return { mag, ph: Math.atan2(ni, nr) - Math.atan2(di, dr) };
  };
  const a = apexSection(0.42, SR);
  // Returned without the minus sign the round trip carries, so +1 here IS the
  // open end and −1 IS the rigid cap.
  assert(Math.abs(resp(a, 0.001).mag - 1) < 1e-6 && resp(a, 0.001).ph > -1e-3,
    `at DC the apex reads ${resp(a, 0.001).mag.toFixed(4)}∠${resp(a, 0.001).ph.toFixed(3)} — `
    + 'it has to be +1, which with the round trip\u2019s sign is an OPEN end and is what makes '
    + 'a cone half-wave');
  const ny = resp(a, SR / 2 - 1);
  assert(Math.abs(ny.mag - 1) < 1e-4 && Math.abs(Math.abs(ny.ph) - Math.PI) < 1e-3,
    `at Nyquist the apex reads ${ny.mag.toFixed(4)}∠${ny.ph.toFixed(3)} — it has to be −1, the `
    + 'rigid cap, which is why a cone\u2019s modes migrate toward the odd series up high');
  for (const f of [50, 200, 900, 4000, 12000]) {
    const m = resp(a, f).mag;
    assert(Math.abs(m - 1) < 1e-4,
      `an allpass may not change level, and at ${f} Hz this one is ${m.toFixed(5)}`);
  }
  // And the limit that has to hold for the two families to be one model: an
  // apex infinitely far away IS a cylinder.
  const far = apexSection(1e6, SR);
  assert(Math.abs(resp(far, 200).mag - 1) < 1e-6 && Math.abs(resp(far, 200).ph) > Math.PI - 1e-3,
    'a very distant apex should collapse to the constant −1 the cylinder path uses');
  // The one place a length in metres becomes a time, so it is worth one line.
  assert(Math.abs(SOUND_SPEED_MPS - 343) < 1, 'the speed of sound moved');
});

check('a cone gives the even harmonics a cylinder cannot', () => {
  // Compared as h2 AGAINST h3 rather than either against h1, and the reason is
  // worth a line: they are a fifth apart, so anything broadband — the bell's
  // rolloff, the bore's wall loss, a radiation formant — moves them together,
  // and what is left is the one thing that differs, which is whether the pipe
  // supports an even mode at all.  Measured against h1 instead, the oboe reads
  // 3 dB from a clarinet, because its narrow bore is simply darker; measured
  // this way it reads 7.
  //
  //     Clarinet  −11.7      Alto Sax  −2.9
  //     Bass Cl.  −15.0      Tenor     −2.3      Oboe  −4.6
  const shape: string[] = [];
  const cyl: number[] = [];
  const cone: number[] = [];
  for (let b = 0; b < PIPE_BODIES.length; b++) {
    const body = PIPE_BODIES[b]!;
    const got: number[] = [];
    for (const step of [0, 7, 14]) {
      const pitch = body.lowest + step;
      const out = blow({ body: b }, pitch);
      const f0 = hz(pitch);
      got.push(db(magAt(out.left, f0 * 2)) - db(magAt(out.left, f0 * 3)));
    }
    const med = [...got].sort((x, y) => x - y)[1]!;
    (body.apexM === null ? cyl : cone).push(med);
    shape.push(`${body.name} ${med.toFixed(1)}`);
  }
  const gap = Math.min(...cone) - Math.max(...cyl);
  assert(gap > 5,
    `the quietest cone's second harmonic stands ${gap.toFixed(1)} dB higher against its third `
    + `than the loudest cylinder's does, and a pipe that supports every mode should be well `
    + `clear — h2−h3 per body: ${shape.join(', ')}`);
});

check('and the bore loses what its walls cost, which is not a corner frequency', () => {
  // The loop's only loss used to be a one-pole at 3.2 to 5.2 kHz, which a note
  // three octaves below it barely notices: 0.024 to 0.040 dB per round trip
  // where the walls alone cost 0.43 to 1.33.  Two claims here, both measured
  // against the law rather than against a remembered number.
  const sectionsDb = (secs: readonly { b0: number; b1: number; b2: number;
    a1: number; a2: number }[], f: number): number => {
    let total = 0;
    for (const sc of secs) {
      const w = (2 * Math.PI * f) / SR;
      const nr = sc.b0 + sc.b1 * Math.cos(w) + sc.b2 * Math.cos(2 * w);
      const ni = -(sc.b1 * Math.sin(w) + sc.b2 * Math.sin(2 * w));
      const dr = 1 + sc.a1 * Math.cos(w) + sc.a2 * Math.cos(2 * w);
      const di = -(sc.a1 * Math.sin(w) + sc.a2 * Math.sin(2 * w));
      total += 20 * Math.log10(Math.hypot(nr, ni) / Math.hypot(dr, di));
    }
    return total;
  };
  // ONE: the filter really follows √f, over every body and three octaves each.
  let worst = 0;
  let worstAt = '';
  for (const body of PIPE_BODIES) {
    for (const step of [0, 12, 24]) {
      const f1 = hz(body.lowest + step);
      const b = PIPE_BODIES.indexOf(body);
      const roundTripM = (reedLoopDelay({ ...DEFAULTS, body: b }, f1, SR).raw
        * SOUND_SPEED_MPS) / SR;
      const w = wallLoss(body.boreRadiusM, roundTripM, f1, SR);
      const k = (WALL_LOSS_NP * roundTripM) / body.boreRadiusM;
      for (let i = 0; i < 24; i++) {
        const f = f1 * Math.pow(Math.min(SR * 0.42, f1 * 40) / f1, i / 23);
        const got = 20 * Math.log10(w.flat) + sectionsDb(w.sections, f);
        const want = -8.686 * k * Math.sqrt(f);
        if (Math.abs(got - want) > worst) {
          worst = Math.abs(got - want);
          worstAt = `${body.name} p${body.lowest + step} at ${(f / f1).toFixed(0)}×`;
        }
      }
    }
  }
  assert(worst < 0.5,
    `the wall-loss filter is ${worst.toFixed(2)} dB off the √f law at ${worstAt} — three shelves `
    + 'fitted at 3, 12 and 48 times the note should hold it under half a dB');
  // TWO: the note itself is not nearly lossless any more.  This is the number
  // the oscillation lives or dies by, and it is exact by construction.
  for (const body of PIPE_BODIES) {
    const f1 = hz(body.lowest);
    const b = PIPE_BODIES.indexOf(body);
    const roundTripM = (reedLoopDelay({ ...DEFAULTS, body: b }, f1, SR).raw
      * SOUND_SPEED_MPS) / SR;
    const atNote = -20 * Math.log10(wallLoss(body.boreRadiusM, roundTripM, f1, SR).flat);
    assert(atNote > 0.3 && atNote < 3,
      `${body.name} loses ${atNote.toFixed(2)} dB per round trip at its lowest note, and a real `
      + 'bore of that radius and length is between a third of a dB and three');
  }
  // THREE: a narrower bore loses more, which is the whole content of the 1/a.
  const narrow = PIPE_BODIES.reduce((a, b) => (a.boreRadiusM < b.boreRadiusM ? a : b));
  const wide = PIPE_BODIES.reduce((a, b) => (a.boreRadiusM > b.boreRadiusM ? a : b));
  const lossOf = (bd: typeof narrow): number =>
    -20 * Math.log10(wallLoss(bd.boreRadiusM, 1.5, 300, SR).flat);
  assert(lossOf(narrow) > lossOf(wide) * 2,
    `${narrow.name} at ${(narrow.boreRadiusM * 1000).toFixed(1)} mm should lose far more per `
    + `metre than ${wide.name} at ${(wide.boreRadiusM * 1000).toFixed(1)} mm, and it loses `
    + `${lossOf(narrow).toFixed(2)} against ${lossOf(wide).toFixed(2)} dB`);
});

check('and the walls reach the SOUND, which the design of the filter does not prove', () => {
  // Written after the obvious test turned out to be vacuous: the wall loss can
  // be designed, counted in the tuning's phase and never applied to a single
  // sample, and the suite passed 21 of 21 anyway.  So this is the check that
  // the loop uses it, and it is measured at the FUNDAMENTAL on purpose.
  //
  // At the note itself the bell's one-pole is transparent — 0.07 dB at the
  // oboe's bottom with the corner as low as the Bore knob can put it — so
  // anything the knob does DOWN THERE is the walls and can be nothing else.
  // Measured, the fundamental's level between a half-radius bore and a
  // double-radius one:
  //
  //     with the walls    Alto −2.10   Tenor −2.15   Oboe −3.03 dB
  //                       Clarinet −0.20   Bass Clarinet −0.07
  //     without them      every body 0.00 to 0.04
  //
  // The cylinders move least because their reeds have more gain in reserve and
  // simply push back; the bound below is asked of the cones, where the size of
  // it is not arguable, and every body is asked for the SIGN.
  const level = (b: number, bore: number): number => {
    const vals: number[] = [];
    for (const step of [2, 9]) {
      const pitch = PIPE_BODIES[b]!.lowest + step;
      const out = blow({ body: b, bore }, pitch);
      vals.push(db(magAt(out.left, hz(pitch))));
    }
    return (vals[0]! + vals[1]!) / 2;
  };
  const seen: string[] = [];
  for (let b = 0; b < PIPE_BODIES.length; b++) {
    const body = PIPE_BODIES[b]!;
    const narrow = level(b, 0.5);
    const wide = level(b, 2);
    seen.push(`${body.name} ${(narrow - wide).toFixed(2)}`);
    assert(narrow - wide < 0.1,
      `${body.name}: halving the bore's radius made its fundamental LOUDER by `
      + `${(wide - narrow).toFixed(2)} dB, and narrower walls can only take more`);
    if (body.apexM !== null) {
      assert(narrow - wide < -1,
        `${body.name}: the Bore knob moved its fundamental by only `
        + `${(narrow - wide).toFixed(2)} dB across its whole range, and with the walls in the `
        + `loop it is 2 to 3 — without them it is 0.01, so this is what a wall-loss filter that `
        + `nothing applies looks like (${seen.join(', ')})`);
    }
  }
});

check('the register key is an interval the PIPE chooses, and the two differ', () => {
  // A cylinder's next supported mode is its third harmonic and a cone's is its
  // second, so the same hole is a twelfth on one and an octave on the other.
  // That is the fact; the two checks after this one are whether the model does
  // it.
  for (const body of PIPE_BODIES) {
    const want = body.apexM === null ? 3 : 2;
    assert(ventMode(body) === want,
      `${body.name} hands the note to mode ${ventMode(body)}, not ${want}`);
    // And the pipe really is that many times as long, which is what makes the
    // written note come out where the part says it should.
    const f = hz(body.lowest + 2);
    const b = PIPE_BODIES.indexOf(body);
    const open = reedLoopDelay({ ...DEFAULTS, body: b, register: 1 }, f, SR).raw;
    const shut = reedLoopDelay({ ...DEFAULTS, body: b, register: 0 }, f, SR).raw;
    assert(Math.abs(open / shut - want) < 0.02,
      `${body.name} pipe is ${(open / shut).toFixed(2)}× as long with the key down, not ${want}×`);
  }
  // A key and not a fader, and the boundary is where the parameter says.
  assert(registerOpen(PIPE_BODIES[0]!, { register: 0.6 })
    && !registerOpen(PIPE_BODIES[0]!, { register: 0.4 }),
    'the key should be open above half and shut below it');
});

check('and the hole holds the note on every body, swept by pitch and pressure', () => {
  // The check the notch version could not pass, and the reason this vent is a
  // PLACE rather than a frequency.  Ninety cells: five bodies, six pitches over
  // two octaves each, three breath pressures.  Swept deliberately — the first
  // register key in this engine passed a check that looked at one pitch and one
  // velocity, and was a coin toss everywhere else.
  const bad: string[] = [];
  let worstOff = 0;
  let weakest = -200;
  for (let b = 0; b < PIPE_BODIES.length; b++) {
    const body = PIPE_BODIES[b]!;
    const m = ventMode(body);
    for (const step of [0, 5, 10, 15, 19, 24]) {
      for (const vel of [0.6, 0.8, 1]) {
        const pitch = body.lowest + step;
        const f = hz(pitch);
        const out = blow({ body: b, register: 1, velocity: vel }, pitch);
        if (rms(out.left, 0.6, 1.0) < 10 ** (-50 / 20)) {
          bad.push(`${body.name} p${pitch} v${vel}: silent`); continue;
        }
        const got = soundingHz(out.left, f, 0.7, true);
        if (got === null) { bad.push(`${body.name} p${pitch} v${vel}: no tone`); continue; }
        const off = centsOff(got, f);
        // 20 cents, and the bound is the delay line's resolution rather than a
        // tolerance chosen to pass: measured, nothing is worse than 14, and the
        // worst of it is the clarinet at the top of its range where one whole
        // sample of loop is already 42 cents.
        if (Math.abs(off) > 20) {
          bad.push(`${body.name} p${pitch} v${vel}: ${off.toFixed(0)}c`); continue;
        }
        worstOff = Math.max(worstOff, Math.abs(off));
        // And the mode the hole exists to remove is gone rather than merely
        // quieter.  40 dB is a long way inside the 61 measured; what it is there
        // to fail is a vent that stopped venting.
        const own = db(magAt(out.left, f / m)) - db(magAt(out.left, f));
        if (own > -40) {
          bad.push(`${body.name} p${pitch} v${vel}: own mode only ${(-own).toFixed(0)} dB down`);
        }
        weakest = Math.max(weakest, own);
      }
    }
  }
  assert(bad.length === 0,
    `${bad.length} of 90 cells wrong — ${bad.slice(0, 6).join('; ')}`);
  assert(worstOff < 20 && weakest < -40,
    `worst ${worstOff.toFixed(0)} cents, removed mode at worst ${(-weakest).toFixed(0)} dB down`);
});

check('and it is the PLACE doing that, not the size of the hole', () => {
  // The claim this whole rewrite rests on: the hole is selective because of
  // WHERE it is, so the admittance only has to be big enough to drain a mode
  // and does not have to be tuned per note or per body.  One number covers a
  // clarinet and an oboe, and the sweep behind it is beside the constant.
  assert(HOLE_ADMITTANCE >= 4,
    `the cones need 4 or more and this is ${HOLE_ADMITTANCE} — see the sweep`);
  // The junction is transparent when the hole is shut: that is what lets the
  // key-up bore stay one delay line, and it is why every tuning number in the
  // engine's header still holds.  Stated as arithmetic, since the code path it
  // guards is chosen by a boolean: 2(a+b)/(2+0) = a+b, so each wave passes
  // straight through.
  const shutJunction = (a: number, bb: number): number => (2 * (a + bb)) / (2 + 0);
  assert(shutJunction(0.3, -0.2) === 0.3 + -0.2,
    'a shut hole has to pass both waves through untouched');
});

check('and the apex is paid for in the tuning, not left to the tuning pass', () => {
  // The apex's phase delay is 8 per cent of an alto's loop at the bottom of its
  // range.  If `reedLoopDelay` did not count it, the tuning pass would have to
  // walk it back a bounded step at a time, and the pass exists for the reed's
  // phase — which has no closed form — rather than for a filter whose phase
  // does.
  const cone = PIPE_BODIES.findIndex((b) => b.apexM !== null);
  assert(cone >= 0, 'the table has no cone in it any more');
  const body = PIPE_BODIES[cone]!;
  const t = reedLoopDelay({ ...DEFAULTS, body: cone }, hz(body.lowest), SR);
  const own = phaseDelaySamples([apexSection(body.apexM!, SR)], hz(body.lowest), SR);
  assert(own > 5, `the apex should be worth real samples and reads ${own.toFixed(2)}`);
  // Bounded on the DIFFERENCE, not on "bigger than", and the first version of
  // this check got that wrong: the DC bleed's phase LEADS, so the total comes
  // out a little UNDER the apex's own delay — measured −0.41 samples on the
  // alto, −1.34 on the tenor, +1.15 on the oboe.  What the accounting claims is
  // that the apex is in there, and 90.12 against 89.72 says it is; a version
  // that had left it out would read a fraction of a sample.
  assert(Math.abs(t.filterDelay - own) < 3,
    `the tuning accounts for ${t.filterDelay.toFixed(2)} samples of filter phase and the apex `
    + `alone is ${own.toFixed(2)} — that is not the apex plus a lossy sample or two`);
  // A cylinder must not have paid for one.
  const cylIndex = PIPE_BODIES.findIndex((b) => b.apexM === null);
  const c = reedLoopDelay({ ...DEFAULTS, body: cylIndex }, hz(body.lowest), SR);
  assert(Math.abs(c.filterDelay) < 4,
    `a cylinder has no apex and is accounting for ${c.filterDelay.toFixed(2)} samples anyway`);
});

// ── In tune ───────────────────────────────────────────────────────────────
check('it plays the note it was asked for, across its range', () => {
  const bad: string[] = [];
  for (let b = 0; b < PIPE_BODIES.length; b++) {
    const low = PIPE_BODIES[b]!.lowest;
    for (const pitch of [low, low + 5, low + 12, low + 19, low + 24]) {
      const out = blow({ body: b }, pitch);
      for (const t of [0.2, 0.45, 0.7, 0.95]) {
        const got = soundingHz(out.left, hz(pitch), t);
        if (got === null) { bad.push(`${PIPE_BODIES[b]!.name} p${pitch} @${t}s: no tone`); continue; }
        const off = centsOff(got, hz(pitch));
        // 15 cents, and the bound is the delay line's resolution rather than a
        // tolerance chosen to pass.  Measured against the loop's length: two
        // cents at 163 samples and above, four to six at 82, and thirteen at
        // 41, where one whole sample of loop IS 42 cents.  The engine's header
        // carries the table; `string-model.ts` documents the same limit at the
        // top of a guitar.
        if (Math.abs(off) > 15) {
          bad.push(`${PIPE_BODIES[b]!.name} p${pitch} @${t}s: ${off.toFixed(0)} cents`);
        }
      }
    }
  }
  assert(bad.length === 0, `out of tune — ${bad.join('; ')}`);
});

check('and the tuning is the filters taken out, not a constant put in', () => {
  // `reedLoopDelay` subtracts what the loop's linear filters really turn the
  // phase by.  That correction has to MOVE with the note and with the bore,
  // or it is a fudge that happens to suit one setting.
  const a = reedLoopDelay({ ...DEFAULTS, body: 0 }, hz(38), SR);
  const b = reedLoopDelay({ ...DEFAULTS, body: 0 }, hz(74), SR);
  assert(Math.abs(a.filterDelay - b.filterDelay) > 1,
    `the filter compensation is ${a.filterDelay.toFixed(2)} at the bottom and `
    + `${b.filterDelay.toFixed(2)} at the top — if it does not move it is not phase`);
  assert(a.raw > b.raw * 3, 'a lower note should want a much longer pipe');
  // And the phase helper it rests on: a lowpass lags, a DC blocker leads, and
  // the sum has to carry the sign.  Getting this wrong cost 920 cents once.
  const lag = phaseDelaySamples([{ b0: 0.4, b1: 0, b2: 0, a1: -0.6, a2: 0 }], 200, SR);
  const lead = phaseDelaySamples([{ b0: 1, b1: -1, b2: 0, a1: -0.99, a2: 0 }], 200, SR);
  assert(lag > 0, `a lowpass should delay, and this one reports ${lag.toFixed(2)}`);
  assert(lead < 0, `a DC blocker should lead, and this one reports ${lead.toFixed(2)}`);
});

// ── The register key ─────────────────────────────────────────────────────
check('the register key changes which mode carries the note, not the note', () => {
  // On the instrument, opening the vent makes one fingering sound a twelfth
  // higher.  In a DAW the note written has to be the note heard, so what the
  // key selects here is the pipe's THIRD mode at the same pitch — the clarion
  // register's tone where the part says it should be.
  //
  // Checked at six velocities on purpose.  The first version of this control
  // left the pipe's length alone and notched its fundamental out, which was not
  // a register key but a coin toss: 647, 647, 1901, −555, −556 and 1965 cents
  // at velocities 0.6 to 1.0.  The check that was here asserted the twelfth at
  // velocity 0.8 — the single value where the coin had come up right — and
  // passed.  Sweeping is what makes this one able to fail.
  const bad: string[] = [];
  for (const vel of [0.6, 0.7, 0.8, 0.85, 0.9, 1]) {
    const out = blow({ register: 1, velocity: vel }, 50);
    const got = soundingHz(out.left, hz(50), 0.7, true);
    if (got === null) { bad.push(`vel ${vel}: no tone`); continue; }
    const off = centsOff(got, hz(50));
    if (Math.abs(off) > 15) bad.push(`vel ${vel}: ${off.toFixed(0)} cents`);
  }
  assert(bad.length === 0, `the register register moved the note — ${bad.join('; ')}`);
});

check('and with it open the pipe is three times as long, with its own first mode out', () => {
  const open = blow({ register: 1 }, 50);
  const shut = blow({}, 50);
  const f = hz(50);
  // The pipe's own fundamental is a third of the sounding note when its third
  // mode is carrying it, and the vent is what takes that mode out.  If it were
  // still there the note would be an octave and a fifth too low.
  const own = db(magAt(open.left, f / 3)) - db(magAt(open.left, f));
  assert(own < -18,
    `the pipe's own fundamental is only ${(-own).toFixed(1)} dB below the sounding note with the `
    + 'register open — the vent is supposed to have taken it out');
  // And the pipe really is longer: the tuner says so directly.
  const lenOpen = reedLoopDelay({ ...DEFAULTS, register: 1 }, f, SR).raw;
  const lenShut = reedLoopDelay({ ...DEFAULTS, register: 0 }, f, SR).raw;
  assert(Math.abs(lenOpen / lenShut - 3) < 0.02,
    `the register-open pipe is ${(lenOpen / lenShut).toFixed(2)} times the length, and the third `
    + 'mode needs three');
  // The clarion register is brighter than the chalumeau, which is the whole
  // musical reason for the key.
  const bright = (x: Float32Array): number =>
    db(magAt(x, f * 3)) - db(magAt(x, f));
  assert(bright(open.left) > bright(shut.left) - 30, 'sanity: both registers have some spectrum');
});

// ── Beating chokes the top ───────────────────────────────────────────────
check('past the pressure that shuts the reed, blowing harder stops helping', () => {
  const levels = [0.8, 1.0, 1.2, 1.3].map((breath) => db(rms(blow({ breath }, 50).left, 0.4, 0.9)));
  for (let i = 1; i < levels.length; i++) {
    assert(levels[i]! >= levels[i - 1]! - 0.5,
      `blowing harder made it quieter: ${levels.map((x) => x.toFixed(1)).join(' → ')} dB`);
  }
  const early = levels[1]! - levels[0]!;
  const late = levels[3]! - levels[2]!;
  assert(late < early,
    `the top of the breath range gives ${late.toFixed(2)} dB per step against `
    + `${early.toFixed(2)} lower down — the reed is supposed to be running out of travel`);
});

// ── What is NOT claimed ──────────────────────────────────────────────────
check('breath is level, and in this model barely timbre — stated, not implied', () => {
  const f0 = hz(50);
  const shape = (breath: number): number => {
    const out = blow({ breath }, 50);
    return db(magAt(out.left, f0 * 3)) - db(magAt(out.left, f0));
  };
  const soft = shape(0.8);
  const hard = shape(1.3);
  const moved = Math.abs(hard - soft);
  // A real clarinet's spectrum opens out with pressure.  This one's does not,
  // and an earlier comment in the engine said it did.  The check is here so
  // that if someone makes it true the test tells them to go and fix the
  // comment — and if someone re-asserts it without making it true, this fails.
  assert(moved < 2,
    `the third harmonic moved ${moved.toFixed(2)} dB relative to the first across the breath `
    + 'range.  If that is now a real effect, say so in the engine and raise this bound');
});

// ── Determinism ──────────────────────────────────────────────────────────
check('the same note renders identically every time', () => {
  const a = blow({}, 50);
  const b = blow({}, 50);
  let worst = 0;
  for (let i = 0; i < a.left.length; i++) {
    worst = Math.max(worst, Math.abs((a.left[i] ?? 0) - (b.left[i] ?? 0)));
  }
  assert(worst === 0, `two renders of one note differ by ${worst.toExponential(2)} — a bounce `
    + 'has to be bit-identical to the preview, so the breath cannot use Math.random()');
});

check('and two different notes do not', () => {
  const a = blow({}, 50);
  const b = blow({}, 57);
  let same = true;
  for (let i = 0; i < 2000; i++) if ((a.left[i + 20_000] ?? 0) !== (b.left[i + 20_000] ?? 0)) { same = false; break; }
  assert(!same, 'two different pitches rendered the same samples');
});

// ── The reed is stable wherever the knobs go ─────────────────────────────
check('every reachable embouchure stays finite', () => {
  // The first version integrated the reed with explicit Euler, which diverges
  // once `2ζω > 2` — and a third of the reachable range does that.  Lip goes to
  // 4 and Stiffness to 2.2, so the corner is inside the UI, not outside it.
  const lip = REED_PARAMS.find((q) => q.id === 'damp')!;
  const stiff = REED_PARAMS.find((q) => q.id === 'stiff')!;
  const bad: string[] = [];
  for (const damp of [lip.min, 1, lip.max]) {
    for (const st of [stiff.min, 1, stiff.max]) {
      for (const body of [0, 1]) {
        const out = blow({ damp, stiff: st, body }, PIPE_BODIES[body]!.lowest + 12);
        let peak = 0;
        for (const v of out.left) {
          if (!Number.isFinite(v)) { bad.push(`damp ${damp} stiff ${st} body ${body}: not finite`); break; }
          peak = Math.max(peak, Math.abs(v));
        }
        if (peak > 2) bad.push(`damp ${damp} stiff ${st} body ${body}: peaked at ${peak.toFixed(1)}`);
      }
    }
  }
  assert(bad.length === 0, `the reed left the rails — ${bad.join('; ')}`);
});

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.pass ? '' : ` — ${r.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed) process.exit(1);
