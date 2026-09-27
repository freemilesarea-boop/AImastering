// A string that exists in SPACE, and what that buys that nothing else here has.
//
// This codebase already has two string models, and both are better than this
// one at what they do.  `string-model.ts` is a delay line: a round trip and a
// loop filter, exactly in tune, and every loss it needs is a filter in the
// loop.  `struck-string.ts` is additive: it places partial n at
// `n·f₁√(1+Bn²)` and gives each its own pair of decay rates, so it owns
// inharmonicity outright and no finite grid will out-tune it.
//
// So a spatial string has to justify itself, and exactly one thing does:
//
//   A delay line and a sum of partials both assume the string's FREQUENCIES
//   are decided before the note starts.  A real string's are not.  Pull it
//   aside and it gets LONGER, which means tighter, which means sharper — so a
//   hard pluck starts sharp and glides down as it decays.  Placing partials
//   cannot do that, because the places move during the note.
//
// That is geometric nonlinearity, it is the Kirchhoff–Carrier model below, and
// on a string that exists in space it costs almost nothing: the tension is a
// property of the shape, and the shape is right there.
//
// ── What was tried here first, and why it is not in this file ───────────────
//
// This engine was begun for a sitar's jawari — a curve under the string near
// the bridge that the string rolls on and off, so the point where it leaves
// moves during every cycle.  The contact was built, and it works as a piece of
// numerics: it conserves energy exactly (below), it is stable at any stiffness,
// and it can be made effectively rigid.  What it did not do is sound like a
// jawari, in either geometry, and the measurements are worth keeping so nobody
// rebuilds it hoping:
//
//   · a surface falling away from the termination is touched only on the
//     downward half of each swing — 5 to 20 per cent of samples.  On a
//     LOSSLESS string, where every mode's energy is constant and the top of
//     the spectrum is therefore flat to 0.0 dB over two seconds, it moved the
//     3–18 kHz band by −1.4 to +0.9 dB with no pattern in depth or pitch.
//     Lossy, it made the top sag FASTER than a plain string at every pitch and
//     depth (−29 to −42 dB against −18 to −26), and the contact stopped
//     entirely part way through the note, because the wrapped length shrinks
//     below one grid cell as the string decays.
//   · rebuilt as a DOME the string is draped over, which is what a sitar
//     bridge actually is — contact at rest, and vibration slides the point
//     where the string leaves — contact rose to 60–95 per cent of samples and
//     conservation held.  Upward transfer was still ≈ 0 ± 1 dB, and the dome
//     made the output darker, not brighter.
//
// The one real effect was that the barrier's own load signal kept its high
// band 5 to 11 dB longer than a plain string's, consistently across pitch.
// Real, modest, not monotone in depth, and not an instrument.  A conservative
// contact reaches a steady state and stays there; what a jawari needs is
// something this formulation does not supply, and a guess about what would be
// a guess.  It was removed rather than left in unused.
//
// ── The scheme ──────────────────────────────────────────────────────────────
//
//     u_tt = c²(1 + αS) u_xx − κ² u_xxxx − 2σ₀ u_t + 2σ₁ u_txx
//
//     S = ½∫₀¹ u_x² dx          the stretch, which is what raises the tension
//     α = EA/T₀                 how much stretching this string costs
//     κ = c√B/π                 bending, which stretches the partials
//     σ₀, σ₁                    a loss that treats every partial alike, and
//                               one that takes the top faster
//
// `u` is transverse displacement, the string is one unit long, and its mass per
// unit length is one — so `c = 2f₀` and every coefficient below is in those
// units.
//
// Grid spacing comes from the pitch rather than the other way round.  With `N`
// segments and `λ = ck/h` the Courant number, λ = 1 is dispersion-free and IS a
// pair of delay lines.  A grid chosen the other way — N first, λ second — would
// put the fundamental wherever the rounding left it, which for a 466 Hz string
// is 51 cents.
//
// ── Why it is stable, and how that is guaranteed rather than hoped ──────────
//
// Everything that pushes a grid point spends from one budget, because the
// Laplacian's largest eigenvalue is 4:
//
//     λ²(1 + αS) + 4μ² + 4σ₁k/h² ≤ 1
//
// All three shares are computed rather than assumed.  `fdCourantLimit` solves
// the first two for λ — a quadratic, not a constant, because μ itself depends
// on the grid — and `FdGrid.headroom` carries what is left to `fdLosses`, which
// returns the σ₁ it was asked for or the largest stable one, whichever is
// smaller, and says which.
//
// That last handover fixed a real latent bug: `fdLosses` used to size σ₁ from
// `1 − λ²` alone, ignoring the stiffness term's share.  At B = 4e-5 the two
// already sum to 0.992, so `1 − λ²` said 0.286 was free when 0.008 was, and it
// would have allowed a σ₁ three and a half times the stable one.

/** The largest pitch rise a pluck may be asked for, in cents. */
export const FD_TENSION_MAX_CENTS = 400;

