// analyzer-view — the two things an analyser shows that a backdrop does not.
//
// `spectrum-view.ts` is already a good analyser: log columns, maximum across
// the bins in a pixel, a tilt so music does not read as a landslide, and peak
// ballistics with a hold line.  It is drawn behind an EQ curve, where what it
// is for is pointing at the 340 Hz box while you pull it out.
//
// A standalone analyser is asked a different question — "is this mix balanced"
// rather than "what is that whistle" — and the answer needs two things that
// file does not have.
//
// ── 1. An AVERAGE, and it has to be in power ───────────────────────────────
//
// The peak-fall line answers "is it loud NOW".  Tonal balance is a question
// about the whole passage, so it needs a line that converges: a one-pole
// average with a stated time constant, which is also exactly what the match
// EQ compares when it takes a reference.
//
// And the average has to be taken in POWER, not in decibels, which is the
// trap.  Averaging dB averages the LOGARITHM, and the mean of logarithms is
// the logarithm of the geometric mean — a different number, always lower, and
// dragged down without limit by quiet moments.  Measured on a band that is
// -20 dB half the time and -60 dB the other half: the power average reads
// -23.0 dB, which is the level of the energy that was actually there, and a
// dB average reads -40.0, which is a level the signal never had.
//
// ── 2. A GONIOMETER, because a spectrum cannot show phase ──────────────────
//
// Two mixes with identical spectra can be mono-compatible and unlistenable
// respectively, and nothing in a magnitude display separates them.  The
// Lissajous of left against right does, at a glance: a vertical line is mono,
// a circle is uncorrelated, a horizontal line is out of phase and will vanish
// the moment anything sums it.
//
// Rotated 45 degrees, which is not decoration.  Plotted raw, L against R, a
// mono signal is a diagonal, and "diagonal" is not a shape anyone reads at
// speed.  The rotation puts mid on the vertical axis and side on the
// horizontal, so the display means up-down = level, left-right = width, and
// those are the two things being looked for.

import { correlationOf, widthFromCorrelation } from '../analysis/reference.js';
import { columnHz, type SpectrumScale } from './spectrum-view.js';

/** The averaging windows on offer, in seconds. */
export const AVERAGE_SECONDS: readonly number[] = [1, 3, 10, 30];

export const AVERAGE_LABELS: readonly string[] = ['1초', '3초', '10초', '30초'];

/**
 * How many seconds of history a window actually holds.
 *
 * A one-pole is not a box: after one time constant it has taken 63 % of a
 * step, and it never arrives.  The label says the time constant because that
 * is the number that means something, and this says what to expect of it.
 */
export const AVERAGE_NOTES: readonly string[] = AVERAGE_SECONDS.map(
  (sec) => `시정수 ${sec}초 · 계단 입력의 63%까지 ${sec}초, 95%까지 ${(sec * 3).toFixed(0)}초`,
);

/** The window a parameter value selects. */
export function averageSeconds(index: number): number {
  const i = Math.round(Number.isFinite(index) ? index : 1);
  return AVERAGE_SECONDS[Math.max(0, Math.min(AVERAGE_SECONDS.length - 1, i))]!;
}

/**
 * Advance a running average towards a new frame, in place.
 *
 * One pole per column, in POWER — see the note at the top of this file.  The
 * coefficient is `exp(-dt/tau)`, which is the exact solution of the pole
 * rather than the `dt/tau` approximation: at 60 fps and a one-second window
 * they agree, and at 8 fps on a loaded machine the approximation is 6 %
 * fast, which is a different meter depending on how busy the computer is.
 */
export function advanceAverage(
  average: Float32Array, target: Float32Array,
  dtSec: number, tauSec: number, floorDb: number,
): void {
  const dt = Math.max(0, Math.min(1, dtSec));
  const tau = Math.max(1e-3, tauSec);
  const a = Math.exp(-dt / tau);
  for (let i = 0; i < average.length; i++) {
    const want = Math.pow(10, (target[i] ?? floorDb) / 10);
    const now = Math.pow(10, (average[i] ?? floorDb) / 10);
    const next = a * now + (1 - a) * want;
    average[i] = next > 0 ? Math.max(floorDb, 10 * Math.log10(next)) : floorDb;
  }
}

