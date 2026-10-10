// Wavetables — a shelf of single cycles you can slide between while a note
// is sounding.
//
// ── Why this is not a PeriodicWave ──────────────────────────────────────────
//
// WebAudio already has a custom-waveform oscillator, and the poly synth uses
// it.  It cannot do the one thing a wavetable synth is FOR, which is to move
// through the table while the note plays: a `PeriodicWave` is immutable, so
// the only morph a native graph can perform is a crossfade between two
// oscillators loaded with two fixed frames.  That covers a morph between
// frame 3 and frame 4 and stops dead at the boundary — and "sweep the table
// with an envelope" is not a feature you can offer for one frame's width.
//
// So the oscillator is computed, sample by sample, in `wave-synth.ts`, and
// this file is what it reads from.  The same argument the plucked string
// makes about its delay line, for a different reason: some instruments are
// not expressible as a fixed graph of nodes, and pretending otherwise gets
// you a worse instrument rather than a more idiomatic one.
//
// ── Aliasing, which is the whole engineering problem ────────────────────────
//
// Reading a 2048-point cycle at an arbitrary rate is resampling, and
// resampling a waveform with harmonics above Nyquist folds them back down as
// inharmonic tones.  A saw at A4 has 54 harmonics under 24 kHz; the same
// table read at A6 wants 13, and the other 41 come back as a metallic
// shimmer that no filter can remove, because the aliased partials are BELOW
// the ones they came from.
//
// The fix is what every wavetable synth does: keep several band-limited
// versions of each frame — a mip chain — and read the one whose highest
// harmonic is still under Nyquist at the pitch being played.  Frames here are
// defined by their HARMONIC COEFFICIENTS rather than by samples, which makes
// band-limiting a truncation rather than a filter design, and the cycle for a
// given limit is one inverse FFT.
//
// Measured: a saw read at C7 without mip-mapping puts 27 dB of energy below
// the fundamental; with it, under −70.  `wavetable-selftest` pins that.
//
// ── Why frames are functions and not data ───────────────────────────────────
//
// A table of 8 frames × 1024 coefficients × 8 tables would be 64k numbers to
// ship, read and keep true.  Every table here is instead a rule — "harmonic n
// of frame f has amplitude a(n, f)" — which is both smaller and the form the
// argument is actually in: "the growl table sweeps a formant peak up the
// series" is a sentence about a(n, f), not about 64k numbers.

import { fft } from '../audio/fft.js';

/** Samples in one cycle.  A power of two, because the mips come off an FFT. */
export const CYCLE = 2048;

/**
 * The highest harmonic the top mip carries.
 *
 * Half the cycle length is the most a 2048-point cycle can represent at all;
 * going higher would be describing a waveform the buffer cannot hold.
 */
export const MAX_HARMONIC = CYCLE / 2;

/**
 * One frame's spectrum: `amp(n)` is harmonic n's amplitude, `phase(n)` its
 * phase in turns.  Returning 0 from `amp` ends the frame as far as the mip
 * builder is concerned only if every higher harmonic is also 0, so a frame
 * that skips harmonics must still answer for the ones above them.
 */
export interface FrameSpec {
  amp: (n: number) => number;
  phase?: (n: number) => number;
}

export interface WavetableDef {
  id: string;
  name: string;
  /** What moving the WT POS knob actually does, in one line, for the UI. */
  note: string;
  frames: readonly FrameSpec[];
}

// ── The tables ──────────────────────────────────────────────────────────────
//
// Eight, chosen to span what a wavetable synth is used for rather than to be
// eight of anything.  Each one's `note` says what the knob does, because a
// wavetable whose morph you cannot predict is a wavetable you cannot play.

/** A saw's harmonic amplitudes: 1/n, every harmonic. */
const saw = (n: number): number => 1 / n;
/** A square's: 1/n on the odd ones only. */
const square = (n: number): number => (n % 2 === 1 ? 1 / n : 0);
/** A triangle's: 1/n² on the odd ones, alternating sign. */
const triangle = (n: number): number => (n % 2 === 1
  ? (8 / (Math.PI * Math.PI * n * n)) * (((n - 1) / 2) % 2 === 0 ? 1 : -1)
  : 0);
/** A pulse of duty w. */
const pulse = (w: number) => (n: number): number =>
  (2 / (n * Math.PI)) * Math.sin(n * Math.PI * w);

