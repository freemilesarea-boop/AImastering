// The wavetable synth — two tables, a sub, noise, a filter, and a matrix that
// can point any of sixteen sources at any of eighteen things.
//
// ── Why the whole voice is computed instead of wired ────────────────────────
//
// Every other instrument here is native WebAudio nodes where it can be, and
// this one is not, for a reason that is specific rather than a preference:
//
//   · WT POS has to be MODULATABLE.  A `PeriodicWave` is immutable, so a
//     native graph can only crossfade two fixed frames — which covers a morph
//     from frame 3 to frame 4 and stops at the boundary.  "Sweep the table
//     with an envelope" is the instrument, and it is not expressible.
//   · The filter is a state-variable ladder with per-sample cutoff, not a
//     biquad.  `BiquadFilterNode` recomputes its coefficients per render
//     quantum, so an audio-rate filter modulation — which is half of what a
//     matrix is for — arrives as 128-sample steps.
//   · A matrix routes to destinations WebAudio does not expose as AudioParams
//     at all: unison detune, the table position, the drive curve.
//
// So the voice is rendered into a stereo buffer and played back through a
// gain.  The same shape the piano uses, and it carries the same two benefits:
// the preview and the offline bounce are bit-identical, and nothing depends
// on which WebAudio implementation is underneath.
//
// ── What it costs, measured ─────────────────────────────────────────────────
//
// Four seconds of a morphing table: 24 ms for one oscillator, 33 ms for seven
// unison voices — the reads are cheap and cache-friendly, and the loop
// overhead dominates.  A full voice (two oscillators at their default unison,
// sub, noise, filter) is in `wave-synth-selftest`'s budget check, which is a
// LIMIT and not a benchmark: every note is computed on the thread that
// schedules it.
//
// The first version of the table reader cost 117 ms for the same four seconds
// because it built a template-literal cache key twice per sample.  That is
// why `TableReader` holds its two cycles.

import {
  MOD_DESTS, activeRows, lfoValue, noteRandom, type MatrixRow,
} from './mod-matrix.js';
import { TableReader, mipFor, wavetableAt } from './wavetable.js';

/** How often the matrix is evaluated, in samples. */
const CONTROL_STRIDE = 16;

/**
 * Destination indices, looked up once at module load.
 *
 * `MOD_DESTS` is the single list everything agrees on — the UI's dropdown,
 * the saved parameter and this loop — so these are derived from it rather
 * than written out, and reordering that list cannot silently rewire the
 * engine.
 */
const dstIndex = (id: string): number => {
  const i = MOD_DESTS.findIndex((d) => d.id === id);
  if (i < 0) throw new Error(`no modulation destination '${id}'`);
  return i;
};
const D_A_POS = dstIndex('aPos');
const D_B_POS = dstIndex('bPos');
const D_A_PITCH = dstIndex('aPitch');
const D_B_PITCH = dstIndex('bPitch');
const D_CUTOFF = dstIndex('cutoff');
const D_RES = dstIndex('res');
const D_A_LEVEL = dstIndex('aLevel');
const D_B_LEVEL = dstIndex('bLevel');
const D_SUB = dstIndex('subLevel');
const D_NOISE = dstIndex('noise');
const D_A_PAN = dstIndex('aPan');
const D_B_PAN = dstIndex('bPan');
const D_A_DETUNE = dstIndex('aDetune');
const D_B_DETUNE = dstIndex('bDetune');
const D_DRIVE = dstIndex('drive');
const D_A_PHASE = dstIndex('aPhase');
const D_B_PHASE = dstIndex('bPhase');
const D_AMP = dstIndex('amp');

