// A reed and a pipe, computed sample by sample.
//
// The instrument roster had sixteen entries and not one wind: no clarinet, no
// saxophone, no oboe, nothing blown.  It is the only family that was missing
// entirely, and it is the one a physical model is most worth building for,
// because the things a blown instrument does are exactly the things a sampled
// one cannot.
//
// ── Why a reed is not a bow, and why the maths is nearly the same ──────────
//
// `bowed-string.ts` solves a continuous nonlinearity feeding a waveguide: the
// bow never stops pushing, and what it delivers depends on how fast the string
// is already moving under it.  A reed is the same shape of problem with
// pressure in place of velocity.  The player never stops blowing, and how much
// air gets through depends on how far the reed has already been pushed shut by
// the pressure difference across it.
//
// At the mouthpiece the bore carries two travelling pressure waves.  With
// `p⁻` the one returning from the bell and `p⁺` the one leaving,
//
//     p = p⁺ + p⁻                               (the pressure the reed sees)
//     u = (p⁺ − p⁻)/Z                           (the flow it lets through)
//
// so `p⁺ = p⁻ + Z·u` and therefore `p = 2·p⁻ + Z·u`.  Writing `Δp = p_m − p`
// for the pressure across the reed and `D = p_m − 2·p⁻` for what the bore
// offers, the junction is
//
//     Δp + Z·F(Δp) − D = 0
//
// which is `solveBow`'s equation with different letters.  F is the flow
// through the reed channel, by Bernoulli: proportional to the opening and to
// the square root of the pressure driving the air through it.
//
// ── The fold, and why this model does not have one ─────────────────────────
//
// The usual simplification says the reed has no mass, so its opening follows
// the pressure instantly: `y = 1 − Δp/p_c`, shut at the closing pressure.
// Substituting that leaves, in units of `p_c`,
//
//     G(x) = ζ·(1 − x)·√x       and       G′(x) = ζ·(1 − 3x)/(2√x)
//
// so the flow PEAKS at x = 1/3 and falls back to zero at x = 1.  The junction
// is then not monotone: `g′(x) = 0` when `3ζs² − 2s − ζ = 0` with `s = √x`,
// which has the single positive root `s* = (1 + √(1+3ζ²))/(3ζ)`.  That sits
// inside (0,1) exactly when ζ > 1 — strong coupling — and there the curve
// folds and carries up to three roots.  A solver that brackets the whole
// interval finds A root rather than THE root and hops between branches from
// sample to sample, which is the failure `solveBow`'s header describes: the
// same settings give a clean tone at one pitch and noise at the next.
//
// The fold is an artefact of pretending the reed weighs nothing.  A reed is a
// stiff cane tongue with mass, a spring and a lot of damping, resonating
// somewhere around 2 kHz; give it those and its opening becomes a STATE,
// integrated from the pressure it saw last sample rather than solved from the
// pressure this one.  With `y` known, the junction is
//
//     Δp + ζ·y·√|Δp|·sign(Δp) − D = 0
//
// monotone in Δp for any fixed y ≥ 0, and it is a quadratic in `s = √|Δp|`:
//
//     Δp > 0:   s² + ζy·s − D = 0    →   s = (−ζy + √(ζ²y² + 4D))/2
//     Δp < 0:   s² + ζy·s + D = 0    →   s = (−ζy + √(ζ²y² − 4D))/2
//
// Exact, closed form, no iteration and no branch to choose.  The hysteresis
// the fold was standing in for does not disappear — it moves into the reed's
// own motion, which is where it physically lives, and it is what makes the
// note refuse to start until the pressure is up and then keep going below the
// pressure that started it.
//
// ── What the pipe's shape decides ─────────────────────────────────────────
//
// A cylinder closed at the reed and open at the bell reflects with INVERSION
// at the open end.  A sign flip once per round trip means the waveform repeats
// only after two of them, so the pipe supports odd harmonics and nothing else,
// and its length is a quarter of a wavelength.  That is a clarinet, and it is
// why a clarinet's low register sounds hollow.
//
// A cone is the other case: its round trip does not invert, all harmonics are
// supported, and the length is half a wavelength.  That is a saxophone.  The
// difference between the two instruments is not the reed and not the material
// — it is this sign.
//
// Stated as the simplification it is: a real cone is a conical waveguide whose
// cross-section grows along it, which stretches its lowest modes slightly
// sharp and is why a saxophone's bottom notes need a different embouchure.
// One sign gets the harmonic structure, which is the audible difference; it
// does not get that stretching.
//
// ── The register vent ─────────────────────────────────────────────────────
//
// Opening a small hole near the mouthpiece stops the fundamental sustaining,
// and the pipe jumps to its next supported mode.  On a cylinder that is the
// THIRD harmonic — a twelfth, 1902 cents — not an octave.  Every sampled
// clarinet gets this wrong by construction, because a sample library is built
// per note and the jump is a property of the pipe rather than of any note.
// Here it is a notch in the loop at the fundamental: the mode whose gain drops
// below one stops oscillating and the next one takes over.
//
// ── How well it plays in tune, and where that runs out ────────────────────
//
// Measured at the top of a held note, with the loop's length in samples beside
// each reading, because the length is the thing that limits it:
//
//     Clarinet        163sp −2c   122sp −2c   82sp −4c   55sp −5c   41sp −13c
//     Bass Clarinet   327sp −2c   245sp −2c  163sp −2c  109sp −3c   61sp −11c
//
// Two cents wherever there is room, and worse as the pipe gets short.  That is
// the delay line's resolution rather than anything about reeds: the read
// interpolates linearly between two samples, and at 41 samples one whole sample
// of loop is 42 cents, so there is nowhere left to put the fraction.  The same
// limit is written up in `string-model.ts`, which measures 7.7 cents at the top
// of a guitar.  A higher-order interpolator would buy some of it back and is
// not here.
//
// ── Determinism ───────────────────────────────────────────────────────────
//
// Breath noise is seeded from the note, like every other model here, so a
// bounce is bit-identical to the preview.