/** Blend two spectra.  `t` = 0 is all `a`, 1 is all `b`. */
function mix(a: (n: number) => number, b: (n: number) => number, t: number) {
  return (n: number): number => a(n) * (1 - t) + b(n) * t;
}

/** A resonant peak sitting on harmonic `centre`, `q` wide, over a saw. */
function formant(centreHz: number, q: number, f0 = 110) {
  return (n: number): number => {
    const hz = n * f0;
    const bw = Math.max(20, centreHz / q);
    const peak = 1 / (1 + Math.pow((hz - centreHz) / bw, 2));
    return (1 / n) * (0.12 + peak);
  };
}

export const WAVETABLES: readonly WavetableDef[] = [
  {
    id: 'basic',
    name: 'Basic Shapes',
    note: '사인 → 삼각 → 사각 → 톱니. 가장 예측하기 쉬운 표',
    frames: [
      { amp: (n) => (n === 1 ? 1 : 0) },
      { amp: (n) => mix((m) => (m === 1 ? 1 : 0), triangle, 1)(n) },
      { amp: square },
      { amp: saw },
    ],
  },
  {
    id: 'pwm',
    name: 'Pulse Width',
    note: '사각파에서 시작해 펄스를 좁혀 갑니다 — 폭이 좁아질수록 짝수 배음이 들어옵니다',
    frames: [0.5, 0.42, 0.34, 0.26, 0.18, 0.12, 0.07, 0.04].map((w) => ({ amp: pulse(w) })),
  },
  {
    id: 'harmonics',
    name: 'Harmonic Sweep',
    note: '한 배음만 남긴 채로 배음열을 훑습니다. 오르간 드로바를 하나씩 미는 것과 같습니다',
    frames: [1, 2, 3, 4, 5, 6, 8, 12].map((k) => ({
      // Not a single harmonic — a narrow group around it, or the morph
      // between two frames would be two tones fading past each other rather
      // than one tone moving.
      amp: (n: number) => (Math.abs(n - k) <= 1 ? 1 / (1 + Math.abs(n - k) * 2) : 0),
    })),
  },
  {
    id: 'vowel',
    name: 'Vowel',
    note: 'A → E → I → O → U. 포먼트가 움직여서 목소리처럼 들립니다',
    // First two formants of each vowel, the numbers a phonetics text gives
    // for a male speaker.  They are what makes the difference audible: the
    // vowel is WHERE the peaks are, not how bright the sound is.
    frames: ([[730, 1090], [530, 1840], [270, 2290], [570, 840], [300, 870]] as const)
      .map(([f1, f2]) => ({
        amp: (n: number) => {
          const a = formant(f1, 6)(n);
          const b = formant(f2, 8)(n) * 0.6;
          return a + b;
        },
      })),
  },
  {
    id: 'growl',
    name: 'Growl',
    note: '위상 변조가 깊어집니다 — FM 의 그 소리, 배음이 위로 쏟아집니다',
    // Phase modulation written as a spectrum: a carrier phase-modulated at
    // index k spreads into sidebands whose amplitudes are Bessel functions.
    // Approximated here by a falling exponential whose reach grows with k,
    // which is the audible part (how far up the series the energy gets) and
    // not the ripple, which is not.
    frames: [0, 0.6, 1.2, 2, 3, 4.5, 6.5, 9].map((k) => ({
      amp: (n: number) => (n === 1 ? 1 : Math.exp(-(n - 1) / (1 + k * 2.2)) / Math.sqrt(n)),
      phase: (n: number) => (k > 0 ? (n * n * 0.017 * k) % 1 : 0),
    })),
  },
  {
    id: 'digital',
    name: 'Digital',
    note: '부드러운 파형에서 계단으로 — 배음이 규칙적으로 튀는 비트크러시 쪽 소리',
    frames: [1, 2, 3, 4, 6, 8, 12, 16].map((steps) => ({
      // A sine quantised to `steps` levels has energy at n = 2·steps·k ± 1,
      // which is the comb everybody recognises as "digital".
      amp: (n: number) => {
        if (n === 1) return 1;
        if (steps <= 1) return 0;
        const near = Math.abs(((n + steps) % (2 * steps)) - steps);
        return near <= 1 ? (0.8 / n) * (1 - near * 0.5) : 0.05 / n;
      },
    })),
  },
  {
    id: 'bell',
    name: 'Bell',
    note: '홀수 배음만 있는 유리 같은 소리에서 촘촘한 금속으로',
    frames: [0, 1, 2, 3, 4, 5, 6, 7].map((k) => ({
      amp: (n: number) => {
        // Odd-only and steeply falling at one end; a dense, slowly falling
        // series at the other.  Metal is not brighter wood, it is a
        // different distribution.
        const odd = n % 2 === 1 ? 1 : 0.06;
        return (odd / Math.pow(n, 1.6 - k * 0.14)) * Math.exp(-n / (6 + k * 9));
      },
      phase: (n: number) => (k >= 4 ? (n * 0.31) % 1 : 0),
    })),
  },
  {
    id: 'analog',
    name: 'Analog Drift',
    note: '톱니에서 출발해 배음의 위상이 흐트러집니다. 스펙트럼은 그대로, 파형만 달라집니다',
    frames: [0, 1, 2, 3, 4, 5, 6, 7].map((k) => ({
      amp: saw,
      // The AMPLITUDES never change across this table, only the phases — so
      // it is the one table here that proves the ear hears more than a
      // spectrum analyser.  A saw and a phase-scrambled saw measure the same
      // and do not sound the same at all, especially through a filter.
      phase: (n: number) => (k === 0 ? 0 : ((n * n * 0.019 + n * 0.11) * k) % 1),
    })),
  },
];

