// The pictures the bowed string's panel draws, as arithmetic.
//
// Same rule as the other instrument panels: a drawing that lives inside a
// canvas callback can only be checked by looking at it, so the maths comes
// out here and `bowed-panel-selftest` measures it against the engine.
//
// ── What this instrument needs a picture OF ────────────────────────────────
//
// Not a filter curve — the string has no filter anyone turns.  What a bowed
// string IS, is the stick-slip cycle: the string riding with the bow for most
// of the period and flying back for the rest.  Everything a player controls
// changes that cycle and nothing else, so drawing it draws the instrument.
//
// It also draws the two ways of getting it wrong, which is the real argument
// for the picture.  Under the minimum bow force the single release breaks
// into several per period — the breathy surface sound — and over-pressed the
// stick runs long and the cycle goes ragged.  Both are visible in the shape
// and neither is visible in two numbers on two knobs.
//
// ── Why there is no Schelleng diagram here ─────────────────────────────────
//
// The obvious picture for this instrument is Schelleng's: bow force against
// bow position, with the playable wedge between the minimum and maximum
// force drawn on it.  It is not here, and the reason is worth writing down
// rather than leaving as an absence.
//
// The engine's force knob is deliberately scaled as a = k·v_bow/β, so the
// regime depends on k = 0.14 + 1.5·force and on NOTHING ELSE — bow position
// and bow speed cancel by construction, which is what makes the knob playable
// (see `bowed-string.ts`).  A diagram in knob coordinates would therefore be
// two horizontal lines: true, and a picture of the mapping rather than of the
// instrument.  A diagram in newtons would need the regime measured at every
// cell of a grid, which is a rendered note per cell.
//
// So the regime is reported as what it is — a measured state of the cycle
// being drawn — and the wedge is left to the textbooks.

import {
  BOW_BODIES, bodySections, cascadeDb, renderBowedVoice, stringFor,
  type BowBody,
} from '../engine/bowed-string.js';
import type { Point } from './synth-views.js';

/**
 * The rate the previews render at.
 *
 * The engine's own, and not reduced the way the drum machine's previews are.
 * A waveguide's delay line is an integer number of samples and the bow's
 * fraction of it is a small one: at 24 kHz the bridge side of a high note is
 * three samples long and the picture stops being of the same instrument.
 */
export const PREVIEW_RATE = 48_000;

/** How long a preview bows for before the picture is taken. */
export const PREVIEW_SECONDS = 0.55;

/** Where in that the cycle is read, once the motion has settled. */
const SETTLE_SEC = 0.3;

