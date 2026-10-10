// A bowed string, computed sample by sample.
//
// ── Why this is not the plucked string with a longer envelope ───────────────
//
// A plucked string is an INITIAL CONDITION: you put energy in once and listen
// to it leave.  `string-model.ts` is that, and it is right for a guitar.
//
// A bowed string is a CONTINUOUS NONLINEARITY.  The bow never stops feeding
// the string, and what it feeds depends on how fast the string is already
// moving under it — rosin grips while the two move together and lets go once
// they do not.  Grip, drag, release, catch again: once per period, and the
// travelling kink that results is Helmholtz motion.  That feedback is the
// instrument.  There is no envelope that turns a pluck into it, which is why
// every sampled string library still sounds like a sample when you ask it for
// a crescendo on one bow, and why this is a second engine rather than a knob
// on the first.
//
// Three things follow from the friction that do not follow from an envelope,
// and all three are measured in `bowed-selftest.ts`:
//
//   · LOUDNESS IS BOW SPEED, not bow force.  Pressing harder on a violin
//     does not make it louder, it makes it worse.  On every sampled
//     instrument velocity is loudness, which is why a sampled violin cannot
//     play a real crescendo.
//   · THERE IS A MINIMUM AND A MAXIMUM FORCE, and both depend on where the
//     bow sits.  Below the minimum the string never locks into Helmholtz
//     motion and you get the breathy surface sound; above the maximum the
//     kink cannot release cleanly and you get the crunch.  Schelleng drew
//     the region between them in 1973 and it is the whole of bow technique.
//   · WHERE THE BOW SITS IS A COMB.  The Helmholtz corner reaches the bow
//     once per round trip, so the bridge force is a sawtooth whose corner is
//     at the bow's fraction of the string.  Near the bridge that is a short
//     corner and a bright, thin, hard-to-control sound; over the fingerboard
//     it is a long one and the sound is soft and flutey.
//
// ── How the friction is actually solved ────────────────────────────────────
//
// The usual implementation (STK's included) replaces the friction with a
// hand-fitted "bow table" — a curve that returns a reflection coefficient and
// happens to oscillate.  This solves the real junction instead, because the
// three properties above come OUT of the physics and have to be put INTO a
// fitted curve one at a time.
//
// At the bow, the string is two semi-infinite sections of impedance Z.  With
// `v_h` the sum of the two incoming velocity waves and F the force the bow
// applies, the string has to satisfy both
//
//     v = v_h + F/(2Z)                         (the waveguide's load line)
//     F = sign(Δv) · F_N · μ(|Δv|)              (the friction curve)
//
// at once, where Δv = v_bow − v is how fast the bow is sliding over the
// string and μ falls from a static μ_s to a dynamic μ_d as it does.  Writing
// a = F_N/(2Z) — the bow force in velocity units — and eliminating v:
//
//     Δv + a·μ(Δv) − d = 0,      d = v_bow − v_h
//
// STICKING is the case Δv = 0, which needs |d| ≤ a·μ_s: the bow can hold the
// string only while the force that would take it is within what rosin has.
// Otherwise the string slips and the root in (0, |d|) is where.
//
// The root is unique, which is worth stating because the literature's picture
// of bowed friction is famously multivalued and the first version of this
// solver was written to cope with three roots.  It does not have to:
//
//     h(u) = u + a·μ(u) − D      with u = |Δv| and D = |d|
//
// has h(0) = a·μ_s − D, which is NEGATIVE exactly when the string is
// slipping at all, and h(D) = a·μ(D) > 0 always.  h falls to a single
// minimum at u* = v_s·ln(a(μ_s−μ_d)/v_s) and rises after it, so on [u*, D]
// it is monotone and there is exactly one crossing.  The multivaluedness in
// the textbook picture lives in the (v, F) plane WITH the sticking branch
// included; once sticking has been decided separately — which it is, one
// line above — what is left is single-valued.
//
// Getting that wrong is not harmless.  Bisecting the whole of [0, D] on a
// function that dips below zero finds A crossing rather than THE crossing,
// and the solver then hops between branches from sample to sample.  Measured,
// that turned the same settings into a clean sawtooth at one pitch and noise
// at the next — which reads as "bowing is chaotic" and is really a bracket
// that was too wide.
//
// ── Where the bow sits, when the note is not an open string ────────────────
//
// The player's arm does not move up the fingerboard as the notes get higher.
// The bow stays roughly where it was and the STRING gets shorter, so the
// bow's fraction of the sounding length grows — by an octave's worth at the
// octave.  High positions are therefore closer to the bridge in the only
// sense that matters, which is why they are brighter and harder to play, and
// modelling it means picking the string first and scaling β by the stop.
//
// ── The body ───────────────────────────────────────────────────────────────
//
// A bowed waveguide on its own is a sawtooth: correct, and not a violin.
// What makes it one is a box with a few strong resonances — the main air
// resonance through the f-holes, the corpus modes just above it, and the
// broad "bridge hill" two octaves up that is the bridge's own compliance
// rather than the box at all.  Those are filters here, and an impulse
// response of a real instrument would be better.  Said plainly rather than
// left for someone to discover.
//
// ── Determinism ────────────────────────────────────────────────────────────
//
// Bow noise is seeded from the note, like everything else here: a bounce is
// bit-identical to the preview, so the hair cannot use `Math.random()`.

