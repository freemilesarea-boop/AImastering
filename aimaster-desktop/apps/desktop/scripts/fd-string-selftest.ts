/**
 * fd-string-selftest — is it a string in space, or arithmetic with a story?
 *
 * There were already two string models here and both are better than this one
 * at what they do: `string-model.ts` is a delay line, exactly in tune and
 * cheap, and `struck-string.ts` is additive, placing each partial at
 * `n·f₁√(1+Bn²)` with its own decay.  So a spatial string has to justify
 * itself, and exactly one thing does — a frequency that moves DURING the note.
 * Pull a wire aside and it gets longer, which means tighter, which means
 * sharper, so a hard pluck starts sharp and glides down as it decays.  Neither
 * a delay line nor a sum of partials can do that, because both decide their
 * frequencies before the note starts.
 *
 * So the measurements below are, in order: that the numerics are sound at all,
 * and then that the one thing this engine is for actually happens.
 *
 *   · THE SCHEME IS THE SCHEME.  Measured partials against the exact discrete
 *     dispersion relation, not against a hope.
 *   · IT CONSERVES ENERGY.  Lossless, to three decimal places, with the
 *     nonlinear tension term running — and the RULER is checked too, against an
 *     amplitude law and a T60 it cannot fake.
 *   · THE KNOB MEANS CENTS.  Asked for n cents of bite, the pitch starts n
 *     cents sharp, at four pitches.
 *   · HARDER IS SHARPER, AS THE SQUARE.  Which is the musical half of it: one
 *     gesture gives loudness and bend together.
 *   · IT COMES BACK.  The glide ends at the nominal pitch, not beside it.
 *
 * What is NOT claimed is checked too.  The stiffness term runs LOW against the
 * ideal stiff string, and by more as the grid coarsens; the test states the size
 * of that gap rather than pretending it is not there, and would fail if someone
 * re-tuned the term to hide it.
 *
 * Run:  pnpm --filter @aimaster/desktop test:fd-string
 */

import {
  CLAV_BODIES, CLAV_PARAMS, CLAV_STIFF_MAX, FD_TENSION_MAX_CENTS,
  FD_TENSION_PEAK_ROOM, fdCourantLimit, fdGrid, fdLosses, fdStiffMu,
  fdString, renderClavVoice, type FdStringOptions,
} from '../src/renderer/daw/engine/fd-string.js';

const SR = 48_000;
const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

const hz = (pitch: number): number => 440 * Math.pow(2, (pitch - 69) / 12);

const DEFAULTS: Record<string, number> = { level: 0.7 };
for (const q of CLAV_PARAMS) DEFAULTS[q.id] = q.default;

const plain = (over: Partial<FdStringOptions> = {}): FdStringOptions => ({
  freqHz: hz(48), sampleRate: SR, seconds: 1.6, pickPosition: 0.25, pickWidth: 0.05,
  amplitude: 1, lowT60: 3, highT60: 1.5, inharmonic: 0, tensionCents: 0, ...over,
});

// ── The measuring instruments, and why they are written this way ─────────────

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
      const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const c = Math.cos(ang * k); const si = Math.sin(ang * k);
        const ur = re[i + k]!; const ui = im[i + k]!;
        const vr = re[i + k + len / 2]! * c - im[i + k + len / 2]! * si;
        const vi = re[i + k + len / 2]! * si + im[i + k + len / 2]! * c;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
      }
    }
  }
}

function spectrum(a: Float32Array, from: number, len: number): Float64Array {
  const n = 1 << Math.ceil(Math.log2(len * 4));
  const re = new Float64Array(n); const im = new Float64Array(n);
  for (let i = 0; i < len; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1));
    re[i] = (a[from + i] ?? 0) * w;
  }
  fft(re, im);
  const mag = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i]!, im[i]!);
  return mag;
}

/**
 * The peak nearest `want`, parabolically interpolated on the log magnitude.
 *
 * The denominator `l − 2c + r` is NEGATIVE at a peak.  Clamped to a small
 * POSITIVE number, which is what this was written as first, the interpolated
 * frequency goes to 1e30 and poisons every cents figure computed against it —
 * that bug once read a correct stiffness term as 55 cents wrong and had it
 * rewritten twice before the probe was suspected.
 */
