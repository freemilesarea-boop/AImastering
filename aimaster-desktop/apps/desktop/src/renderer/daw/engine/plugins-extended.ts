// The rest of the rack: everything a mix and a master actually need.
//
// The core file holds the devices the DAW grew up with.  This one holds the
// ones an engineer expects to find when they sit down — a real parametric EQ,
// a gate, a multiband, a clipper, the modulation family, mid/side tools, and
// the metering-and-dither end of a master chain.
//
// Every one is native Web Audio.  That is not a stylistic preference: the live
// channel and the offline bounce are the same graph, so anything that cannot
// be built from filters, gains, delays, shapers and the dynamics node would
// make monitoring and rendering disagree.  Where that rule bites — modulation
// with a free-running LFO — the device says so rather than pretending.

import {
  absShaper, automatableFrom, dbToGain, makeShaper, smoother, wetDry, withBypass,
  type PluginDescriptor,
} from './plugin-kit.js';

const p = (params: Record<string, number>, id: string, fallback: number): number => {
  const v = params[id];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};

// ── Building blocks ─────────────────────────────────────────────────────────

/**
 * Split into mid and side, and put them back together.
 *
 * M = (L+R)/2, S = (L-R)/2, and the inverse — the matrix every stereo tool in
 * this file is built on.  Done with a splitter, gains and a merger because
 * that is exactly what the matrix is; there is no node that does it for you.
 */
interface MidSide {
  input: GainNode;
  mid: GainNode;
  side: GainNode;
  output: GainNode;
  /** Feed the processed mid and side back in. */
  midReturn: GainNode;
  sideReturn: GainNode;
}

function midSide(ctx: BaseAudioContext): MidSide {
  const input = ctx.createGain();
  const splitter = ctx.createChannelSplitter(2);
  input.connect(splitter);

  const mid = ctx.createGain();
  const side = ctx.createGain();
  const half = ctx.createGain(); half.gain.value = 0.5;
  const halfNeg = ctx.createGain(); halfNeg.gain.value = -0.5;

  // mid = 0.5L + 0.5R
  const lToMid = ctx.createGain(); lToMid.gain.value = 0.5;
  const rToMid = ctx.createGain(); rToMid.gain.value = 0.5;
  splitter.connect(lToMid, 0); splitter.connect(rToMid, 1);
  lToMid.connect(mid); rToMid.connect(mid);

  // side = 0.5L - 0.5R
  const lToSide = ctx.createGain(); lToSide.gain.value = 0.5;
  const rToSide = ctx.createGain(); rToSide.gain.value = -0.5;
  splitter.connect(lToSide, 0); splitter.connect(rToSide, 1);
  lToSide.connect(side); rToSide.connect(side);

  // L = M + S, R = M - S
  const midReturn = ctx.createGain();
  const sideReturn = ctx.createGain();
  const merger = ctx.createChannelMerger(2);
  const mToL = ctx.createGain();
  const sToL = ctx.createGain();
  const mToR = ctx.createGain();
  const sToR = ctx.createGain(); sToR.gain.value = -1;
  midReturn.connect(mToL); sideReturn.connect(sToL);
  midReturn.connect(mToR); sideReturn.connect(sToR);
  mToL.connect(merger, 0, 0); sToL.connect(merger, 0, 0);
  mToR.connect(merger, 0, 1); sToR.connect(merger, 0, 1);

  const output = ctx.createGain();
  merger.connect(output);
  void half; void halfNeg;
  return { input, mid, side, output, midReturn, sideReturn };
}

/** A free-running LFO on an AudioParam: oscillator through a depth gain. */
interface Lfo {
  osc: OscillatorNode;
  depth: GainNode;
  setRate: (hz: number) => void;
  setDepth: (value: number) => void;
}

function lfo(ctx: BaseAudioContext, rateHz: number, depth: number, type: OscillatorType = 'sine'): Lfo {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.value = rateHz;
  const gain = ctx.createGain();
  gain.gain.value = depth;
  osc.connect(gain);
  // Started at zero so an offline render always begins at the same phase.  In
  // a live context "zero" is when the context was created, not when the song
  // started, which is why these devices are marked free-running.
  osc.start(0);
  return {
    osc,
    depth: gain,
    setRate: (hz) => { osc.frequency.value = hz; },
    setDepth: (v) => { gain.gain.value = v; },
  };
}

/** Soft clip: tanh-ish above the ceiling, straight through below it. */
function clipCurve(ceiling: number, hardness: number): Float32Array<ArrayBuffer> {
  const n = 4096;
  const curve = new Float32Array(n);
  const k = 1 + hardness * 40;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const scaled = x / Math.max(1e-4, ceiling);
    const shaped = Math.tanh(scaled * k) / Math.tanh(k);
    curve[i] = shaped * ceiling;
  }
  return curve;
}

/** Quantise to `bits`, the way a converter would. */
function bitCurve(bits: number): Float32Array<ArrayBuffer> {
  const n = 8192;
  const curve = new Float32Array(n);
  const levels = Math.max(2, Math.pow(2, Math.max(1, bits)) / 2);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.round(x * levels) / levels;
  }
  return curve;
}

/**
 * Asymmetric drive — even harmonics, the way a tube stage leans.
 *
 * A symmetric shaper only makes odd harmonics, which is why pure tanh sounds
 * like a fuzz pedal and not like a preamp.
 */
function tubeCurve(drive: number, bias: number): Float32Array<ArrayBuffer> {
  const n = 4096;
  const curve = new Float32Array(n);
  const k = 1 + drive * 24;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const b = x + bias;
    const shaped = Math.tanh(b * k) - Math.tanh(bias * k);
    curve[i] = shaped / Math.max(1e-6, Math.tanh(k));
  }
  return curve;
}

/** Deterministic noise, for dither — a seeded buffer, identical every render. */
function noiseBuffer(ctx: BaseAudioContext, seconds = 2): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // A fixed LCG: a bounce must be reproducible, and Math.random is not.
  let seed = 0x2545f491;
  const next = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let i = 0; i < length; i++) {
    // TPDF: the sum of two rectangular sources, which is what dither wants.
    data[i] = (next() + next()) - 1;
  }
  return buffer;
}

// ── The devices ─────────────────────────────────────────────────────────────