import { CALIBRATED_LEVEL, INSTRUMENT_TRIM } from './instrument-level.js';

/** A small deterministic PRNG.  Same note, same bow hair, every render. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One resonance of a body: centre, Q, and how far it stands up, in dB. */
export type BodyMode = readonly [hz: number, q: number, db: number];

export interface BowBody {
  id: string;
  name: string;
  /** Open strings, lowest first, as MIDI pitch. */
  strings: readonly number[];
  /** The corpus modes, lowest first. */
  modes: readonly BodyMode[];
  /**
   * The bridge hill: a broad peak two octaves or so above the corpus modes.
   *
   * It is NOT a mode of the box — it is the bridge itself, which is a sprung
   * lever and has its own resonance.  That is why it is broad, why it sits
   * in the same place on instruments of very different sizes relative to
   * their bodies, and why muting a violin (a clip on the bridge) kills it.
   */
  hill: BodyMode;
  /** Below the main air resonance a box this size radiates almost nothing. */
  floorHz: number;
  /** Bow-to-bridge distance on an OPEN string, as a fraction of its length. */
  beta: number;
}

/**
 * The four instruments, and the numbers that make them four.
 *
 * The mode frequencies are the ones the violin-acoustics literature keeps
 * finding — A0 (the Helmholtz resonance of the air in the box, tuned near the
 * open D on a violin), CBR, B1− and B1+ (the corpus bending modes, the pair
 * that decides whether an instrument is called dark or bright), and the hill.
 * They are a family average rather than any one instrument: no two violins
 * agree on them, which is most of what "this violin sounds like that" means.
 */