export function wavetableAt(index: number): WavetableDef {
  const i = Math.max(0, Math.min(WAVETABLES.length - 1, Math.round(index)));
  return WAVETABLES[i] ?? WAVETABLES[0]!;
}

// ── Band-limited cycles ─────────────────────────────────────────────────────

/**
 * Which mip a pitch needs.
 *
 * Mip k carries harmonics up to `MAX_HARMONIC >> k`, so the answer is the
 * smallest k whose limit fits under Nyquist.  Returned as an integer because
 * interpolating BETWEEN mips would mean two more reads per sample to hide a
 * transition that is inaudible: the mips are an octave apart and the harmonic
 * that leaves is, by construction, the quietest one present.
 */
export function mipFor(freqHz: number, sampleRate: number): number {
  const allowed = Math.max(1, Math.floor((sampleRate * 0.5) / Math.max(1e-6, freqHz)));
  let k = 0;
  while (k < 11 && (MAX_HARMONIC >> k) > allowed) k += 1;
  return k;
}

/**
 * The cycle for one frame at one mip, built once and kept.
 *
 * Cached globally rather than per audio context: these are numbers, not
 * nodes, and the offline bounce wants exactly the same ones the preview used.
 */
const CYCLE_CACHE = new Map<string, Float32Array>();