import { CALIBRATED_LEVEL, INSTRUMENT_TRIM } from './instrument-level.js';

/** A small deterministic PRNG.  Same note, same breath, every render. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One resonance of a bore or bell: centre, Q, and how far it stands up, in dB. */
export type PipeMode = readonly [hz: number, q: number, db: number];

export interface PipeBody {
  id: string;
  name: string;
  /**
   * Whether the round trip inverts.
   *
   * `true` for a cylinder — odd harmonics, quarter-wave — and `false` for a
   * cone.  This one flag is the clarinet/saxophone distinction; see the
   * header.
   */
  inverting: boolean;
  /** The lowest note the instrument has, as MIDI pitch, for the bore scaling. */
  lowest: number;
  /** Bore and bell resonances, lowest first. */
  modes: readonly PipeMode[];
  /**
   * Where radiation from the bell has fallen away.
   *
   * A bell radiates high frequencies efficiently and low ones hardly at all,
   * which is why a clarinet's lowest notes come mostly out of the tone holes
   * and why the instrument is directional only up high.
   */
  floorHz: number;
  /**
   * How much of the top the bore loses per round trip, as the corner of a
   * one-pole lowpass in the loop.
   *
   * A narrow bore loses more, which is why an oboe is quieter and reedier
   * than a saxophone at the same length.
   */
  lossHz: number;
  /** The reed's own resonance, in Hz — stiff and short is high. */
  reedHz: number;
}

/**
 * The four instruments, and the numbers that make them four.
 *
 * The bore resonances here are the formant-like peaks a blown pipe's
 * radiation shows rather than the pipe's own modes, which the delay line
 * already has: the bell's flare, and for the double reeds the small
 * high-Q peak the narrow conical bore puts just above 1 kHz that is most of
 * what makes an oboe recognisable in two notes.
 */
export const PIPE_BODIES: readonly PipeBody[] = [
  {
    id: 'clarinet', name: 'Clarinet',
    inverting: true, lowest: 50,                      // concert D3
    modes: [[1500, 1.2, 4], [3000, 1.4, 3]],
    floorHz: 140, lossHz: 4200, reedHz: 2300,
  },
  {
    id: 'bassclarinet', name: 'Bass Clarinet',
    inverting: true, lowest: 38,
    modes: [[900, 1.2, 4], [2000, 1.4, 2.5]],
    floorHz: 80, lossHz: 3200, reedHz: 1500,
  },
];

// ── Why there is no saxophone here ────────────────────────────────────────
//
// A cone was tried and it does not work, and the reason is the simplification
// the header is careful to admit: modelling a conical bore as a round trip that
// does not invert gets the harmonic structure and nothing else.  With it, the
// pipe would not hold its fundamental.  Measured across three octaves at four
// blowing pressures, with the cylinders passing the same grid at 6 to 27 cents:
//
//                  breath 0.7   0.85    1.0    1.2
//     Alto Sax p62     silent silent silent  1215c
//     Tenor    p74     silent silent  1237c  1237c
//     Oboe     p62     silent silent silent silent
//
// Either no periodic tone at all, or a jump of an octave and a bit.  A real
// cone is a waveguide whose cross-section grows along it, so a wave travelling
// out meets a continuous partial reflection rather than one at the end; that is
// a section per step, not a sign, and it is its own piece of work.  The bodies
// above are the two the model actually plays.

export const PIPE_BODY_NAMES: readonly string[] = PIPE_BODIES.map((b) => b.name);

/**
 * Solve the reed junction for the pressure across the reed.
 *
 * `d` is what the bore offers (`p_m − 2·p⁻`), `zy` is the coupling `ζ·y` with
 * the reed's CURRENT opening — a state, not a function of `d` — and the
 * result is exact: see the header for the quadratic.
 *
 * Returns the pressure difference; the caller turns it into flow.
 */
export function solveReed(d: number, zy: number): number {
  if (d === 0) return 0;
  const k = Math.max(0, zy);
  if (d > 0) {
    // s² + k·s − d = 0, positive root.
    const s = (-k + Math.sqrt(k * k + 4 * d)) * 0.5;
    return s * s;
  }
  // Blowing back through the reed: the channel is held open, so k is the full
  // aperture and the root is the other sign.
  const s = (-k + Math.sqrt(k * k - 4 * d)) * 0.5;
  return -s * s;
}