/**
 * How much more room the grid reserves than the heard pitch rise needs.
 *
 * The tension peaks at the instant of release and the ear hears its average
 * over a cycle, so the peak the scheme must stay stable through is several times
 * the number on the knob — measured between 2.6 and 5.0 across the range, worse
 * as the grid coarsens.  Six covers it with the margin `fdCourantLimit` adds on
 * top, and the cost is grid: measured at the top of the range, 400 cents at full
 * pull budgets a rise of 3.52, which takes λ from 0.997 to 0.398 and the segment
 * count down by sixty per cent at every pitch.
 */
export const FD_TENSION_PEAK_ROOM = 6;

/**
 * What the bridge slope is multiplied by on its way out.
 *
 * Arbitrary, and it only has to be consistent: the instrument layer trims every
 * voice to a measured level anyway.  It is here so the raw numbers a probe
 * prints are near unity instead of near ten thousand.
 */
export const FD_BRIDGE_GAIN = 0.02;

export interface FdGrid {
  segments: number;
  courant: number;
  /**
   * What is left of the stability budget once the wave, tension and stiffness
   * terms have taken their share.  `fdLosses` sizes σ₁ from this.
   */
  headroom: number;
  /**
   * The largest tension rise THIS grid can carry, which is not always the one it
   * was asked for.
   *
   * `segments` has a floor of 8, and at the very top of the range that floor
   * wins: at 2093 Hz a rise of 1.5 wants λ = 0.554, which is five segments, so
   * the grid comes back with eight and λ = 0.698 instead — and `λ²(1 + rise)`
   * is then 1.217, which is not stable.  The floor is worth keeping (three grid
   * points is not a string), so the tension gives way instead, and the caller
   * can see by how much rather than getting a quietly unstable string.
   */
  riseRoom: number;
}

/**
 * How much of the stability budget the string's own bending stiffness spends.
 *
 * A real string is not a pure membrane: bending it costs energy, which adds
 * `−κ²u_xxxx` and stretches the partials to `n·f₁√(1 + Bn²)`.  `B` is the
 * inharmonicity coefficient, and it is expensive on a fine grid — `μ = κk/h²`
 * grows as N².
 *
 * Measured against the scheme's own dispersion relation, the term is exact: at
 * three pitches and four values of B, all thirty-six partials came out within
 * 0.1 cent of `sin(ωk/2) = √(λ²s² + 4μ²s⁴)`.  Against the IDEAL stiff string it
 * runs low, and by more as the grid coarsens — on a fine grid the twentieth
 * partial reads +11.0 cents where the continuum wants +13.7, and at the top of
 * the range, where N falls to about 70, +0.5 against +3.5.  So `inharmonic` is
 * a request the bottom of the range honours closely and the top only partly;
 * `struck-string.ts` is the model to use when a partial has to land exactly.
 */
export function fdStiffMu(inharmonic: number, freqHz: number, grid: FdGrid,
  sampleRate: number): number {
  const c = 2 * Math.max(1, freqHz);
  const kappa = (c * Math.sqrt(Math.max(0, inharmonic))) / Math.PI;
  return (kappa * grid.segments * grid.segments) / sampleRate;
}

/**
 * The largest Courant number the stiffness and the tension leave room for.
 *
 * `rise` is the fractional rise in `c²` at the loudest moment of the note —
 * `αS` at the initial shape — and it is known before the render starts, so the
 * grid can be sized for it exactly instead of clamped during it.
 *
 * With `x = λ²`, `μ = λ²√B·sr/(2πf)` from substituting `N = λ·sr/2f`, and
 * `Q = B·sr²/(π²f²)`:
 *
 *     x(1 + rise) + Q·x² ≤ 1
 *
 * A guessed constant stood in for the stiffness share first and it was nine
 * times too small at the bottom of the range, which showed as infinities on the
 * very first note: Q goes as B/f², so stiffness is cheap up high and expensive
 * down low, and no single number can stand in for it.
 */
export function fdCourantLimit(
  inharmonic = 0, freqHz = 196, sampleRate = 48_000, rise = 0,
): number {
  // The tension term is asked for HALF AGAIN as much budget as it will use, and
  // that margin is not decoration.  Sized exactly — `λ²(1 + αS) ≤ 0.998` — the
  // scheme reached NaN at most pitches and most tensions, erratically: the
  // frozen-coefficient bound is necessary and not sufficient for a coefficient
  // that moves, and the term conserves energy only approximately (0.007 to
  // 0.036 dB over a lossless second), so with two parts in a thousand spare
  // there was nothing to absorb the difference.  The margin costs a few per cent
  // of the grid on a string that glides and nothing at all on one that does not.
  const load = 1 + 1.5 * Math.max(0, rise);
  const q = (Math.max(0, inharmonic) * sampleRate * sampleRate)
    / (Math.PI * Math.PI * Math.max(1, freqHz) * Math.max(1, freqHz));
  const x = q <= 0
    ? 1 / load
    : (-load + Math.sqrt(load * load + 4 * q)) / (2 * q);
  return Math.sqrt(Math.max(0.04, Math.min(1, x))) * 0.999;
}

