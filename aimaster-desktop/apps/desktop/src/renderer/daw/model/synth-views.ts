// The pictures the wavetable synth's panel draws, as arithmetic.
//
// Kept out of the component for the reason every other picture in this app is
// (`plugin-curves.ts`, `plugin-shapes.ts`): a drawing that lives inside a
// canvas callback can only be checked by looking at it, and "the filter
// display agrees with the filter" is a claim a test should be able to make.
//
// Everything here returns points in the SAME space — x and y both 0…1, y
// measured downwards — so the component's job is one multiply per axis and it
// cannot introduce a scale error of its own.

import { TableReader, type WavetableDef } from '../engine/wavetable.js';
import { lfoValue } from '../engine/mod-matrix.js';

export interface Point { x: number; y: number }

/**
 * One frame of a table, as a polyline.
 *
 * Mip 0 on purpose: this is a picture of what the table IS, not of what a
 * particular note will hear, and band-limiting the drawing to the note being
 * played would make the same table look different in every octave.
 */
export function framePoints(table: WavetableDef, pos: number, points: number): Float32Array {
  const out = new Float32Array(points);
  const reader = new TableReader(table);
  for (let i = 0; i < points; i++) out[i] = reader.read(pos, i / points, 0);
  return out;
}

export interface SurfaceLine {
  /** The polyline, in 0…1 space. */
  points: Point[];
  /** Which frame this is, so the caller can colour the current one. */
  frame: number;
  /** 0 at the front, 1 at the back — for fading with depth. */
  depth: number;
}

/**
 * The whole table as a stack of slices in perspective.
 *
 * This is the picture everybody recognises, and it is worth saying what it is
 * FOR rather than treating it as decoration: a wavetable's frames are the
 * only part of this instrument you cannot infer from a number.  "Table 4,
 * position 3.2" tells you nothing; the shape at position 3.2 sitting between
 * the shapes either side of it tells you what turning the knob will do.
 *
 * Front-to-back is frame 0 to the last, so the stack reads left to right the
 * way the position knob moves.  `shear` and `rise` are how far each step goes
 * across and up; `shrink` is the perspective, and without it the back of the
 * stack is the same size as the front and the picture reads as a grid rather
 * than as depth.
 */
export function tableSurface(
  table: WavetableDef, points: number,
  opts: { shear?: number; rise?: number; shrink?: number } = {},
): SurfaceLine[] {
  const shear = opts.shear ?? 0.3;
  const rise = opts.rise ?? 0.42;
  const shrink = opts.shrink ?? 0.34;
  const frames = table.frames.length;
  const out: SurfaceLine[] = [];
  // Back to front, so a caller that paints in order gets the near slices on
  // top without sorting anything.
  for (let f = frames - 1; f >= 0; f--) {
    const depth = frames === 1 ? 0 : f / (frames - 1);
    const wave = framePoints(table, f, points);
    const scale = 1 - shrink * depth;
    const x0 = shear * depth;
    const yBase = 1 - rise * depth;
    const line: Point[] = [];
    for (let i = 0; i < points; i++) {
      line.push({
        x: x0 + (i / (points - 1)) * (1 - shear) * scale,
        // Amplitude is a quarter of the height so that neighbouring slices
        // can overlap a little, which is what makes the stack read as one
        // surface rather than as a row of separate pictures.
        y: yBase - 0.5 * rise - (wave[i] ?? 0) * 0.22 * scale,
      });
    }
    out.push({ points: line, frame: f, depth });
  }
  return out;
}

/**
 * Where the position marker sits on that stack.
 *
 * Between two slices when the position is between two frames, which is the
 * whole point of the display: it shows that the knob is continuous and the
 * frames are not.
 */
export function surfaceMarker(
  table: WavetableDef, pos: number,
  opts: { shear?: number; rise?: number; shrink?: number } = {},
): { points: Point[]; depth: number } {
  const shear = opts.shear ?? 0.3;
  const rise = opts.rise ?? 0.42;
  const shrink = opts.shrink ?? 0.34;
  const frames = table.frames.length;
  const clamped = Math.max(0, Math.min(frames - 1, pos));
  const depth = frames === 1 ? 0 : clamped / (frames - 1);
  const wave = framePoints(table, clamped, 256);
  const scale = 1 - shrink * depth;
  const x0 = shear * depth;
  const yBase = 1 - rise * depth;
  const points: Point[] = [];
  for (let i = 0; i < 256; i++) {
    points.push({
      x: x0 + (i / 255) * (1 - shear) * scale,
      y: yBase - 0.5 * rise - (wave[i] ?? 0) * 0.22 * scale,
    });
  }
  return { points, depth };
}