function partial(mag: Float64Array, want: number, span: number): number {
  const binHz = SR / (mag.length * 2);
  const lo = Math.max(1, Math.round((want - span) / binHz));
  const hi = Math.min(mag.length - 2, Math.round((want + span) / binHz));
  let best = lo;
  for (let i = lo; i <= hi; i++) if (mag[i]! > mag[best]!) best = i;
  const l = Math.log(Math.max(1e-30, mag[best - 1]!));
  const c = Math.log(Math.max(1e-30, mag[best]!));
  const r = Math.log(Math.max(1e-30, mag[best + 1]!));
  const den = l - 2 * c + r;
  const d = Math.abs(den) < 1e-30 ? 0 : Math.max(-1, Math.min(1, (0.5 * (l - r)) / den));
  return (best + d) * binHz;
}

/**
 * Pitch against time, from interpolated zero crossings of a resonator-filtered
 * copy.  A spectral window long enough to resolve an 82 Hz fundamental is 170
 * ms wide, and the glide this engine exists for happens inside that — measured
 * spectrally, a 200-cent bite read as 74.
 *
 * ── What this cannot read, which decides where it may be used ──────────────
 *
 * It needs the FUNDAMENTAL to be strongly excited.  Plucked at 0.12 of its
 * length, which is where the Clavinet body's pad sits, the fundamental is weak
 * and this read a 95-cent bite as 471.  Narrowing the resonator until it
 * isolates the fundamental fixes the selectivity and breaks the timing — a
 * band of a tenth of the pitch needs ten periods to settle, by which time the
 * glide is over, and the same note then read 11 cents.  Tracking a higher
 * partial instead, whose cents shift is identical, is worse again: at three
 * times the pitch the same Q spans the neighbours, and two bodies read −87 and
 * −225 cents.
 *
 * So every check below that reads an absolute number in cents plucks the string
 * near a quarter of its length, and says so.
 */
function pitchTrack(a: Float32Array, f0: number): { t: number; cents: number }[] {
  const r = Math.exp((-Math.PI * f0 * 0.5) / SR);
  const b1 = 2 * r * Math.cos((2 * Math.PI * f0) / SR);
  const b2 = -r * r;
  const y = new Float64Array(a.length);
  let y1 = 0; let y2 = 0;
  for (let i = 0; i < a.length; i++) {
    const v = (a[i] ?? 0) * (1 - r) + b1 * y1 + b2 * y2;
    y[i] = v; y2 = y1; y1 = v;
  }
  // Skip the resonator's own startup: before it has rung for two periods its
  // output is its impulse response and not the signal's pitch, and reading it
  // gave a string with NO tension a first period 660 cents sharp — identically
  // at three different pitches, which is the signature of one bad crossing pair.
  const settle = Math.round((2 * SR) / f0);
  let peak = 0;
  for (let i = settle; i < y.length; i++) peak = Math.max(peak, Math.abs(y[i]!));
  const floor = peak * 1e-3;
  const cross: number[] = [];
  for (let i = settle + 1; i < y.length; i++) {
    if (y[i - 1]! <= 0 && y[i]! > 0 && Math.abs(y[i]!) > floor) {
      const d = y[i]! - y[i - 1]!;
      cross.push(i - 1 + (d === 0 ? 0 : -y[i - 1]! / d));
    }
  }
  const out: { t: number; cents: number }[] = [];
  for (let i = 1; i < cross.length; i++) {
    const period = (cross[i]! - cross[i - 1]!) / SR;
    if (period <= 0) continue;
    const cents = 1200 * Math.log2(1 / period / f0);
    // A resonator locked to f0 cannot honestly report an octave away; anything
    // that does is a dropped or doubled crossing in the quiet tail.
    if (Math.abs(cents) > 700) continue;
    out.push({ t: cross[i - 1]! / SR, cents });
  }
  return out;
}