/**
 * The grid for a pitch: as many segments as fit under the Courant limit.
 *
 * Bounded below at 8 so the very top of the range still has a string rather
 * than three points and a rounding error, and above at 2048 so a bass note
 * cannot ask for a render that never finishes.
 */
export function fdGrid(freqHz: number, sampleRate: number, inharmonic = 0,
  rise = 0): FdGrid {
  const limit = fdCourantLimit(inharmonic, freqHz, sampleRate, rise);
  const want = Math.floor((limit * sampleRate) / (2 * Math.max(1, freqHz)));
  const segments = Math.max(8, Math.min(2048, want));
  const courant = (2 * Math.max(1, freqHz) * segments) / sampleRate;
  const stub: FdGrid = { segments, courant, headroom: 0, riseRoom: 0 };
  const mu = fdStiffMu(inharmonic, freqHz, stub, sampleRate);
  const l2 = courant * courant;
  // A sliver under the whole budget rather than exactly all of it: filled to the
  // last bit the sum reads 1.0000000000000002 and the scheme is marginal by a
  // rounding error, which is not a place to leave a string.
  const riseRoom = Math.max(0, ((1 - 4 * mu * mu) * 0.999) / Math.max(1e-9, l2) - 1);
  const used = l2 * (1 + Math.min(Math.max(0, rise), riseRoom)) + 4 * mu * mu;
  return { segments, courant, headroom: Math.max(0, 1 - used), riseRoom };
}

export interface FdLosses {
  sigma0: number;
  sigma1: number;
  /** True when `sigma1` had to be reduced to keep the scheme stable. */
  clamped: boolean;
}

/**
 * The two loss coefficients from two decay times.
 *
 * A mode at ω decays at `σ₀ + σ₁(ω/c)²` nepers per second, so asking for a T60
 * at the fundamental and another at a reference frequency up top determines
 * both — and those are the two numbers a player would actually name.
 */
export function fdLosses(
  freqHz: number, highHz: number, lowT60: number, highT60: number,
  grid: FdGrid, sampleRate: number,
): FdLosses {
  const c = 2 * Math.max(1, freqHz);              // with L = 1, f = c/2
  const w1 = 2 * Math.PI * Math.max(1, freqHz);
  const wh = 2 * Math.PI * Math.max(w1 / (2 * Math.PI) + 1, highHz);
  // 60 dB of AMPLITUDE is a factor of 1000, which is `3·ln10` nepers and not
  // `6·ln10` — the power-versus-amplitude slip, and it made every string decay
  // in 1.4 seconds when it was asked for 3.
  const sLow = (3 * Math.LN10) / Math.max(0.02, lowT60);
  const sHigh = (3 * Math.LN10) / Math.max(0.01, Math.min(highT60, lowT60));
  let sigma1 = ((sHigh - sLow) * c * c) / (wh * wh - w1 * w1);
  const sigma0 = Math.max(0, sLow - (sigma1 * w1 * w1) / (c * c));
  // The diffusion's share of the budget is `4σ₁k/h²`, and what it may spend is
  // whatever the wave, tension and stiffness terms left — not `1 − λ²`, which
  // is the same number only when the string has no stiffness.
  const k = 1 / sampleRate;
  const h = 1 / grid.segments;
  const most = ((grid.headroom * h * h) / (4 * k)) * 0.98;
  const clamped = sigma1 > most;
  sigma1 = Math.max(0, Math.min(sigma1, most));
  return { sigma0, sigma1, clamped };
}

export interface FdStringOptions {
  freqHz: number;
  sampleRate: number;
  seconds: number;
  /** Where the string is plucked, as a fraction of its length from the bridge. */
  pickPosition: number;
  /** How wide the pluck is, as a fraction of the length: a finger, or a nail. */
  pickWidth: number;
  /** How far the string is pulled aside.  The tension rise goes as its square. */
  amplitude: number;
  /** T60 at the fundamental, seconds. */
  lowT60: number;
  /** T60 at 5 kHz, seconds — always the shorter of the two. */
  highT60: number;
  /** Inharmonicity: mode n sits near `n·f₁·√(1 + Bn²)`.  0 = a pure membrane. */
  inharmonic: number;
  /**
   * How many cents sharp the note starts when `amplitude` is 1.
   *
   * ── What this knob is, exactly ────────────────────────────────────────────
   *
   * The physical constant behind it is `α = EA/T₀`, which is a property of the
   * wire and not of the note, and nobody knows what theirs is.  So α is solved
   * for instead: the stretch `S` of the shape the pluck actually makes is
   * computed, and α is set so that `αS` comes out at exactly this many cents
   * WHEN the amplitude is 1.
   *
   * What that keeps is the part that matters musically.  `S` goes as the square
   * of the displacement, so a pluck at half the amplitude starts a quarter of
   * the cents sharp and one at double starts four times — the pitch is a
   * function of how hard the string was hit, which is the whole point, and it
   * glides down as the note decays because `S` decays with it.
   *
   * What it gives up is that a narrower pluck really does stretch a real string
   * more, and here it does not: changing `pickWidth` re-solves α and leaves the
   * cents where they were.  The knob means what it says at the cost of one
   * cross-coupling nobody would reach for on purpose.
   */
  tensionCents: number;
}