/**
 * The flow the reed passes at a given pressure difference and opening.
 *
 * Bernoulli through a channel of area proportional to `y`.  Reported
 * separately from the solve because the tests check the two against each
 * other: `solveReed` is only right if `d − reedFlow(Δp, y) === Δp`.
 */
export function reedFlow(dp: number, zy: number): number {
  return Math.max(0, zy) * Math.sqrt(Math.abs(dp)) * (dp < 0 ? -1 : 1);
}

/** A fractional delay line. */
class Line {
  private buf: Float32Array;
  private mask: number;
  private w = 0;

  constructor(maxDelay: number) {
    let n = 4;
    while (n < maxDelay + 4) n *= 2;
    this.buf = new Float32Array(n);
    this.mask = n - 1;
  }

  read(delay: number): number {
    const d = Math.max(1, delay);
    const di = Math.floor(d);
    const fr = d - di;
    const i0 = (this.w - di) & this.mask;
    const i1 = (i0 - 1) & this.mask;
    const a = this.buf[i0] ?? 0;
    const b = this.buf[i1] ?? 0;
    return a + fr * (b - a);
  }

  write(x: number): void {
    this.w = (this.w + 1) & this.mask;
    this.buf[this.w] = x;
  }
}

interface Biquad { b0: number; b1: number; b2: number; a1: number; a2: number }

function peaking(hz: number, q: number, db: number, sr: number): Biquad {
  const w = 2 * Math.PI * Math.min(hz, sr * 0.49) / sr;
  const A = Math.pow(10, db / 40);
  const alpha = Math.sin(w) / (2 * Math.max(0.05, q));
  const a0 = 1 + alpha / A;
  return {
    b0: (1 + alpha * A) / a0,
    b1: (-2 * Math.cos(w)) / a0,
    b2: (1 - alpha * A) / a0,
    a1: (-2 * Math.cos(w)) / a0,
    a2: (1 - alpha / A) / a0,
  };
}

function highpass(hz: number, q: number, sr: number): Biquad {
  const w = 2 * Math.PI * Math.min(hz, sr * 0.49) / sr;
  const alpha = Math.sin(w) / (2 * Math.max(0.05, q));
  const a0 = 1 + alpha;
  const c = Math.cos(w);
  return {
    b0: ((1 + c) / 2) / a0,
    b1: (-(1 + c)) / a0,
    b2: ((1 + c) / 2) / a0,
    a1: (-2 * c) / a0,
    a2: (1 - alpha) / a0,
  };
}

/**
 * A two-pole lowpass — the reed's own motion.
 *
 * Bilinear, not an integrator.  The first version stepped
 * `y'' + 2ζω y' + ω²(y−1) = −ω²Δp` with explicit Euler, which multiplies the
 * reed's velocity by `1 − 2ζω` each sample and therefore DIVERGES once
 * `2ζω > 2`.  Both knobs that set those reach it: at Lip 2.2 and Stiffness 2.2
 * the factor is −1.91, and the note left the pipe entirely — measured at 131
 * samples of loop error, which is not a tuning problem, it is a blow-up.  A
 * third of the reachable range did that.  Bilinear is stable for every ζ and
 * every ω, and its phase is in closed form, which the tuning below needs.
 */
function lowpass(hz: number, q: number, sr: number): Biquad {
  const w = 2 * Math.PI * Math.min(hz, sr * 0.49) / sr;
  const alpha = Math.sin(w) / (2 * Math.max(0.05, q));
  const c = Math.cos(w);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - c) / 2) / a0,
    b1: (1 - c) / a0,
    b2: ((1 - c) / 2) / a0,
    a1: (-2 * c) / a0,
    a2: (1 - alpha) / a0,
  };
}

/**
 * The phase delay of a cascade at one frequency, in samples.
 *
 * What the loop needs is not group delay: the pipe oscillates at ONE
 * frequency, and what decides its period is the total phase the round trip
 * turns at that frequency.  Used to take the filters' share out of the delay
 * line so the instrument plays in tune.
 */
export function phaseDelaySamples(sections: readonly Biquad[], hz: number, sr: number): number {
  const w = 2 * Math.PI * hz / sr;
  if (!(w > 0)) return 0;
  // Each section's phase on its own, summed — NOT the phase of the product.
  //
  // The first version multiplied the responses together and took one `atan2`
  // of the result, then dragged it below zero because a delay ought to be
  // positive.  A DC blocker's phase LEADS, so that turned a few degrees of
  // lead into nearly a full turn, and the compensation took a whole period
  // out of the loop: measured, the clarinet dropped from 141 Hz to 74.2 and
  // the residual read as 160 samples.  One biquad's phase never leaves
  // (−π, π], so summing them needs no unwrapping and carries the sign.
  let phase = 0;
  for (const s of sections) {
    const cw = Math.cos(w); const c2 = Math.cos(2 * w);
    const sw = Math.sin(w); const s2 = Math.sin(2 * w);
    const nr = s.b0 + s.b1 * cw + s.b2 * c2;
    const ni = -(s.b1 * sw + s.b2 * s2);
    const dr = 1 + s.a1 * cw + s.a2 * c2;
    const di = -(s.a1 * sw + s.a2 * s2);
    phase += Math.atan2(ni, nr) - Math.atan2(di, dr);
  }
  return -phase / w;
}