export const BOW_BODIES: readonly BowBody[] = [
  {
    id: 'violin', name: 'Violin',
    strings: [55, 62, 69, 76],                    // G3 D4 A4 E5
    modes: [[280, 13, 7], [405, 15, 3.5], [460, 12, 7.5], [530, 11, 8]],
    hill: [2500, 1.1, 6], floorHz: 190, beta: 0.09,
  },
  {
    id: 'viola', name: 'Viola',
    strings: [48, 55, 62, 69],                    // C3 G3 D4 A4
    // A viola is a violin that is too small for its own tuning — the body
    // would have to be half again as long to put A0 a fifth lower, and no
    // player could reach round it.  So its air resonance sits ABOVE where
    // the tuning wants it, leaving the bottom fifth unsupported.  That
    // hollow low C is the sound of the instrument, not a defect of it.
    modes: [[230, 13, 6.5], [350, 15, 3], [420, 12, 7], [480, 11, 7]],
    hill: [2000, 1.1, 5], floorHz: 150, beta: 0.085,
  },
  {
    id: 'cello', name: 'Cello',
    strings: [36, 43, 50, 57],                    // C2 G2 D3 A3
    modes: [[100, 13, 6.5], [180, 15, 4], [220, 12, 7], [280, 11, 6]],
    hill: [1400, 1.1, 5], floorHz: 70, beta: 0.075,
  },
  {
    id: 'bass', name: 'Double Bass',
    strings: [28, 33, 38, 43],                    // E1 A1 D2 G2
    modes: [[60, 12, 6], [100, 14, 4], [130, 12, 6], [180, 11, 5]],
    hill: [800, 1.1, 4], floorHz: 40, beta: 0.07,
  },
];

export const BOW_BODY_NAMES: readonly string[] = BOW_BODIES.map((b) => b.name);

/** Rosin's static coefficient — what it can hold before it lets go. */
export const MU_STATIC = 0.8;
/** What is left once it is sliding. */
export const MU_DYNAMIC = 0.25;
/**
 * How fast the string has to slide before the friction has fallen most of
 * the way from static to dynamic.
 *
 * This is the one number in the friction that is not a textbook constant:
 * rosin's real curve depends on temperature at the contact, which changes
 * within a single period.  A fixed characteristic velocity is the standard
 * simplification and it is a simplification — the thermal model gives a
 * wider hysteresis loop and a rounder release than this does.
 */
export const SLIP_VELOCITY = 0.09;

/** μ(u): what rosin holds at a sliding speed u. */
export function frictionMu(u: number): number {
  return MU_DYNAMIC + (MU_STATIC - MU_DYNAMIC) * Math.exp(-Math.abs(u) / SLIP_VELOCITY);
}

/**
 * Solve the bow junction for the velocity wave it injects.
 *
 * `d` is how fast the bow would be sliding if it were frictionless, `a` is
 * the bow force in velocity units, and `prev` is last sample's sliding speed,
 * which is both the starting guess and the choice of branch where the curve
 * folds.  Returns `{ w, slip }`: the injected wave, and the sliding speed to
 * carry into the next sample.
 */
export function solveBow(d: number, a: number, prev: number): { w: number; slip: number } {
  // Sticking: the string goes exactly where the bow does, and the bow takes
  // whatever force that needs — as long as rosin has it.
  if (Math.abs(d) <= a * MU_STATIC) return { w: d, slip: 0 };

  const sign = d < 0 ? -1 : 1;
  const D = Math.abs(d);
  const h = (u: number): number => u + a * frictionMu(u) - D;
  const dh = (u: number): number =>
    1 - (a * (MU_STATIC - MU_DYNAMIC) / SLIP_VELOCITY) * Math.exp(-u / SLIP_VELOCITY);

  // Bracket on [u*, D], where h is monotone increasing — see the header.
  const k = a * (MU_STATIC - MU_DYNAMIC) / SLIP_VELOCITY;
  const uStar = k > 1 ? Math.min(D, SLIP_VELOCITY * Math.log(k)) : 0;

  let u = Math.min(D, Math.max(uStar, prev));
  let ok = false;
  for (let i = 0; i < 4; i++) {
    const g = h(u);
    if (Math.abs(g) < 1e-10) { ok = true; break; }
    const slope = dh(u);
    if (!(slope > 1e-6)) break;
    const next = u - g / slope;
    if (!(next >= uStar) || next > D) break;
    u = next;
    if (Math.abs(g) < 1e-8) { ok = true; break; }
  }
  if (!ok || !Number.isFinite(u)) {
    let lo = uStar;
    let hi = D;
    for (let i = 0; i < 28; i++) {
      const mid = (lo + hi) * 0.5;
      if (h(mid) < 0) lo = mid; else hi = mid;
    }
    u = (lo + hi) * 0.5;
  }
  return { w: sign * (D - u), slip: u };
}