/** What the string did, beside the samples it produced. */
export interface FdStringDetail {
  samples: Float32Array;
  /**
   * The string's own energy, sampled ten times across the render, in dB.
   *
   * ── Why the potential terms pair TWO time levels ──────────────────────────
   *
   * A leapfrog step conserves a Hamiltonian, but not the obvious one.  The
   * quantity it holds exactly pairs each potential term across the step —
   * `⟨δₓuⁿ, δₓuⁿ⁻¹⟩`, not `‖δₓuⁿ‖²`.  Written at one time level the measure
   * oscillates at twice the fundamental and reads as drift wherever the ten
   * sampling instants happen to land: a lossless string with nothing but a
   * pluck on it scored 0.19 to 0.47 dB, which was a defect in the ruler and not
   * in the string.  Written across the step, the same string reads 0.000.
   *
   * The bending term was missing from it altogether, which made every stiff
   * string unjudgeable: its energy really does live partly in `δₓₓu`.
   *
   * The ruler is checked against two things it cannot fake.  It scales as the
   * square of the amplitude — 6.02 dB per doubling, measured 6.03, 6.02, 6.02 —
   * and a lossy string loses exactly what its T60 promises: asked for 1, 2 and
   * 0.5 seconds it read −54.00, −27.00 and −108.00 dB over 0.9 s against
   * −54.00, −27.00 and −108.00 wanted.
   */
  energyDb: number[];
  /** How many cents sharp the first sample's tension actually put the string. */
  riseCents: number;
  /** The largest fractional rise in `c²` reached during the note. */
  peakRise: number;
  /**
   * The share of the stability budget the note actually reached, at its worst.
   *
   * `λ²(1 + peak αS) + 4μ²`, which must not exceed 1.  Reported rather than
   * merely arranged, because the arrangement is easy to break by accident: take
   * away the ceiling `FdGrid.riseRoom` puts on the tension and the top of the
   * range spends 3.85 of it — and the resulting instability grows so slowly that
   * a peak threshold over a second of audio does not notice.
   */
  budgetUsed: number;
  /** True when `fdLosses` had to reduce σ₁ to stay stable. */
  lossClamped: boolean;
  /**
   * The share of samples whose tension rise hit the budgeted ceiling.
   *
   * Small is fine and means the grid was sized correctly.  Large means the knob
   * is no longer delivering what it says, because the clamp and not the stretch
   * is setting the pitch.
   */
  tensionHeld: number;
}