/** The median pitch over a window — a median, because one bad period is one. */
function pitchOver(a: Float32Array, f0: number, from: number, to: number): number {
  const v = pitchTrack(a, f0).filter((p) => p.t >= from && p.t < to)
    .map((p) => p.cents).sort((x, y) => x - y);
  assert(v.length >= 2, `no pitch to read between ${from} and ${to} s`);
  return v[Math.floor(v.length / 2)]!;
}

/**
 * The pitch at the START of the note: the median of the first few periods the
 * tracker can read at all.
 *
 * Counted in PERIODS rather than seconds because the resonator needs two of them
 * to settle, and at 82 Hz two periods is 24 ms — which swallowed a fixed 6-period
 * window whole and left one reading in it.
 */
function pitchStart(a: Float32Array, f0: number): number {
  const all = pitchTrack(a, f0);
  assert(all.length >= 3, 'the note has no readable pitch at all');
  const v = all.slice(0, 4).map((p) => p.cents).sort((x, y) => x - y);
  return v[Math.floor(v.length / 2)]!;
}

// ── 1. The scheme is the scheme ──────────────────────────────────────────────

check('the stiffness term has the dispersion the scheme says it has', () => {
  const worst: string[] = [];
  for (const pitch of [40, 52, 64]) {
    const f = hz(pitch);
    for (const B of [1e-5, 4e-5, 1e-4]) {
      const g = fdGrid(f, SR, B, 0);
      const mu = fdStiffMu(B, f, g, SR);
      const d = fdString(plain({
        freqHz: f, inharmonic: B, seconds: 1.2, pickPosition: 0.137,
        pickWidth: 0.03, lowT60: 6, highT60: 5,
      }));
      const mag = spectrum(d.samples, Math.round(0.03 * SR), 1 << 15);
      const f1 = partial(mag, f, f * 0.08);
      for (const nn of [5, 10, 20]) {
        const got = partial(mag, nn * f, f * 0.45);
        // The exact eigenvalue of `u⁺ = 2u − u⁻ + λ²δ²u − μ²δ⁴u`.
        const sp = Math.sin((nn * Math.PI) / (2 * g.segments));
        const arg = Math.sqrt(g.courant * g.courant * sp * sp
          + 4 * mu * mu * sp * sp * sp * sp);
        const want = (SR * Math.asin(Math.min(1, arg))) / Math.PI;
        const err = Math.abs(1200 * Math.log2(got / want));
        if (err > 3) worst.push(`p${pitch} B=${B} h${nn}: ${err.toFixed(1)}c off the scheme`);
        void f1;
      }
    }
  }
  assert(worst.length === 0, worst.join('; '));
});

check('and it runs LOW against the ideal stiff string, by more on a coarse grid', () => {
  // Stated rather than hidden.  If someone re-tunes `fdStiffMu` to close this
  // gap, the scheme check above will start failing instead, which is the point.
  const f = hz(40);
  const B = 4e-5;
  const d = fdString(plain({
    freqHz: f, inharmonic: B, seconds: 1.2, pickPosition: 0.137, pickWidth: 0.03,
    lowT60: 6, highT60: 5,
  }));
  const mag = spectrum(d.samples, Math.round(0.03 * SR), 1 << 15);
  const f1 = partial(mag, f, f * 0.08);
  const got = 1200 * Math.log2(partial(mag, 20 * f, f * 0.45) / (20 * f1));
  const ideal = 1200 * Math.log2(Math.sqrt(1 + B * 400));
  assert(got > 0.5 * ideal && got < 0.95 * ideal,
    `the twentieth partial is ${got.toFixed(1)}c sharp against an ideal ${ideal.toFixed(1)}c`
    + ' — expected between half and 95 per cent of it');
});

// ── 2. It conserves energy, and the ruler is checked too ─────────────────────