/** A notch, for the register vent: kills one frequency and leaves the rest. */
function notch(hz: number, q: number, sr: number): Biquad {
  const w = 2 * Math.PI * Math.min(hz, sr * 0.49) / sr;
  const alpha = Math.sin(w) / (2 * Math.max(0.05, q));
  const a0 = 1 + alpha;
  const c = Math.cos(w);
  return { b0: 1 / a0, b1: (-2 * c) / a0, b2: 1 / a0, a1: (-2 * c) / a0, a2: (1 - alpha) / a0 };
}

function runBiquad(s: Biquad, x: number, z: [number, number]): number {
  const y = s.b0 * x + z[0];
  z[0] = s.b1 * x - s.a1 * y + z[1];
  z[1] = s.b2 * x - s.a2 * y;
  return y;
}

/** The radiation chain: the bore's peaks, and the bell's rolloff below. */
export function pipeSections(body: PipeBody, sr: number, tilt = 1): Biquad[] {
  const out = body.modes.map(([hz, q, db]) => peaking(hz, q, db * tilt, sr));
  out.push(highpass(body.floorHz, 0.7, sr));
  return out;
}

/**
 * How much of a static pressure the bore keeps: −20 dB of it, not none.
 *
 * A full DC blocker was the first attempt and it mistunes the bottom of the
 * range badly.  Phase delay is `−φ/ω`, and a blocker's phase LEADS by nearly
 * 90° as ω falls, so `φ/ω` grows without limit: measured through the tuner,
 * the blocker accounted for −28.93 samples at pitch 38 against −0.58 at pitch
 * 62.  Compensating for that is compensating for a number that is mostly the
 * filter's own doing.
 *
 * What the bore actually needs is for its loop gain at DC to be under one, and
 * that only takes attenuation.  Subtracting 0.9 of a very slow running mean
 * leaves the DC gain at 0.1 and, at 4 Hz, is nearly inaudible in phase terms
 * anywhere the instrument plays.
 */
export const BORE_DC_KEEP = 0.1;
const BLEED_HZ = 4;
const BLEED_TAKE = 1 - BORE_DC_KEEP;
export const boreBleedBeta = (sr: number): number => Math.exp(-2 * Math.PI * BLEED_HZ / sr);

/** The bleed as one first-order section, so the tuner and the loop agree. */
function bleedSectionFor(sr: number): Biquad {
  const beta = boreBleedBeta(sr);
  return { b0: 1 - BLEED_TAKE * (1 - beta), b1: -beta, b2: 0, a1: -beta, a2: 0 };
}

export interface ReedTuning {
  /** What the pipe's length would be if the filters in it had no phase. */
  raw: number;
  /** What it is set to instead. */
  delay: number;
  /** The loss one-pole's coefficient, so the render and this cannot disagree. */
  lossA: number;
  /** The reed's own two-pole response. */
  reed: Biquad;
  /** What the loop's linear filters account for, in samples. */
  filterDelay: number;
}

/**
 * How long the delay line has to be for the pipe to play the note asked for.
 *
 * Its own function, and exported, because the tuning is the part of this
 * engine most likely to be wrong in a way nobody hears until they play along
 * with something: `reed-selftest.ts` reads these numbers directly rather than
 * inferring them from a pitch, so a tuning bug is reported as a tuning bug.
 *
 * The delay line is not the only delay in the loop.  Two filters sit inside it
 * and each turns the round trip's phase further, so the pipe oscillates where
 * the TOTAL phase comes back round.  Measured before any of this existed, at
 * the defaults: 141.6 Hz where 146.8 was asked, 63 cents flat, and across
 * three octaves 32, 43, 63, 91, 118, 179 and 224 cents — growing in cents but
 * constant at 5.6 to 6.1 SAMPLES, which is what says it is filter phase and
 * not anything to do with pitch.
 */