function render(o: FdStringOptions): FdStringDetail {
  const sr = o.sampleRate;
  const n = Math.max(1, Math.round(sr * Math.max(0.01, o.seconds)));
  const out = new Float32Array(n);
  const energyDb: number[] = [];

  const cents = Math.max(0, Math.min(FD_TENSION_MAX_CENTS, o.tensionCents));
  const amp = o.amplitude;
  // The rise in `c²` that `cents` of PITCH corresponds to.  The tension raises
  // the wave speed and the frequency by the same factor, so `c²` by its square.
  const heard = Math.pow(2, cents / 600) - 1;
  const asked = FD_TENSION_PEAK_ROOM * heard * amp * amp;

  const grid = fdGrid(o.freqHz, sr, o.inharmonic, asked);
  // Where the grid's own floor of eight segments beats the Courant limit, the
  // tension is what gives way — and the calibration target is scaled by the same
  // factor, so the knob under-delivers gracefully instead of asking for a rise
  // the clamp would then have to hold back all note long.  It only bites at the
  // very top of the range: at 2093 Hz with full bite, about a third of the ask.
  const rise = Math.min(asked, grid.riseRoom);
  const want = asked > 0 ? heard * amp * amp * (rise / asked) : 0;
  const N = grid.segments;
  const lambda2 = grid.courant * grid.courant;
  const losses = fdLosses(o.freqHz, 5000, o.lowT60, o.highT60, grid, sr);

  const k = 1 / sr;
  const h = 1 / N;
  const mu = (2 * losses.sigma1 * k) / (h * h);
  const muStiff = fdStiffMu(o.inharmonic, o.freqHz, grid, sr);
  const stiffTerm = muStiff * muStiff;
  const a0 = 1 + losses.sigma0 * k;
  const aPrev = 1 - losses.sigma0 * k;

  // Three time steps of the string.  Index 0 is the bridge and N the nut; both
  // stay at zero, which is what "terminated" means.
  const cur = new Float64Array(N + 1);
  const old = new Float64Array(N + 1);
  const nxt = new Float64Array(N + 1);
  // The Laplacian, and the whole of the step bar its wave term — both needed
  // before the tension coefficient can be worked out.
  const lap = new Float64Array(N + 1);
  const bare = new Float64Array(N + 1);

  const centre = Math.min(0.95, Math.max(0.02, o.pickPosition)) * N;
  // At least three cells wide, because a pluck narrower than that is not a
  // pluck, it is a spike — and with the tension term it is a dangerous one.  At
  // the top of the range the grid falls to about 33 segments, where a width of
  // 0.05 asks for 1.6 cells; the whole of the stretch is then one enormous
  // gradient which disperses on the first step and can re-concentrate well above
  // where it started, so the tension coefficient reached 25 and the string left
  // the building within seven samples.
  const halfWidth = Math.max(3, Math.min(0.4, Math.max(0.01, o.pickWidth)) * N);

  /** The pluck: a raised cosine, released from rest, which is what plucking IS. */
  const pluck = (): void => {
    for (let i = 0; i <= N; i++) { cur[i] = 0; old[i] = 0; nxt[i] = 0; }
    for (let i = 1; i < N; i++) {
      const d = Math.abs(i - centre);
      if (d >= halfWidth) continue;
      const shape = 0.5 * (1 + Math.cos((Math.PI * d) / halfWidth));
      cur[i] = amp * shape;
      old[i] = cur[i]!;
    }
  };

  /** `S = ½∫u_x² dx`, which on this grid is `½h·Σ(Δa/h)(Δb/h)`. */
  const stretch = (a: Float64Array, b: Float64Array): number => {
    let sum = 0;
    for (let i = 0; i < N; i++) sum += (a[i + 1]! - a[i]!) * (b[i + 1]! - b[i]!);
    return sum / (2 * h);
  };

  let held = 0;

  /**
   * One step, and the tension coefficient it used.
   *
   * ── The tension, solved rather than lagged ──────────────────────────────
   *
   * Evaluating the stretch at the current time level and stepping explicitly
   * does not conserve energy — it GAINS, a little every step (+0.001 to +0.036
   * dB over a lossless second), and the gain compounds: at one pitch the string
   * ran for 85,894 samples and then went to NaN in a handful.  Clamping the
   * coefficient to its budget stopped the explosion and replaced it with a worse
   * lie, because on coarse grids the clamp then bound for the whole note and the
   * pitch simply sat 96 cents sharp instead of gliding down from it.
   *
   * What conserves it exactly is taking the coefficient from the stretch
   * measured ACROSS the step, symmetrically:
   *
   *     ten = 1 + α·[S(uⁿ, uⁿ⁺¹) + S(uⁿ, uⁿ⁻¹)] / 2
   *
   * Then the wave term's work telescopes — `(a+b)(a−b) = a² − b²` with
   * `a = S(uⁿ,uⁿ⁺¹)` and `b = S(uⁿ,uⁿ⁻¹)` — so the quartic part of the potential
   * is conserved the same way the quadratic part already was.
   *
   * It is implicit, but only in one SCALAR, and `S` is linear in each argument,
   * so there is nothing to iterate: with `u⁺ = bare + W·δ²u`, `W = λ²·ten/a0`
   * and `β = S(uⁿ,uⁿ⁺¹)`,
   *
   *     β = A + C(1 + α(β + γ)/2),   A = S(uⁿ, bare),  C = λ²·S(uⁿ, δ²uⁿ)/a0
   *
   * which is one line of algebra.  `C < 0` always, because summation by parts
   * over fixed ends makes `S(u, δ²u) = −‖δ²u‖²/2h`, so the denominator cannot
   * vanish.
   */
  const advance = (alpha: number): number => {
    for (let i = 1; i < N; i++) {
      const d2cur = cur[i + 1]! - 2 * cur[i]! + cur[i - 1]!;
      const d2old = old[i + 1]! - 2 * old[i]! + old[i - 1]!;
      // Bending, as the fourth difference.  The ends are simply supported —
      // `u = u_xx = 0` — which in a grid means the mirror point outside the end
      // is the negative of the one inside, and that is what the reads below do.
      let d4 = 0;
      if (stiffTerm > 0) {
        const left2 = i >= 2 ? cur[i - 2]! : -cur[Math.min(N, 2 - i)]!;
        const right2 = i + 2 <= N ? cur[i + 2]! : -cur[Math.max(0, 2 * N - i - 2)]!;
        d4 = right2 - 4 * cur[i + 1]! + 6 * cur[i]! - 4 * cur[i - 1]! + left2;
      }
      lap[i] = d2cur;
      bare[i] = (2 * cur[i]! - aPrev * old[i]! + mu * (d2cur - d2old)
        - stiffTerm * d4) / a0;
    }
    const gamma = stretch(cur, old);
    const av = stretch(cur, bare);
    const cv = (lambda2 * stretch(cur, lap)) / a0;
    const beta = (av + cv + (cv * alpha * gamma) / 2) / (1 - (cv * alpha) / 2);
    const raw = (alpha * (beta + gamma)) / 2;
    // A guard, not the mechanism.  With the solve above and the room reserved
    // for the peak it should never bind, and `tensionHeld` reports how often it
    // did so that claim is checkable rather than asserted.
    if (raw > rise) held += 1;
    const ten = 1 + Math.max(0, Math.min(rise, raw));
    const w = (lambda2 * ten) / a0;
    for (let i = 1; i < N; i++) nxt[i] = bare[i]! + w * lap[i]!;
    return ten;
  };

  const roll = (): void => {
    for (let i = 0; i <= N; i++) { old[i] = cur[i]!; cur[i] = nxt[i]!; }
  };

  // ── Why α is calibrated by rehearsing the note ────────────────────────────
  //
  // The physical constant is `α = EA/T₀`, a property of the wire that nobody
  // knows for theirs, so it is solved for from the pitch asked for instead.  The
  // first attempt solved it from the stretch of the plucked SHAPE, and the knob
  // came out wrong by a factor of two and a half to five: what a listener hears
  // is not the tension at the instant of release but its average over a cycle,
  // and the string spends half of each cycle with its energy in motion rather
  // than in stretch.  The factor is not a constant either — it grows as the grid
  // coarsens, so it was 2.6 at the bottom of the range and 5.0 at the top.
  //
  // So the note is rehearsed for a few periods, the mean rise that produces is
  // measured, and α is scaled by the ratio.  `advance` is linear in α to first
  // order, so one correction is enough; it is done twice because the second
  // costs four periods of a string and removes the second-order part too.
  const periods = Math.max(64, Math.round((4 * sr) / Math.max(1, o.freqHz)));
  const calSteps = Math.min(n, periods);
  let alpha = 0;
  if (heard > 0) {
    pluck();
    const s0 = stretch(cur, cur);
    alpha = s0 > 0 ? want / s0 : 0;
    for (let pass = 0; pass < 2 && alpha > 0; pass++) {
      pluck();
      let sum = 0;
      for (let s = 0; s < calSteps; s++) { sum += advance(alpha) - 1; roll(); }
      const mean = sum / Math.max(1, calSteps);
      if (!(mean > 1e-12)) break;
      alpha *= want / mean;
    }
    held = 0;
  }

  const c2 = 4 * Math.max(1, o.freqHz) * Math.max(1, o.freqHz);
  let peakRise = 0;
  let riseCents = 0;

  pluck();
  for (let s = 0; s < n; s++) {
    const ten = advance(alpha);
    if (ten - 1 > peakRise) peakRise = ten - 1;
    if (s === 0) riseCents = 600 * Math.log2(Math.max(1e-12, ten));
    if (s % Math.max(1, Math.floor(n / 10)) === 0 && energyDb.length < 10) {
      let kinetic = 0;
      for (let i = 1; i < N; i++) {
        const v = (cur[i]! - old[i]!) * sr;
        kinetic += 0.5 * h * v * v;
      }
      // Both potentials across the step, for the reason in `energyDb` above.
      // The tension's own share is quartic: `U = c²(S + ½αS²)`, whose gradient
      // is the `c²(1 + αS)u_xx` the update applies.
      const sx = stretch(cur, old);
      let bend = 0;
      if (stiffTerm > 0) {
        for (let i = 1; i < N; i++) {
          bend += (cur[i + 1]! - 2 * cur[i]! + cur[i - 1]!)
            * (old[i + 1]! - 2 * old[i]! + old[i - 1]!);
        }
        bend *= ((0.5 * h) / (k * k)) * stiffTerm;
      }
      const potential = c2 * (sx + 0.5 * alpha * sx * sx);
      energyDb.push(10 * Math.log10(Math.max(1e-30, kinetic + potential + bend)));
    }
    // What the body hears is the FORCE the string pulls the bridge with, which
    // is its slope at the termination — the displacement there is zero by
    // definition, so a tap would hear nothing.
    out[s] = ((cur[1]! - cur[0]!) / h) * FD_BRIDGE_GAIN;
    roll();
  }
  return {
    samples: out, energyDb, riseCents, peakRise,
    budgetUsed: lambda2 * (1 + peakRise) + 4 * stiffTerm,
    lossClamped: losses.clamped,
    tensionHeld: held / n,
  };
}