export interface PeakBand {
  hz: number;
  db: number;
  /** Which column it was found in — the caller draws a marker there. */
  column: number;
}

/**
 * The loudest column, and what frequency that is.
 *
 * Read off the TILTED columns, because the tilt is what makes the picture
 * comparable across the spectrum: untilted, the loudest column of almost any
 * piece of music is in the bottom octave, every time, and a readout that
 * always says "58 Hz" is a readout nobody looks at twice.
 */
export function peakBand(
  columns: Float32Array, scale: SpectrumScale,
): PeakBand {
  let best = -Infinity;
  let at = 0;
  for (let i = 0; i < columns.length; i++) {
    const v = columns[i] ?? -Infinity;
    if (v > best) { best = v; at = i; }
  }
  return {
    hz: columnHz(at, columns.length, scale),
    db: Number.isFinite(best) ? best : scale.bottomDb,
    column: at,
  };
}

export interface ScopeReading {
  /** −1 (out of phase) … +1 (mono). */
  correlation: number;
  /** 0 (mono) … 200 (fully decorrelated and beyond). */
  widthPct: number;
  /** Peak sample magnitude across both channels, for scaling the picture. */
  peak: number;
}

/**
 * The goniometer's points, written into `out` as x, y pairs in −1…1.
 *
 * `out.length / 2` points are taken, spread evenly across the block rather
 * than from its start: a scope that draws the first 512 samples of every
 * frame shows one 10 ms slice of a 20 ms frame and misses half the audio.
 *
 * The rotation is the 45 degrees described at the top, and the scaling is the
 * MID/SIDE the rest of this codebase already computes: (L+R)/2 up, (R−L)/2
 * across.  Not the orthonormal rotation, which divides by √2 — that is the
 * geometrically tidy one and it puts a full-scale mono signal at 1.414, off
 * the top of a picture whose edge is supposed to mean full scale.  Measured
 * in the app before this was fixed: 1.414 tall, drawn outside the box.
 *
 * What it costs is that a full-scale signal in ONE channel reaches 0.5 rather
 * than 0.707, so the single-channel diagonals are half length.  That is the
 * right trade: the edge of the picture meaning full scale is the reference
 * people read against, and the diagonals are a direction, not a distance.
 */
export function goniometerPoints(
  left: Float32Array, right: Float32Array, out: Float32Array,
): number {
  const points = Math.floor(out.length / 2);
  const n = Math.min(left.length, right.length);
  if (points === 0 || n === 0) return 0;
  const stride = Math.max(1, Math.floor(n / points));
  let written = 0;
  for (let p = 0; p < points; p++) {
    const i = p * stride;
    if (i >= n) break;
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    out[written * 2] = (r - l) / 2;
    out[written * 2 + 1] = (l + r) / 2;
    written++;
  }
  return written;
}

/**
 * Correlation, width and peak for one block.
 *
 * `correlationOf` is the reference system's, not a second implementation of
 * the same sum — one meter, one truth, the same rule the loudness engine is
 * held to.
 */
export function scopeReading(left: Float32Array, right: Float32Array): ScopeReading {
  const correlation = correlationOf(left, right);
  let peak = 0;
  const n = Math.min(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const a = Math.abs(left[i] ?? 0);
    const b = Math.abs(right[i] ?? 0);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
  }
  return { correlation, widthPct: widthFromCorrelation(correlation), peak };
}

/**
 * What a correlation reading means, in the words the panel prints.
 *
 * The thresholds are the ones that matter in practice rather than round
 * numbers: under zero something will cancel when it is summed, and that is
 * the only reading on this meter that is a fault rather than a choice.
 */
export function correlationNote(correlation: number): string {
  if (!Number.isFinite(correlation)) return '신호 없음';
  if (correlation > 0.95) return '거의 모노';
  if (correlation > 0.5) return '넓지만 모노 호환';
  if (correlation > 0.1) return '넓음';
  if (correlation > -0.1) return '완전히 비상관 — 모노로 합치면 3 dB 줄어듭니다';
  return '역상 — 모노로 합치면 사라집니다';
}