export function reedLoopDelay(
  params: Readonly<Record<string, number>>, freqHz: number, sr: number,
): ReedTuning {
  const body = PIPE_BODIES[Math.round(p(params, 'body', 0))] ?? PIPE_BODIES[0]!;
  const sounding = Math.max(20, freqHz);
  // ── What the register key does, and what it does NOT do ──────────────────
  //
  // On the instrument, opening the vent makes the same fingering sound a
  // twelfth higher.  In a DAW the note written has to be the note heard, so
  // what the key selects here is WHICH MODE of the pipe carries it: with the
  // vent open the pipe is three times as long and its third mode does the
  // work, which is the clarion register's tone at the pitch asked for.
  //
  // The first version left the pipe's length alone and notched its fundamental
  // out, and it was not a register key, it was a coin toss.  Measured at one
  // pitch across six velocities it landed on 647, 647, 1901, −555, −556 and
  // 1965 cents — and the test that was supposed to guard it asserted the
  // twelfth at velocity 0.8, which is the one value where it happened to be
  // right.  A check that passes because of the number it was given is worse
  // than no check.
  const onThird = p(params, 'register', 0) >= 0.5;
  const f = onThird ? sounding / 3 : sounding;
  const period = sr / f;
  const raw = body.inverting ? period * 0.5 : period;

  const lossHz = Math.max(800, body.lossHz * p(params, 'bore', 1));
  const lossA = Math.exp(-2 * Math.PI * lossHz / sr);
  const lossSection: Biquad = { b0: 1 - lossA, b1: 0, b2: 0, a1: -lossA, a2: 0 };
  // At the frequency the pipe will actually oscillate at, which is the sounding
  // note whichever mode is carrying it.
  const filterDelay = phaseDelaySamples([lossSection, bleedSectionFor(sr)], sounding, sr);

  const reedHz = Math.max(300, Math.min(sr * 0.45, body.reedHz * p(params, 'stiff', 1)));
  const reedDamp = Math.max(0.2, Math.min(4, p(params, 'damp', 1.4)));
  const reed = lowpass(reedHz, 1 / (2 * reedDamp), sr);

  // The reed's own phase is deliberately NOT taken out here.
  //
  // It is in the loop, through the junction's reflection coefficient
  // `(1 − g)/(1 + g)`, and `g` depends on the operating point the oscillation
  // settles at — so there is no closed form to subtract.  A constant share of
  // the reed's phase delay was tried: over two bores, four octaves and five
  // embouchures the share that would have been needed ran from 0.103 to 2.698,
  // and the wrong way round, with more reed phase going with LESS error.  Any
  // number there would have been one picked to make a single note right.
  //
  // What handles it instead is the tuning pass in `renderReedVoice`, which
  // plays the note and listens.
  //
  // Never past half the raw length: a compensation bigger than that is not a
  // compensation, it is a different note, and the first version's did exactly
  // that — a mis-signed phase took 67 samples out of a 163-sample loop and the
  // clarinet came out 920 cents sharp.
  const want = raw - filterDelay;
  const delay = Math.max(raw * 0.5, Math.min(raw * 1.5, want));
  return { raw, delay, lossA, reed, filterDelay };
}

export interface ReedRenderSpec {
  sampleRate: number;
  seconds: number;
  /** How long the player is blowing.  The tail after it is the pipe emptying. */
  gateSec: number;
  freqHz: number;
  pitch: number;
  velocity: number;
  startBeat: number;
  params: Readonly<Record<string, number>>;
}

export interface ReedRender { left: Float32Array; right: Float32Array }

function p(params: Readonly<Record<string, number>>, id: string, fallback: number): number {
  const v = params[id];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Control rate — breath and vibrato move at this stride, not per sample. */
export const REED_CONTROL_STRIDE = 16;

/** How long after the breath stops there is still something to hear. */
export function reedTail(params: Readonly<Record<string, number>>): number {
  const body = PIPE_BODIES[Math.round(p(params, 'body', 0))] ?? PIPE_BODIES[0]!;
  // A pipe is not a string: it stops almost at once.  What is left is the
  // room the bore's losses allow, which is milliseconds, plus the release the
  // player's breath actually takes.
  return 0.08 + 0.25 * p(params, 'release', 0.15) + (body.lossHz < 4000 ? 0.04 : 0);
}

/**
 * Blow one note.
 *
 * The loop is: read what came back from the bell, solve the reed for the
 * pressure across it, turn that into flow, send the flow back down the bore.
 * Everything else — the vent, the losses, the radiation — is filtering on one
 * of those two paths.
 */
/**
 * How much of a note the tuning pass listens to, and how much of that it uses.
 *
 * ── Why the pipe is tuned by playing it ────────────────────────────────────
 *
 * `reedLoopDelay` takes the loop's linear filters out exactly.  What is left is
 * the junction's own reflection phase, and that depends on the operating point
 * the oscillation itself settles at, so there is no closed form to take.
 *
 * It was worth finding out whether a constant share of the reed's phase would
 * stand in for it.  It will not: over a grid of two bores, four octaves and
 * five embouchures, the share that would have been needed ran from 0.103 to
 * 2.698, and the wrong way round — MORE reed phase went with LESS error, which
 * is the opposite of what compensating the reed's phase would predict.  A
 * single number there would have been a number chosen to make one note right.
 *
 * A separate cheap simulation of the bore was the next attempt and it is worse
 * than useless, because which mode a pipe settles into depends on how the note
 * starts.  Blown with a two-period ramp instead of the real attack, the cone
 * locked onto its fifth or sixth mode: the period came back at 117 samples
 * where 653.8 was asked for, and the cylinder answered with twice the period
 * rather than the period.  A probe that does not reproduce the onset is
 * measuring a different instrument.
 *
 * So the tuning pass IS the render — the same loop, the same attack, the same
 * breath noise — run over the first part of the note and then thrown away.
 *
 * How MUCH of the note is not a free choice either.  At 0.28 s the pass settled
 * on its own fixed point and the pass was still 24 to 36 cents out, and more
 * iterations did not help because they were all converging to the same wrong
 * answer: the window had settled before the note had.  At 0.55 s the same
 * measurement lands within 2 cents at every velocity, including the one that
 * had produced no tone at all.  Voices are cached per note, so the cost is paid
 * once per distinct note rather than per beat.
 */
/**
 * How long each tuning pass listens, in order.
 *
 * Ramped, because the two things a pass needs are in tension.  A short window
 * is cheap but settles before the note does — at 0.28 s the iteration converged
 * on its own fixed point 24 to 36 cents out, and more passes only reached the
 * same wrong answer faster.  A long window is right and costs: five passes of
 * 0.55 s took a one-second note from 3.5 ms to 29.8 ms.
 *
 * But an early pass is correcting a large error, where precision does not
 * matter, and only the last one has to be exact.  Two short passes to get
 * close and one long one to finish costs a third of five long ones.
 *
 * Two passes of 0.55 s was tried and is not enough — it read within a cent at
 * the pitch it was tested at and was 12 to 54 cents flat across the rest of the
 * range, growing with pitch.  Which is its own lesson about one data point.
 */
const TUNE_WINDOWS: readonly number[] = [0.18, 0.3, 0.55, 0.55];
const TUNE_LISTEN = 0.5;

const TUNE_DAMPING = 0.6;

/**
 * The period of a signal, by autocorrelation near a lag that is expected.
 *
 * Bounded deliberately.  The question is "how far off is this", not "what note
 * is this": searched widely, a cylinder's odd-harmonic waveform correlates as
 * well at twice its period as at its period, and answered 1349 samples where
 * 653.8 was the truth.  A confidence floor goes with the bound, so a pass that
 * did not find a periodic signal declines to correct rather than inventing a
 * correction.
 */
export function spectrumPeriodNear(
  x: Float32Array, want: number, wide = false,
): number | null {
  // `wide` is for one case only: the register key moves the note a twelfth, so
  // a test that has to find where it landed needs to look outside the window
  // the tuning uses.  The tuning itself must NOT look that far — see above.
  const lo = Math.max(2, Math.floor(want * (wide ? 0.2 : 0.78)));
  const hi = Math.ceil(want * (wide ? 1.9 : 1.28));
  const span = x.length - hi;
  if (span < 32 || hi <= lo + 1) return null;
  let mean = 0;
  for (let i = 0; i < x.length; i++) mean += x[i] ?? 0;
  mean /= x.length;
  let best = -Infinity;
  let bestLag = -1;
  const r: number[] = [];
  for (let lag = lo; lag <= hi; lag++) {
    let sum = 0;
    let ea = 0;
    let eb = 0;
    for (let k = 0; k < span; k++) {
      const a = (x[k] ?? 0) - mean;
      const b = (x[k + lag] ?? 0) - mean;
      sum += a * b; ea += a * a; eb += b * b;
    }
    const c = sum / Math.sqrt(ea * eb + 1e-30);
    r.push(c);
    if (c > best) { best = c; bestLag = lag; }
  }
  if (bestLag < 0 || best < 0.7) return null;
  const i0 = bestLag - lo;
  const y0 = r[i0 - 1];
  const y1 = r[i0] ?? 0;
  const y2 = r[i0 + 1];
  if (y0 === undefined || y2 === undefined) return bestLag;
  const den = y0 - 2 * y1 + y2;
  const shift = den !== 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / den)) : 0;
  return bestLag + shift;
}