function p(params: Readonly<Record<string, number>>, id: string, fallback: number): number {
  const v = params[id];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function bodyOf(params: Readonly<Record<string, number>>): BowBody {
  const i = Math.max(0, Math.min(BOW_BODIES.length - 1, Math.round(p(params, 'body', 0))));
  return BOW_BODIES[i] ?? BOW_BODIES[0]!;
}

/**
 * The bow's fraction of the sounding length, for a note.
 *
 * The engine's own rule, asked for rather than copied: the picture has to
 * know where the comb sits and where the stick should end, and a second
 * expression of the same rule is a second thing to keep in step.
 */
export function betaOf(params: Readonly<Record<string, number>>, pitch: number): number {
  const body = bodyOf(params);
  const knob = Math.max(0.02, Math.min(0.3, p(params, 'pos', body.beta)));
  return Math.max(0.012, Math.min(0.2, knob * Math.sqrt(stringFor(body, pitch).stop)));
}

/**
 * The period a settled note actually has, in samples.
 *
 * Correlation against a shifted copy of itself, searched within 8% of the
 * nominal and interpolated parabolically.
 *
 * Over TWELVE periods, which is measured rather than picked: against a long
 * render tracked by zero crossings, three periods lands up to 4 cents out and
 * twelve under one.  Four cents is nothing to hear and is not nothing to
 * draw — at the fifth harmonic it is twenty, which is most of a bin, and the
 * bar then reads a couple of decibels low.
 */
function refinePeriod(trace: Float32Array, from: number, nominal: number): number {
  const lo = Math.max(2, Math.floor(nominal * 0.92));
  const hi = Math.ceil(nominal * 1.08);
  const span = Math.min(trace.length - from - hi - 1, Math.round(nominal * 12));
  if (span < 8) return nominal;
  const corr = (lag: number): number => {
    let num = 0;
    let a = 0;
    let b = 0;
    for (let i = 0; i < span; i++) {
      const x = trace[from + i] ?? 0;
      const y = trace[from + i + lag] ?? 0;
      num += x * y; a += x * x; b += y * y;
    }
    return num / Math.sqrt(a * b + 1e-30);
  };
  let best = lo;
  let bestVal = -Infinity;
  for (let lag = lo; lag <= hi; lag++) {
    const v = corr(lag);
    if (v > bestVal) { bestVal = v; best = lag; }
  }
  if (best <= lo || best >= hi) return nominal;
  const a = corr(best - 1);
  const b = bestVal;
  const c = corr(best + 1);
  const denom = a - 2 * b + c;
  const shift = Math.abs(denom) < 1e-12 ? 0 : 0.5 * (a - c) / denom;
  return best + Math.max(-1, Math.min(1, shift));
}

export type BowRegime = 'surface' | 'helmholtz' | 'pressed';

export interface BowCycle {
  /** One period of the string's velocity at the bow, in 0…1 space. */
  points: readonly Point[];
  /** The fraction of the period the string was stuck to the bow. */
  stuck: number;
  /** What Helmholtz motion would give: 1 − β. */
  idealStuck: number;
  /** How many times it let go in one period.  Helmholtz motion lets go once. */
  releases: number;
  regime: BowRegime;
  /** How far the spectrum is from a sawtooth, in dB rms.  See `bowAnalysis`. */
  sawtoothError: number;
  /** The period drawn, in milliseconds. */
  periodMs: number;
}

export interface BowSpectrum {
  /** One entry per harmonic: its level against the first, in dB. */
  harmonics: readonly number[];
  /** The 1/n a sawtooth would give, for the same harmonics. */
  sawtooth: readonly number[];
  /** Which harmonic the bow's position notches, 1/β rounded. */
  combAt: number;
  /** The floor the picture is drawn down to. */
  floorDb: number;
}

export interface BowAnalysis { cycle: BowCycle; spectrum: BowSpectrum }

/**
 * Everything the panel measures, from ONE rendered note.
 *
 * Both pictures and the badge come out of the same render, which is not only
 * cheaper — it is the only way they cannot contradict each other, and an
 * earlier version that rendered twice did contradict itself: the cycle said
 * the string was slipping several times a period at a setting whose spectrum
 * was a sawtooth to a tenth of a decibel.
 *
 * The body is switched off for the render.  The spectrum picture is about the
 * STRING — with the body on, the plot is the box's resonances and the
 * string's harmonics together and the one thing it exists to show is buried —
 * and the bow's own velocity does not pass through the body at all.
 *
 * ── Which measurement decides the regime, and why it is not the cycle ──────
 *
 * The obvious rule is to count how many times the cycle lets go: once is
 * Helmholtz motion, more is the surface sound.  Measured across a grid of bow
 * forces and positions against the spectrum, that rule is wrong often enough
 * to matter — partial slips that re-catch, and slips the window happens to
 * cut in half, both read as extra releases at settings whose tone is fine.
 *
 * The measurement that separates the regimes cleanly is the SPECTRUM: how far
 * the harmonics are from 1/n.  Inside the playable window that reads under
 * 1 dB and outside it 3 to 11.  So the badge is decided by that, and the
 * stuck fraction only says WHICH way it went wrong — short of (1−β) is not
 * enough bow force, past it is too much.
 */
export function bowAnalysis(
  params: Readonly<Record<string, number>>, pitch: number,
  columns = 220, harmonics = 20,
): BowAnalysis {
  const hz = 440 * Math.pow(2, (pitch - 69) / 12);
  const n = Math.round(PREVIEW_RATE * PREVIEW_SECONDS);
  const trace = new Float32Array(n);
  const out = renderBowedVoice({
    sampleRate: PREVIEW_RATE, seconds: PREVIEW_SECONDS, gateSec: PREVIEW_SECONDS,
    freqHz: hz, pitch, velocity: 0.8, startBeat: 0,
    params: { ...params, vibDepth: 0, bodyAmt: 0 }, bowVelocity: trace,
  });

  const nominal = PREVIEW_RATE / Math.max(20, hz);
  const settle = Math.max(0, Math.min(n - 5 * Math.ceil(nominal) - 2,
    Math.round(SETTLE_SEC * PREVIEW_RATE)));

  // The period the string ACTUALLY settled at, not the one it was asked for.
  //
  // A bowed string's period is set by when the friction lets go, so it lands
  // a few cents off the delay line's own — real, and measured at 0.4 to 7
  // cents across the range.  Harmless to hear and not harmless to draw: a
  // spectrum read at the nominal frequency misses each harmonic by k times
  // that error, so the picture showed the fifth harmonic of an open E at
  // −51 dB where the note has it at −14.  The panel was drawing a spectrum
  // the instrument does not have, and getting duller the higher it played.
  //
  // Refined by correlation around the nominal, over three periods, with a
  // parabolic fit on the peak for the part of a sample that matters most.
  const period = refinePeriod(trace, settle, nominal);
  const len = Math.max(4, Math.round(period));

  // The bow's own speed is the level the plateau sits at, and the engine's is
  // not reachable from here — so it is read off the cycle instead, as the
  // level the string spends most of its time within a whisker of.  Which is
  // what sticking IS, so reading it this way is the measurement rather than a
  // guess at it.
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = 0; i < len; i++) {
    const v = trace[settle + i] ?? 0;
    if (v > hi) hi = v;
    if (v < lo) lo = v;
  }
  const span = Math.max(1e-9, hi - lo);

  // Two thresholds, and the window starts where the string CATCHES.
  //
  // Both are corrections measurement forced.  One threshold a hair under the
  // plateau counts the ripple ON it — the wave bouncing between bow and
  // bridge, which is real and is not letting go.  And a window starting at an
  // arbitrary sample cuts a slip in half and counts one release as two, which
  // at β = 0.11 is exactly what it did.  Starting at the catch fixes the count
  // and the picture together: the plateau is then always on the left, where
  // the 1−β marker is, instead of the drawing sliding as the knobs move.
  const stickAt = hi - span * 0.06;
  const goneAt = hi - span * 0.7;
  let from = settle;
  for (let i = 1; i < 2 * len; i++) {
    const prev = trace[settle + i - 1] ?? 0;
    const here = trace[settle + i] ?? 0;
    if (prev <= stickAt && here > stickAt) { from = settle + i; break; }
  }

  let stuck = 0;
  let releases = 0;
  let wasStuck = true;
  for (let i = 0; i < len; i++) {
    const v = trace[from + i] ?? 0;
    if (v > stickAt) { stuck++; wasStuck = true; } else if (v < goneAt && wasStuck) {
      releases++;
      wasStuck = false;
    }
  }

  const points: Point[] = [];
  for (let c = 0; c <= columns; c++) {
    const i = Math.min(len - 1, Math.round((c / columns) * (len - 1)));
    const v = trace[from + i] ?? 0;
    points.push({ x: c / columns, y: 1 - (v - lo) / span });
  }

  // ── The spectrum, from the same note ────────────────────────────────────
  const off = Math.round(SETTLE_SEC * PREVIEW_RATE);
  const win = Math.min(out.left.length - off, 8192);
  const at = (f: number): number => {
    let re = 0;
    let im = 0;
    for (let i = 0; i < win; i++) {
      const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (win - 1));
      const ph = 2 * Math.PI * f * i / PREVIEW_RATE;
      re += (out.left[off + i] ?? 0) * w * Math.cos(ph);
      im += (out.left[off + i] ?? 0) * w * Math.sin(ph);
    }
    return Math.hypot(re, im) / win * 4;
  };
  // Every harmonic is read off the period that was measured, not the one the
  // note was asked for — see `refinePeriod`.
  const f0 = PREVIEW_RATE / period;
  const h1 = Math.max(1e-12, at(f0));
  const levels: number[] = [];
  const saw: number[] = [];
  for (let k = 1; k <= harmonics; k++) {
    levels.push(k * f0 < PREVIEW_RATE * 0.45
      ? 20 * Math.log10(Math.max(1e-12, at(f0 * k) / h1))
      : -Infinity);
    saw.push(20 * Math.log10(1 / k));
  }

  const beta = betaOf(params, pitch);
  const combAt = Math.round(1 / beta);
  // Measured below the comb only: the notch at 1/β is the bow position doing
  // its job, and counting it as an error would make the badge say "surface
  // sound" for bowing far from the bridge, where 1/β falls low enough to land
  // inside the window.
  const top = Math.max(4, Math.min(8, Math.floor(0.7 * combAt)));
  let err = 0;
  for (let k = 2; k <= top; k++) err += ((levels[k - 1] ?? 0) - (saw[k - 1] ?? 0)) ** 2;
  const sawtoothError = Math.sqrt(err / (top - 1));

  const idealStuck = 1 - beta;
  const frac = stuck / len;
  const regime: BowRegime = sawtoothError < 2.5
    ? 'helmholtz'
    : (frac >= idealStuck ? 'pressed' : 'surface');

  return {
    cycle: {
      points, stuck: frac, idealStuck, releases: Math.max(1, releases), regime,
      sawtoothError, periodMs: (len / PREVIEW_RATE) * 1000,
    },
    spectrum: { harmonics: levels, sawtooth: saw, combAt, floorDb: -42 },
  };
}

