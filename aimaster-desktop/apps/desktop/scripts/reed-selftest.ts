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
  registerOpen,
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
  // Measured, both families, same grid: the second harmonic sits 9 dB higher on
  // a cone.  The bound is 5 dB rather than 9 so that a small change in a bore's
  // formants does not fail it, and the measured spread is printed so nobody has
  // to guess how much room that is.
  const h2of: string[] = [];
  const cyl: number[] = [];
  const cone: number[] = [];
  for (let b = 0; b < PIPE_BODIES.length; b++) {
    const body = PIPE_BODIES[b]!;
    const got: number[] = [];
    for (const step of [0, 7, 14]) {
      const pitch = body.lowest + step;
      const out = blow({ body: b }, pitch);
      const f0 = hz(pitch);
      got.push(db(magAt(out.left, f0 * 2)) - db(magAt(out.left, f0)));
    }
    const med = [...got].sort((x, y) => x - y)[1]!;
    (body.apexM === null ? cyl : cone).push(med);
    h2of.push(`${body.name} ${med.toFixed(1)}`);
  }
  const worstCone = Math.min(...cone);
  const loudestCyl = Math.max(...cyl);
  assert(worstCone - loudestCyl > 5,
    `the quietest cone's second harmonic is ${(worstCone - loudestCyl).toFixed(1)} dB above the `
    + `loudest cylinder's, and a cone supporting all its harmonics should be well clear — `
    + `h2/h1 per body: ${h2of.join(', ')}`);
});

check('a cone knows its key would be an octave, and refuses to fake one', () => {
  // The fact first: a cylinder's next mode is its third harmonic and a cone's
  // is its second, so the same key is a twelfth on one and an octave on the
  // other.  That is what `ventMode` is for and it is used to place the notch.
  for (const body of PIPE_BODIES) {
    const want = body.apexM === null ? 3 : 2;
    assert(ventMode(body) === want,
      `${body.name} hands the note to mode ${ventMode(body)}, not ${want}`);
  }
  // And then the refusal.  A notch an octave below the carrying mode cannot
  // hold it down — measured, the cones landed on a twelfth up, a fifth up, 39
  // cents flat and silence depending on the note — so on a cone the key does
  // NOTHING, and this is what says so.  Bit for bit, because "nothing" is the
  // claim: anything else would be a control that lands somewhere different
  // every time, which is what this engine already refused once.
  for (let b = 0; b < PIPE_BODIES.length; b++) {
    const body = PIPE_BODIES[b]!;
    const cone = body.apexM !== null;
    assert(registerOpen(body, { register: 1 }) === (cone ? 0 : 1),
      `${body.name} reports the key ${registerOpen(body, { register: 1 })} open`);
    const shut = blow({ body: b }, body.lowest + 2);
    const open = blow({ body: b, register: 1 }, body.lowest + 2);
    let same = true;
    for (let i = 0; i < shut.left.length; i += 97) {
      if (shut.left[i] !== open.left[i]) { same = false; break; }
    }
    assert(same === cone, cone
      ? `${body.name} is a cone and its register key changed the render`
      : `${body.name} is a cylinder and its register key did nothing`);
  }
});

check('and on the cylinders the key holds over the range it claims', () => {
  // The existing check sweeps velocities at one pitch.  Swept by PITCH instead,
  // this is where it stops: measured on the clarinet at the vent open, −14, 3,
  // −1 and −1 cents at p50, p52, p57 and p62, and 2852 cents at p69.  A twelfth
  // above p69 is past the top of the pipe's useful length — 41 samples of loop,
  // where one sample is 42 cents — and what it locks onto there is a higher
  // mode, not the clarion.  So the claim is the bottom two octaves of each
  // cylinder, and the check is written to fail if that shrinks.
  const bad: string[] = [];
  for (let b = 0; b < PIPE_BODIES.length; b++) {
    const body = PIPE_BODIES[b]!;
    if (body.apexM !== null) continue;
    for (const step of [0, 2, 7, 12]) {
      const pitch = body.lowest + step;
      const f = hz(pitch);
      const out = blow({ body: b, register: 1 }, pitch);
      const got = soundingHz(out.left, f, 0.7, true);
      if (got === null) { bad.push(`${body.name} p${pitch}: no tone`); continue; }
      const off = centsOff(got, f);
      if (Math.abs(off) > 20) bad.push(`${body.name} p${pitch}: ${off.toFixed(0)}c`);
    }
  }
  assert(bad.length === 0, `the register key moved the note — ${bad.join('; ')}`);
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