/**
 * Why the matrix runs at a stride and the oscillators do not.
 *
 * Sixteen samples is three hundred microseconds — a third of a millisecond,
 * which is above every modulation rate a person can hear as motion and below
 * every rate at which stepping would be audible as a buzz.  Evaluating eight
 * matrix rows, four LFOs and three envelopes per SAMPLE would be most of the
 * cost of the instrument for a result nobody could distinguish; evaluating
 * them per BLOCK of 128, as a native graph must, is audible as stepping on a
 * fast filter sweep.  Sixteen is between the two on purpose.
 *
 * The values are linearly interpolated across the stride, so a destination
 * still moves smoothly — a held step would click on the way out of a fast
 * envelope even at this rate.
 */

export interface SynthRenderSpec {
  sampleRate: number;
  seconds: number;
  /** Seconds the key is held; the release follows it. */
  gateSec: number;
  freqHz: number;
  pitch: number;
  velocity: number;
  /** Deterministic per-note randomness — see `noteRandom`. */
  random: number;
  params: Readonly<Record<string, number>>;
  /** Beats per second, for tempo-synced LFOs. */
  beatsPerSec: number;
}

function p(params: Readonly<Record<string, number>>, id: string, fallback: number): number {
  const v = params[id];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** One ADSR, evaluated at a time in seconds. */
function envAt(t: number, gate: number, a: number, d: number, s: number, r: number): number {
  if (t < 0) return 0;
  if (t < gate) {
    if (t < a) return a <= 0 ? 1 : t / a;
    const dt = t - a;
    if (dt < d) return d <= 0 ? s : 1 + (s - 1) * (dt / d);
    return s;
  }
  // The level the release starts from is the level the note had reached, not
  // the sustain: a note released during its attack has to fall from where it
  // actually was, or a staccato stab jumps to full before it decays.
  const held = gate < a
    ? (a <= 0 ? 1 : gate / a)
    : (gate - a < d ? (d <= 0 ? s : 1 + (s - 1) * ((gate - a) / d)) : s);
  const rt = t - gate;
  if (r <= 0) return 0;
  return rt >= r ? 0 : held * (1 - rt / r);
}

interface LfoState { phase: number; rate: number; shape: number; skew: number; delay: number; rise: number; }

function readLfos(params: Readonly<Record<string, number>>, beatsPerSec: number): LfoState[] {
  const out: LfoState[] = [];
  for (let i = 1; i <= 4; i++) {
    const synced = p(params, `l${i}sync`, 1) > 0.5;
    // Synced rates are in beats per cycle: 4 is a bar at 4/4, 0.25 a
    // sixteenth.  Unsynced ones are hertz.  Both end up as cycles per
    // second here so the render loop does not have to care.
    const beats = Math.max(0.03125, p(params, `l${i}beats`, 1));
    const hz = Math.max(0.01, p(params, `l${i}rate`, 2));
    out.push({
      phase: p(params, `l${i}phase`, 0),
      rate: synced ? beatsPerSec / beats : hz,
      shape: p(params, `l${i}shape`, 0),
      skew: p(params, `l${i}skew`, 0.5),
      delay: Math.max(0, p(params, `l${i}delay`, 0)),
      rise: Math.max(0, p(params, `l${i}rise`, 0)),
    });
  }
  return out;
}

/**
 * A two-pole state-variable filter, one sample at a time.
 *
 * Chosen over a biquad because it takes a new cutoff on EVERY sample without
 * recomputing anything expensive — the whole coefficient update is one `tan`,
 * and even that is approximated below — and because low-pass, high-pass,
 * band-pass and notch all fall out of the same two integrators rather than
 * being four different coefficient sets.
 *
 * The topology is the zero-delay-feedback form: it stays stable as the cutoff
 * is swept quickly, which the naive form does not, and a filter that is only
 * stable while its knob is still is no use in a synth with a matrix.
 */
class Svf {
  private ic1 = 0;
  private ic2 = 0;

  reset(): void { this.ic1 = 0; this.ic2 = 0; }

  /** `g` is tan(pi*fc/sr), `k` is 1/Q.  Returns [low, band, high]. */
  step(x: number, g: number, k: number, out: Float64Array): void {
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - this.ic2;
    const v1 = a1 * this.ic1 + a2 * v3;
    const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    out[0] = v2;                 // low
    out[1] = v1;                 // band
    out[2] = x - k * v1 - v2;    // high
  }
}

/** Soft clip with the gain taken back out, so Drive is a timbre control. */
function drive(x: number, amount: number): number {
  if (amount <= 0.001) return x;
  const k = 1 + amount * 14;
  // Divided by the RMS the curve gives a full-scale sine rather than by
  // tanh(k) — the same correction the poly synth's Drive needed, and for the
  // same reason: normalising the endpoints leaves the loudness moving.
  const comp = 1 / (0.72 + 0.28 / Math.sqrt(k));
  return (Math.tanh(k * x) / k) * comp * k * 0.5;
}

/** Pink-ish and brown-ish noise from white, by one-pole filtering. */
class Noise {
  private seed: number;
  private pink = 0;
  private brown = 0;
  constructor(seed: number) { this.seed = seed >>> 0 || 1; }
  next(colour: number): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    const white = (this.seed / 2147483648) - 1;
    this.pink += 0.15 * (white - this.pink);
    this.brown += 0.02 * (white - this.brown);
    // 0 = white, 0.5 = pink, 1 = brown, crossfaded and level-matched so that
    // turning the colour knob is not also a volume knob.
    if (colour <= 0.5) {
      const t = colour * 2;
      return white * (1 - t) + this.pink * 3.2 * t;
    }
    const t = (colour - 0.5) * 2;
    return this.pink * 3.2 * (1 - t) + this.brown * 9 * t;
  }
}