export const EXTENDED_PLUGINS: PluginDescriptor[] = [
  // ── EQ ────────────────────────────────────────────────────────────────────
  {
    id: 'eq8',
    name: 'Parametric EQ',
    category: 'eq',
    hasSidechain: false,
    params: [
      { id: 'hpfHz',  name: 'HPF',      min: 20,  max: 1000,  default: 20,   unit: 'Hz' },
      { id: 'lowDb',  name: 'Low',      min: -18, max: 18,    default: 0,    unit: 'dB' },
      { id: 'lowHz',  name: 'Low Freq', min: 40,  max: 400,   default: 120,  unit: 'Hz' },
      { id: 'b1Db',   name: 'Band 1',   min: -18, max: 18,    default: 0,    unit: 'dB' },
      { id: 'b1Hz',   name: 'B1 Freq',  min: 60,  max: 2000,  default: 300,  unit: 'Hz' },
      { id: 'b1Q',    name: 'B1 Q',     min: 0.2, max: 8,     default: 1,    unit: '' },
      { id: 'b2Db',   name: 'Band 2',   min: -18, max: 18,    default: 0,    unit: 'dB' },
      { id: 'b2Hz',   name: 'B2 Freq',  min: 200, max: 8000,  default: 1200, unit: 'Hz' },
      { id: 'b2Q',    name: 'B2 Q',     min: 0.2, max: 8,     default: 1,    unit: '' },
      { id: 'b3Db',   name: 'Band 3',   min: -18, max: 18,    default: 0,    unit: 'dB' },
      { id: 'b3Hz',   name: 'B3 Freq',  min: 800, max: 16000, default: 4000, unit: 'Hz' },
      { id: 'b3Q',    name: 'B3 Q',     min: 0.2, max: 8,     default: 1,    unit: '' },
      { id: 'highDb', name: 'High',     min: -18, max: 18,    default: 0,    unit: 'dB' },
      { id: 'highHz', name: 'High Freq', min: 2000, max: 16000, default: 8000, unit: 'Hz' },
      { id: 'lpfHz',  name: 'LPF',      min: 2000, max: 20000, default: 20000, unit: 'Hz' },
    ],
    // Every one of these is exactly one BiquadFilter AudioParam, so the whole
    // EQ automates — filter sweeps included.
    automatableParams: [
      'hpfHz', 'lowDb', 'lowHz', 'b1Db', 'b1Hz', 'b1Q', 'b2Db', 'b2Hz', 'b2Q',
      'b3Db', 'b3Hz', 'b3Q', 'highDb', 'highHz', 'lpfHz',
    ],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const hpf = ctx.createBiquadFilter(); hpf.type = 'highpass';
      hpf.frequency.value = p(params, 'hpfHz', 20);
      const low = ctx.createBiquadFilter(); low.type = 'lowshelf';
      low.frequency.value = p(params, 'lowHz', 120); low.gain.value = p(params, 'lowDb', 0);

      const bells = [1, 2, 3].map((n) => {
        const f = ctx.createBiquadFilter();
        f.type = 'peaking';
        f.frequency.value = p(params, `b${n}Hz`, [300, 1200, 4000][n - 1]!);
        f.gain.value = p(params, `b${n}Db`, 0);
        f.Q.value = p(params, `b${n}Q`, 1);
        return f;
      });

      const high = ctx.createBiquadFilter(); high.type = 'highshelf';
      high.frequency.value = p(params, 'highHz', 8000); high.gain.value = p(params, 'highDb', 0);
      const lpf = ctx.createBiquadFilter(); lpf.type = 'lowpass';
      lpf.frequency.value = p(params, 'lpfHz', 20000);

      let cursor: AudioNode = input;
      for (const node of [hpf, low, ...bells, high, lpf]) {
        cursor.connect(node);
        cursor = node;
      }
      cursor.connect(output);

      return {
        setParam: (id, v) => {
          if (id === 'hpfHz')  hpf.frequency.value = v;
          if (id === 'lpfHz')  lpf.frequency.value = v;
          if (id === 'lowDb')  low.gain.value = v;
          if (id === 'lowHz')  low.frequency.value = v;
          if (id === 'highDb') high.gain.value = v;
          if (id === 'highHz') high.frequency.value = v;
          const bell = /^b([123])(Db|Hz|Q)$/.exec(id);
          if (bell) {
            const node = bells[Number(bell[1]) - 1];
            if (!node) return;
            if (bell[2] === 'Db') node.gain.value = v;
            if (bell[2] === 'Hz') node.frequency.value = v;
            if (bell[2] === 'Q')  node.Q.value = Math.max(0.05, v);
          }
        },
        automatable: automatableFrom({
          hpfHz: hpf.frequency, lpfHz: lpf.frequency,
          lowDb: low.gain, lowHz: low.frequency,
          highDb: high.gain, highHz: high.frequency,
          b1Db: bells[0]!.gain, b1Hz: bells[0]!.frequency, b1Q: bells[0]!.Q,
          b2Db: bells[1]!.gain, b2Hz: bells[1]!.frequency, b2Q: bells[1]!.Q,
          b3Db: bells[2]!.gain, b3Hz: bells[2]!.frequency, b3Q: bells[2]!.Q,
        }),
      };
    }),
  },

  {
    id: 'tilt',
    name: 'Tilt EQ',
    category: 'eq',
    hasSidechain: false,
    params: [
      { id: 'tiltDb',  name: 'Tilt',  min: -12, max: 12,    default: 0,    unit: 'dB' },
      { id: 'pivotHz', name: 'Pivot', min: 200, max: 5000,  default: 1000, unit: 'Hz' },
    ],
    // One knob, two shelves: the tilt writes equal and opposite gains, and the
    // pivot retunes both. Half a tilt is a shelf, not a tilt.
    automatableParams: [],
    latencyFor: () => 0,
    // One knob that darkens or brightens a whole mix without asking which
    // band — the fastest useful move there is on a master.
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const lowShelf = ctx.createBiquadFilter(); lowShelf.type = 'lowshelf';
      const highShelf = ctx.createBiquadFilter(); highShelf.type = 'highshelf';
      const apply = (tilt: number, pivot: number): void => {
        lowShelf.frequency.value = pivot;
        highShelf.frequency.value = pivot;
        lowShelf.gain.value = -tilt;    // tilt up = bright: cut low, boost high
        highShelf.gain.value = tilt;
      };
      apply(p(params, 'tiltDb', 0), p(params, 'pivotHz', 1000));
      input.connect(lowShelf).connect(highShelf).connect(output);
      return {
        setParam: (id, v) => {
          if (id === 'tiltDb')  params['tiltDb'] = v;
          if (id === 'pivotHz') params['pivotHz'] = v;
          apply(p(params, 'tiltDb', 0), p(params, 'pivotHz', 1000));
        },
      };
    }),
  },

  {
    id: 'mseq',
    name: 'Mid/Side EQ',
    category: 'eq',
    hasSidechain: false,
    params: [
      { id: 'midLowDb',  name: 'M Low',  min: -12, max: 12, default: 0, unit: 'dB' },
      { id: 'midHighDb', name: 'M High', min: -12, max: 12, default: 0, unit: 'dB' },
      { id: 'sideLowDb', name: 'S Low',  min: -12, max: 12, default: 0, unit: 'dB' },
      { id: 'sideHighDb', name: 'S High', min: -12, max: 12, default: 0, unit: 'dB' },
    ],
    automatableParams: ['midLowDb', 'midHighDb', 'sideLowDb', 'sideHighDb'],
    latencyFor: () => 0,
    // Brighten the sides without brightening the vocal; tighten the centre
    // without narrowing the record.  The one EQ a master often needs.
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const ms = midSide(ctx);
      input.connect(ms.input);

      const shelf = (type: 'lowshelf' | 'highshelf', db: number): BiquadFilterNode => {
        const f = ctx.createBiquadFilter();
        f.type = type;
        f.frequency.value = type === 'lowshelf' ? 200 : 6000;
        f.gain.value = db;
        return f;
      };
      const midLow = shelf('lowshelf', p(params, 'midLowDb', 0));
      const midHigh = shelf('highshelf', p(params, 'midHighDb', 0));
      const sideLow = shelf('lowshelf', p(params, 'sideLowDb', 0));
      const sideHigh = shelf('highshelf', p(params, 'sideHighDb', 0));

      ms.mid.connect(midLow).connect(midHigh).connect(ms.midReturn);
      ms.side.connect(sideLow).connect(sideHigh).connect(ms.sideReturn);
      ms.output.connect(output);

      return {
        setParam: (id, v) => {
          if (id === 'midLowDb')   midLow.gain.value = v;
          if (id === 'midHighDb')  midHigh.gain.value = v;
          if (id === 'sideLowDb')  sideLow.gain.value = v;
          if (id === 'sideHighDb') sideHigh.gain.value = v;
        },
        automatable: automatableFrom({
          midLowDb: midLow.gain,
          midHighDb: midHigh.gain,
          sideLowDb: sideLow.gain,
          sideHighDb: sideHigh.gain,
        }),
      };
    }),
  },

  // ── Dynamics ──────────────────────────────────────────────────────────────
  {
    id: 'gate',
    name: 'Noise Gate',
    category: 'dynamics',
    hasSidechain: false,
    params: [
      { id: 'thresholdDb', name: 'Threshold', min: -80, max: 0,    default: -45, unit: 'dB' },
      { id: 'rangeDb',     name: 'Range',     min: 0,   max: 60,   default: 40,  unit: 'dB' },
      { id: 'attackMs',    name: 'Attack',    min: 1,   max: 100,  default: 5,   unit: 'ms' },
      { id: 'releaseMs',   name: 'Release',   min: 20,  max: 2000, default: 200, unit: 'ms' },
    ],
    // Threshold and range rebuild the gate's transfer curve; attack and release
    // are the detector's two biquads.
    automatableParams: [],
    latencyFor: () => 0,
    // Between the toms, under the amp, behind the room mic.  A gate is the
    // most-used dynamics device in a real multitrack and the DAW had none.
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const vca = ctx.createGain();
      vca.gain.value = 0;
      const rect = absShaper(ctx);
      const env = smoother(ctx, p(params, 'attackMs', 5));

      const buildCurve = (thresholdDb: number, rangeDb: number): Float32Array<ArrayBuffer> => {
        const n = 2048;
        const curve = new Float32Array(n);
        const thr = dbToGain(thresholdDb);
        const floor = dbToGain(-Math.max(0, rangeDb));
        for (let i = 0; i < n; i++) {
          const level = Math.abs((i / (n - 1)) * 2 - 1);
          // Open above the threshold, closed below, with a short ramp across
          // it so a signal sitting on the threshold does not chatter.
          const ratio = thr > 0 ? level / thr : 1;
          const openness = Math.max(0, Math.min(1, (ratio - 0.5) / 0.5));
          curve[i] = floor + (1 - floor) * openness;
        }
        return curve;
      };

      let curve = makeShaper(ctx, buildCurve(
        p(params, 'thresholdDb', -45), p(params, 'rangeDb', 40),
      ));
      input.connect(rect).connect(env.input);
      env.output.connect(curve);
      curve.connect(vca.gain);
      input.connect(vca).connect(output);

      return {
        setParam: (id, v) => {
          params[id] = v;
          if (id === 'attackMs' || id === 'releaseMs') env.setTimeMs(v);
          if (id === 'thresholdDb' || id === 'rangeDb') {
            const next = makeShaper(ctx, buildCurve(
              p(params, 'thresholdDb', -45), p(params, 'rangeDb', 40),
            ));
            env.output.disconnect();
            curve.disconnect();
            curve = next;
            env.output.connect(curve);
            curve.connect(vca.gain);
          }
        },
        dispose: () => { curve.disconnect(); },
      };
    }),
  },

  {
    id: 'mbcomp',
    name: 'Multiband Compressor',
    category: 'dynamics',
    hasSidechain: false,
    params: [
      { id: 'lowXHz',   name: 'Low X',   min: 60,  max: 500,  default: 180,  unit: 'Hz' },
      { id: 'highXHz',  name: 'High X',  min: 1500, max: 8000, default: 3000, unit: 'Hz' },
      { id: 'lowThrDb', name: 'Low Thr', min: -48, max: 0,    default: -20, unit: 'dB' },
      { id: 'lowRatio', name: 'Low R',   min: 1,   max: 12,   default: 3,   unit: ':1' },
      { id: 'midThrDb', name: 'Mid Thr', min: -48, max: 0,    default: -20, unit: 'dB' },
      { id: 'midRatio', name: 'Mid R',   min: 1,   max: 12,   default: 3,   unit: ':1' },
      { id: 'hiThrDb',  name: 'High Thr', min: -48, max: 0,   default: -20, unit: 'dB' },
      { id: 'hiRatio',  name: 'High R',  min: 1,   max: 12,   default: 3,   unit: ':1' },
      { id: 'makeupDb', name: 'Makeup',  min: -12, max: 12,   default: 0,   unit: 'dB' },
    ],
    automatableParams: ['lowThrDb', 'lowRatio', 'midThrDb', 'midRatio', 'hiThrDb', 'hiRatio', 'makeupDb'],
    latencyFor: () => 0,
    // Control the bass without dulling the cymbals.  A single band across a
    // whole mix cannot do that, which is why every master chain has one.
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const lowX = p(params, 'lowXHz', 180);
      const highX = p(params, 'highXHz', 3000);

      const band = (
        filters: BiquadFilterNode[], thresholdDb: number, ratio: number,
      ): { entry: AudioNode; comp: DynamicsCompressorNode } => {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = thresholdDb;
        comp.ratio.value = Math.max(1, ratio);
        comp.knee.value = 6;
        comp.attack.value = 0.01;
        comp.release.value = 0.15;
        let cursor: AudioNode = filters[0]!;
        for (let i = 1; i < filters.length; i++) { cursor.connect(filters[i]!); cursor = filters[i]!; }
        cursor.connect(comp);
        return { entry: filters[0]!, comp };
      };

      const lp = (hz: number): BiquadFilterNode => {
        const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = hz; return f;
      };
      const hp = (hz: number): BiquadFilterNode => {
        const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hz; return f;
      };

      // Two poles per crossover edge so the bands do not bleed into each
      // other; a single pole leaves a band audibly present an octave away.
      const lowFilters = [lp(lowX), lp(lowX)];
      const midFilters = [hp(lowX), hp(lowX), lp(highX), lp(highX)];
      const highFilters = [hp(highX), hp(highX)];

      const low = band(lowFilters, p(params, 'lowThrDb', -20), p(params, 'lowRatio', 3));
      const mid = band(midFilters, p(params, 'midThrDb', -20), p(params, 'midRatio', 3));
      const high = band(highFilters, p(params, 'hiThrDb', -20), p(params, 'hiRatio', 3));

      const makeup = ctx.createGain();
      makeup.gain.value = dbToGain(p(params, 'makeupDb', 0));
      for (const b of [low, mid, high]) {
        input.connect(b.entry);
        b.comp.connect(makeup);
      }
      makeup.connect(output);

      const setCrossover = (): void => {
        const lx = p(params, 'lowXHz', 180);
        const hx = Math.max(lx * 2, p(params, 'highXHz', 3000));
        for (const f of lowFilters) f.frequency.value = lx;
        midFilters[0]!.frequency.value = lx; midFilters[1]!.frequency.value = lx;
        midFilters[2]!.frequency.value = hx; midFilters[3]!.frequency.value = hx;
        for (const f of highFilters) f.frequency.value = hx;
      };

      return {
        setParam: (id, v) => {
          params[id] = v;
          if (id === 'lowXHz' || id === 'highXHz') setCrossover();
          if (id === 'lowThrDb') low.comp.threshold.value = v;
          if (id === 'lowRatio') low.comp.ratio.value = Math.max(1, v);
          if (id === 'midThrDb') mid.comp.threshold.value = v;
          if (id === 'midRatio') mid.comp.ratio.value = Math.max(1, v);
          if (id === 'hiThrDb')  high.comp.threshold.value = v;
          if (id === 'hiRatio')  high.comp.ratio.value = Math.max(1, v);
          if (id === 'makeupDb') makeup.gain.value = dbToGain(v);
        },
        // The crossover frequencies are not offered: each one retunes a
        // matched pair of filters, and moving half of a Linkwitz-Riley pair
        // is a hole in the response, not a sweep.
        automatable: automatableFrom({
          lowThrDb: low.comp.threshold,
          lowRatio: { param: low.comp.ratio, map: (v) => Math.max(1, v) },
          midThrDb: mid.comp.threshold,
          midRatio: { param: mid.comp.ratio, map: (v) => Math.max(1, v) },
          hiThrDb: high.comp.threshold,
          hiRatio: { param: high.comp.ratio, map: (v) => Math.max(1, v) },
          makeupDb: { param: makeup.gain, map: dbToGain },
        }),
        reduction: () => Math.min(low.comp.reduction, mid.comp.reduction, high.comp.reduction),
      };
    }),
  },

  {
    id: 'clipper',
    name: 'Soft Clipper',
    category: 'dynamics',
    hasSidechain: false,
    params: [
      { id: 'driveDb',   name: 'Drive',    min: 0,   max: 24, default: 0,  unit: 'dB' },
      { id: 'ceilingDb', name: 'Ceiling',  min: -12, max: 0,  default: -1, unit: 'dB' },
      { id: 'hardness',  name: 'Hardness', min: 0,   max: 1,  default: 0.5, unit: '' },
    ],
    automatableParams: ['driveDb'],
    latencyFor: () => 0,
    // Shaves the two dB of drum transient that would otherwise cost the whole
    // master three dB of limiting.  Instant, no detector, no pumping.
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const drive = ctx.createGain();
      drive.gain.value = dbToGain(p(params, 'driveDb', 0));
      let shaper = makeShaper(
        ctx, clipCurve(dbToGain(p(params, 'ceilingDb', -1)), p(params, 'hardness', 0.5)),
      );
      // Oversampled: clipping generates harmonics above Nyquist, and without
      // this they fold back down as aliasing that sounds like grit low in the
      // spectrum where no grit belongs.
      shaper.oversample = '4x';

      // Oversampling costs something: the resampling filter rings, so the
      // output overshoots the curve by a dB or so.  A clipper whose ceiling is
      // a suggestion is not a clipper, so a hard, un-oversampled stage after
      // it makes the ceiling true.
      let guard = makeShaper(ctx, clipCurve(dbToGain(p(params, 'ceilingDb', -1)), 1));
      drive.connect(shaper);
      shaper.connect(guard);
      guard.connect(output);
      input.connect(drive);

      return {
        setParam: (id, v) => {
          params[id] = v;
          if (id === 'driveDb') { drive.gain.value = dbToGain(v); return; }
          // ceilingDb and hardness fall through to the curve rebuild below.
          const ceiling = dbToGain(p(params, 'ceilingDb', -1));
          const next = makeShaper(ctx, clipCurve(ceiling, p(params, 'hardness', 0.5)));
          next.oversample = '4x';
          const nextGuard = makeShaper(ctx, clipCurve(ceiling, 1));
          drive.disconnect();
          shaper.disconnect();
          guard.disconnect();
          shaper = next;
          guard = nextGuard;
          drive.connect(shaper);
          shaper.connect(guard);
          guard.connect(output);
        },
        automatable: automatableFrom({ driveDb: { param: drive.gain, map: dbToGain } }),
        dispose: () => { shaper.disconnect(); guard.disconnect(); },
      };
    }),
  },

  // ── Saturation and character ──────────────────────────────────────────────
  {
    id: 'tube',
    name: 'Tube Drive',
    category: 'saturation',
    hasSidechain: false,
    params: [
      { id: 'drive',   name: 'Drive',  min: 0,   max: 1,  default: 0.3, unit: '' },
      { id: 'bias',    name: 'Bias',   min: 0,   max: 0.5, default: 0.15, unit: '' },
      { id: 'toneHz',  name: 'Tone',   min: 1000, max: 16000, default: 8000, unit: 'Hz' },
      { id: 'mix',     name: 'Mix',    min: 0,   max: 100, default: 100, unit: '%' },
      { id: 'outDb',   name: 'Output', min: -24, max: 12, default: 0,  unit: 'dB' },
    ],
    automatableParams: ['toneHz', 'mix', 'outDb'],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      // Asymmetric on purpose: a symmetric curve makes only odd harmonics and
      // sounds like a fuzz pedal.  The bias is what makes it a preamp.
      let shaper = makeShaper(ctx, tubeCurve(p(params, 'drive', 0.3), p(params, 'bias', 0.15)));
      shaper.oversample = '4x';
      const tone = ctx.createBiquadFilter(); tone.type = 'lowpass';
      tone.frequency.value = p(params, 'toneHz', 8000);
      const blend = wetDry(ctx, 0);
      const wet = blend.wet;
      const dry = blend.dry;
      const out = ctx.createGain();
      out.gain.value = dbToGain(p(params, 'outDb', 0));

      const setMix = (percent: number): void => blend.setMix(percent / 100);
      setMix(p(params, 'mix', 100));

      input.connect(shaper);
      shaper.connect(tone).connect(wet).connect(out);
      input.connect(dry).connect(out);
      out.connect(output);

      return {
        setParam: (id, v) => {
          params[id] = v;
          if (id === 'toneHz') tone.frequency.value = v;
          if (id === 'mix')    setMix(v);
          if (id === 'outDb')  out.gain.value = dbToGain(v);
          if (id === 'drive' || id === 'bias') {
            const next = makeShaper(ctx, tubeCurve(p(params, 'drive', 0.3), p(params, 'bias', 0.15)));
            next.oversample = '4x';
            input.disconnect(shaper);
            shaper.disconnect();
            shaper = next;
            input.connect(shaper);
            shaper.connect(tone);
          }
        },
        // `drive` and `bias` rebuild the tube curve together, so neither is
        // a parameter a lane can ride.
        automatable: automatableFrom({
          toneHz: tone.frequency,
          mix: { param: blend.mix, map: (v) => Math.max(0, Math.min(1, v / 100)) },
          outDb: { param: out.gain, map: dbToGain },
        }),
        dispose: () => { blend.dispose(); shaper.disconnect(); },
      };
    }),
  },

  {
    id: 'bitcrush',
    name: 'Bit Crusher',
    category: 'saturation',
    hasSidechain: false,
    params: [
      { id: 'bits', name: 'Bits', min: 2,  max: 16,  default: 8,  unit: '' },
      { id: 'mix',  name: 'Mix',  min: 0,  max: 100, default: 100, unit: '%' },
    ],
    automatableParams: ['mix'],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      let shaper = makeShaper(ctx, bitCurve(p(params, 'bits', 8)));
      const blend = wetDry(ctx, 0);
      const wet = blend.wet;
      const dry = blend.dry;
      const setMix = (percent: number): void => blend.setMix(percent / 100);
      setMix(p(params, 'mix', 100));
      input.connect(shaper).connect(wet).connect(output);
      input.connect(dry).connect(output);
      return {
        setParam: (id, v) => {
          if (id === 'mix') { setMix(v); return; }
          if (id !== 'bits') return;
          const next = makeShaper(ctx, bitCurve(v));
          input.disconnect(shaper);
          shaper.disconnect();
          shaper = next;
          input.connect(shaper).connect(wet);
        },
        // `bits` rebuilds the quantising curve — there is no parameter to ramp.
        automatable: automatableFrom({
          mix: { param: blend.mix, map: (v) => Math.max(0, Math.min(1, v / 100)) },
        }),
        dispose: () => { blend.dispose(); shaper.disconnect(); },
      };
    }),
  },

  // ── Modulation ────────────────────────────────────────────────────────────
  // Every device below runs a free-running LFO.  Its phase is tied to when the
  // audio context was created, not to the song position, so a bounce will not
  // land on the same phase as what you were monitoring.  That is true of
  // unsynced modulation in every DAW; it is flagged here rather than quietly
  // being a difference between what you approved and what you exported.
  {
    id: 'chorus',
    name: 'Chorus',
    category: 'modulation',
    hasSidechain: false,
    freeRunning: true,
    params: [
      { id: 'rateHz',  name: 'Rate',  min: 0.05, max: 8,   default: 0.6, unit: 'Hz' },
      { id: 'depthMs', name: 'Depth', min: 0.5,  max: 12,  default: 4,   unit: 'ms' },
      { id: 'delayMs', name: 'Delay', min: 5,    max: 40,  default: 18,  unit: 'ms' },
      { id: 'mix',     name: 'Mix',   min: 0,    max: 100, default: 40,  unit: '%' },
    ],
    automatableParams: ['mix'],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      // Two voices in opposite phase: one alone is a vibrato, two are a
      // chorus, and putting them on opposite sides is what makes it wide.
      // `drySlope: 0.5` keeps this device's own blend law: a fully wet
      // chorus still carries half the original, or the body drops out.
      const blend = wetDry(ctx, 0, { drySlope: 0.5 });
      const wet = blend.wet;
      const dry = blend.dry;
      const voices = [0, 1].map((i) => {
        const delay = ctx.createDelay(0.2);
        delay.delayTime.value = p(params, 'delayMs', 18) / 1000;
        const mod = lfo(ctx, p(params, 'rateHz', 0.6), p(params, 'depthMs', 4) / 1000);
        if (i === 1) mod.osc.type = 'triangle';
        mod.depth.connect(delay.delayTime);
        const pan = ctx.createStereoPanner();
        pan.pan.value = i === 0 ? -0.7 : 0.7;
        input.connect(delay).connect(pan).connect(wet);
        return { delay, mod };
      });

      const setMix = (percent: number): void => blend.setMix(percent / 100);
      setMix(p(params, 'mix', 40));
      wet.connect(output);
      input.connect(dry).connect(output);

      return {
        setParam: (id, v) => {
          if (id === 'mix') setMix(v);
          for (const [i, voice] of voices.entries()) {
            if (id === 'rateHz')  voice.mod.setRate(v * (i === 1 ? 1.17 : 1));
            if (id === 'depthMs') voice.mod.setDepth(v / 1000);
            if (id === 'delayMs') voice.delay.delayTime.value = v / 1000;
          }
        },
        // Rate, depth and delay each move BOTH voices — and the second voice
        // runs at 1.17× the rate, so there is no single parameter behind any
        // of them.  That detune is what makes it a chorus rather than two
        // flangers, so it is not worth collapsing to win a lane.
        automatable: automatableFrom({
          mix: { param: blend.mix, map: (v) => Math.max(0, Math.min(1, v / 100)) },
        }),
        dispose: () => { blend.dispose(); for (const v of voices) v.mod.osc.stop(); },
      };
    }),
  },

  {
    id: 'flanger',
    name: 'Flanger',
    category: 'modulation',
    hasSidechain: false,
    freeRunning: true,
    params: [
      { id: 'rateHz',   name: 'Rate',     min: 0.05, max: 5,   default: 0.3, unit: 'Hz' },
      { id: 'depthMs',  name: 'Depth',    min: 0.1,  max: 5,   default: 2,   unit: 'ms' },
      { id: 'delayMs',  name: 'Delay',    min: 0.5,  max: 10,  default: 3,   unit: 'ms' },
      { id: 'feedback', name: 'Feedback', min: 0,    max: 0.95, default: 0.5, unit: '' },
      { id: 'mix',      name: 'Mix',      min: 0,    max: 100, default: 50,  unit: '%' },
    ],
    automatableParams: ['rateHz', 'depthMs', 'delayMs', 'feedback', 'mix'],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const delay = ctx.createDelay(0.05);
      delay.delayTime.value = p(params, 'delayMs', 3) / 1000;
      const mod = lfo(ctx, p(params, 'rateHz', 0.3), p(params, 'depthMs', 2) / 1000);
      mod.depth.connect(delay.delayTime);

      // Feedback is what turns a comb filter into a jet; it is clamped below
      // unity because at 1.0 it is not an effect, it is an oscillator.
      const feedback = ctx.createGain();
      feedback.gain.value = Math.min(0.95, p(params, 'feedback', 0.5));
      const blend = wetDry(ctx, 0);
      const wet = blend.wet;
      const dry = blend.dry;
      const setMix = (percent: number): void => blend.setMix(percent / 100);
      setMix(p(params, 'mix', 50));

      input.connect(delay);
      delay.connect(feedback).connect(delay);
      delay.connect(wet).connect(output);
      input.connect(dry).connect(output);

      return {
        setParam: (id, v) => {
          if (id === 'rateHz')   mod.setRate(v);
          if (id === 'depthMs')  mod.setDepth(v / 1000);
          if (id === 'delayMs')  delay.delayTime.value = v / 1000;
          if (id === 'feedback') feedback.gain.value = Math.min(0.95, v);
          if (id === 'mix')      setMix(v);
        },
        automatable: automatableFrom({
          rateHz: mod.osc.frequency,
          depthMs: { param: mod.depth.gain, map: (v) => v / 1000 },
          delayMs: { param: delay.delayTime, map: (v) => v / 1000 },
          feedback: { param: feedback.gain, map: (v) => Math.min(0.95, v) },
          mix: { param: blend.mix, map: (v) => Math.max(0, Math.min(1, v / 100)) },
        }),
        dispose: () => { blend.dispose(); mod.osc.stop(); },
      };
    }),
  },

  {
    id: 'phaser',
    name: 'Phaser',
    category: 'modulation',
    hasSidechain: false,
    freeRunning: true,
    params: [
      { id: 'rateHz',   name: 'Rate',     min: 0.05, max: 8,    default: 0.4, unit: 'Hz' },
      { id: 'depth',    name: 'Depth',    min: 0,    max: 1,    default: 0.7, unit: '' },
      { id: 'centreHz', name: 'Centre',   min: 200,  max: 4000, default: 900, unit: 'Hz' },
      { id: 'feedback', name: 'Feedback', min: 0,    max: 0.9,  default: 0.4, unit: '' },
      { id: 'mix',      name: 'Mix',      min: 0,    max: 100,  default: 50,  unit: '%' },
    ],
    automatableParams: ['rateHz', 'feedback', 'mix'],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      // Four allpass stages: they leave the magnitude alone and rotate phase,
      // so the notches appear only where the wet meets the dry.  That is what
      // separates a phaser from a flanger.
      const stages = [0, 1, 2, 3].map(() => {
        const f = ctx.createBiquadFilter();
        f.type = 'allpass';
        f.frequency.value = p(params, 'centreHz', 900);
        f.Q.value = 0.7;
        return f;
      });
      const mod = lfo(ctx, p(params, 'rateHz', 0.4), p(params, 'centreHz', 900) * p(params, 'depth', 0.7));
      for (const stage of stages) mod.depth.connect(stage.frequency);

      const feedback = ctx.createGain();
      feedback.gain.value = Math.min(0.9, p(params, 'feedback', 0.4));
      const blend = wetDry(ctx, 0);
      const wet = blend.wet;
      const dry = blend.dry;
      const setMix = (percent: number): void => blend.setMix(percent / 100);
      setMix(p(params, 'mix', 50));

      let cursor: AudioNode = input;
      for (const stage of stages) { cursor.connect(stage); cursor = stage; }

      // One sample of delay inside the feedback loop.
      //
      // Web Audio mutes any cycle that does not contain a DelayNode, and
      // without this the ENTIRE allpass chain renders silence — the device
      // was audible only as the dry path being turned down.  A single sample
      // is the shortest legal loop and is inaudible as a delay; what it does
      // is make the resonance exist at all.
      const loopDelay = ctx.createDelay(0.05);
      loopDelay.delayTime.value = 1 / ctx.sampleRate;
      cursor.connect(loopDelay).connect(feedback).connect(stages[0]!);

      cursor.connect(wet).connect(output);
      input.connect(dry).connect(output);

      return {
        setParam: (id, v) => {
          params[id] = v;
          if (id === 'rateHz')   mod.setRate(v);
          if (id === 'feedback') feedback.gain.value = Math.min(0.9, v);
          if (id === 'mix')      setMix(v);
          if (id === 'centreHz' || id === 'depth') {
            const centre = p(params, 'centreHz', 900);
            for (const stage of stages) stage.frequency.value = centre;
            mod.setDepth(centre * p(params, 'depth', 0.7));
          }
        },
        // `centreHz` retunes every all-pass stage and `depth` is scaled BY it,
        // so the two are one control in two knobs — neither is offered.
        automatable: automatableFrom({
          rateHz: mod.osc.frequency,
          feedback: { param: feedback.gain, map: (v) => Math.min(0.9, v) },
          mix: { param: blend.mix, map: (v) => Math.max(0, Math.min(1, v / 100)) },
        }),
        dispose: () => { blend.dispose(); mod.osc.stop(); },
      };
    }),
  },

  {
    id: 'tremolo',
    name: 'Tremolo',
    category: 'modulation',
    hasSidechain: false,
    freeRunning: true,
    params: [
      { id: 'rateHz', name: 'Rate',  min: 0.1, max: 20,  default: 5,  unit: 'Hz' },
      { id: 'depth',  name: 'Depth', min: 0,   max: 1,   default: 0.5, unit: '' },
      { id: 'shape',  name: 'Shape', min: 0,   max: 1,   default: 0,  unit: '' },
    ],
    automatableParams: ['rateHz'],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const vca = ctx.createGain();
      const depth = p(params, 'depth', 0.5);
      // Centre the modulation so full depth reaches silence and no depth is
      // unity — a tremolo that changes the average level is a volume knob.
      vca.gain.value = 1 - depth / 2;
      const mod = lfo(ctx, p(params, 'rateHz', 5), depth / 2);
      mod.depth.connect(vca.gain);
      input.connect(vca).connect(output);
      return {
        setParam: (id, v) => {
          if (id === 'rateHz') mod.setRate(v);
          if (id === 'depth')  { vca.gain.value = 1 - v / 2; mod.setDepth(v / 2); }
          if (id === 'shape')  mod.osc.type = v >= 0.5 ? 'square' : 'sine';
        },
        // `depth` sets the LFO's swing AND re-centres the VCA around it, so
        // the two have to move together; `shape` swaps a waveform, which is
        // not a ramp at all.
        automatable: automatableFrom({ rateHz: mod.osc.frequency }),
        dispose: () => { mod.osc.stop(); },
      };
    }),
  },

  {
    id: 'autopan',
    name: 'Auto Pan',
    category: 'modulation',
    hasSidechain: false,
    freeRunning: true,
    params: [
      { id: 'rateHz', name: 'Rate',  min: 0.05, max: 10, default: 0.5, unit: 'Hz' },
      { id: 'depth',  name: 'Depth', min: 0,    max: 1,  default: 0.7, unit: '' },
    ],
    automatableParams: ['rateHz', 'depth'],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const panner = ctx.createStereoPanner();
      panner.pan.value = 0;
      const mod = lfo(ctx, p(params, 'rateHz', 0.5), p(params, 'depth', 0.7));
      mod.depth.connect(panner.pan);
      input.connect(panner).connect(output);
      return {
        setParam: (id, v) => {
          if (id === 'rateHz') mod.setRate(v);
          if (id === 'depth')  mod.setDepth(v);
        },
        automatable: automatableFrom({
          rateHz: mod.osc.frequency,
          depth: mod.depth.gain,
        }),
        dispose: () => { mod.osc.stop(); },
      };
    }),
  },

  // ── Delay ─────────────────────────────────────────────────────────────────
  {
    id: 'pingpong',
    name: 'Ping-Pong Delay',
    category: 'delay',
    hasSidechain: false,
    params: [
      { id: 'timeMs',   name: 'Time',     min: 20,  max: 1500, default: 350, unit: 'ms' },
      { id: 'feedback', name: 'Feedback', min: 0,   max: 0.9,  default: 0.4, unit: '' },
      { id: 'toneHz',   name: 'Tone',     min: 800, max: 16000, default: 6000, unit: 'Hz' },
      { id: 'mix',      name: 'Mix',      min: 0,   max: 100,  default: 28,  unit: '%' },
    ],
    automatableParams: ['mix'],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      // Two delays that feed each OTHER, each panned hard: that cross-feed is
      // the whole trick, and it is why the repeats alternate sides.
      const left = ctx.createDelay(2);
      const right = ctx.createDelay(2);
      const time = p(params, 'timeMs', 350) / 1000;
      left.delayTime.value = time;
      right.delayTime.value = time;

      const fbL = ctx.createGain();
      const fbR = ctx.createGain();
      const fb = Math.min(0.9, p(params, 'feedback', 0.4));
      fbL.gain.value = fb;
      fbR.gain.value = fb;

      // Repeats get darker as they go, the way a real space does.
      const toneL = ctx.createBiquadFilter(); toneL.type = 'lowpass';
      const toneR = ctx.createBiquadFilter(); toneR.type = 'lowpass';
      toneL.frequency.value = p(params, 'toneHz', 6000);
      toneR.frequency.value = p(params, 'toneHz', 6000);

      const panL = ctx.createStereoPanner(); panL.pan.value = -1;
      const panR = ctx.createStereoPanner(); panR.pan.value = 1;

      input.connect(left);
      left.connect(toneL).connect(fbL).connect(right);
      right.connect(toneR).connect(fbR).connect(left);

      const wet = ctx.createGain();
      const dry = ctx.createGain();
      left.connect(panL).connect(wet);
      right.connect(panR).connect(wet);
      const setMix = (percent: number): void => {
        wet.gain.value = Math.max(0, Math.min(1, percent / 100));
        dry.gain.value = 1;                       // a send-style effect: dry stays put
      };
      setMix(p(params, 'mix', 28));
      wet.connect(output);
      input.connect(dry).connect(output);

      return {
        setParam: (id, v) => {
          if (id === 'timeMs')   { left.delayTime.value = v / 1000; right.delayTime.value = v / 1000; }
          if (id === 'feedback') { const g = Math.min(0.9, v); fbL.gain.value = g; fbR.gain.value = g; }
          if (id === 'toneHz')   { toneL.frequency.value = v; toneR.frequency.value = v; }
          if (id === 'mix')      setMix(v);
        },
        // Time, feedback and tone each set a matched left/right pair — one
        // knob, two AudioParams, and ramping half a ping-pong is a stereo
        // image tearing itself apart.  The mix is a send-style wet gain, so
        // it is a single parameter as it stands.
        automatable: automatableFrom({
          mix: { param: wet.gain, map: (v) => Math.max(0, Math.min(1, v / 100)) },
        }),
      };
    }),
  },

  {
    id: 'tapedelay',
    name: 'Tape Delay',
    category: 'delay',
    hasSidechain: false,
    freeRunning: true,
    params: [
      { id: 'timeMs',   name: 'Time',     min: 40,  max: 1500, default: 400, unit: 'ms' },
      { id: 'feedback', name: 'Feedback', min: 0,   max: 0.95, default: 0.45, unit: '' },
      { id: 'toneHz',   name: 'Tone',     min: 600, max: 12000, default: 3500, unit: 'Hz' },
      { id: 'wowMs',    name: 'Wow',      min: 0,   max: 3,    default: 0.6, unit: 'ms' },
      { id: 'drive',    name: 'Drive',    min: 0,   max: 1,    default: 0.25, unit: '' },
      { id: 'mix',      name: 'Mix',      min: 0,   max: 100,  default: 25,  unit: '%' },
    ],
    automatableParams: ['timeMs', 'feedback', 'toneHz', 'wowMs', 'mix'],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      // What makes a tape delay a tape delay is what happens INSIDE the
      // feedback loop: each pass gets darker, softer and slightly detuned.
      // A clean delay with a filter after it does not do that.
      const delay = ctx.createDelay(2);
      delay.delayTime.value = p(params, 'timeMs', 400) / 1000;
      const wow = lfo(ctx, 0.7, p(params, 'wowMs', 0.6) / 1000);
      wow.depth.connect(delay.delayTime);

      const tone = ctx.createBiquadFilter(); tone.type = 'lowpass';
      tone.frequency.value = p(params, 'toneHz', 3500);
      const lowCut = ctx.createBiquadFilter(); lowCut.type = 'highpass';
      lowCut.frequency.value = 120;                 // tape has no deep bottom
      let sat = makeShaper(ctx, tubeCurve(p(params, 'drive', 0.25), 0.05));
      const fb = ctx.createGain();
      fb.gain.value = Math.min(0.95, p(params, 'feedback', 0.45));

      const wet = ctx.createGain();
      const setMix = (percent: number): void => {
        wet.gain.value = Math.max(0, Math.min(1, percent / 100));
      };
      setMix(p(params, 'mix', 25));

      input.connect(delay);
      delay.connect(tone).connect(lowCut).connect(sat);
      sat.connect(fb).connect(delay);
      sat.connect(wet).connect(output);
      input.connect(output);

      return {
        setParam: (id, v) => {
          params[id] = v;
          if (id === 'timeMs')   delay.delayTime.value = v / 1000;
          if (id === 'feedback') fb.gain.value = Math.min(0.95, v);
          if (id === 'toneHz')   tone.frequency.value = v;
          if (id === 'wowMs')    wow.setDepth(v / 1000);
          if (id === 'mix')      setMix(v);
          if (id === 'drive') {
            const next = makeShaper(ctx, tubeCurve(v, 0.05));
            lowCut.disconnect();
            sat.disconnect();
            sat = next;
            lowCut.connect(sat);
            sat.connect(fb);
            sat.connect(wet);
          }
        },
        // `drive` rebuilds the saturation curve inside the feedback loop.
        automatable: automatableFrom({
          timeMs: { param: delay.delayTime, map: (v) => v / 1000 },
          feedback: { param: fb.gain, map: (v) => Math.min(0.95, v) },
          toneHz: tone.frequency,
          wowMs: { param: wow.depth.gain, map: (v) => v / 1000 },
          mix: { param: wet.gain, map: (v) => Math.max(0, Math.min(1, v / 100)) },
        }),
        dispose: () => { wow.osc.stop(); sat.disconnect(); },
      };
    }),
  },

  // ── Imaging ───────────────────────────────────────────────────────────────
  {
    id: 'monomaker',
    name: 'Mono Maker',
    category: 'imaging',
    hasSidechain: false,
    params: [
      { id: 'freqHz', name: 'Below',  min: 20, max: 400, default: 120, unit: 'Hz' },
      { id: 'widthPct', name: 'Width', min: 0, max: 200, default: 100, unit: '%' },
    ],
    automatableParams: ['widthPct'],
    latencyFor: () => 0,
    // Bass that is out of phase between the channels disappears the moment
    // anything sums to mono — a club system, a phone, a laptop.  Collapsing
    // only the bottom keeps the record wide and keeps the low end.
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const ms = midSide(ctx);
      input.connect(ms.input);

      // Only the side channel is filtered: kill the side below the corner and
      // the bottom is mono while the mid keeps every bit of its energy.
      //
      // Four poles, not two.  A gentle slope leaves an octave of side energy
      // under the corner — bass that still reads on the meters and still
      // disappears in mono, which is the exact problem the device is for.
      const sideHp = [0, 1].map(() => {
        const f = ctx.createBiquadFilter();
        f.type = 'highpass';
        f.frequency.value = p(params, 'freqHz', 120);
        f.Q.value = 0.707;
        return f;
      });
      const width = ctx.createGain();
      width.gain.value = Math.max(0, p(params, 'widthPct', 100) / 100);

      ms.mid.connect(ms.midReturn);
      ms.side.connect(sideHp[0]!).connect(sideHp[1]!).connect(width).connect(ms.sideReturn);
      ms.output.connect(output);

      return {
        setParam: (id, v) => {
          if (id === 'freqHz')   for (const f of sideHp) f.frequency.value = v;
          if (id === 'widthPct') width.gain.value = Math.max(0, v / 100);
        },
        // `freqHz` retunes a cascade of high-passes, not one filter.
        automatable: automatableFrom({
          widthPct: { param: width.gain, map: (v) => Math.max(0, v / 100) },
        }),
      };
    }),
  },

  {
    id: 'haas',
    name: 'Haas Widener',
    category: 'imaging',
    hasSidechain: false,
    params: [
      { id: 'delayMs', name: 'Delay',  min: 0, max: 40,  default: 12, unit: 'ms' },
      { id: 'amount',  name: 'Amount', min: 0, max: 1,   default: 0.5, unit: '' },
    ],
    automatableParams: ['delayMs', 'amount'],
    latencyFor: () => 0,
    // A few milliseconds on one side reads as width, not as an echo.  Mono
    // compatibility is the price, which is why Amount exists and why this is
    // not something to put on a bass.
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const splitter = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);
      const delay = ctx.createDelay(0.1);
      delay.delayTime.value = p(params, 'delayMs', 12) / 1000;
      // `amount` is a wet/dry blend on the right channel under another name,
      // so it gets the same single-parameter treatment.
      const blend = wetDry(ctx, p(params, 'amount', 0.5));
      const wet = blend.wet;
      const dryR = blend.dry;
      const setAmount = (a: number): void => blend.setMix(a);

      input.connect(splitter);
      splitter.connect(merger, 0, 0);                 // left straight through
      splitter.connect(delay, 1);
      delay.connect(wet).connect(merger, 0, 1);
      splitter.connect(dryR, 1);
      dryR.connect(merger, 0, 1);
      merger.connect(output);

      return {
        setParam: (id, v) => {
          if (id === 'delayMs') delay.delayTime.value = v / 1000;
          if (id === 'amount')  setAmount(v);
        },
        automatable: automatableFrom({
          delayMs: { param: delay.delayTime, map: (v) => v / 1000 },
          amount: blend.mix,
        }),
        dispose: () => blend.dispose(),
      };
    }),
  },

  // ── Utility ───────────────────────────────────────────────────────────────
  {
    id: 'phase',
    name: 'Phase / Mono',
    category: 'utility',
    hasSidechain: false,
    params: [
      { id: 'invertL', name: 'Invert L', min: 0, max: 1, default: 0, unit: '' },
      { id: 'invertR', name: 'Invert R', min: 0, max: 1, default: 0, unit: '' },
      { id: 'swap',    name: 'Swap L/R', min: 0, max: 1, default: 0, unit: '' },
      { id: 'mono',    name: 'Mono',     min: 0, max: 1, default: 0, unit: '' },
    ],
    // Four switches, not knobs: each one re-wires a matrix of six gains, and
    // ramping through 'half swapped' is not a state this device has.
    automatableParams: [],
    latencyFor: () => 0,
    // The first thing to reach for when a snare has two mics and the pair
    // sounds thin, and the check every mix needs before it leaves.
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const splitter = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);
      const lGain = ctx.createGain();
      const rGain = ctx.createGain();
      const lToL = ctx.createGain();
      const lToR = ctx.createGain();
      const rToL = ctx.createGain();
      const rToR = ctx.createGain();

      const wire = (): void => {
        const swap = p(params, 'swap', 0) >= 0.5;
        const mono = p(params, 'mono', 0) >= 0.5;
        lGain.gain.value = p(params, 'invertL', 0) >= 0.5 ? -1 : 1;
        rGain.gain.value = p(params, 'invertR', 0) >= 0.5 ? -1 : 1;
        if (mono) {
          lToL.gain.value = 0.5; rToL.gain.value = 0.5;
          lToR.gain.value = 0.5; rToR.gain.value = 0.5;
        } else if (swap) {
          lToL.gain.value = 0; rToL.gain.value = 1;
          lToR.gain.value = 1; rToR.gain.value = 0;
        } else {
          lToL.gain.value = 1; rToL.gain.value = 0;
          lToR.gain.value = 0; rToR.gain.value = 1;
        }
      };
      wire();

      input.connect(splitter);
      splitter.connect(lGain, 0);
      splitter.connect(rGain, 1);
      lGain.connect(lToL); lGain.connect(lToR);
      rGain.connect(rToL); rGain.connect(rToR);
      lToL.connect(merger, 0, 0); rToL.connect(merger, 0, 0);
      lToR.connect(merger, 0, 1); rToR.connect(merger, 0, 1);
      merger.connect(output);

      return {
        setParam: (id, v) => { params[id] = v; wire(); },
      };
    }),
  },

  {
    id: 'dcblock',
    name: 'DC Blocker',
    category: 'utility',
    hasSidechain: false,
    params: [],
    // One job, no parameters.
    automatableParams: [],
    latencyFor: () => 0,
    // A DC offset costs headroom without making a sound: the waveform sits
    // off-centre and the limiter sees peaks that are not music.
    create: (ctx) => withBypass(ctx, (input, output) => {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 5;
      hp.Q.value = 0.707;
      input.connect(hp).connect(output);
      return { setParam: () => { /* nothing to set — it is one job */ } };
    }),
  },

  // ── Master chain ──────────────────────────────────────────────────────────
  {
    id: 'dither',
    name: 'Dither',
    category: 'master',
    hasSidechain: false,
    params: [
      { id: 'bits',     name: 'Bits',  min: 8,  max: 24, default: 16, unit: '' },
      { id: 'amount',   name: 'Amount', min: 0, max: 2,  default: 1,  unit: '' },
    ],
    // The noise level is a function of BOTH knobs (an LSB from the bit depth,
    // scaled by the amount), so neither is a parameter on its own.
    automatableParams: [],
    latencyFor: () => 0,
    // The last device in the chain and nowhere else.  Truncating 24-bit to
    // 16 without dither turns quiet tails into gritty steps; a bit of noise
    // below the last bit trades that for hiss nobody can hear.
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const source = ctx.createBufferSource();
      source.buffer = noiseBuffer(ctx);
      source.loop = true;
      const level = ctx.createGain();
      const setLevel = (bits: number, amount: number): void => {
        // One LSB of the target word length, scaled by taste.
        const lsb = Math.pow(2, -(Math.max(2, bits) - 1));
        level.gain.value = lsb * Math.max(0, amount);
      };
      setLevel(p(params, 'bits', 16), p(params, 'amount', 1));
      source.connect(level).connect(output);
      source.start(0);
      input.connect(output);
      return {
        setParam: (id, v) => {
          params[id] = v;
          setLevel(p(params, 'bits', 16), p(params, 'amount', 1));
        },
        dispose: () => { try { source.stop(); } catch { /* never started */ } },
      };
    }),
  },

  {
    id: 'hum',
    name: 'Hum Remover',
    category: 'restore',
    hasSidechain: false,
    params: [
      { id: 'baseHz',   name: 'Base',     min: 40, max: 70, default: 60, unit: 'Hz' },
      { id: 'harmonics', name: 'Harmonics', min: 1, max: 8, default: 4,  unit: '' },
      { id: 'q',        name: 'Q',        min: 5,  max: 60, default: 30, unit: '' },
    ],
    // Every knob retunes the whole notch cascade — up to eight filters — and
    // the harmonic count switches notches in and out entirely.
    automatableParams: [],
    latencyFor: () => 0,
    // Mains hum is not one tone, it is a comb: 50 or 60 Hz and everything
    // above it.  Notching only the fundamental leaves the buzz behind.
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const MAX = 8;
      const notches = Array.from({ length: MAX }, () => {
        const f = ctx.createBiquadFilter();
        f.type = 'notch';
        f.Q.value = p(params, 'q', 30);
        return f;
      });
      const tune = (): void => {
        const base = p(params, 'baseHz', 60);
        const count = Math.round(p(params, 'harmonics', 4));
        const q = p(params, 'q', 30);
        notches.forEach((f, i) => {
          const hz = base * (i + 1);
          // Filters past the requested count are parked out of the way rather
          // than rewired, so changing the count never rebuilds the graph.
          f.frequency.value = i < count && hz < ctx.sampleRate / 2 ? hz : 20_000;
          f.Q.value = q;
        });
      };
      tune();
      let cursor: AudioNode = input;
      for (const f of notches) { cursor.connect(f); cursor = f; }
      cursor.connect(output);
      return {
        setParam: (id, v) => { params[id] = v; tune(); },
      };
    }),
  },

  {
    id: 'loudness',
    name: 'Loudness Meter',
    category: 'master',
    hasSidechain: false,
    params: [
      { id: 'targetLufs', name: 'Target', min: -24, max: -6, default: -14, unit: 'LUFS' },
    ],
    // A meter. Its one knob is the target it reports against; it changes
    // nothing in the signal path, so there is nothing for a lane to move.
    automatableParams: [],
    latencyFor: () => 0,
    // A master is finished against a number, not a feeling.  This is the only
    // device here that changes nothing: the audio passes through untouched and
    // a tap off the side is K-weighted per BS.1770-4 so what the window shows
    // is the same measurement the delivery target is written in.
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      input.connect(output);

      // BS.1770-4 K-weighting: a +3.99 dB high shelf at 1681.97 Hz followed by
      // an RLB high-pass at 38.135 Hz.  Both are ordinary biquads, so the
      // measurement runs in the graph rather than on the main thread.
      const shelf = ctx.createBiquadFilter();
      shelf.type = 'highshelf';
      shelf.frequency.value = 1681.974450955533;
      shelf.gain.value = 3.999843853973347;
      shelf.Q.value = 0.7071752369554196;

      const rlb = ctx.createBiquadFilter();
      rlb.type = 'highpass';
      rlb.frequency.value = 38.13547087602444;
      // Web Audio reads a high-pass Q in decibels; 0.5003 as a cookbook Q is
      // -6.02 dB here.  Passing the raw number would measure a filter nobody
      // specified.
      rlb.Q.value = 20 * Math.log10(0.5003270373238773);

      const weighted = ctx.createAnalyser();
      weighted.fftSize = 2048;
      weighted.smoothingTimeConstant = 0;
      const raw = ctx.createAnalyser();
      raw.fftSize = 2048;
      raw.smoothingTimeConstant = 0;

      input.connect(shelf).connect(rlb).connect(weighted);
      input.connect(raw);

      const block = new Float32Array(weighted.fftSize);
      const rawBlock = new Float32Array(raw.fftSize);

      return {
        setParam: (id, v) => { params[id] = v; },
        analyse: () => {
          weighted.getFloatTimeDomainData(block);
          raw.getFloatTimeDomainData(rawBlock);
          let sum = 0;
          for (let i = 0; i < block.length; i++) sum += block[i]! * block[i]!;
          const meanSquare = sum / block.length;
          let peak = 0;
          for (let i = 0; i < rawBlock.length; i++) {
            const a = Math.abs(rawBlock[i]!);
            if (a > peak) peak = a;
          }
          return {
            // The -0.691 offset is the standard's, not a fudge.
            lufs: meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -70,
            peakDb: peak > 0 ? 20 * Math.log10(peak) : -70,
          };
        },
      };
    }),
  },
];
