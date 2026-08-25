// What a device does to a signal, as the numbers the engine is actually using.
//
// `plugin-curves.ts` re-derives the biquad maths because Web Audio only gives
// you a filter node, not its response.  A WaveShaperNode is the opposite case:
// the engine hands it a Float32Array, and that array IS the transfer function.
// So there is nothing to re-derive here and nothing to approximate — this
// module calls the same `tanhCurve`, `clipCurve`, `bitCurve`, `tubeCurve` and
// `gateGainCurve` the graph is built from, and reads them the way a
// WaveShaperNode reads them.
//
// That is the whole point.  A drive knob that visibly bends the curve, and a
// bit crusher whose staircase has exactly as many steps as the converter it is
// pretending to be, cannot drift out of agreement with what is being heard,
// because there is only one copy of the maths.
//
// Pure, so it is tested without an AudioContext.

import {
  biquadMagnitudeDb, biquadResponse, cAbs, cAdd, cDiv, cMul, delayTaps,
  type BiquadSpec, type Complex,
} from './plugin-curves.js';
import { tanhCurve } from '../engine/plugin-kit.js';
import {
  bitCurve, clipCurve, gateGainCurve, tubeCurve,
} from '../engine/plugins-extended.js';

function num(params: Record<string, number>, id: string, fallback: number): number {
  const v = params[id];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

const dbToGain = (db: number): number => Math.pow(10, db / 20);

/**
 * A waveshaping device, as the chain of gains and curves the graph holds.
 *
 * `curves` is in signal order because two of these devices use more than one:
 * the soft clipper follows its oversampled shaper with an un-oversampled guard
 * so the ceiling is true rather than a suggestion, and drawing only the first
 * would draw a ceiling the device does not have.
 */
export interface ShaperSpec {
  /** Before the curves, in the wet path only. */
  inputGain: number;
  curves: Float32Array[];
  /** After the curves, still in the wet path only. */
  wetGain: number;
  /** 0..1 wet blend against the dry input. */
  mix: number;
  /**
   * What the dry path is multiplied by.
   *
   * Normally `1 - mix`, but the exciter ADDS its treated band on top of a dry
   * path that stays at full level — turning its mix up does not uncover
   * anything, it piles more on.  Defaulting this to `1 - mix` would draw the
   * exciter quietly cross-fading, which is not what you hear.
   */
  dryGain: number;
  /**
   * After the blend, on both paths.
   *
   * Not the same place as `wetGain`, and the difference is visible: the
   * saturator's level compensation sits inside its wet path, so turning the
   * mix down uncovers the untouched dry signal, while the tube's output trim
   * sits after the blend and moves the whole thing.  Drawing them at the same
   * point would put the tube's dry line in the wrong place.
   */
  postGain: number;
  /** The device's own words for what these numbers are doing. */
  caption: string;
}

/** Read a WaveShaper curve at `x`, the way WaveShaperNode reads it. */
export function readCurve(curve: Float32Array, x: number): number {
  const n = curve.length;
  if (n === 0) return x;
  if (n === 1) return curve[0] ?? x;
  // Web Audio maps x = -1..+1 across the whole array and clamps outside it.
  const t = (Math.max(-1, Math.min(1, x)) + 1) / 2 * (n - 1);
  const i = Math.floor(t);
  const lo = curve[Math.min(n - 1, i)] ?? 0;
  const hi = curve[Math.min(n - 1, i + 1)] ?? lo;
  return lo + (hi - lo) * (t - i);
}

/** What comes out of the whole device when `x` goes in, dry blend included. */
export function shaperOutput(spec: ShaperSpec, x: number): number {
  let wet = x * spec.inputGain;
  for (const curve of spec.curves) wet = readCurve(curve, wet);
  wet *= spec.wetGain;
  return spec.postGain * (wet * spec.mix + x * spec.dryGain);
}

/**
 * The waveshaping devices, or null for anything that is not one.
 *
 * The gate and the denoiser are deliberately absent: their curve maps a
 * DETECTOR envelope to a gain, not an input sample to an output sample, so
 * plotting it on these axes would draw a transfer function neither device has.
 * They get the dynamics axes instead — see `detectorFor`.
 */
/**
 * The devices drawn as a transfer curve.
 *
 * A separate list from `shaperFor` only in that it costs nothing to ask: the
 * window needs the answer on every render to size itself, and `shaperFor`
 * builds four-thousand-entry Float32Arrays.
 */
export const TRANSFER_CURVE_DEVICES: readonly string[] = [
  'trim', 'saturation', 'tube', 'clipper', 'bitcrush', 'exciter',
];

/** The devices drawn on the detector axes. */
export const DETECTOR_DEVICES: readonly string[] = ['gate', 'denoise'];

/** Whether this device wants a square picture — a transfer curve needs one. */
export function wantsSquareVisual(pluginId: string): boolean {
  return TRANSFER_CURVE_DEVICES.includes(pluginId);
}

export function shaperFor(pluginId: string, params: Record<string, number>): ShaperSpec | null {
  if (!TRANSFER_CURVE_DEVICES.includes(pluginId)) return null;
  if (pluginId === 'trim') {
    const db = num(params, 'gainDb', 0);
    return {
      inputGain: 1, curves: [], wetGain: 1, mix: 1, dryGain: 0, postGain: dbToGain(db),
      caption: `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB — 기울기만 바뀌는 직선입니다`,
    };
  }

  if (pluginId === 'saturation') {
    const driveDb = num(params, 'driveDb', 0);
    const gain = dbToGain(driveDb);
    return {
      inputGain: gain,
      curves: [tanhCurve(num(params, 'bias', 0))],
      // The engine compensates the level the drive adds, so the macro is not
      // also a volume knob.  It is inside the wet path, not after the blend.
      wetGain: 1 / Math.max(1, Math.sqrt(gain)),
      mix: num(params, 'mix', 0),
      dryGain: 1 - num(params, 'mix', 0),
      postGain: 1,
      caption: `드라이브 ${driveDb.toFixed(1)} dB · 믹스 ${Math.round(num(params, 'mix', 0) * 100)}%`,
    };
  }

  if (pluginId === 'tube') {
    return {
      inputGain: 1,
      curves: [tubeCurve(num(params, 'drive', 0.3), num(params, 'bias', 0.15))],
      wetGain: 1,
      mix: num(params, 'mix', 100) / 100,
      dryGain: 1 - num(params, 'mix', 100) / 100,
      postGain: dbToGain(num(params, 'outDb', 0)),
      // The tone control is a lowpass in the wet path; it changes the sound
      // but not this transfer curve, so it is said rather than drawn.
      caption: `바이어스 ${num(params, 'bias', 0.15).toFixed(2)} · 짝수 배음 — 톤은 곡선 밖`,
    };
  }

  if (pluginId === 'exciter') {
    const amount = num(params, 'amount', 0);
    const mix = num(params, 'mix', 0);
    // `input -> highpass -> drive(1 + amount*8) -> tanh(0.15) -> wet(mix) -> out`
    // with `input -> out` at FULL level alongside.  This curve is what content
    // above the corner meets; the corner is a filter and has no place on a
    // transfer curve's axes, so it is said in the caption instead of drawn.
    return {
      inputGain: 1 + amount * 8,
      curves: [tanhCurve(0.15)],
      wetGain: 1,
      mix,
      dryGain: 1,
      postGain: 1,
      caption: `${(num(params, 'freqHz', 4000) / 1000).toFixed(1)} kHz 위만 · 드라이브 ×${(1 + amount * 8).toFixed(1)} · ${(mix * 100).toFixed(0)}% 더함`,
    };
  }

  if (pluginId === 'clipper') {
    const ceiling = dbToGain(num(params, 'ceilingDb', -1));
    return {
      inputGain: dbToGain(num(params, 'driveDb', 0)),
      // Shaper then guard, both of them, because the guard is what makes the
      // ceiling real after oversampling rings past it.
      curves: [clipCurve(ceiling, num(params, 'hardness', 0.5)), clipCurve(ceiling, 1)],
      wetGain: 1, mix: 1, dryGain: 0, postGain: 1,
      caption: `실링 ${num(params, 'ceilingDb', -1).toFixed(1)} dB · 하드니스 ${num(params, 'hardness', 0.5).toFixed(2)}`,
    };
  }

  if (pluginId === 'bitcrush') {
    const bits = num(params, 'bits', 8);
    return {
      inputGain: 1,
      curves: [bitCurve(bits)],
      wetGain: 1,
      mix: num(params, 'mix', 100) / 100,
      dryGain: 1 - num(params, 'mix', 100) / 100,
      postGain: 1,
      // `bitCurve` quantises to 2^bits / 2 levels each side of zero, and the
      // knob is continuous, so the step count is rarely a round number.
      caption: `${bits.toFixed(1)} bit · ±${(Math.max(2, Math.pow(2, Math.max(1, bits)) / 2)).toFixed(1)} 단계`,
    };
  }

  return null;
}

/**
 * A device whose curve maps a DETECTOR envelope to a gain.
 *
 * The gate and the denoiser both work this way: a rectifier and a smoother
 * make an envelope, that envelope reads a curve, and the curve drives a VCA.
 * So the useful picture is input level against the gain it earns — which is
 * the compressor's axes, with the curve running the other way.
 */
export interface DetectorSpec {
  /** Envelope (0..1 linear) → gain (0..1 linear). */
  curve: Float32Array;
  thresholdDb: number;
  caption: string;
}

export function detectorFor(pluginId: string, params: Record<string, number>): DetectorSpec | null {
  if (!DETECTOR_DEVICES.includes(pluginId)) return null;
  if (pluginId === 'gate') {
    const thresholdDb = num(params, 'thresholdDb', -45);
    const rangeDb = num(params, 'rangeDb', 40);
    return {
      curve: gateGainCurve(thresholdDb, rangeDb),
      thresholdDb,
      caption: `문턱 ${thresholdDb.toFixed(0)} dB · 닫히면 ${rangeDb.toFixed(0)} dB 내려감`,
    };
  }

  if (pluginId === 'denoise') {
    const thresholdDb = num(params, 'thresholdDb', -48);
    const amount = num(params, 'amount', 0);
    // The engine's own mapping: amount 0..1 becomes an expansion ratio 1..6.
    const ratio = 1 + amount * 5;
    return {
      curve: expanderGainCurve(thresholdDb, ratio),
      thresholdDb,
      caption: `문턱 ${thresholdDb.toFixed(0)} dB · 확장비 ${ratio.toFixed(1)}:1`,
    };
  }

  return null;
}

/**
 * `makeExpanderCurve` without the AudioContext.
 *
 * `plugin-kit` builds this same array but only ever hands it to a shaper; the
 * numbers are duplicated here rather than the module being reshaped around a
 * drawing, and the self-test holds the two to the same values so they cannot
 * drift.
 */
export function expanderGainCurve(
  thresholdDb: number, ratio: number, floorGain = 0.05,
): Float32Array {
  const n = 2048;
  const curve = new Float32Array(n);
  const thr = dbToGain(thresholdDb);
  for (let i = 0; i < n; i++) {
    const env = Math.abs((i / (n - 1)) * 2 - 1);
    let g = 1;
    if (env < thr && thr > 0) {
      g = Math.pow(Math.max(env, 1e-5) / thr, Math.max(0, ratio - 1));
      g = Math.max(floorGain, Math.min(1, g));
    }
    curve[i] = g;
  }
  return curve;
}

/** The gain a detector device gives a signal sitting at `inputDb`. */
export function detectorGainDb(spec: DetectorSpec, inputDb: number): number {
  const gain = readCurve(spec.curve, dbToGain(Math.min(0, inputDb)));
  return 20 * Math.log10(Math.max(1e-6, gain));
}

// ── Devices whose behaviour is a filter, or a filter per stereo component ────

/**
 * A named set of biquads to draw together.
 *
 * The mid/side EQ is two independent chains that a single summed curve would
 * misrepresent — "the sides are 4 dB brighter than the centre" is the whole
 * information, and adding them together destroys exactly that.
 */
export interface NamedCurve {
  label: string;
  specs: BiquadSpec[];
  /** Drawn in this colour, so two curves in one picture stay apart. */
  colour: string;
}

export interface FilterPicture {
  curves: NamedCurve[];
  /** The visible frequency span, which is not always the audible band. */
  fromHz: number;
  toHz: number;
  caption: string;
}

const MID_COLOUR = 'rgba(230,210,160,0.95)';
const SIDE_COLOUR = 'rgba(126,200,255,0.9)';

export const FILTER_DEVICES: readonly string[] = ['mseq', 'hum', 'dcblock'];

export function filterPictureFor(
  pluginId: string, params: Record<string, number>,
): FilterPicture | null {
  if (pluginId === 'mseq') {
    // The engine pins both shelves at 200 Hz and 6 kHz.
    const shelves = (lowDb: number, highDb: number): BiquadSpec[] => [
      { type: 'lowshelf', freq: 200, gain: lowDb, q: 0.707 },
      { type: 'highshelf', freq: 6000, gain: highDb, q: 0.707 },
    ];
    const midLow = num(params, 'midLowDb', 0);
    const midHigh = num(params, 'midHighDb', 0);
    const sideLow = num(params, 'sideLowDb', 0);
    const sideHigh = num(params, 'sideHighDb', 0);
    return {
      curves: [
        { label: 'MID', specs: shelves(midLow, midHigh), colour: MID_COLOUR },
        { label: 'SIDE', specs: shelves(sideLow, sideHigh), colour: SIDE_COLOUR },
      ],
      fromHz: 20, toHz: 20_000,
      caption: `가운데 ${midLow >= 0 ? '+' : ''}${midLow.toFixed(1)}/${midHigh >= 0 ? '+' : ''}${midHigh.toFixed(1)} · 양옆 ${sideLow >= 0 ? '+' : ''}${sideLow.toFixed(1)}/${sideHigh >= 0 ? '+' : ''}${sideHigh.toFixed(1)} dB`,
    };
  }

  if (pluginId === 'hum') {
    const base = num(params, 'baseHz', 60);
    const count = Math.round(num(params, 'harmonics', 4));
    const q = num(params, 'q', 30);
    // The engine builds eight notches always and parks the unused ones at
    // 20 kHz rather than bypassing them.  A parked notch is still in the
    // signal path, so drawing only the active ones would draw a response the
    // device does not have.
    const specs: BiquadSpec[] = [];
    for (let i = 0; i < 8; i++) {
      const hz = base * (i + 1);
      specs.push({
        type: 'notch',
        freq: i < count && hz < 24_000 ? hz : 20_000,
        gain: 0, q,
      });
    }
    return {
      curves: [{ label: '', specs, colour: MID_COLOUR }],
      // A 60 Hz notch and its harmonics live at the bottom; the top two
      // octaves are empty and would just squash the part worth seeing.
      fromHz: 20, toHz: 2000,
      caption: `${base.toFixed(0)} Hz 와 배음 ${count}개 · Q ${q.toFixed(0)}`,
    };
  }

  if (pluginId === 'dcblock') {
    return {
      curves: [{
        label: '',
        specs: [{ type: 'highpass', freq: 5, gain: 0, q: 0.707 }],
        colour: MID_COLOUR,
      }],
      // Drawn from 1 Hz, because a 5 Hz corner seen from 20 Hz upwards is a
      // flat line — and "it does nothing you can hear" is the point, but it
      // only reads as a point if the corner it does have is on the picture.
      fromHz: 1, toHz: 2000,
      caption: '5 Hz 하이패스 — 들리는 대역은 건드리지 않습니다',
    };
  }

  return null;
}

// ── Devices that set stereo width per frequency ─────────────────────────────

/**
 * How wide the device leaves each frequency, as a multiple of the input.
 *
 * The widener and the mono maker both work by filtering the SIDE component and
 * scaling it, so "width" is a curve, not a number: below the corner the sides
 * are gone and the sound is mono no matter where the width knob sits.  A knob
 * reading 1.4x next to a corner frequency reading 120 Hz does not say that.
 */
export interface WidthPicture {
  /** Width multiplier at a frequency; 1 is untouched, 0 is mono. */
  widthAt: (hz: number) => number;
  /** Where the sides are half gone, for the label. */
  cornerHz: number;
  maxWidth: number;
  caption: string;
}

export const WIDTH_DEVICES: readonly string[] = ['widener', 'monomaker'];

export function widthPictureFor(
  pluginId: string, params: Record<string, number>,
): WidthPicture | null {
  if (pluginId === 'widener') {
    const width = num(params, 'width', 1);
    const corner = num(params, 'lowMonoHz', 20);
    // One highpass on the side path, at Web Audio's default Q of 1 (which on
    // a highpass is a resonance in dB, not a cookbook Q).
    const hp: BiquadSpec = { type: 'highpass', freq: corner, gain: 0, q: 1 };
    return {
      widthAt: (hz) => width * Math.pow(10, biquadMagnitudeDb(hp, hz) / 20),
      cornerHz: corner,
      maxWidth: Math.max(2, width),
      caption: `폭 ${width.toFixed(2)}× · ${corner.toFixed(0)} Hz 아래는 모노`,
    };
  }

  if (pluginId === 'monomaker') {
    const width = Math.max(0, num(params, 'widthPct', 100)) / 100;
    const corner = num(params, 'freqHz', 120);
    // TWO highpasses in series on the side path — 12 dB/oct, a steeper skirt
    // than the widener's, and the reason this one sounds tighter.
    const hp: BiquadSpec = { type: 'highpass', freq: corner, gain: 0, q: 0.707 };
    return {
      widthAt: (hz) => width * Math.pow(10, (2 * biquadMagnitudeDb(hp, hz)) / 20),
      cornerHz: corner,
      maxWidth: Math.max(2, width),
      caption: `폭 ${(width * 100).toFixed(0)}% · ${corner.toFixed(0)} Hz 아래는 모노 (12 dB/oct)`,
    };
  }

  return null;
}

// ── Modulation, as what it does over time ───────────────────────────────────

/**
 * A modulator's own movement.
 *
 * "Rate 0.6 Hz, depth 4 ms" is two numbers that only mean something together,
 * and a chorus is two voices at slightly different rates whose whole character
 * is the beating between them — which is a picture or it is nothing.
 */
export interface LfoTrace {
  label: string;
  colour: string;
  /** The modulated value at `t` seconds. */
  at: (t: number) => number;
}

export interface LfoPicture {
  traces: LfoTrace[];
  /** Seconds the picture spans, chosen to show a couple of cycles. */
  spanSec: number;
  min: number;
  max: number;
  unit: string;
  caption: string;
}

export const LFO_DEVICES: readonly string[] = ['tremolo', 'autopan', 'chorus'];

const sine = (phase: number): number => Math.sin(2 * Math.PI * phase);
/** Web Audio's square is a hard two-level wave, not a band-limited one. */
const square = (phase: number): number => (phase % 1 < 0.5 ? 1 : -1);
/** Web Audio's triangle starts at zero, rising. */
function triangle(phase: number): number {
  const t = ((phase % 1) + 1) % 1;
  return t < 0.25 ? t * 4 : t < 0.75 ? 2 - t * 4 : t * 4 - 4;
}

export function lfoPictureFor(
  pluginId: string, params: Record<string, number>,
): LfoPicture | null {
  if (pluginId === 'tremolo') {
    const rate = num(params, 'rateHz', 5);
    const depth = num(params, 'depth', 0.5);
    // The engine sets the VCA to 1 - depth/2 and swings it by depth/2, so the
    // gain runs between 1 - depth and 1 — it ducks, it never boosts.
    const wave = num(params, 'shape', 0) >= 0.5 ? square : sine;
    return {
      traces: [{
        label: 'GAIN', colour: MID_COLOUR,
        at: (t) => 1 - depth / 2 + (depth / 2) * wave(rate * t),
      }],
      spanSec: 2 / Math.max(0.05, rate),
      min: 0, max: 1, unit: '×',
      caption: `${rate.toFixed(2)} Hz · ${(depth * 100).toFixed(0)}% · ${wave === square ? '사각' : '사인'}`,
    };
  }

  if (pluginId === 'autopan') {
    const rate = num(params, 'rateHz', 0.5);
    const depth = num(params, 'depth', 0.7);
    return {
      traces: [{ label: 'PAN', colour: MID_COLOUR, at: (t) => depth * sine(rate * t) }],
      spanSec: 2 / Math.max(0.05, rate),
      min: -1, max: 1, unit: '',
      caption: `${rate.toFixed(2)} Hz · ${(depth * 100).toFixed(0)}% — L↔R`,
    };
  }

  if (pluginId === 'chorus') {
    const rate = num(params, 'rateHz', 0.6);
    const depthMs = num(params, 'depthMs', 4);
    const delayMs = num(params, 'delayMs', 18);
    // Two voices, hard-panned, at rates 1 and 1.17 — and the second one is a
    // triangle.  That mismatch IS the chorus; identical voices would just be a
    // vibrato twice as loud.
    return {
      traces: [
        { label: 'L', colour: MID_COLOUR, at: (t) => delayMs + depthMs * sine(rate * t) },
        { label: 'R', colour: SIDE_COLOUR, at: (t) => delayMs + depthMs * triangle(rate * 1.17 * t) },
      ],
      spanSec: 2 / Math.max(0.05, rate),
      min: Math.max(0, delayMs - depthMs * 1.3),
      max: delayMs + depthMs * 1.3,
      unit: 'ms',
      caption: `${rate.toFixed(2)} Hz · ±${depthMs.toFixed(1)} ms · 두 성부가 1:1.17 로 어긋납니다`,
    };
  }

  return null;
}

// ── Comb and phase interference ─────────────────────────────────────────────

/**
 * What a flanger or a phaser does to the spectrum, and where it moves it to.
 *
 * Both are interference: a path that is delayed or phase-rotated, summed back
 * against the dry signal.  Neither has an audible effect until that sum
 * happens, so neither can be drawn from a magnitude response — the whole thing
 * has to be evaluated in complex numbers, mix and feedback included.
 *
 * The shaded band is where the notches travel as the LFO sweeps.  A still
 * picture of a moving filter is a lie by omission; the band is the honest part.
 */
export interface CombPicture {
  /** Response now, in dB. */
  db: (hz: number) => number;
  /** Lowest and highest dB that frequency reaches across the sweep. */
  sweep: (hz: number) => { lo: number; hi: number };
  caption: string;
}

export const COMB_DEVICES: readonly string[] = ['flanger', 'phaser'];

/** e^-jwT — one delay of `seconds`, as a complex number. */
function delayResponse(seconds: number, hz: number): Complex {
  const w = 2 * Math.PI * hz * seconds;
  return { re: Math.cos(w), im: -Math.sin(w) };
}

/**
 * A delay line with feedback, summed against the dry signal.
 *
 *   H = mix · z / (1 − g·z) + (1 − mix),   z = e^-jwT
 *
 * which is the graph exactly: `input → delay`, `delay → feedback → delay`,
 * `delay → wet`, `input → dry`.
 */
function combDb(delaySec: number, feedback: number, mix: number, hz: number): number {
  const z = delayResponse(delaySec, hz);
  const g = Math.min(0.95, Math.max(0, feedback));
  const den: Complex = { re: 1 - g * z.re, im: -g * z.im };
  const wet = cDiv({ re: mix * z.re, im: mix * z.im }, den);
  return 20 * Math.log10(Math.max(1e-6, cAbs(cAdd(wet, { re: 1 - mix, im: 0 }))));
}

/**
 * Four allpass stages with feedback, summed against the dry signal.
 *
 * The stages have unit magnitude, so everything here comes from their phase
 * meeting the dry path.
 */
function phaserDb(centreHz: number, feedback: number, mix: number, hz: number): number {
  const stage: BiquadSpec = { type: 'allpass', freq: Math.max(20, centreHz), gain: 0, q: 0.7 };
  const a = biquadResponse(stage, hz);
  let chain: Complex = { re: 1, im: 0 };
  for (let i = 0; i < 4; i++) chain = cMul(chain, a);
  // The loop closes through a one-sample delay at 48 kHz.
  const g = Math.min(0.9, Math.max(0, feedback));
  const loop = cMul(chain, delayResponse(1 / 48_000, hz));
  const den: Complex = { re: 1 - g * loop.re, im: -g * loop.im };
  const wet = cDiv({ re: mix * chain.re, im: mix * chain.im }, den);
  return 20 * Math.log10(Math.max(1e-6, cAbs(cAdd(wet, { re: 1 - mix, im: 0 }))));
}

export function combPictureFor(
  pluginId: string, params: Record<string, number>,
): CombPicture | null {
  if (pluginId === 'flanger') {
    const delayMs = num(params, 'delayMs', 3);
    const depthMs = num(params, 'depthMs', 2);
    const feedback = num(params, 'feedback', 0.5);
    const mix = num(params, 'mix', 50) / 100;
    const lowSec = Math.max(0.00005, (delayMs - depthMs) / 1000);
    const highSec = (delayMs + depthMs) / 1000;
    return {
      db: (hz) => combDb(delayMs / 1000, feedback, mix, hz),
      sweep: (hz) => {
        const a = combDb(lowSec, feedback, mix, hz);
        const b = combDb(highSec, feedback, mix, hz);
        return { lo: Math.min(a, b), hi: Math.max(a, b) };
      },
      caption: `${delayMs.toFixed(1)} ±${depthMs.toFixed(1)} ms · 피드백 ${feedback.toFixed(2)} · 믹스 ${(mix * 100).toFixed(0)}%`,
    };
  }

  if (pluginId === 'phaser') {
    const centre = num(params, 'centreHz', 900);
    const depth = num(params, 'depth', 0.7);
    const feedback = num(params, 'feedback', 0.4);
    const mix = num(params, 'mix', 50) / 100;
    // The engine's LFO depth is `centreHz * depth`, so the stages swing that
    // far either side of the centre.
    const lo = Math.max(20, centre * (1 - depth));
    const hi = centre * (1 + depth);
    return {
      db: (hz) => phaserDb(centre, feedback, mix, hz),
      sweep: (hz) => {
        const a = phaserDb(lo, feedback, mix, hz);
        const b = phaserDb(hi, feedback, mix, hz);
        return { lo: Math.min(a, b), hi: Math.max(a, b) };
      },
      caption: `${centre.toFixed(0)} Hz ±${(depth * 100).toFixed(0)}% · 올패스 4단 · 믹스 ${(mix * 100).toFixed(0)}%`,
    };
  }

  return null;
}

// ── Delays whose repeats are not all in the same place ──────────────────────

/**
 * The repeats a delay produces, and which side of the room each lands on.
 *
 * A ping-pong's whole point is that the repeats alternate; drawn as one row of
 * bars it is indistinguishable from an ordinary delay, which is exactly the
 * information a picture is supposed to add.
 */
export interface DelayTap {
  timeSec: number;
  gain: number;
  /** -1 hard left, +1 hard right, 0 centred. */
  pan: number;
}

export interface DelayPicture {
  taps: DelayTap[];
  spanSec: number;
  caption: string;
}

export const DELAY_DEVICES: readonly string[] = ['delay', 'pingpong', 'tapedelay'];

export function delayPictureFor(
  pluginId: string, params: Record<string, number>,
): DelayPicture | null {
  const build = (timeSec: number, feedback: number, pan: (i: number) => number): DelayTap[] =>
    delayTaps(timeSec, feedback).map((tap, i) => ({ ...tap, pan: pan(i) }));

  if (pluginId === 'delay') {
    const timeSec = num(params, 'timeMs', 300) / 1000;
    const taps = build(timeSec, num(params, 'feedback', 0.35), () => 0);
    return {
      taps, spanSec: Math.max(0.5, timeSec * (taps.length + 1)),
      caption: `${taps.length}회 반복 · ${(timeSec * 1000).toFixed(0)} ms`,
    };
  }

  if (pluginId === 'pingpong') {
    const timeSec = num(params, 'timeMs', 350) / 1000;
    // The graph crosses the two lines into each other, so the first repeat is
    // left, the second right, and so on.
    const taps = build(timeSec, Math.min(0.9, num(params, 'feedback', 0.4)), (i) => (i % 2 === 0 ? -1 : 1));
    return {
      taps, spanSec: Math.max(0.5, timeSec * (taps.length + 1)),
      caption: `${taps.length}회 · ${(timeSec * 1000).toFixed(0)} ms · 좌우 번갈아`,
    };
  }

  if (pluginId === 'tapedelay') {
    const timeSec = num(params, 'timeMs', 400) / 1000;
    // The loop gain is the feedback knob TIMES the normalised saturator, which
    // the engine holds at or below unity — so the repeats die at the rate the
    // knob says, and the drive colours them without lengthening the tail.
    const feedback = Math.min(0.95, num(params, 'feedback', 0.45));
    const taps = build(timeSec, feedback, () => 0);
    return {
      taps, spanSec: Math.max(0.5, timeSec * (taps.length + 1)),
      caption: `${taps.length}회 · ${(timeSec * 1000).toFixed(0)} ms · 와우 ±${num(params, 'wowMs', 0.6).toFixed(1)} ms`,
    };
  }

  return null;
}

// ── Devices that compress a band, or several ────────────────────────────────

/**
 * One compressor's static curve, with the band it is working on.
 *
 * A multiband is three of these, and the useful thing is seeing them side by
 * side: the low band squeezing hard while the top is barely touched is the
 * whole reason to reach for one, and nine knobs in a grid do not show it.
 */
export interface BandCurve {
  label: string;
  fromHz: number;
  toHz: number;
  thresholdDb: number;
  ratio: number;
  kneeDb: number;
  makeupDb: number;
}

export interface BandPicture {
  bands: BandCurve[];
  caption: string;
}

export const BAND_DEVICES: readonly string[] = ['mbcomp', 'deesser'];

export function bandPictureFor(
  pluginId: string, params: Record<string, number>,
): BandPicture | null {
  if (pluginId === 'mbcomp') {
    const lowX = num(params, 'lowXHz', 180);
    const highX = num(params, 'highXHz', 3000);
    const makeup = num(params, 'makeupDb', 0);
    // The engine gives all three the same 6 dB knee.
    return {
      bands: [
        {
          label: 'LOW', fromHz: 20, toHz: lowX,
          thresholdDb: num(params, 'lowThrDb', -24), ratio: Math.max(1, num(params, 'lowRatio', 3)),
          kneeDb: 6, makeupDb: makeup,
        },
        {
          label: 'MID', fromHz: lowX, toHz: highX,
          thresholdDb: num(params, 'midThrDb', -24), ratio: Math.max(1, num(params, 'midRatio', 3)),
          kneeDb: 6, makeupDb: makeup,
        },
        {
          label: 'HIGH', fromHz: highX, toHz: 20_000,
          thresholdDb: num(params, 'hiThrDb', -24), ratio: Math.max(1, num(params, 'hiRatio', 3)),
          kneeDb: 6, makeupDb: makeup,
        },
      ],
      caption: `${lowX.toFixed(0)} Hz / ${(highX / 1000).toFixed(1)} kHz 크로스오버 · 메이크업 ${makeup >= 0 ? '+' : ''}${makeup.toFixed(1)} dB`,
    };
  }

  if (pluginId === 'deesser') {
    const freq = num(params, 'freqHz', 6500);
    // Below the split the signal passes untouched; only the band above it is
    // compressed, and the engine maps amount 0..1 to a ratio of 1..12.
    const ratio = 1 + num(params, 'amount', 0) * 11;
    return {
      bands: [
        {
          label: '통과', fromHz: 20, toHz: freq,
          thresholdDb: 0, ratio: 1, kneeDb: 0, makeupDb: 0,
        },
        {
          label: 'S', fromHz: freq, toHz: 20_000,
          thresholdDb: num(params, 'thresholdDb', -24), ratio, kneeDb: 0, makeupDb: 0,
        },
      ],
      caption: `${(freq / 1000).toFixed(1)} kHz 위만 ${ratio.toFixed(1)}:1 로 누릅니다`,
    };
  }

  return null;
}

// ── What each output channel is made of ─────────────────────────────────────

/**
 * The impulses that build each output channel.
 *
 * The Haas widener and the phase utility both work by routing and delaying
 * whole channels, which has no frequency response and no transfer curve — the
 * honest picture is where each output comes from, when it arrives, and with
 * which sign.  Four toggles that read "on" tell you nothing about whether the
 * left output is now the right input upside down.
 */
export interface ChannelImpulse {
  ms: number;
  /** Signed: negative is a polarity flip, which is the whole point here. */
  gain: number;
  from: 'L' | 'R';
}

export interface ChannelPicture {
  channels: Array<{ label: string; impulses: ChannelImpulse[] }>;
  spanMs: number;
  caption: string;
}

export const CHANNEL_DEVICES: readonly string[] = ['haas', 'phase'];

export function channelPictureFor(
  pluginId: string, params: Record<string, number>,
): ChannelPicture | null {
  if (pluginId === 'haas') {
    const delayMs = num(params, 'delayMs', 12);
    const amount = Math.max(0, Math.min(1, num(params, 'amount', 0.5)));
    // Left goes straight through; right is a blend of itself and a delayed
    // copy of itself.  Both arrivals are real and both are audible as one
    // image pulled sideways.
    return {
      channels: [
        { label: 'L', impulses: [{ ms: 0, gain: 1, from: 'L' }] },
        {
          label: 'R',
          impulses: [
            { ms: 0, gain: 1 - amount, from: 'R' },
            { ms: delayMs, gain: amount, from: 'R' },
          ].filter((i) => Math.abs(i.gain) > 0.001) as ChannelImpulse[],
        },
      ],
      spanMs: Math.max(4, delayMs * 1.25),
      caption: `오른쪽만 ${delayMs.toFixed(1)} ms 늦게 · ${(amount * 100).toFixed(0)}%`,
    };
  }

  if (pluginId === 'phase') {
    const on = (id: string): boolean => num(params, id, 0) >= 0.5;
    const lSign = on('invertL') ? -1 : 1;
    const rSign = on('invertR') ? -1 : 1;
    const mono = on('mono');
    const swap = on('swap');
    // The engine's own routing table.
    const [lToL, rToL, lToR, rToR] = mono
      ? [0.5, 0.5, 0.5, 0.5]
      : swap ? [0, 1, 1, 0] : [1, 0, 0, 1];
    const chan = (fromL: number, fromR: number): ChannelImpulse[] => ([
      { ms: 0, gain: fromL * lSign, from: 'L' as const },
      { ms: 0, gain: fromR * rSign, from: 'R' as const },
    ].filter((i) => Math.abs(i.gain) > 0.001));
    const words = [
      mono ? '모노' : swap ? 'L↔R 교체' : '그대로',
      on('invertL') ? 'L 반전' : '',
      on('invertR') ? 'R 반전' : '',
    ].filter(Boolean);
    return {
      channels: [
        { label: 'L', impulses: chan(lToL, rToL) },
        { label: 'R', impulses: chan(lToR, rToR) },
      ],
      spanMs: 1,
      caption: words.join(' · '),
    };
  }

  return null;
}

// ── A noise floor, and nothing else ─────────────────────────────────────────

/**
 * Where the dither noise sits, against the resolution it is dithering for.
 *
 * A bits knob and an amount knob do not say "this puts noise at -93 dBFS",
 * and that number is the only thing about a dither anyone needs to know.
 */
export interface FloorPicture {
  /** The noise the device is adding, in dBFS. */
  noiseDb: number;
  /** The quantisation step the target word length has, in dBFS. */
  lsbDb: number;
  caption: string;
}

export const FLOOR_DEVICES: readonly string[] = ['dither'];

export function floorPictureFor(
  pluginId: string, params: Record<string, number>,
): FloorPicture | null {
  if (pluginId !== 'dither') return null;
  const bits = Math.max(2, num(params, 'bits', 16));
  const amount = Math.max(0, num(params, 'amount', 1));
  // The engine's own maths: one LSB is 2^-(bits-1), scaled by the amount.
  const lsb = Math.pow(2, -(bits - 1));
  const noise = lsb * amount;
  return {
    noiseDb: noise > 0 ? 20 * Math.log10(noise) : -Infinity,
    lsbDb: 20 * Math.log10(lsb),
    caption: amount > 0
      ? `${bits.toFixed(0)} bit · 노이즈 ${(20 * Math.log10(noise)).toFixed(1)} dBFS`
      : `${bits.toFixed(0)} bit · 디더 꺼짐`,
  };
}

// ── Devices that do nothing here ────────────────────────────────────────────

/**
 * A device whose knobs nothing reads.
 *
 * `offline: true` makes the engine bypass the device in the live graph — and
 * in the render, which builds the same graph.  Nothing else looks at the
 * insert's parameters.  So the Pitch Correct insert is a no-op wherever it is
 * placed, and drawing it a retune curve would be inventing a behaviour, the
 * same mistake the exciter's `amountDb` was.
 *
 * Saying so is the picture.
 */
export interface NoticePicture {
  lines: string[];
}

export const NOTICE_DEVICES: readonly string[] = ['pitchcorrect'];

export function noticeFor(pluginId: string): NoticePicture | null {
  if (pluginId !== 'pitchcorrect') return null;
  return {
    lines: [
      '이 인서트는 소리를 바꾸지 않습니다.',
      'offline 장치라 실시간 그래프에서도, 렌더에서도',
      '바이패스되고 노브를 읽는 곳이 없습니다.',
      '피치 보정은 VOCAL 탭의 VariAudio 에서 하세요.',
    ],
  };
}