export function renderReedVoice(spec: ReedRenderSpec): ReedRender {
  const { sampleRate: sr, seconds, gateSec, freqHz, pitch, velocity, startBeat, params } = spec;
  const n = Math.max(1, Math.round(seconds * sr));
  const body = PIPE_BODIES[Math.round(p(params, 'body', 0))] ?? PIPE_BODIES[0]!;
  const tune = reedLoopDelay(params, freqHz, sr);

  const register = Math.max(0, Math.min(1, p(params, 'register', 0)));
  const zeta = Math.max(0.05, p(params, 'reed', 0.9));
  const lossA = tune.lossA;
  const bleedBeta = boreBleedBeta(sr);
  // The sign IS the instrument — see the header.  Writing this as a constant
  // negative was the first version, and it gave the saxophone an inverting
  // round trip on top of its full-period loop, so it sounded an octave down:
  // measured at 72.0 Hz where 146.8 was asked for, ratio 0.490.
  const reflect = (body.inverting ? -1 : 1)
    * Math.max(0.5, Math.min(0.999, 1 - 0.0025 * p(params, 'leak', 1)));

  const gate = Math.max(0.01, gateSec);
  const attack = Math.max(0.004, p(params, 'attack', 0.03));
  const release = Math.max(0.01, p(params, 'release', 0.15));
  // Velocity is breath PRESSURE, and pressure is not gain: below the
  // threshold the note does not sound at all, and above it the spectrum opens
  // out.  That is the whole reason this is a model.
  // Velocity is breath PRESSURE, and the floor is 0.82 of the knob rather than
  // zero: below what the reed needs, playing softly would stop producing a
  // note instead of a softer one.
  //
  // An earlier comment here claimed that pressure opens the spectrum out as
  // well as raising the level.  Measured, in THIS model, it does not: over the
  // whole breath range the third harmonic moved from −7.1 to −6.8 dB relative
  // to the first and the fifth from −11.5 to −10.7, which is nothing, while
  // the level moved 6 dB.  A real clarinet does open out, and what this model
  // has instead is the threshold — it does not speak at all below one — so the
  // claim is corrected rather than left standing.
  const breathVel = Math.max(0, Math.min(1, velocity));
  const breath = p(params, 'breath', 1) * (0.82 + 0.18 * breathVel);
  const vibHz = Math.max(0, p(params, 'vibRate', 5));
  const vibDepth = Math.max(0, p(params, 'vibDepth', 0));
  const growl = Math.max(0, p(params, 'growl', 0));
  const noiseAmt = Math.max(0, p(params, 'noise', 0.12));
  const spread = Math.max(0, Math.min(1, p(params, 'spread', 0.3)));
  const trim = INSTRUMENT_TRIM['reed'] ?? 1;
  // Pressure carries 6 dB of the dynamic range, measured, and a wind player has
  // far more than that.  The rest is taken as gain, which is a simplification
  // and is said so: on the instrument the difference between pp and ff is also
  // the bell radiating differently and the room hearing it differently, and
  // neither of those is here.
  const velGain = 0.32 + 0.68 * breathVel;
  const level = Math.max(0, Math.min(1, p(params, 'level', CALIBRATED_LEVEL))) * trim * velGain;

  /**
   * Blow the pipe.
   *
   * One function for the tuning pass and the render, so the two cannot be
   * playing different instruments — which is exactly how the first tuning
   * attempt went wrong.
   */
  const blow = (
    loopDelay: number, count: number,
    out: { left: Float32Array; right: Float32Array } | { bore: Float32Array },
  ): void => {
    const line = new Line(Math.ceil(tune.raw) + 8);
    const reedZ: [number, number] = [0, 0];
    const ventZ: [number, number] = [0, 0];
    // The notch goes at the PIPE's own fundamental — a third of the sounding
    // note when the register is open — because that is the mode being taken out.
    const vent = notch(Math.max(20, register > 0 ? freqHz / 3 : freqHz), 1.6, sr);
    const radiation = pipeSections(body, sr, p(params, 'tone', 1));
    const radZ: Array<[number, number]> = radiation.map(() => [0, 0]);
    const rnd = mulberry32(
      ((Math.round(pitch) * 2654435761) ^ (Math.round(startBeat * 960) * 40503)
        ^ (Math.round(velocity * 127) * 97)) >>> 0,
    );
    const stereo = 'left' in out;
    let lossZ = 0;
    let bleedMean = 0;
    let noiseZ = 0;
    let pm = 0;
    let dpPrev = 0;
    let dcX = 0;
    let dcZ = 0;

    for (let i = 0; i < count; i++) {
      if (i % REED_CONTROL_STRIDE === 0) {
        const t = i / sr;
        const env = t < gate
          ? Math.min(1, t / attack)
          : Math.max(0, 1 - (t - gate) / release);
        const vib = vibDepth * Math.sin(2 * Math.PI * vibHz * t);
        const grr = growl * Math.sin(2 * Math.PI * 28 * t);
        pm = breath * env * (1 + vib + grr);
      }

      let back = line.read(loopDelay) * reflect;
      lossZ = back * (1 - lossA) + lossZ * lossA;
      back = lossZ;
      bleedMean = bleedMean * bleedBeta + back * (1 - bleedBeta);
      back -= (1 - BORE_DC_KEEP) * bleedMean;
      if (register > 0) {
        const notched = runBiquad(vent, back, ventZ);
        back = back + register * (notched - back);
      }

      // The reed.  It is driven by the pressure difference from LAST sample,
      // which is what makes its opening a state and the junction
      // single-valued — the whole argument in the header.
      const yLin = 1 - runBiquad(tune.reed, Math.max(-1.5, dpPrev), reedZ);
      // Beating: the lay stops the reed, so no more air gets through however
      // hard it is pushed.  Stated as the simplification it is — the lay stops
      // the reed's MOTION too, and this clips only what the flow sees, so the
      // choke at the top is modelled and the slap of the closure is not.
      const y = yLin <= 0 ? 0 : (yLin > 1.6 ? 1.6 : yLin);

      const d = pm - 2 * back;
      const dp = solveReed(d, zeta * y);
      dpPrev = dp;
      const flow = reedFlow(dp, zeta * y);

      const breathNoise = (rnd() * 2 - 1) * noiseAmt * Math.sqrt(Math.max(0, pm)) * 0.35;
      noiseZ = breathNoise * 0.25 + noiseZ * 0.75;

      const outgoing = back + flow + noiseZ;
      line.write(outgoing);

      if (!stereo) { (out as { bore: Float32Array }).bore[i] = outgoing; continue; }

      let rad = outgoing;
      for (let k = 0; k < radiation.length; k++) rad = runBiquad(radiation[k]!, rad, radZ[k]!);
      // The mouth pressure is DC and the bore passes it; a real instrument
      // does not radiate it.  A one-pole DC block: `y = x − x₋₁ + R·y₋₁`.
      const blocked = rad - dcX + 0.9995 * dcZ;
      dcX = rad;
      dcZ = blocked;
      const v = blocked * level;
      // A wind instrument is a point source: the TONE is one signal and
      // putting a different amount of it in each ear is a pan, not a width.
      // What is genuinely uncorrelated between two microphones on a clarinet
      // is the breath, so that is what Spread widens, and the tone stays
      // centred.
      const nl = noiseZ * spread * level;
      const st = out as { left: Float32Array; right: Float32Array };
      st.left[i] = v + nl;
      st.right[i] = v - nl;
    }
  };

  // ── Blow, listen, adjust ────────────────────────────────────────────────
  //
  // Iterated, because one step is not enough.  Shortening the pipe raises the
  // frequency, which moves the junction's operating point, which moves its
  // phase — so the period does not respond to the length with the slope 2 that
  // a single Newton step assumes.  Corrected once, the middle of the range
  // came out 100 to 132 cents SHARP: the right direction and too far.
  //
  // Damped and bounded, and it stops as soon as it is within a sixth of a
  // sample, which is under a cent anywhere the instrument plays.
  let loopDelay = tune.delay;
  {
    const wantPeriod = sr / Math.max(20, freqHz);
    // A third of the loop's own period when the pipe's third mode is carrying
    // the note, because that is what the correction is moving.
    const share = (body.inverting ? 0.5 : 1) * (register > 0 ? 3 : 1);
    for (const window of TUNE_WINDOWS) {
      const count = Math.min(n, Math.round(window * sr));
      const bore = new Float32Array(count);
      const from = Math.floor(count * (1 - TUNE_LISTEN));
      blow(loopDelay, count, { bore });
      const got = spectrumPeriodNear(bore.subarray(from), wantPeriod);
      if (got === null) break;
      const err = (got - wantPeriod) * share;
      // Relative, not absolute.  A sixth of a sample was the first version's
      // criterion and it is a different musical amount at each end of the
      // range: 0.3 cents on a 653-sample period and 7 cents on an 82-sample
      // one, which is why the top note kept stopping 12 cents flat.
      if (Math.abs(err) < Math.max(0.02, wantPeriod * 4e-4)) break;
      const step = Math.max(-tune.raw * 0.2, Math.min(tune.raw * 0.2, err * TUNE_DAMPING));
      loopDelay = Math.max(2, loopDelay - step);
    }
  }

  const left = new Float32Array(n);
  const right = new Float32Array(n);
  blow(loopDelay, n, { left, right });
  return { left, right };
}