// ── The filter ──────────────────────────────────────────────────────────────

/** The modes, in the order the `fltType` parameter indexes them. */
export const FILTER_MODE_NAMES = ['LP', 'BP', 'HP', 'Notch'] as const;

/**
 * The state-variable filter's magnitude, in dB, at one frequency.
 *
 * The ANALOG prototype, which is what the engine's zero-delay-feedback form
 * implements with its cutoff pre-warped by `tan` — so this is the response
 * being heard and not a generic two-pole drawing next to it.  `k` is the same
 * `2 − 2·res` the render loop computes, which is why resonance shows as a
 * peak here at the height it actually has.
 *
 *     D  = (1 − w²) + j·k·w      w = f / fc
 *     LP = 1/|D|   BP = w/|D|   HP = w²/|D|   Notch = |1 − w²|/|D|
 *
 * Two poles is the same filter twice, so the magnitude squares.
 */
export function svfResponseDb(
  mode: number, poles: number, cutoffHz: number, res: number, hz: number,
): number {
  const w = Math.max(1e-6, hz) / Math.max(1e-6, cutoffHz);
  const k = 2 - 2 * Math.max(0, Math.min(0.985, res));
  const real = 1 - w * w;
  const den = Math.hypot(real, k * w);
  let mag: number;
  switch (Math.max(0, Math.min(3, Math.round(mode)))) {
    case 1: mag = w / den; break;
    case 2: mag = (w * w) / den; break;
    case 3: mag = Math.abs(real) / den; break;
    default: mag = 1 / den;
  }
  if (poles >= 2) mag *= mag;
  return 20 * Math.log10(Math.max(1e-9, mag));
}

/** Semitones from MIDI 0 to hertz — the scale the cutoff knob is in. */
export function cutoffHz(semitones: number): number {
  return 8.1758 * Math.pow(2, semitones / 12);
}

// ── Envelopes and LFOs ──────────────────────────────────────────────────────

export interface EnvelopeShape {
  points: Point[];
  /** Where the key lifts, in 0…1 across the picture. */
  releaseAt: number;
}

/**
 * An ADSR as a polyline, drawn over a window that fits it.
 *
 * The window is the envelope's own length plus a held section rather than a
 * fixed number of seconds, because an envelope drawn on a fixed axis is
 * either a vertical line (fast) or a flat one (slow), and in both cases the
 * picture stops being about the settings.  `heldFraction` is how much of the
 * width the sustain gets, so the shape stays readable whatever the times are.
 */
export function envelopeShape(
  attack: number, decay: number, sustain: number, release: number,
  points = 128, heldFraction = 0.22,
): EnvelopeShape {
  const a = Math.max(0, attack);
  const d = Math.max(0, decay);
  const r = Math.max(0, release);
  const s = Math.max(0, Math.min(1, sustain));
  const moving = a + d + r;
  // A zero-length envelope still has to draw something, or the panel shows an
  // empty box for a click that is perfectly valid.
  const span = moving > 1e-6 ? moving : 1;
  const held = span * (heldFraction / Math.max(0.05, 1 - heldFraction));
  const total = span + held;

  const at = (t: number): number => {
    if (t < a) return a <= 0 ? 1 : t / a;
    if (t < a + d) return d <= 0 ? s : 1 + (s - 1) * ((t - a) / d);
    if (t < a + d + held) return s;
    const rt = t - (a + d + held);
    return r <= 0 ? 0 : Math.max(0, s * (1 - rt / r));
  };
  const out: Point[] = [];
  for (let i = 0; i < points; i++) {
    const t = (i / (points - 1)) * total;
    out.push({ x: i / (points - 1), y: 1 - at(t) });
  }
  return { points: out, releaseAt: (a + d + held) / total };
}

/** One or more LFO cycles as a polyline. */
export function lfoShape(
  shape: number, skew: number, cycles = 2, points = 192,
): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < points; i++) {
    const phase = (i / (points - 1)) * cycles;
    // Seed 0: the picture is of the SHAPE, and sample-and-hold's steps are
    // per note.  A drawing that changed every repaint would be describing one
    // note rather than the setting.
    const v = lfoValue(shape, phase, skew, 0);
    out.push({ x: i / (points - 1), y: 0.5 - v * 0.46 });
  }
  return out;
}