/**
 * One plucked note of a stiff, stretching string, and what it did on the way.
 *
 * There were two of these for a while — one returning the samples and one the
 * detail — and the samples-only one was the whole of what the app called, which
 * left the detail reachable from nothing but a test.  Since every number in
 * `FdStringDetail` is there to be checked rather than heard, the honest shape is
 * one function: callers that only want audio take `.samples`, and the
 * diagnostics cost an object per note.
 */
export function fdString(o: FdStringOptions): FdStringDetail {
  return render(o);
}

// ── The instrument this engine is for ───────────────────────────────────────
//
// A Clavinet is a short steel wire plucked by a rubber pad and heard through a
// magnetic pickup at the bridge end.  Every one of the engine's properties is
// one of its properties: the wire is short and stiff, so its partials are
// stretched; the pad plucks it hard, so the note starts sharp and settles; and
// the pickup hears the string's slope at the termination rather than its
// displacement, which is why the instrument is all attack.
//
// Three bodies, because a wire plucked by a pad is one instrument and the
// differences are the wire's: how long, how stiff, how hard the pad, and how
// long the damper lets it ring.

export interface ClavBody {
  id: string;
  name: string;
  /** Inharmonicity at the reference pitch — how short and thick the wire is. */
  stiff: number;
  /** T60 at the fundamental, seconds. */
  ring: number;
  /** The share of `ring` the top of the spectrum gets.  Always below 1. */
  bright: number;
  /** Where the pad catches the wire, as a fraction from the bridge. */
  pick: number;
  /** How wide the pad's contact is: a hard nib, or a soft sticky pad. */
  width: number;
  /** How many cents a full-velocity pluck starts sharp. */
  bite: number;
  /** Where the instrument stops radiating. */
  toneHz: number;
  /** Output trim in decibels — three bodies share one voice, not one level. */
  trimDb: number;
  /** The lowest note it has, for the patch bank and the reference phrase. */
  lowest: number;
}

