// The pictures the analogue synth's panel draws, as arithmetic.
//
// Same rule as `synth-views.ts` next door: a drawing that lives inside a
// canvas callback can only be checked by looking at it, so the maths comes
// out here and `analog-panel-selftest` measures it against the engine.
//
// Everything returns points in the SAME space — x and y both 0…1, y measured
// downwards — so the component does one multiply per axis and cannot
// introduce a scale error of its own.
//
// There is one picture here that the wavetable synth has no equivalent of,
// and it is the one worth explaining.  DRIFT and TOLERANCE are what make this
// instrument analogue rather than a digital one with a ladder bolted on, and
// they are also the two controls whose numbers say least: "3.5 cents" and
// "3%" are not sounds.  Drawn — a line wandering over ten seconds, and six
// voices standing at six different heights — they are.

import {
  analogEnv, analogSample, driftCents, voiceTolerance,
} from '../engine/analog-model.js';
import type { Point } from './synth-views.js';

/** The waveform names, in the order the `shape` parameters index them. */
export const ANALOG_SHAPE_NAMES = ['Saw', 'Pulse', 'Triangle', 'Sine'] as const;

/**
 * The ladder's magnitude, in dB, at one frequency.
 *
 * Derived from the same loop the engine runs rather than from a textbook
 * four-pole curve, which is why it can show the two things that make this
 * filter a ladder and not a low-pass:
 *
 *   · the resonance is a peak at the cutoff AT EVERY SLOPE, because all four
 *     stages always run and only the output tap moves
 *   · the low end FALLS as the resonance comes up, because the feedback is
 *     subtracted from the input — and `compensation` feeds some input forward
 *     to put it back
 *
 * ── Why this is a z-domain expression and not `1/(1 + jw)⁴` ─────────────────
 *
 * The analogue prototype is wrong here by up to six decibels, and the first
 * version of this function used it.  Two things the engine does that the
 * prototype does not:
 *
 *   · each stage is the trapezoidal one-pole  H₁(z) = G(1+z⁻¹)/(1−(1−2G)z⁻¹)
 *     with G = g/(1+g), whose response bends near Nyquist
 *   · the feedback reads the PREVIOUS sample, so the loop carries an extra
 *     z⁻¹ — and at high resonance the loop gain is within a few per cent of
 *     one, where a small phase error is a large change in 1/(1−L)
 *
 * With both, and the output taken from stage `poles`:
 *
 *     H(z) = H₁(z)ᵖᵒˡᵉˢ · (1 + k·comp) / (1 + k·H₁(z)⁴·z⁻¹)
 *
 * Measured against the engine's own `Ladder`, this agrees to 0.01 dB at three
 * slopes and five frequencies.  The prototype was 15 dB out at the peak.
 *
 * ── Its one limit, said out loud ───────────────────────────────────────────
 *
 * `k = 4·res` is what the render loop computes, and above about k = 3.5 the
 * filter SELF-OSCILLATES.  A self-oscillating filter has no magnitude
 * response: the loop's own tone drives the `tanh` and compresses everything
 * else through it, which is the sound and is not a curve.  The picture keeps
 * drawing above that point because a panel that blanked at 0.88 would be
 * useless, and what it draws there is the small-signal response the loop
 * would have if it were not oscillating — the shape is right and the height
 * at the very peak is optimistic.
 *
 * The `tanh` is not in this at all, for the same reason: a saturating loop
 * has no single magnitude response, and drawing one at a particular level
 * would be right at one input and wrong at every other.  This is the
 * small-signal response, which is what a filter curve has always meant.
 */
export function ladderResponseDb(
  poles: number, cutoffHz: number, res: number, compensation: number, hz: number,
  sampleRate = 48000,
): number {
  const k = 4 * Math.min(0.999, Math.max(0, res));
  const comp = Math.max(0, Math.min(1, compensation));
  const tap = Math.max(2, Math.min(4, Math.round(poles)));

  const g = Math.tan((Math.PI * Math.min(cutoffHz, sampleRate * 0.49)) / sampleRate);
  const G = g / (1 + g);
  const th = (2 * Math.PI * Math.max(1e-6, hz)) / sampleRate;
  const zr = Math.cos(-th);
  const zi = Math.sin(-th);

  // H₁ = G(1 + z⁻¹) / (1 − (1−2G)z⁻¹), as one complex division.
  const nRe = G * (1 + zr);
  const nIm = G * zi;
  const dRe = 1 - (1 - 2 * G) * zr;
  const dIm = -(1 - 2 * G) * zi;
  const dd = dRe * dRe + dIm * dIm;
  const h1Re = (nRe * dRe + nIm * dIm) / dd;
  const h1Im = (nIm * dRe - nRe * dIm) / dd;

  // Powers of H₁ by repeated multiplication — the tap and the fourth stage.
  let tRe = 1; let tIm = 0;
  let fRe = 1; let fIm = 0;
  for (let i = 0; i < 4; i++) {
    const re = fRe * h1Re - fIm * h1Im;
    fIm = fRe * h1Im + fIm * h1Re;
    fRe = re;
    if (i + 1 === tap) { tRe = fRe; tIm = fIm; }
  }

  // The loop: k·H₁⁴·z⁻¹.
  const lRe = fRe * zr - fIm * zi;
  const lIm = fRe * zi + fIm * zr;
  const denRe = 1 + k * lRe;
  const denIm = k * lIm;

  const mag = (Math.hypot(tRe, tIm) * (1 + k * comp))
    / Math.max(1e-12, Math.hypot(denRe, denIm));
  return 20 * Math.log10(Math.max(1e-9, mag));
}