check('the energy ruler scales as the square of the amplitude', () => {
  let prev = NaN;
  for (const amp of [0.25, 0.5, 1, 2]) {
    const e = fdString(plain({ amplitude: amp, lowT60: 1e6, highT60: 1e6 })).energyDb[0]!;
    if (Number.isFinite(prev)) {
      assert(Math.abs(e - prev - 6.02) < 0.1,
        `doubling the amplitude moved the energy by ${(e - prev).toFixed(2)} dB, not 6.02`);
    }
    prev = e;
  }
});

check('a lossy string loses exactly what its T60 promises', () => {
  for (const t60 of [0.5, 1, 2]) {
    const d = fdString(plain({ lowT60: t60, highT60: t60, seconds: 1.0 }));
    // Ten samples across the render, so the last sits at 0.9 of it.
    const want = (-60 * 0.9) / t60;
    const got = d.energyDb[9]! - d.energyDb[0]!;
    assert(Math.abs(got - want) < 0.5,
      `T60 ${t60}s lost ${got.toFixed(2)} dB over 0.9 s, wanted ${want.toFixed(2)}`);
  }
});

check('a lossless string holds its energy, with the tension term running', () => {
  const bad: string[] = [];
  for (const pitch of [40, 52, 64, 76]) {
    for (const cents of [0, 100, 400]) {
      const d = fdString(plain({
        freqHz: hz(pitch), tensionCents: cents, inharmonic: 2e-5,
        lowT60: 1e6, highT60: 1e6, seconds: 1.5,
      }));
      const drift = d.energyDb[9]! - d.energyDb[0]!;
      if (!(Math.abs(drift) < 0.05)) {
        bad.push(`p${pitch} ${cents}c drifted ${drift.toFixed(3)} dB`);
      }
      // A clamp that binds is the coefficient lying about what it does.  It is
      // a guard here, and the solve is the mechanism.
      if (d.tensionHeld > 0.01) {
        bad.push(`p${pitch} ${cents}c clamped on ${(d.tensionHeld * 100).toFixed(1)}% of samples`);
      }
    }
  }
  assert(bad.length === 0, bad.join('; '));
});

// ── 3. The one thing this engine is for ──────────────────────────────────────

check('the bite knob is in cents, at four pitches', () => {
  const bad: string[] = [];
  for (const pitch of [40, 52, 64, 76]) {
    const f = hz(pitch);
    for (const cents of [100, 200, 400]) {
      const a = fdString(plain({ freqHz: f, tensionCents: cents, seconds: 1.6 })).samples;
      const got = pitchStart(a, f);
      if (Math.abs(got - cents) > 0.35 * cents) {
        bad.push(`p${pitch} asked ${cents}c and started ${got.toFixed(0)}c sharp`);
      }
    }
  }
  assert(bad.length === 0, bad.join('; '));
});

check('a string with no bite starts exactly where it is tuned', () => {
  for (const pitch of [40, 52, 64, 76]) {
    const f = hz(pitch);
    const got = pitchStart(fdString(plain({ freqHz: f, seconds: 1.6 })).samples, f);
    assert(Math.abs(got) < 5, `p${pitch} started ${got.toFixed(1)}c off with no tension asked for`);
  }
});

check('harder is sharper, and as the square of how hard', () => {
  const f = hz(52);
  const seen: number[] = [];
  for (const amp of [0.25, 0.5, 1]) {
    const a = fdString(plain({ freqHz: f, amplitude: amp, tensionCents: 200, seconds: 1.6 })).samples;
    seen.push(pitchStart(a, f));
  }
  assert(seen[0]! < seen[1]! && seen[1]! < seen[2]!,
    `not monotone in amplitude: ${seen.map((v) => v.toFixed(0)).join(' ')}`);
  // Quartering the pull should quarter the rise in `c²`, near enough.  Compared
  // as a ratio of rises rather than of cents, because cents are logarithmic and
  // the square law is not.
  const rise = (c: number): number => Math.pow(2, c / 600) - 1;
  const quarter = rise(seen[1]!) / rise(seen[2]!);
  assert(quarter > 0.15 && quarter < 0.4,
    `halving the pull changed the rise by ${quarter.toFixed(3)}, wanted about a quarter`);
});