/** The reference pitch at which `stiff` is read as a plain B. */
export const CLAV_STIFF_REF_HZ = 196;

/** As stiff as a wire is allowed to be, whatever the pitch asks for. */
export const CLAV_STIFF_MAX = 5e-4;

export const CLAV_BODIES: readonly ClavBody[] = [
  {
    // The D6 itself: a very short wire under a hard rubber pad, damped by a
    // felt the moment the key returns.  Stiff enough that the tenth partial is
    // audibly sharp, which is most of why it does not sound like a guitar.
    id: 'clav', name: 'Clavinet',
    stiff: 2.4e-4, ring: 1.6, bright: 0.28, pick: 0.12, width: 0.03,
    bite: 95, toneHz: 6800, trimDb: 0, lowest: 36,
  },
  {
    // A Pianet's pad is STICKY — it pulls the string aside and lets go slowly,
    // which is a wider contact and a softer corner.  Longer ring, far less
    // bite, and the top goes first.
    id: 'pianet', name: 'Pianet',
    stiff: 1.6e-4, ring: 2.4, bright: 0.2, pick: 0.2, width: 0.08,
    bite: 45, toneHz: 4600, trimDb: 1.5, lowest: 41,
  },
  {
    // A long thick wire plucked hard: the glide is the loudest thing about it,
    // because the stretch goes as the square of how far the string was pulled
    // and this one gets pulled a long way.
    id: 'wire', name: 'Wire Bass',
    stiff: 5e-5, ring: 3.2, bright: 0.35, pick: 0.25, width: 0.05,
    bite: 180, toneHz: 3200, trimDb: -2, lowest: 24,
  },
];

export const CLAV_BODY_NAMES: readonly string[] = CLAV_BODIES.map((b) => b.name);

export interface ClavRenderSpec {
  sampleRate: number;
  seconds: number;
  gateSec: number;
  freqHz: number;
  velocity: number;
  params: Readonly<Record<string, number>>;
}

export interface ClavRender { left: Float32Array; right: Float32Array }

const pv = (p: Readonly<Record<string, number>>, id: string, fallback: number): number => {
  const v = p[id];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};

/** How long a note rings on after its key is released. */
export function clavTail(params: Readonly<Record<string, number>>): number {
  return Math.min(1.2, Math.max(0.02, pv(params, 'damp', 0.12)) * 3);
}

/**
 * One note of a plucked steel wire.
 *
 * ── Why velocity drives AMPLITUDE and not gain ─────────────────────────────
 *
 * Because that is the whole instrument.  The tension rise goes as the square of
 * how far the wire was pulled aside, so a hard key makes a note that is louder
 * AND starts sharper AND glides further — three things from one gesture, none of
 * which a gain stage can imitate.  Sent through a gain instead, every note would
 * bend by the same amount and the loud ones would simply be loud.
 */