const SUB_SHAPES = ['sine', 'triangle', 'square', 'saw'] as const;

function subSample(shape: number, phase: number): number {
  const ph = phase - Math.floor(phase);
  switch (Math.max(0, Math.min(3, Math.round(shape)))) {
    case 0: return Math.sin(2 * Math.PI * ph);
    case 1: return ph < 0.5 ? -1 + 4 * ph : 3 - 4 * ph;
    case 2: return ph < 0.5 ? 1 : -1;
    default: return 2 * ph - 1;
  }
}

export interface SynthRender { left: Float32Array; right: Float32Array; }

/**
 * Render one voice.
 *
 * Stereo out, because pan is a per-oscillator destination and a mono render
 * followed by one panner could not place OSC A left and OSC B right, which is
 * the commonest wide-pad trick there is.
 */
export function renderVoice(spec: SynthRenderSpec): SynthRender {
  const sr = spec.sampleRate;
  const n = Math.max(1, Math.round(sr * Math.max(0.01, spec.seconds)));
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const prm = spec.params;

  const rows = activeRows(prm);
  const lfos = readLfos(prm, spec.beatsPerSec);
  const envs = [1, 2, 3].map((i) => ({
    a: Math.max(0, p(prm, `e${i}a`, i === 1 ? 0.005 : 0.01)),
    d: Math.max(0, p(prm, `e${i}d`, 0.3)),
    s: Math.max(0, Math.min(1, p(prm, `e${i}s`, i === 1 ? 0.7 : 0))),
    r: Math.max(0.002, p(prm, `e${i}r`, 0.15)),
  }));

  // Static values every destination starts from.
  const base = {
    aPos: p(prm, 'aPos', 0), bPos: p(prm, 'bPos', 0),
    aPitch: 0, bPitch: 0,
    cutoff: p(prm, 'cutoff', 60), res: Math.max(0, Math.min(0.98, p(prm, 'res', 0.2))),
    aLevel: p(prm, 'aLevel', 0.7), bLevel: p(prm, 'bLevel', 0),
    subLevel: p(prm, 'subLevel', 0), noise: p(prm, 'noiseLevel', 0),
    aPan: p(prm, 'aPan', 0), bPan: p(prm, 'bPan', 0),
    aDetune: p(prm, 'aDetune', 12), bDetune: p(prm, 'bDetune', 12),
    drive: p(prm, 'drive', 0), aPhase: p(prm, 'aPhase', 0), bPhase: p(prm, 'bPhase', 0),
    amp: 1,
  };

  const tableA = wavetableAt(p(prm, 'aTable', 0));
  const tableB = wavetableAt(p(prm, 'bTable', 1));
  const unisonA = Math.max(1, Math.min(7, Math.round(p(prm, 'aUnison', 1))));
  const unisonB = Math.max(1, Math.min(7, Math.round(p(prm, 'bUnison', 1))));
  const readersA = Array.from({ length: unisonA }, () => new TableReader(tableA));
  const readersB = Array.from({ length: unisonB }, () => new TableReader(tableB));
  const phA = new Float64Array(unisonA);
  const phB = new Float64Array(unisonB);

  // Where each unison voice starts in the cycle.
  //
  // `rand` scatters them and `phase` sets where an unscattered one begins.
  // Both matter and they are not the same control: a hard-synced start makes
  // every note begin with the same transient (which is what a plucky bass
  // wants), and a scattered one makes the attack soft and wide (which is what
  // a pad wants).  With `rand` at 0 and unison above 1 the voices would start
  // identical and sum to one louder voice, so the spread is applied first.
  const randA = Math.max(0, Math.min(1, p(prm, 'aRand', 0)));
  const randB = Math.max(0, Math.min(1, p(prm, 'bRand', 0)));
  for (let v = 0; v < unisonA; v++) {
    const jitter = noteRandom(spec.pitch, v, 11) * 0.5 + 0.5;
    phA[v] = base.aPhase + randA * jitter;
  }
  for (let v = 0; v < unisonB; v++) {
    const jitter = noteRandom(spec.pitch, v, 23) * 0.5 + 0.5;
    phB[v] = base.bPhase + randB * jitter;
  }

  const octA = Math.round(p(prm, 'aOct', 0)) * 12 + Math.round(p(prm, 'aSemi', 0));
  const octB = Math.round(p(prm, 'bOct', 0)) * 12 + Math.round(p(prm, 'bSemi', 0));
  const fineA = p(prm, 'aFine', 0);
  const fineB = p(prm, 'bFine', 0);
  const blendA = Math.max(0, Math.min(1, p(prm, 'aBlend', 0.6)));
  const blendB = Math.max(0, Math.min(1, p(prm, 'bBlend', 0.6)));

  const subOct = Math.round(p(prm, 'subOct', -1));
  const subShape = p(prm, 'subWave', 0);
  let subPhase = 0;
  const noise = new Noise((spec.pitch * 2654435761) ^ 0x9e3779b9);
  const noiseColour = Math.max(0, Math.min(1, p(prm, 'noiseColour', 0.5)));

  const filterType = Math.max(0, Math.min(3, Math.round(p(prm, 'fltType', 0))));
  const poles = p(prm, 'flt24', 1) > 0.5 ? 2 : 1;
  const keyTrack = Math.max(0, Math.min(1, p(prm, 'fltKey', 0)));
  const fltMix = Math.max(0, Math.min(1, p(prm, 'fltMix', 1)));

  const wheelValue = Math.max(0, Math.min(1, p(prm, 'wheel', 0)));
  const pressValue = Math.max(0, Math.min(1, p(prm, 'pressure', 0)));
  const macros = [1, 2, 3, 4].map((i) => Math.max(0, Math.min(1, p(prm, `macro${i}`, 0))));

  const srcValues = new Float64Array(17);
  srcValues[8] = spec.velocity;
  srcValues[9] = (spec.pitch - 60) / 48;
  srcValues[10] = spec.random;
  for (let i = 0; i < 4; i++) srcValues[11 + i] = macros[i] ?? 0;
  srcValues[15] = wheelValue;
  srcValues[16] = pressValue;

  // ── Why the modulation lives in two Float64Arrays ─────────────────────────
  //
  // It was a Record<string, number> and the instrument cost 127 ms a note.
  // Fourteen destinations read per SAMPLE, each one a hashed string lookup in
  // two objects — twenty-eight hash lookups per sample, which is more work
  // than the oscillators, the filter and the envelopes put together.  Indexed
  // arrays and the numbers land in registers.
  const modCur = new Float64Array(MOD_DESTS.length);
  const modNxt = new Float64Array(MOD_DESTS.length);

  const evaluate = (t: number, into: Float64Array): void => {
    for (let i = 0; i < 3; i++) {
      const e = envs[i]!;
      srcValues[1 + i] = envAt(t, spec.gateSec, e.a, e.d, e.s, e.r);
    }
    for (let i = 0; i < 4; i++) {
      const l = lfos[i]!;
      const active = t - l.delay;
      if (active < 0) { srcValues[4 + i] = 0; continue; }
      const ramp = l.rise <= 0 ? 1 : Math.min(1, active / l.rise);
      srcValues[4 + i] = lfoValue(
        l.shape, l.phase + active * l.rate, l.skew, Math.round(spec.pitch) + i * 7) * ramp;
    }
    into.fill(0);
    for (const row of rows) {
      const dest = MOD_DESTS[row.dst];
      if (!dest) continue;
      into[row.dst] = (into[row.dst] ?? 0) + (srcValues[row.src] ?? 0) * row.amt * dest.span;
    }
  };

  const ampEnv = envs[0]!;
  const gate = spec.gateSec;

  // ── Per-sample state, updated once per control block ──────────────────────
  //
  // Everything a sample needs is a plain number that walks towards its next
  // value by a fixed step.  The expensive parts — two `Math.pow` per unison
  // voice for the detune ratio, one `Math.tan` for the filter — happen once
  // per sixteen samples, which is where they belong: none of them can move
  // faster than the modulation driving them.
  const incA = new Float64Array(unisonA);
  const incB = new Float64Array(unisonB);
  const stepIncA = new Float64Array(unisonA);
  const stepIncB = new Float64Array(unisonB);
  const wA = new Float64Array(unisonA);
  const wB = new Float64Array(unisonB);
  // Where each unison voice sits across the stereo field.
  //
  // This is what makes a supersaw WIDE, and it is not the same thing as
  // panning the oscillator: the voices are spread across the field in the
  // same order they are detuned, so the flat one is in the middle and the
  // sharp and the low ones go opposite ways.  Measured before it existed:
  // the default patch came out at −238 dB on the side channel, which is to
  // say perfectly mono — three detuned voices all landing in the same place,
  // which is a chorus you cannot hear around rather than a wide sound.
  const widthA = Math.max(0, Math.min(1, p(prm, 'aWidth', 0.6)));
  const widthB = Math.max(0, Math.min(1, p(prm, 'bWidth', 0.6)));
  const wAL = new Float64Array(unisonA);
  const wAR = new Float64Array(unisonA);
  const wBL = new Float64Array(unisonB);
  const wBR = new Float64Array(unisonB);
  for (let v = 0; v < unisonA; v++) {
    wA[v] = unisonA === 1 ? 1 : (v * 2 === unisonA - 1 ? 1 : blendA);
    const spread = unisonA === 1 ? 0 : (v / (unisonA - 1) - 0.5) * 2 * widthA;
    wAL[v] = Math.cos((spread + 1) * Math.PI / 4) * Math.SQRT2 * (wA[v] ?? 1);
    wAR[v] = Math.sin((spread + 1) * Math.PI / 4) * Math.SQRT2 * (wA[v] ?? 1);
  }
  for (let v = 0; v < unisonB; v++) {
    wB[v] = unisonB === 1 ? 1 : (v * 2 === unisonB - 1 ? 1 : blendB);
    const spread = unisonB === 1 ? 0 : (v / (unisonB - 1) - 0.5) * 2 * widthB;
    wBL[v] = Math.cos((spread + 1) * Math.PI / 4) * Math.SQRT2 * (wB[v] ?? 1);
    wBR[v] = Math.sin((spread + 1) * Math.PI / 4) * Math.SQRT2 * (wB[v] ?? 1);
  }
  const normA = 1 / Math.sqrt(unisonA);
  const normB = 1 / Math.sqrt(unisonB);

  let posA = 0; let posB = 0; let levA = 0; let levB = 0;
  let subLev = 0; let nzLev = 0; let g = 0; let kRes = 0; let driveAmt = 0;
  let aL = 0; let aR = 0; let bL = 0; let bR = 0; let ampMod = 0; let subInc = 0;
  // Phase OFFSET, not phase accumulator.
  //
  // The A Phase and B Phase knobs decide where a note starts in the cycle and
  // are applied once, above.  The matrix destinations of the same name are a
  // different thing: an offset added to the read position every sample, which
  // is phase modulation — the operator-on-operator trick that gives an FM
  // synth its metallic edge, and the reason a wavetable synth can make bells
  // out of a saw.  The two were conflated at first and the destination did
  // nothing at all; `wave-synth-selftest`'s sweep of every destination is
  // what said so.
  let phModA = 0; let phModB = 0;
  let sPhA = 0; let sPhB = 0;
  let sPosA = 0; let sPosB = 0; let sLevA = 0; let sLevB = 0;
  let sSub = 0; let sNz = 0; let sG = 0; let sK = 0; let sDrive = 0;
  let sAL = 0; let sAR = 0; let sBL = 0; let sBR = 0; let sAmp = 0;
  let mipA = 0; let mipB = 0;

  /** Read one block's modulation into the walking values. */
  const target = (m: Float64Array, out: Float64Array, uni: number,
    baseCents: number, baseDetune: number, pitchIdx: number, detIdx: number): number => {
    const cents = baseCents + (m[pitchIdx] ?? 0);
    const f = spec.freqHz * Math.pow(2, cents / 1200);
    const det = Math.max(0, baseDetune + (m[detIdx] ?? 0));
    for (let v = 0; v < uni; v++) {
      const spread = uni === 1 ? 0 : (v / (uni - 1) - 0.5) * 2;
      out[v] = (f * Math.pow(2, (spread * det) / 1200)) / sr;
    }
    return f;
  };

  const settle = (m: Float64Array, into: 'now' | 'step', samples: number): void => {
    const fA = target(m, into === 'now' ? incA : stepIncA, unisonA,
      octA * 100 + fineA, base.aDetune, D_A_PITCH, D_A_DETUNE);
    const fB = target(m, into === 'now' ? incB : stepIncB, unisonB,
      octB * 100 + fineB, base.bDetune, D_B_PITCH, D_B_DETUNE);
    const tPosA = Math.max(0, base.aPos + (m[D_A_POS] ?? 0));
    const tPosB = Math.max(0, base.bPos + (m[D_B_POS] ?? 0));
    const tLevA = Math.max(0, base.aLevel + (m[D_A_LEVEL] ?? 0));
    const tLevB = Math.max(0, base.bLevel + (m[D_B_LEVEL] ?? 0));
    const tSub = Math.max(0, base.subLevel + (m[D_SUB] ?? 0));
    const tNz = Math.max(0, base.noise + (m[D_NOISE] ?? 0));
    const cutSemis = base.cutoff + (m[D_CUTOFF] ?? 0) + keyTrack * (spec.pitch - 60);
    const fc = Math.min(sr * 0.47, Math.max(20, 8.1758 * Math.pow(2, cutSemis / 12)));
    const tG = Math.tan(Math.PI * (fc / sr));
    const tK = 2 - 2 * Math.max(0, Math.min(0.985, base.res + (m[D_RES] ?? 0)));
    const tDrive = Math.max(0, Math.min(1, base.drive + (m[D_DRIVE] ?? 0)));
    const pA = Math.max(-1, Math.min(1, base.aPan + (m[D_A_PAN] ?? 0)));
    const pB = Math.max(-1, Math.min(1, base.bPan + (m[D_B_PAN] ?? 0)));
    // Equal power, so a pan sweep does not also be a volume sweep.
    const tAL = Math.cos((pA + 1) * Math.PI / 4) * Math.SQRT2;
    const tAR = Math.sin((pA + 1) * Math.PI / 4) * Math.SQRT2;
    const tBL = Math.cos((pB + 1) * Math.PI / 4) * Math.SQRT2;
    const tBR = Math.sin((pB + 1) * Math.PI / 4) * Math.SQRT2;
    const tAmp = m[D_AMP] ?? 0;
    const tPhA = m[D_A_PHASE] ?? 0;
    const tPhB = m[D_B_PHASE] ?? 0;

    if (into === 'now') {
      posA = tPosA; posB = tPosB; levA = tLevA; levB = tLevB;
      subLev = tSub; nzLev = tNz; g = tG; kRes = tK; driveAmt = tDrive;
      aL = tAL; aR = tAR; bL = tBL; bR = tBR; ampMod = tAmp;
      phModA = tPhA; phModB = tPhB;
      subInc = (spec.freqHz * Math.pow(2, subOct)) / sr;
      mipA = mipFor(fA * 1.04, sr);
      mipB = mipFor(fB * 1.04, sr);
      return;
    }
    const inv = 1 / samples;
    for (let v = 0; v < unisonA; v++) stepIncA[v] = ((stepIncA[v] ?? 0) - (incA[v] ?? 0)) * inv;
    for (let v = 0; v < unisonB; v++) stepIncB[v] = ((stepIncB[v] ?? 0) - (incB[v] ?? 0)) * inv;
    sPosA = (tPosA - posA) * inv; sPosB = (tPosB - posB) * inv;
    sLevA = (tLevA - levA) * inv; sLevB = (tLevB - levB) * inv;
    sSub = (tSub - subLev) * inv; sNz = (tNz - nzLev) * inv;
    sG = (tG - g) * inv; sK = (tK - kRes) * inv; sDrive = (tDrive - driveAmt) * inv;
    sAL = (tAL - aL) * inv; sAR = (tAR - aR) * inv;
    sBL = (tBL - bL) * inv; sBR = (tBR - bR) * inv;
    sAmp = (tAmp - ampMod) * inv;
    sPhA = (tPhA - phModA) * inv; sPhB = (tPhB - phModB) * inv;
    mipA = mipFor(fA * 1.04, sr);
    mipB = mipFor(fB * 1.04, sr);
  };

  evaluate(0, modCur);
  settle(modCur, 'now', 1);

  const fOutL = new Float64Array(3);
  const fOutR = new Float64Array(3);
  const svfL1 = new Svf(); const svfL2 = new Svf();
  const svfR1 = new Svf(); const svfR2 = new Svf();
  const lp = filterType === 0; const notch = filterType === 3;

  for (let i = 0; i < n; i++) {
    if (i % CONTROL_STRIDE === 0) {
      const remaining = Math.min(CONTROL_STRIDE, n - i);
      evaluate((i + remaining) / sr, modNxt);
      settle(modNxt, 'step', remaining);
    }

    // ── Oscillators ───────────────────────────────────────────────────────
    let sumAL = 0; let sumAR = 0;
    for (let v = 0; v < unisonA; v++) {
      const sample = readersA[v]!.read(posA, (phA[v] ?? 0) + phModA, mipA);
      sumAL += sample * (wAL[v] ?? 1);
      sumAR += sample * (wAR[v] ?? 1);
      let ph = (phA[v] ?? 0) + (incA[v] ?? 0);
      if (ph >= 1) ph -= Math.floor(ph);
      phA[v] = ph;
      incA[v] = (incA[v] ?? 0) + (stepIncA[v] ?? 0);
    }
    let sumBL = 0; let sumBR = 0;
    if (levB > 1e-6) {
      for (let v = 0; v < unisonB; v++) {
        const sample = readersB[v]!.read(posB, (phB[v] ?? 0) + phModB, mipB);
        sumBL += sample * (wBL[v] ?? 1);
        sumBR += sample * (wBR[v] ?? 1);
        let ph = (phB[v] ?? 0) + (incB[v] ?? 0);
        if (ph >= 1) ph -= Math.floor(ph);
        phB[v] = ph;
        incB[v] = (incB[v] ?? 0) + (stepIncB[v] ?? 0);
      }
    }
    const gA = normA * levA; const gB = normB * levB;
    sumAL *= gA; sumAR *= gA; sumBL *= gB; sumBR *= gB;

    let common = 0;
    if (subLev > 1e-6) {
      common += subSample(subShape, subPhase) * subLev;
      subPhase += subInc;
      if (subPhase >= 1) subPhase -= Math.floor(subPhase);
    }
    if (nzLev > 1e-6) common += noise.next(noiseColour) * nzLev;

    // ── Filter, per channel ───────────────────────────────────────────────
    //
    // Two of them, because the oscillators are panned BEFORE the filter and a
    // mono filter would undo that: a pad with OSC A hard left and OSC B hard
    // right is the commonest wide sound there is, and it only stays wide if
    // each side keeps its own filter state.
    const half = common * 0.70710678;
    // The oscillator's own Pan multiplies the unison spread rather than
    // replacing it: Pan moves the whole stack, Width decides how far the
    // voices inside it are from each other.
    const inL = sumAL * aL + sumBL * bL + half;
    const inR = sumAR * aR + sumBR * bR + half;

    svfL1.step(inL, g, kRes, fOutL);
    svfR1.step(inR, g, kRes, fOutR);
    let fl = notch ? inL - (fOutL[1] ?? 0) * kRes : (fOutL[filterType] ?? 0);
    let fr = notch ? inR - (fOutR[1] ?? 0) * kRes : (fOutR[filterType] ?? 0);
    if (poles === 2) {
      svfL2.step(fl, g, kRes, fOutL);
      svfR2.step(fr, g, kRes, fOutR);
      fl = notch ? fl - (fOutL[1] ?? 0) * kRes : (fOutL[filterType] ?? 0);
      fr = notch ? fr - (fOutR[1] ?? 0) * kRes : (fOutR[filterType] ?? 0);
    }
    void lp;
    let outL = inL + (fl - inL) * fltMix;
    let outR = inR + (fr - inR) * fltMix;
    if (driveAmt > 0.001) { outL = drive(outL, driveAmt); outR = drive(outR, driveAmt); }

    const env = envAt(i / sr, gate, ampEnv.a, ampEnv.d, ampEnv.s, ampEnv.r);
    const amp = env * Math.max(0, 1 + ampMod);
    left[i] = outL * amp;
    right[i] = outR * amp;

    posA += sPosA; posB += sPosB; levA += sLevA; levB += sLevB;
    subLev += sSub; nzLev += sNz; g += sG; kRes += sK; driveAmt += sDrive;
    aL += sAL; aR += sAR; bL += sBL; bR += sBR; ampMod += sAmp;
    phModA += sPhA; phModB += sPhB;
  }
  return { left, right };
}

/** Seconds a voice needs after the key lifts, from the longest envelope. */
export function tailSeconds(params: Readonly<Record<string, number>>): number {
  let longest = 0;
  for (let i = 1; i <= 3; i++) longest = Math.max(longest, p(params, `e${i}r`, 0.15));
  return Math.min(12, longest + 0.02);
}

export { SUB_SHAPES, CONTROL_STRIDE };
export type { MatrixRow };