check('the glide comes back to the nominal pitch', () => {
  for (const pitch of [52, 64]) {
    const f = hz(pitch);
    const a = fdString(plain({ freqHz: f, tensionCents: 300, seconds: 2.4, lowT60: 4 })).samples;
    const start = pitchStart(a, f);
    const end = pitchOver(a, f, 1.6, 2.0);
    assert(start > 120, `p${pitch} never went sharp: ${start.toFixed(0)}c`);
    assert(Math.abs(end) < 12, `p${pitch} settled at ${end.toFixed(1)}c instead of its own pitch`);
  }
});

// ── 4. The guards, which are the reason none of the above ever reads NaN ─────

check('the Courant limit leaves the stiffness and the tension their share', () => {
  for (const B of [0, 1e-5, 1e-4, CLAV_STIFF_MAX]) {
    for (const rise of [0, 0.1, 0.5, 1.5]) {
      for (const pitch of [24, 48, 72, 96]) {
        const f = hz(pitch);
        const g = fdGrid(f, SR, B, rise);
        const mu = fdStiffMu(B, f, g, SR);
        const eff = Math.min(rise, g.riseRoom);
        const used = g.courant * g.courant * (1 + eff) + 4 * mu * mu;
        assert(used <= 1,
          `p${pitch} B=${B} rise=${rise} spends ${used.toFixed(4)} of the budget`);
        // The tension may be cut back, but only where the segment floor forced
        // it — anywhere the grid was free to choose λ it must deliver the ask.
        assert(eff >= rise - 1e-9 || g.segments <= 8,
          `p${pitch} B=${B} cut the rise to ${eff.toFixed(3)} on a ${g.segments}-segment grid`);
        assert(Math.abs(g.headroom - Math.max(0, 1 - used)) < 1e-9,
          `p${pitch} B=${B} rise=${rise} reports headroom ${g.headroom} against ${1 - used}`);
        // Above the limit only where the segment floor put it there, and then
        // `riseRoom` is what keeps the step stable instead.
        assert(g.courant <= fdCourantLimit(B, f, SR, rise) + 1e-12 || g.segments <= 8,
          `p${pitch} B=${B} rise=${rise} exceeded its own limit on `
          + `${g.segments} segments`);
      }
    }
  }
});

check('sigma1 is sized from what is LEFT, not from the wave term alone', () => {
  // The bug this replaces: with stiffness in play, `1 − λ²` overstates the room
  // by a long way — at B = 4e-5 the wave and stiffness terms already sum to
  // 0.992, so `1 − λ²` said 0.286 was free when 0.008 was.
  const f = hz(48);
  const B = 4e-5;
  const g = fdGrid(f, SR, B, 0);
  assert(g.headroom < 1 - g.courant * g.courant,
    `headroom ${g.headroom.toFixed(4)} is not tighter than 1 − λ² `
    + `(${(1 - g.courant * g.courant).toFixed(4)}), so the stiffness share is being ignored`);
  const h = 1 / g.segments;
  const most = ((g.headroom * h * h) / (4 / SR)) * 0.98;
  const ls = fdLosses(f, 5000, 0.08, 0.02, g, SR);
  assert(ls.sigma1 <= most + 1e-12,
    `sigma1 ${ls.sigma1} exceeds the ${most} the budget leaves`);
  assert(ls.clamped, 'a string asked to lose its top in 20 ms should have clamped');
});

check('no note anywhere in the range overspends the stability budget', () => {
  // The direct statement of the guarantee, because arranging it is easy to break
  // by accident and the breakage is quiet: without the ceiling `FdGrid.riseRoom`
  // puts on the tension, the top of the range spends 3.85 of the budget and then
  // grows so slowly that a peak threshold over a second of audio sees nothing.
  const bad: string[] = [];
  for (let pitch = 24; pitch <= 96; pitch += 6) {
    for (const cents of [0, 100, FD_TENSION_MAX_CENTS]) {
      for (const amp of [0.3, 1, 1.5]) {
        const d = fdString(plain({
          freqHz: hz(pitch), tensionCents: cents, inharmonic: CLAV_STIFF_MAX,
          amplitude: amp, seconds: 0.35,
        }));
        if (!(d.budgetUsed <= 1)) {
          bad.push(`p${pitch} ${cents}c amp${amp} spent ${d.budgetUsed.toFixed(4)}`);
        }
      }
    }
  }
  assert(bad.length === 0, bad.join('; '));
});