export function renderClavVoice(spec: ClavRenderSpec): ClavRender {
  const { sampleRate: sr, seconds, gateSec, freqHz, velocity, params } = spec;
  const n = Math.max(1, Math.round(seconds * sr));
  const body = CLAV_BODIES[Math.round(pv(params, 'kind', 0))] ?? CLAV_BODIES[0]!;

  // A real wire gets stiffer as it is shortened, so B climbs with pitch.  The
  // engine under-delivers stretch on the coarse grids the top of the range gets
  // (see `fdStiffMu`), so this is a request rather than a promise, and it is
  // capped where the grid cost stops being worth it.
  const stiff = Math.min(CLAV_STIFF_MAX,
    body.stiff * Math.max(0.05, pv(params, 'stiff', 1))
    * Math.max(0.25, Math.min(4, freqHz / CLAV_STIFF_REF_HZ)));

  const vel = Math.min(1, Math.max(0, velocity));
  // A key at rest still plucks the string a little; the pad never catches
  // nothing.  0.3 at the bottom keeps a soft note a note rather than a whisper.
  const amp = 0.3 + 0.7 * vel;
  const ring = Math.max(0.15, body.ring * Math.max(0.15, pv(params, 'ring', 1)));

  const { samples: raw } = fdString({
    freqHz, sampleRate: sr, seconds,
    pickPosition: Math.min(0.45, Math.max(0.03, body.pick * Math.max(0.2, pv(params, 'pick', 1)))),
    pickWidth: Math.min(0.2, Math.max(0.01, body.width * Math.max(0.2, pv(params, 'pad', 1)))),
    amplitude: amp,
    lowT60: ring,
    highT60: Math.max(0.05, ring * Math.min(0.95, body.bright)),
    inharmonic: stiff,
    tensionCents: Math.min(FD_TENSION_MAX_CENTS,
      Math.max(0, body.bite * Math.max(0, pv(params, 'bite', 1)))),
  });

  // The damper: a key returning puts felt on the wire, which is a fast decay and
  // not a gate.  Cut at the gate with no damper at all and the note ends in a
  // click, which is the one thing a felt never does.
  const damp = Math.max(0.02, pv(params, 'damp', 0.12));
  const gateEnd = Math.max(1, Math.round(gateSec * sr));
  const dampPer = Math.exp(-1 / Math.max(1, damp * sr));

  // Tone, as one pole, and the stereo as the SAME signal through two slightly
  // different corners.  A delay between the sides would be a comb, and a comb on
  // a signal whose whole character is its attack is audible as a flange.
  const corner = Math.max(400, Math.min(sr * 0.45,
    body.toneHz * Math.max(0.1, pv(params, 'tone', 1))));
  const spread = Math.min(1, Math.max(0, pv(params, 'spread', 0.25)));
  const gain = Math.pow(10, body.trimDb / 20) * Math.max(0, pv(params, 'level', 0.5));

  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const aL = 1 - Math.exp((-2 * Math.PI * corner * (1 + 0.18 * spread)) / sr);
  const aR = 1 - Math.exp((-2 * Math.PI * corner * (1 - 0.18 * spread)) / sr);
  let yL = 0;
  let yR = 0;
  let env = 1;
  for (let i = 0; i < n; i++) {
    if (i >= gateEnd) env *= dampPer;
    const x = (raw[i] ?? 0) * env * gain;
    yL += aL * (x - yL);
    yR += aR * (x - yR);
    left[i] = yL;
    right[i] = yR;
  }
  return { left, right };
}

export const CLAV_PARAMS: readonly {
  id: string; name: string; min: number; max: number; default: number; unit: string;
  choices?: readonly string[]; choiceNotes?: readonly string[];
}[] = [
  {
    id: 'kind', name: 'Instrument', min: 0, max: CLAV_BODIES.length - 1, default: 0, unit: '',
    choices: CLAV_BODY_NAMES,
    choiceNotes: [
      '짧고 단단한 강선, 딱딱한 고무 패드 — 배음이 늘어나고 어택이 전부입니다',
      '끈적한 패드가 천천히 놓아주는 현 — 물기 적고 길게 울립니다',
      '길고 굵은 강선을 세게 — 장력 변조로 인한 피치 하강이 가장 큰 쪽입니다',
    ],
  },
  // The star of the engine, and the reason it exists: how many cents a
  // full-velocity pluck starts sharp before settling.  A soft key bends by the
  // SQUARE of how much less far it pulled the wire, so this is a ceiling and not
  // a fixed detune.
  { id: 'bite',   name: 'Bite',    min: 0,    max: 2.5, default: 1,   unit: '×' },
  { id: 'stiff',  name: 'Stiffness', min: 0,  max: 2.5, default: 1,   unit: '×' },
  { id: 'pick',   name: 'Pick Pos', min: 0.2, max: 3,   default: 1,   unit: '×' },
  { id: 'pad',    name: 'Pad',     min: 0.2,  max: 3,   default: 1,   unit: '×' },
  { id: 'ring',   name: 'Ring',    min: 0.15, max: 2.5, default: 1,   unit: '×' },
  { id: 'damp',   name: 'Damper',  min: 0.02, max: 0.4, default: 0.12, unit: 's' },
  { id: 'tone',   name: 'Tone',    min: 0.1,  max: 2.5, default: 1,   unit: '×' },
  { id: 'spread', name: 'Spread',  min: 0,    max: 1,   default: 0.25, unit: '' },
];

export const CLAV_PARAM_IDS: readonly string[] = CLAV_PARAMS.map((q) => q.id);