/**
 * A fractional delay line.
 *
 * Read and write are separate so the length can move under vibrato without
 * the buffer being rebuilt; the interpolation is linear, which loses a little
 * top at long delays and is what every waveguide does.
 */
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

/** One biquad section, as coefficients and two states. */
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

/** The magnitude of a cascade at one frequency, in dB. */
export function cascadeDb(sections: readonly Biquad[], hz: number, sr: number): number {
  const w = 2 * Math.PI * hz / sr;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  let mag = 1;
  for (const s of sections) {
    const nr = s.b0 + s.b1 * cw + s.b2 * c2;
    const ni = -(s.b1 * sw + s.b2 * s2);
    const dr = 1 + s.a1 * cw + s.a2 * c2;
    const di = -(s.a1 * sw + s.a2 * s2);
    mag *= Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  return 20 * Math.log10(Math.max(1e-12, mag));
}

/**
 * The body's filters, as a cascade.
 *
 * Exported so the tests — and any picture — read the same sections the sound
 * goes through, rather than a second copy of the numbers that can drift from
 * it.  `tilt` shifts every resonance together, which is what a smaller or
 * larger instrument of the same family is.
 */
export function bodySections(body: BowBody, sr: number, tilt = 1): Biquad[] {
  const out: Biquad[] = [highpass(body.floorHz * tilt, 0.7, sr)];
  for (const [hz, q, db] of body.modes) out.push(peaking(hz * tilt, q, db, sr));
  out.push(peaking(body.hill[0] * tilt, body.hill[1], body.hill[2], sr));
  return out;
}

function runBiquad(s: Biquad, x: number, z: [number, number]): number {
  const y = s.b0 * x + z[0];
  z[0] = s.b1 * x - s.a1 * y + z[1];
  z[1] = s.b2 * x - s.a2 * y;
  return y;
}

/**
 * Which string a note is played on, and how far up it.
 *
 * The highest string that can reach the note, the way a player picks it: a
 * violinist plays A4 on the A string open, not in fourth position on the D.
 * Returns the open pitch and the stop ratio (1 = open, 2 = the octave).
 */
export function stringFor(body: BowBody, pitch: number): { open: number; stop: number } {
  let open = body.strings[0] ?? 55;
  for (const s of body.strings) if (s <= pitch) open = s;
  return { open, stop: Math.pow(2, (pitch - open) / 12) };
}

export interface BowedRenderSpec {
  sampleRate: number;
  seconds: number;
  /** How long the bow is on the string. */
  gateSec: number;
  freqHz: number;
  pitch: number;
  velocity: number;
  startBeat: number;
  params: Readonly<Record<string, number>>;
  /**
   * Filled, if given, with the string's velocity AT THE BOW.
   *
   * This is the stick-slip cycle itself — the thing the panel draws and the
   * thing the instrument is — and it is not recoverable from the output: what
   * comes out of the bridge is one travelling wave through a body, and the
   * velocity at the bow is the sum of two.  An out-parameter rather than a
   * second function, because a second function would be a second copy of the
   * loop and the two could then disagree about the sound.
   */
  bowVelocity?: Float32Array;
}

export interface BowedRender { left: Float32Array; right: Float32Array }

function p(params: Readonly<Record<string, number>>, id: string, fallback: number): number {
  const v = params[id];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Control rate, as everywhere else here: vibrato does not need 48 kHz. */
export const BOW_CONTROL_STRIDE = 16;

/**
 * How long after the bow leaves the string there is still something to hear.
 *
 * Not an envelope release — the string is still ringing and still losing
 * energy through the same loop, so this is how long that takes to become
 * inaudible at the damping in use.
 */
export function bowedTail(params: Readonly<Record<string, number>>): number {
  const damp = Math.min(0.9999, Math.max(0.9, 1 - 0.02 * (1 - p(params, 'sustainRing', 0.6))));
  // Round trips to fall 60 dB, at a middling pitch of 300 Hz.
  const trips = Math.log(0.001) / Math.log(damp);
  return Math.min(4, Math.max(0.12, trips / 300));
}

export function renderBowedVoice(spec: BowedRenderSpec): BowedRender {
  const sr = spec.sampleRate;
  const n = Math.max(1, Math.round(sr * Math.max(0.02, spec.seconds)));
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  // Silence rather than NaN when the note is not a note.
  //
  // Found by driving this from the running app with a malformed note, which
  // made the pitch NaN.  The other instruments answered with silence; this
  // one filled the buffer with NaN, and a NaN buffer does not stay on its own
  // track — it goes down the mix bus and takes the whole song with it.  A
  // resonant loop has this failure mode and an oscillator does not, so the
  // guard belongs here rather than in the caller.
  if (!Number.isFinite(spec.freqHz) || spec.freqHz <= 0
    || !Number.isFinite(spec.pitch) || !Number.isFinite(spec.velocity)) {
    return { left, right };
  }
  const prm = spec.params;
  const vel = Math.min(1, Math.max(0, spec.velocity));

  const body = BOW_BODIES[Math.max(0, Math.min(BOW_BODIES.length - 1,
    Math.round(p(prm, 'body', 0))))] ?? BOW_BODIES[0]!;

  // ── Where the bow sits ─────────────────────────────────────────────────
  //
  // The knob is where the arm is, on an open string.  The note decides the
  // rest: a stopped string is shorter and the same arm is a larger fraction
  // of the way to the bridge.
  const { stop } = stringFor(body, spec.pitch);
  const betaKnob = Math.max(0.02, Math.min(0.3, p(prm, 'pos', body.beta)));
  // The square root rather than the stop itself: a player going up the
  // fingerboard moves the bow toward the bridge as well, so β grows more
  // slowly than the string shortens.  Capped, because past about a fifth of
  // the way along there is no Helmholtz motion left to have.
  const beta = Math.max(0.012, Math.min(0.2, betaKnob * Math.sqrt(stop)));

  // ── The bow ────────────────────────────────────────────────────────────
  //
  // Velocity is BOW SPEED, and force is its own knob.  That is the whole
  // point of the engine and it is why a crescendo here is a real one.
  const speed = Math.max(0.01, p(prm, 'speed', 0.5)) * (0.35 + 0.65 * vel);
  const forceKnob = Math.max(0, Math.min(1, p(prm, 'force', 0.45)));
  // Force in velocity units, and the mapping is MEASURED.
  //
  // Instrumenting the junction — what fraction of each period the string is
  // stuck to the bow, and how far its velocity swings — makes the window
  // visible.  Helmholtz motion is the state where the string rides with the
  // bow for (1−β) of the period and flies back during the rest, so its
  // velocity runs between +v_bow and −v_bow(1−β)/β.  At A4, β = 0.09 and a
  // bow speed of 0.435, that predicts a stuck fraction of 0.910 and a swing
  // of [−4.40, +0.44].  Swept, the model gives:
  //
  //      a = 1      stuck 0.706   v [−1.76, 0.44]     below minimum force
  //      a = 2      stuck 0.869   v [−4.48, 0.44]     Helmholtz
  //      a = 4      stuck 0.895   v [−4.74, 0.44]     Helmholtz
  //      a = 16     stuck 0.957   v [−11.35, 0.44]    over-pressed
  //
  // so the window is real and it is narrow in the wrong units.  Written as
  // a = k·v_bow/β it stops moving: k between about 0.5 and 1.3 is Helmholtz
  // at EVERY pitch and every bow position tested, which is what makes the
  // knob playable.  That is not a fudge — Schelleng's minimum force is
  // proportional to bow speed and inversely to the square of β, so a knob in
  // absolute force would have to be re-set every time either changed.  Here
  // the knob is a position in the Schelleng diagram instead.
  //
  // What is NOT modelled, since the same sweep shows it: past about k = 2 the
  // string simply sticks longer and gets louder without bound, where a real
  // over-pressed string goes into a rough, period-doubled crunch.  Escaping
  // that needs the torsional modes and a bow of finite width, neither of
  // which is here, so the knob's top is placed below it.
  const aMax = (0.14 + 1.5 * forceKnob) * speed / Math.max(0.05, beta);

  const attackSec = Math.max(0.005, Math.min(0.5, p(prm, 'attack', 0.05)));
  const relSec = Math.max(0.01, Math.min(1.5, p(prm, 'release', 0.08)));
  const gate = Math.max(0.01, spec.gateSec);

  // ── The string ─────────────────────────────────────────────────────────
  const damping = Math.min(0.9999, Math.max(0.9,
    1 - 0.02 * (1 - Math.max(0, Math.min(1, p(prm, 'sustainRing', 0.6))))));
  // One pole of loss inside the loop: the top of the spectrum dies faster
  // than the bottom, which is why a note that is let go turns dark before it
  // turns quiet.  Its phase delay at low frequency is taken back out of the
  // loop length below, so it does not detune the string.
  //
  // Its corner goes as the SQUARE ROOT of the pitch, which is the one choice
  // here that was arrived at by elimination.  A corner in fixed Hz leaves the
  // top of the range with almost no loss in the loop and the ripple from the
  // bow-bridge section then never dies; a corner proportional to the pitch
  // does the same thing one octave higher up.  Swept against the stuck
  // fraction the string actually achieves, √f0 is the rule that holds
  // Helmholtz motion from the bottom of a bass to the top of a violin, and it
  // is also roughly what a real string does — a mode's Q rises with frequency,
  // but nothing like proportionally.
  const brightKnob = Math.max(0, Math.min(1, p(prm, 'bright', 0.5)));
  const lossHz = (170 + 250 * brightKnob) * Math.sqrt(Math.max(20, spec.freqHz));
  const wLoss = 2 * Math.PI * Math.min(lossHz, sr * 0.45) / sr;
  const cLoss = 2 - Math.cos(wLoss);
  const lossG = Math.max(0, Math.min(0.92, cLoss - Math.sqrt(Math.max(0, cLoss * cLoss - 1))));
  const lossDelay = lossG / (1 - lossG);

  const period = sr / Math.max(20, spec.freqHz);
  const rnd = mulberry32((Math.round(spec.pitch) * 2654435761
    + Math.round(spec.startBeat * 96) * 40503 + Math.round(vel * 127)) >>> 0);

  const bridgeLine = new Line(period + 8);
  const nutLine = new Line(period + 8);

  // ── Vibrato ────────────────────────────────────────────────────────────
  //
  // A finger rocking on the string, so it is a LENGTH change, and the
  // amplitude wobble that comes with it is not a second effect — it is those
  // harmonics sliding across the body's resonances, which happens by itself
  // once the body is there.
  const vibHz = Math.max(0, Math.min(9, p(prm, 'vibRate', 5.2)));
  const vibCents = Math.max(0, Math.min(80, p(prm, 'vibDepth', 0)));
  const vibDelay = Math.max(0, Math.min(1.5, p(prm, 'vibDelay', 0.25)));

  const hair = Math.max(0, Math.min(1, p(prm, 'hair', 0.25)));

  // ── The body ───────────────────────────────────────────────────────────
  const tilt = Math.pow(2, Math.max(-1, Math.min(1, p(prm, 'size', 0))) * 0.25);
  const sections = bodySections(body, sr, tilt);
  const zL = sections.map((): [number, number] => [0, 0]);
  // The right ear is not at the same angle to the box as the left, and the
  // modes do not radiate evenly.  A slightly different hill is what that is;
  // it is an approximation of a directional pattern, not a measurement of one.
  const width = Math.max(0, Math.min(1, p(prm, 'width', 0.4)));
  const sectionsR = bodySections(body, sr, tilt * (1 + 0.035 * width));
  const zR = sectionsR.map((): [number, number] => [0, 0]);
  const bodyMix = Math.max(0, Math.min(1, p(prm, 'bodyAmt', 1)));

  const trim = (INSTRUMENT_TRIM as Readonly<Record<string, number>>)['bowed'] ?? 1;
  const level = Math.max(0, Math.min(1, p(prm, 'level', CALIBRATED_LEVEL)));
  const gain = trim * level;
  const trace = spec.bowVelocity;
  let slip = 0;
  let lossZ = 0;
  let hairZ = 0;
  let dcZ = 0;
  let vBow = 0;
  let aBow = 0;
  let dB = beta * period - 1 - lossDelay;
  let dN = (1 - beta) * period - 1;
  let tap = beta * period * 0.5;

  for (let i = 0; i < n; i++) {
    if ((i % BOW_CONTROL_STRIDE) === 0) {
      const t = i / sr;
      // Bow on, bow off.  The attack is a ramp of SPEED and FORCE together,
      // because that is what an arm does, and everything the attack sounds
      // like comes out of the friction rather than out of a shape.
      const on = t < gate
        ? Math.min(1, t / attackSec)
        : Math.max(0, 1 - (t - gate) / relSec);
      vBow = speed * on;
      aBow = aMax * on;

      const vibOn = vibCents > 0 && t > vibDelay
        ? Math.min(1, (t - vibDelay) / 0.18)
        : 0;
      const cents = vibOn * vibCents * Math.sin(2 * Math.PI * vibHz * t);
      const per = period * Math.pow(2, -cents / 1200);
      // Three things sit in the loop besides the two delays, and all three
      // have to come out of the length or the string plays flat:
      //
      //   · each line is READ before it is WRITTEN, which is one more sample
      //     of delay apiece — measured, the first version locked at a period
      //     of 111 samples where A4 wants 109.1, which is 30 cents flat and
      //     gets worse the higher the note
      //   · the loss filter's own phase delay, g/(1-g) at low frequency
      //
      // The compensation is exact at low frequency only, because a one-pole's
      // phase delay is not flat.  What that costs is a few cents of stretch
      // at the very top of each string, which is the direction a real string's
      // stiffness pulls it anyway.
      dB = beta * per - 1 - lossDelay;
      dN = (1 - beta) * per - 1;
      tap = beta * per * 0.5;
    }

    // Both incoming waves arrive at the bow.  The bridge and the nut each
    // reflect with a sign change; only the bridge end is lossy, because the
    // nut (or the finger) is the near-rigid one.
    //
    // The loss filter is IN the loop, which is the whole point of it: a loop
    // whose gain is one number loses every harmonic at the same rate, and a
    // string does not — it loses the top first.  Put outside, on the output
    // tap, it darkens the sound and leaves the loop undamped, and the top of
    // the spectrum then rings until the motion is no longer periodic at all.
    // That was the first version, and it did exactly that.
    const raw = bridgeLine.read(dB);
    lossZ = raw * (1 - lossG) + lossZ * lossG;
    const fromBridge = -lossZ * damping;
    const fromNut = -nutLine.read(dN);
    const vh = fromBridge + fromNut;

    // Bow hair is not smooth and rosin is not evenly spread.  A little noise
    // ON THE BOW SPEED (not added to the output) is what that is: it feeds
    // the same nonlinearity the note does, so it scratches during the attack
    // and all but vanishes once Helmholtz motion takes hold — which is
    // exactly when a real bow stops being audible as hair.
    hairZ += 0.08 * ((rnd() * 2 - 1) - hairZ);
    const vb = vBow * (1 + hair * 0.9 * hairZ);

    const sol = solveBow(vb - vh, aBow, slip);
    slip = sol.slip;
    if (trace && i < trace.length) trace[i] = vh + sol.w;

    bridgeLine.write(fromNut + sol.w);
    nutLine.write(fromBridge + sol.w);

    // The bridge sees the wave arriving at it — half a round trip along the
    // short side — and a rigid termination turns that velocity wave into the
    // force the body is driven by.  Taking the output at the BOW instead
    // would be the two-level velocity of the stick-slip cycle, which is what
    // the player's finger feels and not what the room hears.
    const x = bridgeLine.read(tap);
    // The junction has a DC component whenever the bow is not symmetric, and
    // a body cannot radiate it.  Removing it here rather than letting the
    // highpass do it keeps the filter states from drifting off.
    const hp = x - dcZ;
    dcZ += hp * 0.0006;

    let l = hp;
    let r = hp;
    for (let s = 0; s < sections.length; s++) l = runBiquad(sections[s]!, l, zL[s]!);
    for (let s = 0; s < sectionsR.length; s++) r = runBiquad(sectionsR[s]!, r, zR[s]!);
    left[i] = gain * (bodyMix * l + (1 - bodyMix) * hp);
    right[i] = gain * (bodyMix * r + (1 - bodyMix) * hp);
  }

  return { left, right };
}

/**
 * The instrument's knobs.
 *
 * Bow Speed and Bow Force are two knobs and not one on purpose: they are the
 * two axes of the Schelleng diagram, they do different things, and collapsing
 * them into a single "expression" is exactly the simplification that makes a
 * sampled string library unable to play a crescendo.
 */
export const BOWED_PARAMS: readonly {
  id: string; name: string; min: number; max: number; default: number; unit: string;
}[] = [
  { id: 'body',   name: 'Body',    min: 0, max: BOW_BODIES.length - 1, default: 0, unit: '' },
  { id: 'size',   name: 'Size',    min: -1, max: 1, default: 0, unit: '' },

  { id: 'speed',  name: 'Bow Spd', min: 0.05, max: 1, default: 0.5, unit: '' },
  { id: 'force',  name: 'Bow Frc', min: 0, max: 1, default: 0.55, unit: '' },
  { id: 'pos',    name: 'Bow Pos', min: 0.02, max: 0.3, default: 0.09, unit: '' },
  { id: 'hair',   name: 'Hair',    min: 0, max: 1, default: 0.25, unit: '' },

  { id: 'attack', name: 'Attack',  min: 0.005, max: 0.5, default: 0.05, unit: 's' },
  { id: 'release', name: 'Release', min: 0.01, max: 1.5, default: 0.08, unit: 's' },

  { id: 'bright', name: 'Bright',  min: 0, max: 1, default: 0.5, unit: '' },
  { id: 'sustainRing', name: 'Ring', min: 0, max: 1, default: 0.6, unit: '' },

  { id: 'vibRate', name: 'Vib Rate', min: 0, max: 9, default: 5.2, unit: 'Hz' },
  { id: 'vibDepth', name: 'Vibrato', min: 0, max: 80, default: 0, unit: 'ct' },
  { id: 'vibDelay', name: 'Vib Dly', min: 0, max: 1.5, default: 0.25, unit: 's' },

  { id: 'bodyAmt', name: 'Body Amt', min: 0, max: 1, default: 1, unit: '' },
  { id: 'width',  name: 'Width',   min: 0, max: 1, default: 0.4, unit: '' },
  { id: 'level',  name: 'Level',   min: 0, max: 1, default: CALIBRATED_LEVEL, unit: '' },
];

export const BOWED_PARAM_IDS: readonly string[] = BOWED_PARAMS.map((q) => q.id);