check('nothing in the playable range leaves the rails', () => {
  const bad: string[] = [];
  for (let pitch = 24; pitch <= 96; pitch += 8) {
    for (const cents of [0, FD_TENSION_MAX_CENTS]) {
      for (const B of [0, CLAV_STIFF_MAX]) {
        const a = fdString(plain({
          freqHz: hz(pitch), tensionCents: cents, inharmonic: B,
          amplitude: 1.4, seconds: 1.2, pickWidth: 0.02,
        })).samples;
        let peak = 0;
        for (let i = 0; i < a.length; i += 3) {
          const v = a[i] ?? 0;
          if (!Number.isFinite(v)) { bad.push(`p${pitch} ${cents}c B=${B}: not finite`); break; }
          peak = Math.max(peak, Math.abs(v));
        }
        if (peak > 60) bad.push(`p${pitch} ${cents}c B=${B}: peaked at ${peak.toFixed(0)}`);
      }
    }
  }
  assert(bad.length === 0, bad.join('; '));
});

check('the grid reserves more room than the heard rise needs', () => {
  // `FD_TENSION_PEAK_ROOM` is the whole reason the clamp above never binds: the
  // tension PEAKS at the instant of release and the ear hears its average over a
  // cycle, so the peak the scheme must survive is several times the knob.
  assert(FD_TENSION_PEAK_ROOM >= 3,
    `${FD_TENSION_PEAK_ROOM} is not enough room for a peak measured at 2.6 to 5 times the mean`);
  const bite = fdString(plain({ tensionCents: 200, seconds: 0.4 }));
  const peakCents = 600 * Math.log2(1 + bite.peakRise);
  assert(peakCents > 220,
    `the peak rise was only ${peakCents.toFixed(0)}c for a heard 200c — the average cannot then be 200`);
});

// ── 5. The instrument on top of it ───────────────────────────────────────────

check('every Clavinet body speaks across its own range', () => {
  const bad: string[] = [];
  for (let k = 0; k < CLAV_BODIES.length; k++) {
    const body = CLAV_BODIES[k]!;
    for (const pitch of [body.lowest, body.lowest + 15, body.lowest + 30]) {
      const r = renderClavVoice({
        sampleRate: SR, seconds: 1.4, gateSec: 1.0, freqHz: hz(pitch),
        velocity: 0.8, params: { ...DEFAULTS, kind: k },
      });
      let peak = 0;
      for (let i = 0; i < r.left.length; i += 3) {
        const v = r.left[i] ?? 0;
        if (!Number.isFinite(v)) { bad.push(`${body.id} p${pitch}: not finite`); break; }
        peak = Math.max(peak, Math.abs(v));
      }
      if (peak < 1e-4) bad.push(`${body.id} p${pitch}: silent (${peak.toExponential(1)})`);
      if (peak > 4) bad.push(`${body.id} p${pitch}: peaked at ${peak.toFixed(1)}`);
    }
  }
  assert(bad.length === 0, bad.join('; '));
});