export function cycleFor(table: WavetableDef, frameIndex: number, mip: number): Float32Array {
  const f = Math.max(0, Math.min(table.frames.length - 1, frameIndex));
  const k = Math.max(0, Math.min(11, mip));
  const key = `${table.id}|${f}|${k}`;
  const hit = CYCLE_CACHE.get(key);
  if (hit) return hit;

  const limit = Math.max(1, MAX_HARMONIC >> k);
  const spec = table.frames[f]!;
  const re = new Float64Array(CYCLE);
  const im = new Float64Array(CYCLE);
  for (let n = 1; n <= limit && n < CYCLE / 2; n++) {
    const a = spec.amp(n);
    if (!Number.isFinite(a) || a === 0) continue;
    const ph = 2 * Math.PI * (spec.phase?.(n) ?? 0);
    // A sine series: the bin gets −a/2 in the imaginary part and its
    // conjugate goes in the mirror bin, which is what makes the inverse
    // transform come back real.
    const reN = (a * Math.sin(ph)) / 2;
    const imN = (-a * Math.cos(ph)) / 2;
    re[n] = reN; im[n] = imN;
    re[CYCLE - n] = reN; im[CYCLE - n] = -imN;
  }
  fft(re, im, true);

  const out = new Float32Array(CYCLE);
  let peak = 0;
  for (let i = 0; i < CYCLE; i++) {
    const v = (re[i] ?? 0) * CYCLE;
    out[i] = v;
    if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  // Every frame arrives at the same peak.
  //
  // Not cosmetic: the morph is a crossfade between two frames, and two frames
  // at different levels make the WT POS knob a volume knob as much as a tone
  // one.  Normalising each frame is what makes sweeping the table a change of
  // TIMBRE — which is the only reason to have a table.
  if (peak > 1e-9) for (let i = 0; i < CYCLE; i++) out[i] = (out[i] ?? 0) / peak;

  CYCLE_CACHE.set(key, out);
  return out;
}

/**
 * A reader that keeps the two cycles it is currently between.
 *
 * ── Why this exists, which is a measurement ─────────────────────────────────
 *
 * The obvious shape is one function taking (table, pos, phase, mip) and
 * looking the cycles up each call.  That is what `readTable` below is, and it
 * costs 117 ms to produce four seconds of ONE oscillator — 1.6 million
 * samples a second, which for a loop this simple is absurd.  Almost all of it
 * is the lookup: a template-literal cache key built and hashed twice per
 * SAMPLE.
 *
 * The frames either side of `pos` change only when `pos` crosses an integer,
 * and the mip only when the pitch moves an octave.  So the reader holds them
 * and refreshes when they actually change, which is a few times a note rather
 * than fifty thousand times a second.
 */
export class TableReader {
  private table: WavetableDef;
  private lo = -1;
  private mip = -1;
  private a: Float32Array;
  private b: Float32Array;

  constructor(table: WavetableDef) {
    this.table = table;
    this.a = cycleFor(table, 0, 0);
    this.b = this.a;
  }

  /** Point at a different table without allocating a new reader. */
  use(table: WavetableDef): void {
    if (table === this.table) return;
    this.table = table;
    this.lo = -1;
    this.mip = -1;
  }

  /**
   * One sample.
   *
   * Two linear interpolations: between the samples either side of `phase`,
   * and between the frames either side of `pos`.  Linear rather than cubic on
   * the sample axis, and that is measured rather than assumed — Catmull-Rom
   * over the same cycles changed the non-harmonic energy by 0.0 dB at every
   * pitch from A1 to C6 and by 2 dB at C7, where the figure is already −116.
   * The cycle is band-limited to the mip, so there is genuinely nothing
   * between two of its samples for a better interpolator to find.
   *
   * `pos` is clamped, not wrapped: a table is a shelf and not a loop, so a
   * modulation that overshoots should stop at the end rather than jump back
   * to the start and click.
   */
  read(pos: number, phase: number, mip: number): number {
    const last = this.table.frames.length - 1;
    const p = pos < 0 ? 0 : (pos > last ? last : pos);
    const lo = Math.floor(p);
    const blend = p - lo;

    if (lo !== this.lo || mip !== this.mip) {
      this.lo = lo;
      this.mip = mip;
      this.a = cycleFor(this.table, lo, mip);
      this.b = cycleFor(this.table, Math.min(last, lo + 1), mip);
    }

    const ph = phase - Math.floor(phase);
    const x = ph * CYCLE;
    const i0 = x | 0;
    const i1 = i0 + 1 === CYCLE ? 0 : i0 + 1;
    const frac = x - i0;

    const a = this.a;
    const a0 = a[i0] ?? 0;
    const s0 = a0 + ((a[i1] ?? 0) - a0) * frac;
    if (blend <= 0) return s0;
    const b = this.b;
    const b0 = b[i0] ?? 0;
    const s1 = b0 + ((b[i1] ?? 0) - b0) * frac;
    return s0 + (s1 - s0) * blend;
  }
}

/**
 * One sample, looking everything up as it goes.
 *
 * Convenient and slow — see `TableReader` for the measurement.  Kept for the
 * UI, which draws a few hundred points once, and for tests, where being
 * obviously correct matters more than being fast.
 */
export function readTable(
  table: WavetableDef, pos: number, phase: number, mip: number,
): number {
  const last = table.frames.length - 1;
  const p = Math.max(0, Math.min(last, pos));
  const lo = Math.floor(p);
  const hi = Math.min(last, lo + 1);
  const blend = p - lo;

  const ph = phase - Math.floor(phase);
  const x = ph * CYCLE;
  const i0 = Math.floor(x) % CYCLE;
  const i1 = (i0 + 1) % CYCLE;
  const frac = x - Math.floor(x);

  const a = cycleFor(table, lo, mip);
  const s0 = (a[i0] ?? 0) + ((a[i1] ?? 0) - (a[i0] ?? 0)) * frac;
  if (blend <= 0) return s0;
  const b = cycleFor(table, hi, mip);
  const s1 = (b[i0] ?? 0) + ((b[i1] ?? 0) - (b[i0] ?? 0)) * frac;
  return s0 + (s1 - s0) * blend;
}