export const REED_PARAMS: readonly {
  id: string; name: string; min: number; max: number; default: number; unit: string;
  choices?: readonly string[]; choiceNotes?: readonly string[];
}[] = [
  {
    id: 'body', name: 'Instrument', min: 0, max: PIPE_BODIES.length - 1, default: 0, unit: '',
    choices: PIPE_BODY_NAMES,
    choiceNotes: [
      '원통관 — 홀수 배음, 레지스터 키는 옥타브가 아니라 12도',
      '원통관, 한 옥타브 아래 — 더 굵고 더 많이 잃는 보어',
    ],
  },
  // Breath rests at 1.0 and stops at 0.7, and both numbers are measured.
  //
  // A reed does not sound below a threshold pressure, which is a property worth
  // having and not one to hide behind a floor.  But BELOW that threshold this
  // model does not merely go quiet — it stops being periodic, and at some
  // settings it settled a fifth away instead.  Across the grid, 0.7 gave no
  // tone at two of the three pitches tried and 0.85 upward gave 6 to 27 cents.
  // So the knob starts where the instrument speaks.
  { id: 'breath',   name: 'Breath',   min: 0.7,  max: 1.3,  default: 1,    unit: '' },
  // ζ stops at 1.5 for the same kind of reason: at 1.8 and above, blown at
  // 0.8, the pipe locked 749 cents down instead of playing its fundamental.
  { id: 'reed',     name: 'Reed',     min: 0.5,  max: 1.5,  default: 1,    unit: 'ζ' },
  { id: 'stiff',    name: 'Stiffness', min: 0.4, max: 2.2,  default: 1,    unit: '×' },
  { id: 'damp',     name: 'Lip',      min: 0.2,  max: 4,    default: 1.4,  unit: '' },
  // A key, not a fader: the pipe either sustains its fundamental or it does
  // not.  Measured, it holds the fundamental to 0.5 and is over by 0.8, and
  // what it lands on is 1901 cents up — a twelfth, the third mode, which is
  // the thing about a clarinet that a sampled one cannot have.
  { id: 'register', name: 'Register', min: 0,    max: 1,    default: 0,    unit: '' },
  { id: 'bore',     name: 'Bore',     min: 0.5,  max: 2,    default: 1,    unit: '×' },
  { id: 'leak',     name: 'Leak',     min: 0,    max: 4,    default: 1,    unit: '' },
  { id: 'tone',     name: 'Tone',     min: 0,    max: 2,    default: 1,    unit: '×' },
  { id: 'attack',   name: 'Attack',   min: 0.004, max: 0.4, default: 0.03, unit: 's' },
  { id: 'release',  name: 'Release',  min: 0.01, max: 0.8,  default: 0.15, unit: 's' },
  { id: 'vibRate',  name: 'Vib Rate', min: 0,    max: 9,    default: 5,    unit: 'Hz' },
  { id: 'vibDepth', name: 'Vibrato',  min: 0,    max: 0.25, default: 0,    unit: '' },
  { id: 'growl',    name: 'Growl',    min: 0,    max: 0.3,  default: 0,    unit: '' },
  { id: 'noise',    name: 'Breath Nz', min: 0,   max: 0.5,  default: 0.12, unit: '' },
  { id: 'spread',   name: 'Spread',   min: 0,    max: 1,    default: 0.3,  unit: '' },
  { id: 'level',    name: 'Level',    min: 0,    max: 1,    default: CALIBRATED_LEVEL, unit: '' },
];

export const REED_PARAM_IDS: readonly string[] = REED_PARAMS.map((q) => q.id);