/** The stick-slip cycle alone, for a caller that wants only the picture. */
export function bowCycle(
  params: Readonly<Record<string, number>>, pitch: number, columns = 220,
): BowCycle {
  return bowAnalysis(params, pitch, columns).cycle;
}

/** The bridge's harmonics alone. */
export function bridgeSpectrum(
  params: Readonly<Record<string, number>>, pitch: number, count = 20,
): BowSpectrum {
  return bowAnalysis(params, pitch, 8, count).spectrum;
}

/**
 * The body's response, as the panel draws it.
 *
 * The sections come from the engine, so this is the same cascade the sound
 * goes through rather than a second description of it.
 */
export function bodyCurve(
  params: Readonly<Record<string, number>>, points = 160,
): { curve: readonly Point[]; marks: readonly { hz: number; label: string }[];
  fromHz: number; toHz: number; topDb: number; bottomDb: number } {
  const body = bodyOf(params);
  const tilt = Math.pow(2, Math.max(-1, Math.min(1, p(params, 'size', 0))) * 0.25);
  const sections = bodySections(body, PREVIEW_RATE, tilt);
  const fromHz = 30;
  const toHz = 12_000;
  const topDb = 14;
  const bottomDb = -30;
  const curve: Point[] = [];
  for (let i = 0; i <= points; i++) {
    const u = i / points;
    const hz = fromHz * Math.pow(toHz / fromHz, u);
    const dbv = cascadeDb(sections, hz, PREVIEW_RATE);
    curve.push({
      x: u,
      y: 1 - (Math.max(bottomDb, Math.min(topDb, dbv)) - bottomDb) / (topDb - bottomDb),
    });
  }
  const marks = [
    { hz: body.modes[0]![0] * tilt, label: 'A0' },
    { hz: body.modes[2]![0] * tilt, label: 'B1−' },
    { hz: body.modes[3]![0] * tilt, label: 'B1+' },
    { hz: body.hill[0] * tilt, label: '브리지 힐' },
  ];
  return { curve, marks, fromHz, toHz, topDb, bottomDb };
}

/** Where a frequency sits on the body picture's log axis. */
export function bodyX(hz: number, fromHz: number, toHz: number): number {
  return Math.log(Math.max(fromHz, Math.min(toHz, hz)) / fromHz) / Math.log(toHz / fromHz);
}

/** The four strings of the selected body, as names and where a note sits. */
export function stringRows(
  params: Readonly<Record<string, number>>, pitch: number,
): readonly { open: number; name: string; playing: boolean; stopSemis: number }[] {
  const body = bodyOf(params);
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const chosen = stringFor(body, pitch).open;
  return body.strings.map((open) => ({
    open,
    name: `${names[open % 12]}${Math.floor(open / 12) - 1}`,
    playing: open === chosen,
    stopSemis: open === chosen ? pitch - open : 0,
  }));
}