check('velocity gives a Clavinet loudness and bend from one gesture', () => {
  const body = CLAV_BODIES[0]!;
  const f = hz(body.lowest + 15);
  const loud: number[] = [];
  const sharp: number[] = [];
  // `pick` moved out to about a quarter of the string, because that is where the
  // pitch tracker above can be trusted — this body's pad sits at 0.12, where it
  // read a 95-cent bite as 471.  What is under test is that the VOICE carries
  // velocity into the engine's tension, and any pick position shows that.
  for (const vel of [0.3, 0.65, 1]) {
    const r = renderClavVoice({
      sampleRate: SR, seconds: 1.4, gateSec: 1.2, freqHz: f, velocity: vel,
      params: { ...DEFAULTS, kind: 0, pick: 2 },
    });
    let peak = 0;
    for (const v of r.left) peak = Math.max(peak, Math.abs(v));
    loud.push(20 * Math.log10(Math.max(1e-12, peak)));
    sharp.push(pitchStart(r.left, f));
  }
  assert(loud[0]! < loud[1]! && loud[1]! < loud[2]!,
    `not louder with velocity: ${loud.map((v) => v.toFixed(1)).join(' ')} dB`);
  assert(sharp[0]! < sharp[1]! && sharp[1]! < sharp[2]!,
    `not sharper with velocity: ${sharp.map((v) => v.toFixed(0)).join(' ')} cents`);
  assert(sharp[2]! - sharp[0]! > 20,
    `only ${(sharp[2]! - sharp[0]!).toFixed(0)}c between the softest and hardest key`);
  // And in the right neighbourhood, not merely in the right order: this body
  // asks for 95 cents at full pull, and velocity 1 pulls it to 1.0.
  assert(sharp[2]! > 45 && sharp[2]! < 160,
    `a full-velocity key started ${sharp[2]!.toFixed(0)}c sharp against a body asking for `
    + `${body.bite}c`);
});

check('the damper ends a note without a click', () => {
  const f = hz(48);
  const r = renderClavVoice({
    sampleRate: SR, seconds: 1.2, gateSec: 0.4, freqHz: f, velocity: 0.8,
    params: { ...DEFAULTS, kind: 0, damp: 0.05 },
  });
  const at = (t: number): number => {
    let peak = 0;
    for (let i = Math.round(t * SR); i < Math.round((t + 0.02) * SR); i++) {
      peak = Math.max(peak, Math.abs(r.left[i] ?? 0));
    }
    return peak;
  };
  const before = at(0.36);
  const after = at(0.5);
  assert(after < before * 0.35,
    `the damper left ${(20 * Math.log10(after / before)).toFixed(1)} dB at 100 ms past the gate`);
  // A felt, not a switch.  Two milliseconds into a 50 ms damper the level has
  // barely moved, so it has to still be there — comparing the jump AT the gate
  // against the biggest jump inside the note does not catch this, because the
  // bridge-slope signal is spiky enough to hide a cliff among its own edges.
  const justAfter = at(0.402);
  assert(justAfter > before * 0.5,
    `the damper cut to ${(20 * Math.log10(Math.max(1e-12, justAfter / before))).toFixed(1)} dB`
    + ' two milliseconds past the gate, which is a switch and not a felt');
});

check('the three bodies are three instruments, not one with three names', () => {
  const f = hz(48);
  const spec = (k: number): Float32Array => renderClavVoice({
    sampleRate: SR, seconds: 1.4, gateSec: 1.2, freqHz: f, velocity: 0.85,
    params: { ...DEFAULTS, kind: k },
  }).left;
  const tilt = (a: Float32Array): number => {
    const mag = spectrum(a, Math.round(0.02 * SR), 1 << 14);
    const binHz = SR / (mag.length * 2);
    let lo = 0; let hi = 0;
    for (let i = 1; i < mag.length; i++) {
      const fz = i * binHz;
      if (fz > 120 && fz < 900) lo += mag[i]! * mag[i]!;
      if (fz > 2500 && fz < 12000) hi += mag[i]! * mag[i]!;
    }
    return 10 * Math.log10(Math.max(1e-30, hi / Math.max(1e-30, lo)));
  };
  const t = CLAV_BODIES.map((_, k) => tilt(spec(k)));
  for (let i = 0; i < t.length; i++) {
    for (let j = i + 1; j < t.length; j++) {
      assert(Math.abs(t[i]! - t[j]!) > 1.5,
        `${CLAV_BODIES[i]!.id} and ${CLAV_BODIES[j]!.id} are ${Math.abs(t[i]! - t[j]!).toFixed(1)} dB`
        + ' apart in tilt — too close to be two instruments');
    }
  }
});

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.pass ? '' : ` — ${r.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed) process.exit(1);