/**
 * Cycles of an oscillator, as the engine's own sample function leaves it.
 *
 * `analogSample` and nothing else, so a shape whose width control does
 * something shows it doing it — the triangle in particular is the integral of
 * the pulse rather than a shape of its own, and a drawing that used a
 * textbook triangle would show a control that does nothing.
 *
 * The integrator is primed for three cycles before the picture starts, for
 * the same reason the engine's is: it leaks towards centre and its first
 * cycle sits off it.
 */
export function analogWavePoints(
  shape: number, width: number, cycles = 2, points = 256,
): Point[] {
  const dt = cycles / points;
  const tri = { value: 0 };
  let phase = 0;
  for (let i = 0; i < points * 3; i++) {
    analogSample(shape, phase, dt, width, tri);
    phase += dt;
  }
  const out: Point[] = [];
  const raw: number[] = [];
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < points; i++) {
    const v = analogSample(shape, phase, dt, width, tri);
    raw.push(v);
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
    phase += dt;
  }
  // Fitted between its own extremes rather than scaled by its peak.  The
  // shapes do not share a peak — a pulse swings twice as far as a sine — and
  // this picture is of the SHAPE; the levels are the mixer's business and the
  // mixer has knobs for them.  Using the MIDPOINT and not the peak matters
  // for one shape in particular: the triangle comes out of a leaky integrator
  // and sits slightly off centre, so peak-scaling drew it at two thirds
  // height and called it flat.
  const centre = (hi + lo) / 2;
  const half = Math.max(1e-9, (hi - lo) / 2);
  for (let i = 0; i < points; i++) {
    out.push({ x: i / (points - 1), y: 0.5 - (((raw[i] ?? 0) - centre) / half) * 0.46 });
  }
  return out;
}

export interface AnalogEnvShape {
  points: Point[];
  /** Where the key lifts, in 0…1 across the picture. */
  releaseAt: number;
}

/**
 * The analogue ADSR as a polyline, sampled from `analogEnv` itself.
 *
 * The window is the envelope's own length plus a held section, like the
 * wavetable synth's, because an envelope drawn on a fixed time axis is either
 * a vertical line or a flat one.  What is different here is `curve`: at 0 the
 * segments are straight and at 1 they are the exponentials a capacitor makes,
 * and that difference is the single control that decides whether this synth
 * sounds analogue.  It has to be visible.
 */
export function analogEnvPoints(
  attack: number, decay: number, sustain: number, release: number, curve: number,
  points = 160, heldFraction = 0.22,
): AnalogEnvShape {
  const a = Math.max(0, attack);
  const d = Math.max(0, decay);
  const r = Math.max(0, release);
  const s = Math.max(0, Math.min(1, sustain));
  const moving = a + d + r;
  const span = moving > 1e-6 ? moving : 1;
  const held = span * (heldFraction / Math.max(0.05, 1 - heldFraction));
  const total = span + held;
  const gate = a + d + held;

  const out: Point[] = [];
  for (let i = 0; i < points; i++) {
    const t = (i / (points - 1)) * total;
    // The engine's own `analogEnv`, at the engine's own gate — this module
    // never computes an envelope of its own.
    const v = analogEnv(t, gate, a, d, s, r, curve);
    out.push({ x: i / (points - 1), y: 1 - Math.max(0, Math.min(1, v)) });
  }
  return { points: out, releaseAt: gate / total };
}

/**
 * How far the oscillators wander, over `seconds`.
 *
 * `range` is the half-height of the picture in cents, so the line can be read
 * against a scale rather than being auto-fitted — auto-fitting would make
 * drift 1 and drift 25 draw the identical picture, which is the opposite of
 * what this control needs to show.
 */
export function driftPoints(
  depth: number, seed: number, seconds = 10, range = 25, points = 240,
): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < points; i++) {
    const t = (i / (points - 1)) * seconds;
    const cents = driftCents(t, depth, seed);
    out.push({
      x: i / (points - 1),
      y: Math.max(0, Math.min(1, 0.5 - (cents / Math.max(1e-6, range)) * 0.46)),
    });
  }
  return out;
}

export interface VoiceRow {
  slot: number;
  /** The four multipliers, in the order the render loop asks for them. */
  cutoff: number;
  amp: number;
  env: number;
  res: number;
}

/**
 * What each voice's components came out at.
 *
 * The render loop asks `voiceTolerance` for exactly these four, with exactly
 * these spreads, so this table is the hardware the next note will land on —
 * and it is the only way to see that TOLERANCE is a real thing rather than a
 * number in a box.  Six rows at six different heights is the picture; one
 * number is not.
 */
export function voiceRows(voices: number, spread: number): VoiceRow[] {
  const n = Math.max(1, Math.min(8, Math.round(voices)));
  const out: VoiceRow[] = [];
  for (let slot = 0; slot < n; slot++) {
    out.push({
      slot,
      cutoff: voiceTolerance(slot, spread, 0),
      amp: voiceTolerance(slot, spread * 0.5, 1),
      env: voiceTolerance(slot, spread * 0.6, 2),
      res: voiceTolerance(slot, spread * 0.4, 3),
    });
  }
  return out;
}
