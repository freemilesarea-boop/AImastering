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

import { biquadMagnitudeDb, type BiquadSpec } from './plugin-curves.js';
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
  return spec.postGain * (wet * spec.mix + x * (1 - spec.mix));
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
  'trim', 'saturation', 'tube', 'clipper', 'bitcrush',
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
      inputGain: 1, curves: [], wetGain: 1, mix: 1, postGain: dbToGain(db),
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
      postGain: dbToGain(num(params, 'outDb', 0)),
      // The tone control is a lowpass in the wet path; it changes the sound
      // but not this transfer curve, so it is said rather than drawn.
      caption: `바이어스 ${num(params, 'bias', 0.15).toFixed(2)} · 짝수 배음 — 톤은 곡선 밖`,
    };
  }

  if (pluginId === 'clipper') {
    const ceiling = dbToGain(num(params, 'ceilingDb', -1));
    return {
      inputGain: dbToGain(num(params, 'driveDb', 0)),
      // Shaper then guard, both of them, because the guard is what makes the
      // ceiling real after oversampling rings past it.
      curves: [clipCurve(ceiling, num(params, 'hardness', 0.5)), clipCurve(ceiling, 1)],
      wetGain: 1, mix: 1, postGain: 1,
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
