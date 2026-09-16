// The pictures the drum machine's panel draws, as arithmetic.
//
// Same rule as the three synth panels: a drawing that lives inside a canvas
// callback can only be checked by looking at it, so the maths comes out here
// and `drum-panel-selftest` measures it against the engine.
//
// The picture a drum machine needs is not a filter curve — there is no
// filter — it is the HIT ITSELF.  Eleven voices whose whole identity is a
// shape a few hundred milliseconds long, and the only honest way to draw that
// is to render it and plot it.  Which is cheap here for a reason the synths
// cannot use: a drum hit is already short, so the picture is the sound.

import { drumWindow, renderDrumVoice, type DrumVoice } from '../engine/drum-machine.js';
import type { Point } from './synth-views.js';

/** The rate the previews render at, and why it is not the session's. */
export const PREVIEW_RATE = 22050;

/**
 * One hit, as a waveform envelope.
 *
 * Both halves of it: `top` and `bottom` are the largest and smallest sample
 * in each column, so the picture is the shape a waveform display would show
 * rather than a smoothed outline.  A kick's asymmetry and a clap's four
 * bursts are both visible in that and in nothing else.
 *
 * Rendered at 22 kHz because the picture is a few hundred columns wide and
 * nothing above 11 kHz can survive being drawn into one of them anyway.  A
 * kick at this rate costs about three milliseconds.
 *
 * The window is FIXED per voice — its longest possible tail — and not the
 * length of this particular hit.  That is the whole reason the decay knob is
 * visible: an exponential tail drawn on an axis that scales with it is the
 * identical picture at every setting, which is what the first version of this
 * drew and what its check caught.
 *
 * ── The time axis is a square root, and that is not decoration ─────────────
 *
 * A fixed linear window cannot serve this instrument.  The voices span three
 * orders of magnitude — a rim is 11 ms and a cymbal is six seconds — and on a
 * linear axis long enough for the cymbal the clap's four bursts occupy TWO
 * PER CENT of the width and simply are not there.  Which is what the first
 * version drew, and the four bursts are the clap's whole identity.
 *
 * So column `c` covers the time from (c/N)²·W to ((c+1)/N)²·W: fine at the
 * attack, coarse in the tail, monotonic throughout.  The clap's bursts now
 * take 15 per cent of the width and the decay knob still visibly moves where
 * the sound ends.  The label says the window; the axis is stated here and on
 * the panel rather than left to be inferred.
 */
/**
 * The first sample of column `c`, on the square-root axis.
 *
 * Exported because the selftest reproduces the reduction against the engine's
 * own samples and must use the same mapping — a check that computed its own
 * would be checking two descriptions of a picture against each other.
 */
export function columnStart(c: number, columns: number, samples: number): number {
  const u = c / columns;
  return Math.min(samples, Math.floor(u * u * samples));
}

export function hitShape(
  voice: DrumVoice, params: Readonly<Record<string, number>>, columns = 240,
): { top: Point[]; bottom: Point[]; seconds: number } {
  const seconds = drumWindow(voice);
  const r = renderDrumVoice({
    sampleRate: PREVIEW_RATE,
    seconds,
    voice,
    velocity: 1,
    // A fixed seed: this is a picture of the VOICE, and a display that
    // changed every repaint would be describing one hit rather than the
    // settings that made it.
    seed: 1,
    params,
  });
  const n = r.left.length;
  let peak = 1e-9;
  for (let i = 0; i < n; i++) {
    const v = ((r.left[i] ?? 0) + (r.right[i] ?? 0)) / 2;
    if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  const top: Point[] = [];
  const bottom: Point[] = [];
  for (let c = 0; c < columns; c++) {
    const from = columnStart(c, columns, n);
    const to = Math.min(n, Math.max(from + 1, columnStart(c + 1, columns, n)));
    let hi = 0;
    let lo = 0;
    for (let i = from; i < to; i++) {
      const v = ((r.left[i] ?? 0) + (r.right[i] ?? 0)) / 2;
      if (v > hi) hi = v;
      if (v < lo) lo = v;
    }
    const x = c / Math.max(1, columns - 1);
    // Normalised to the hit's own peak, so the picture is the SHAPE.  A voice
    // turned down should not become a flat line at the bottom of its box.
    top.push({ x, y: 0.5 - (hi / peak) * 0.46 });
    bottom.push({ x, y: 0.5 - (lo / peak) * 0.46 });
  }
  return { top, bottom, seconds };
}

/**
 * How the kick's pitch falls, over the first part of the note.
 *
 * Drawn from the same expression the render loop runs.  It is the one thing
 * about this voice that a waveform picture cannot show — at 50 Hz the columns
 * are wider than a cycle — and it is the whole difference between an 808 kick
 * and a sine with an envelope on it.
 */
export function kickSweep(
  tuneHz: number, bendSemis: number, decay: number, masterSemis: number,
  seconds = 0.25, points = 160,
): { points: Point[]; topHz: number; baseHz: number } {
  const f0 = tuneHz * Math.pow(2, masterSemis / 12);
  const bendDec = Math.max(0.002, decay * 0.09);
  const top = f0 * Math.pow(2, bendSemis / 12);
  // A fixed scale rather than an auto-fitted one, so Bend 0 and Bend 48 do
  // not draw the same line — the mistake the analogue panel's drift display
  // was written to avoid.
  const ceiling = tuneHz * Math.pow(2, masterSemis / 12) * Math.pow(2, 48 / 12);
  const out: Point[] = [];
  for (let i = 0; i < points; i++) {
    const t = (i / (points - 1)) * seconds;
    const hz = f0 * Math.pow(2, (bendSemis / 12) * Math.exp(-t / bendDec));
    out.push({
      x: i / (points - 1),
      y: Math.max(0, Math.min(1, 1 - Math.log2(hz / f0) / Math.log2(ceiling / f0))),
    });
  }
  return { points: out, topHz: top, baseHz: f0 };
}
