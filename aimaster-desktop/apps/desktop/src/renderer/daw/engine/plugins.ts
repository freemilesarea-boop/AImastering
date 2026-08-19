// Insert plugins.
//
// Every plugin is built from native WebAudio nodes only — no ScriptProcessor,
// no control-rate JS.  That is a deliberate constraint: nodes render inside
// an OfflineAudioContext, so what you hear live is bit-identical to what
// Bounce / Freeze writes to disk.  A JS envelope follower would silently
// drop out during an offline render and the bounce would not match.
//
// The sidechain compressor and the look-ahead limiter are the interesting
// ones: their detectors are audio-rate signal chains
// (|x| → one-pole → transfer curve) driving a GainNode's `gain` AudioParam
// through an audio connection, which is how you get a working detector with
// no script node in the path.

export interface PluginParamDef {
  id: string;
  name: string;
  min: number;
  max: number;
  default: number;
  unit: string;
}

export interface PluginInstance {
  input: AudioNode;
  output: AudioNode;
  /** Key input, for plugins that have one. */
  sidechain: AudioNode | null;
  latencySamples: number;
  setParam: (id: string, value: number) => void;
  setBypass: (bypassed: boolean) => void;
  /** Tell the plugin an external key is (or is not) feeding its sidechain. */
  setSidechainActive: (active: boolean) => void;
  dispose: () => void;
}

export interface PluginDescriptor {
  id: string;
  name: string;
  category: 'utility' | 'eq' | 'dynamics' | 'delay' | 'reverb' | 'restore' | 'pitch';
  /**
   * Devices that cannot run in the realtime graph (they need to look at the
   * whole file).  They stay visible in the chain — greyed, badged OFFLINE —
   * and are applied by the render path instead of silently doing nothing.
   */
  offline?: boolean;
  params: PluginParamDef[];
  hasSidechain: boolean;
  /** Reported latency, in samples at the context rate — drives ADC. */
  latencyFor: (params: Record<string, number>, sampleRate: number) => number;
  create: (ctx: BaseAudioContext, params: Record<string, number>) => PluginInstance;
}

const dbToGain = (db: number): number => (db <= -144 ? 0 : Math.pow(10, db / 20));

/** Wrap a processing chain with a bypass path that keeps latency identical. */
function withBypass(
  ctx: BaseAudioContext,
  build: (input: GainNode, output: GainNode) => {
    setParam: (id: string, v: number) => void;
    dispose?: () => void;
    sidechain?: AudioNode | null;
    setSidechainActive?: (a: boolean) => void;
    latencySamples?: number;
    /** Node the dry signal must pass through so bypass keeps the same delay. */
    bypassDelay?: AudioNode;
  },
): PluginInstance {
  const input  = ctx.createGain();
  const output = ctx.createGain();
  const wet    = ctx.createGain();
  const dry    = ctx.createGain();
  dry.gain.value = 0;

  const built = build(input, wet);
  wet.connect(output);

  // Bypass must not change alignment: route the dry signal through the same
  // delay the plugin reports, so bypassing a look-ahead limiter does not
  // shift the channel forward by its latency.
  if (built.bypassDelay) {
    input.connect(built.bypassDelay);
    built.bypassDelay.connect(dry);
  } else {
    input.connect(dry);
  }
  dry.connect(output);

  return {
    input,
    output,
    sidechain: built.sidechain ?? null,
    latencySamples: built.latencySamples ?? 0,
    setParam: built.setParam,
    setBypass: (bypassed) => {
      wet.gain.value = bypassed ? 0 : 1;
      dry.gain.value = bypassed ? 1 : 0;
    },
    setSidechainActive: built.setSidechainActive ?? (() => { /* no key input */ }),
    dispose: () => { built.dispose?.(); },
  };
}

/** |x| shaper — the first stage of every detector here. */
function absShaper(ctx: BaseAudioContext): WaveShaperNode {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = Math.abs((i / (n - 1)) * 2 - 1);
  const shaper = ctx.createWaveShaper();
  shaper.curve = curve;
  shaper.oversample = 'none';
  return shaper;
}

/**
 * Static compressor transfer curve as a WaveShaper: envelope in → gain
 * multiplier out.  Only the positive half is ever exercised (the input is a
 * rectified envelope), and the negative half mirrors it so the shaper stays
 * well-defined.
 */
function makeGainCurve(
  ctx: BaseAudioContext, thresholdDb: number, ratio: number, ceiling = false,
): WaveShaperNode {
  const n = 2048;
  const curve = new Float32Array(n);
  const thr = dbToGain(thresholdDb);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const env = Math.abs(x);
    let g = 1;
    if (env > thr && thr > 0) {
      g = ceiling
        ? thr / env                                  // hard ceiling (limiter)
        : Math.pow(env / thr, 1 / Math.max(1, ratio) - 1);
      g = Math.max(0, Math.min(1, g));
    }
    curve[i] = g;
  }
  const shaper = ctx.createWaveShaper();
  shaper.curve = curve;
  shaper.oversample = 'none';
  return shaper;
}

/** Soft-clipping transfer curve with an optional even-harmonic bias. */
function tanhCurve(bias = 0): Float32Array<ArrayBuffer> {
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const biased = x + bias * x * x * 0.5;
    curve[i] = Math.tanh(biased * 1.6) / Math.tanh(1.6);
  }
  return curve;
}

/**
 * Map a detector signal to a GAIN DELTA, reacting to only one polarity.
 * The transient designer uses two of these — one for attacks (positive
 * difference) and one for sustain (negative) — summed onto the same gain.
 */
function halfWaveGainCurve(amount: number, side: 'positive' | 'negative'): Float32Array<ArrayBuffer> {
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const active = side === 'positive' ? Math.max(0, x) : Math.max(0, -x);
    curve[i] = active * amount;
  }
  return curve;
}

/**
 * Downward-expansion curve: unity above the threshold, falling away below it.
 * This is what a broadband denoiser actually is — the noise floor sits under
 * the threshold and gets pushed down, the performance sits above it and is
 * untouched.
 */
function makeExpanderCurve(
  thresholdDb: number, ratio: number, floorGain = 0.05,
): Float32Array<ArrayBuffer> {
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

/**
 * Envelope → dB REDUCTION curve, for a device that drives a filter's gain
 * (which is expressed in dB) rather than a linear VCA.
 */
function makeDbReductionCurve(
  thresholdDb: number, ratio: number, maxCutDb: number,
): Float32Array<ArrayBuffer> {
  const n = 2048;
  const curve = new Float32Array(n);
  const thr = dbToGain(thresholdDb);
  for (let i = 0; i < n; i++) {
    const env = Math.abs((i / (n - 1)) * 2 - 1);
    let cut = 0;
    if (env > thr && thr > 0) {
      const overDb = 20 * Math.log10(env / thr);
      cut = -overDb * (1 - 1 / Math.max(1, ratio));
      cut = Math.max(maxCutDb, cut);
    }
    // Normalised so the caller can scale it back up to dB with a gain node.
    curve[i] = cut / Math.max(1, Math.abs(maxCutDb));
  }
  return curve;
}

/**
 * A WaveShaper's curve may only be assigned once, so a parameter change that
 * reshapes the transfer function has to REPLACE the node.  This helper keeps
 * that swap in one place instead of scattering rewiring through every plugin.
 */
function makeShaper(
  ctx: BaseAudioContext, curve: Float32Array<ArrayBuffer>,
  oversample: OverSampleType = 'none',
): WaveShaperNode {
  const shaper = ctx.createWaveShaper();
  shaper.curve = curve;
  shaper.oversample = oversample;
  return shaper;
}

/** One-pole smoother, expressed as a lowpass corner from a time constant. */
function smoother(ctx: BaseAudioContext, timeMs: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = timeConstantToHz(timeMs);
  f.Q.value = 0.7071;
  return f;
}

export function timeConstantToHz(timeMs: number): number {
  const tau = Math.max(0.0005, timeMs / 1000);
  return Math.max(0.5, Math.min(20_000, 1 / (2 * Math.PI * tau)));
}

// ── Registry ──────────────────────────────────────────────────────────────────

export const PLUGINS: PluginDescriptor[] = [
  {
    id: 'trim',
    name: 'Trim',
    category: 'utility',
    hasSidechain: false,
    params: [{ id: 'gainDb', name: 'Gain', min: -24, max: 24, default: 0, unit: 'dB' }],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const gain = ctx.createGain();
      gain.gain.value = dbToGain(params['gainDb'] ?? 0);
      input.connect(gain).connect(output);
      return {
        setParam: (id, v) => { if (id === 'gainDb') gain.gain.value = dbToGain(v); },
      };
    }),
  },

  {
    id: 'eq3',
    name: 'EQ 3-Band',
    category: 'eq',
    hasSidechain: false,
    params: [
      { id: 'lowDb',   name: 'Low',      min: -18, max: 18,    default: 0,    unit: 'dB' },
      { id: 'midDb',   name: 'Mid',      min: -18, max: 18,    default: 0,    unit: 'dB' },
      { id: 'midHz',   name: 'Mid Freq', min: 200, max: 8000,  default: 1000, unit: 'Hz' },
      { id: 'highDb',  name: 'High',     min: -18, max: 18,    default: 0,    unit: 'dB' },
      { id: 'hpfHz',   name: 'HPF',      min: 20,  max: 400,   default: 20,   unit: 'Hz' },
    ],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const hpf = ctx.createBiquadFilter();  hpf.type = 'highpass';
      hpf.frequency.value = params['hpfHz'] ?? 20;
      const low = ctx.createBiquadFilter();  low.type = 'lowshelf';
      low.frequency.value = 120; low.gain.value = params['lowDb'] ?? 0;
      const mid = ctx.createBiquadFilter();  mid.type = 'peaking';
      mid.frequency.value = params['midHz'] ?? 1000; mid.Q.value = 1;
      mid.gain.value = params['midDb'] ?? 0;
      const high = ctx.createBiquadFilter(); high.type = 'highshelf';
      high.frequency.value = 8000; high.gain.value = params['highDb'] ?? 0;
      input.connect(hpf).connect(low).connect(mid).connect(high).connect(output);
      return {
        setParam: (id, v) => {
          if (id === 'lowDb')  low.gain.value = v;
          if (id === 'midDb')  mid.gain.value = v;
          if (id === 'midHz')  mid.frequency.value = v;
          if (id === 'highDb') high.gain.value = v;
          if (id === 'hpfHz')  hpf.frequency.value = v;
        },
      };
    }),
  },

  {
    id: 'comp',
    name: 'Compressor',
    category: 'dynamics',
    hasSidechain: true,
    params: [
      { id: 'thresholdDb', name: 'Threshold', min: -60, max: 0,   default: -18, unit: 'dB' },
      { id: 'ratio',       name: 'Ratio',     min: 1,   max: 20,  default: 4,   unit: ':1' },
      { id: 'attackMs',    name: 'Attack',    min: 0.1, max: 100, default: 10,  unit: 'ms' },
      { id: 'releaseMs',   name: 'Release',   min: 10,  max: 1000, default: 120, unit: 'ms' },
      { id: 'makeupDb',    name: 'Makeup',    min: 0,   max: 24,  default: 0,   unit: 'dB' },
    ],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      // Signal path: input → vca → makeup → output
      const vca = ctx.createGain();
      vca.gain.value = 0;               // driven entirely by the detector signal
      const makeup = ctx.createGain();
      makeup.gain.value = dbToGain(params['makeupDb'] ?? 0);

      // Detector: key → |x| → smoother → transfer curve → vca.gain
      const internalKey = ctx.createGain();      // key tapped from the input
      const externalKey = ctx.createGain();      // key from another bus
      externalKey.gain.value = 0;
      const rect = absShaper(ctx);
      const env = smoother(ctx, params['attackMs'] ?? 10);
      let curve = makeGainCurve(ctx, params['thresholdDb'] ?? -18, params['ratio'] ?? 4);

      input.connect(internalKey);
      internalKey.connect(rect);
      externalKey.connect(rect);
      rect.connect(env).connect(curve);
      curve.connect(vca.gain);

      input.connect(vca).connect(makeup).connect(output);

      return {
        sidechain: externalKey,
        setSidechainActive: (active) => {
          externalKey.gain.value = active ? 1 : 0;
          internalKey.gain.value = active ? 0 : 1;
        },
        setParam: (id, v) => {
          if (id === 'makeupDb') makeup.gain.value = dbToGain(v);
          if (id === 'attackMs' || id === 'releaseMs') env.frequency.value = timeConstantToHz(v);
          if (id === 'thresholdDb' || id === 'ratio') {
            const next = makeGainCurve(
              ctx,
              id === 'thresholdDb' ? v : (params['thresholdDb'] ?? -18),
              id === 'ratio' ? v : (params['ratio'] ?? 4),
            );
            if (id === 'thresholdDb') params['thresholdDb'] = v; else params['ratio'] = v;
            env.disconnect();
            curve.disconnect();
            curve = next;
            env.connect(curve);
            curve.connect(vca.gain);
          }
        },
        dispose: () => { curve.disconnect(); },
      };
    }),
  },

  {
    id: 'limiter',
    name: 'Look-ahead Limiter',
    category: 'dynamics',
    hasSidechain: false,
    params: [
      { id: 'ceilingDb',   name: 'Ceiling',   min: -12, max: 0,   default: -1,  unit: 'dB' },
      { id: 'lookaheadMs', name: 'Look-ahead', min: 0,  max: 10,  default: 2,   unit: 'ms' },
      { id: 'releaseMs',   name: 'Release',   min: 10,  max: 500, default: 80,  unit: 'ms' },
    ],
    // Real reported latency — this is what delay compensation lines up.
    latencyFor: (params, sampleRate) =>
      Math.round(((params['lookaheadMs'] ?? 2) / 1000) * sampleRate),
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const lookaheadSec = (params['lookaheadMs'] ?? 2) / 1000;
      const delay = ctx.createDelay(0.05);
      delay.delayTime.value = lookaheadSec;

      const vca = ctx.createGain();
      vca.gain.value = 0;
      const rect = absShaper(ctx);
      const env = smoother(ctx, params['releaseMs'] ?? 80);
      const curve = makeGainCurve(ctx, params['ceilingDb'] ?? -1, 20, true);

      // Detector runs on the UNDELAYED signal — that is what look-ahead means.
      input.connect(rect).connect(env).connect(curve);
      curve.connect(vca.gain);
      input.connect(delay).connect(vca).connect(output);

      // Bypass path is delayed by the same look-ahead so A/B stays aligned.
      const bypassDelay = ctx.createDelay(0.05);
      bypassDelay.delayTime.value = lookaheadSec;

      return {
        bypassDelay,
        latencySamples: Math.round(lookaheadSec * ctx.sampleRate),
        setParam: (id, v) => {
          if (id === 'releaseMs') env.frequency.value = timeConstantToHz(v);
          if (id === 'lookaheadMs') {
            delay.delayTime.value = v / 1000;
            bypassDelay.delayTime.value = v / 1000;
          }
        },
      };
    }),
  },

  {
    id: 'delay',
    name: 'Delay',
    category: 'delay',
    hasSidechain: false,
    params: [
      { id: 'timeMs',   name: 'Time',     min: 1, max: 2000, default: 320, unit: 'ms' },
      { id: 'feedback', name: 'Feedback', min: 0, max: 0.95, default: 0.35, unit: '' },
      { id: 'mix',      name: 'Mix',      min: 0, max: 1,    default: 0.3,  unit: '' },
    ],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const delay = ctx.createDelay(2.1);
      delay.delayTime.value = (params['timeMs'] ?? 320) / 1000;
      const fb = ctx.createGain();  fb.gain.value = params['feedback'] ?? 0.35;
      const wet = ctx.createGain(); wet.gain.value = params['mix'] ?? 0.3;
      const dry = ctx.createGain(); dry.gain.value = 1 - (params['mix'] ?? 0.3);
      input.connect(delay);
      delay.connect(fb).connect(delay);
      delay.connect(wet).connect(output);
      input.connect(dry).connect(output);
      return {
        setParam: (id, v) => {
          if (id === 'timeMs')   delay.delayTime.value = v / 1000;
          if (id === 'feedback') fb.gain.value = v;
          if (id === 'mix')      { wet.gain.value = v; dry.gain.value = 1 - v; }
        },
      };
    }),
  },

  {
    id: 'reverb',
    name: 'Reverb',
    category: 'reverb',
    hasSidechain: false,
    params: [
      { id: 'decaySec', name: 'Decay',   min: 0.2, max: 8, default: 1.8, unit: 's' },
      { id: 'mix',      name: 'Mix',     min: 0,   max: 1, default: 1,   unit: '' },
      { id: 'preDelayMs', name: 'Pre-delay', min: 0, max: 120, default: 12, unit: 'ms' },
    ],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const conv = ctx.createConvolver();
      conv.buffer = makeImpulse(ctx, params['decaySec'] ?? 1.8);
      const pre = ctx.createDelay(0.2);
      pre.delayTime.value = (params['preDelayMs'] ?? 12) / 1000;
      const wet = ctx.createGain(); wet.gain.value = params['mix'] ?? 1;
      const dry = ctx.createGain(); dry.gain.value = 1 - (params['mix'] ?? 1);
      input.connect(pre).connect(conv).connect(wet).connect(output);
      input.connect(dry).connect(output);
      return {
        setParam: (id, v) => {
          if (id === 'mix') { wet.gain.value = v; dry.gain.value = 1 - v; }
          if (id === 'preDelayMs') pre.delayTime.value = v / 1000;
          if (id === 'decaySec') conv.buffer = makeImpulse(ctx, v);
        },
      };
    }),
  },

  {
    id: 'saturation',
    name: 'Saturation',
    category: 'utility',
    hasSidechain: false,
    params: [
      { id: 'driveDb', name: 'Drive', min: 0,  max: 24, default: 0, unit: 'dB' },
      { id: 'mix',     name: 'Mix',   min: 0,  max: 1,  default: 0, unit: '' },
      { id: 'bias',    name: 'Bias',  min: -1, max: 1,  default: 0, unit: '' },
    ],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      const drive = ctx.createGain();
      const compensate = ctx.createGain();
      const wet = ctx.createGain();
      const dry = ctx.createGain();
      let shaper = makeShaper(ctx, tanhCurve(params['bias'] ?? 0), '4x');

      const applyDrive = (db: number): void => {
        const gain = dbToGain(db);
        drive.gain.value = gain;
        // Saturation adds level; compensating keeps the macro from also
        // acting as a volume knob.
        compensate.gain.value = 1 / Math.max(1, Math.sqrt(gain));
      };
      applyDrive(params['driveDb'] ?? 0);

      const mix = params['mix'] ?? 0;
      wet.gain.value = mix;
      dry.gain.value = 1 - mix;

      drive.connect(shaper).connect(compensate);
      input.connect(drive);
      compensate.connect(wet).connect(output);
      input.connect(dry).connect(output);

      return {
        setParam: (id, v) => {
          if (id === 'driveDb') applyDrive(v);
          if (id === 'mix') { wet.gain.value = v; dry.gain.value = 1 - v; }
          if (id === 'bias' && v !== (params['bias'] ?? 0)) {
            params['bias'] = v;
            drive.disconnect(shaper);
            shaper.disconnect();
            shaper = makeShaper(ctx, tanhCurve(v), '4x');
            drive.connect(shaper).connect(compensate);
          }
        },
        dispose: () => { try { shaper.disconnect(); } catch { /* ignore */ } },
      };
    }),
  },

  {
    id: 'transient',
    name: 'Transient Designer',
    category: 'dynamics',
    hasSidechain: false,
    params: [
      { id: 'attack',  name: 'Attack',  min: -1, max: 1, default: 0, unit: '' },
      { id: 'sustain', name: 'Sustain', min: -1, max: 1, default: 0, unit: '' },
      { id: 'mix',     name: 'Mix',     min: 0,  max: 1, default: 1, unit: '' },
    ],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      // Two envelope followers at different speeds; their DIFFERENCE is the
      // transient.  Positive during an attack, negative while a note decays,
      // so one signal drives both halves of the control.
      const rect = absShaper(ctx);
      const fast = smoother(ctx, 2);
      const slow = smoother(ctx, 90);
      const invert = ctx.createGain();
      invert.gain.value = -1;
      const difference = ctx.createGain();

      input.connect(rect);
      rect.connect(fast).connect(difference);
      rect.connect(slow).connect(invert).connect(difference);

      const vca = ctx.createGain();
      vca.gain.value = 1;                       // audio-rate control sums onto this

      // The two shapers turn the transient signal into gain deltas.  Their
      // curves depend on the parameters, so changing one swaps the node.
      let attackShaper = makeShaper(ctx, halfWaveGainCurve((params['attack'] ?? 0) * 6, 'positive'));
      let sustainShaper = makeShaper(ctx, halfWaveGainCurve((params['sustain'] ?? 0) * 4, 'negative'));
      difference.connect(attackShaper);
      attackShaper.connect(vca.gain);
      difference.connect(sustainShaper);
      sustainShaper.connect(vca.gain);

      const swap = (which: 'attack' | 'sustain', value: number): void => {
        const old = which === 'attack' ? attackShaper : sustainShaper;
        difference.disconnect(old);
        old.disconnect();
        const next = which === 'attack'
          ? makeShaper(ctx, halfWaveGainCurve(value * 6, 'positive'))
          : makeShaper(ctx, halfWaveGainCurve(value * 4, 'negative'));
        difference.connect(next);
        next.connect(vca.gain);
        if (which === 'attack') attackShaper = next; else sustainShaper = next;
      };

      const wet = ctx.createGain();
      const dry = ctx.createGain();
      const mix = params['mix'] ?? 1;
      wet.gain.value = mix;
      dry.gain.value = 1 - mix;

      input.connect(vca).connect(wet).connect(output);
      input.connect(dry).connect(output);

      return {
        setParam: (id, v) => {
          if (id === 'attack' && v !== (params['attack'] ?? 0)) { params['attack'] = v; swap('attack', v); }
          if (id === 'sustain' && v !== (params['sustain'] ?? 0)) { params['sustain'] = v; swap('sustain', v); }
          if (id === 'mix') { wet.gain.value = v; dry.gain.value = 1 - v; }
        },
        dispose: () => {
          try { attackShaper.disconnect(); sustainShaper.disconnect(); } catch { /* ignore */ }
        },
      };
    }),
  },

  {
    id: 'exciter',
    name: 'Exciter',
    category: 'eq',
    hasSidechain: false,
    params: [
      { id: 'amount', name: 'Amount', min: 0,   max: 1,     default: 0,    unit: '' },
      { id: 'freqHz', name: 'Freq',   min: 1500, max: 12000, default: 4000, unit: 'Hz' },
      { id: 'mix',    name: 'Mix',    min: 0,   max: 1,     default: 0,    unit: '' },
    ],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      // Generate harmonics from the top band only, then blend them back —
      // the classic exciter topology, and the reason it adds "air" instead
      // of just turning the treble up.
      const band = ctx.createBiquadFilter();
      band.type = 'highpass';
      band.frequency.value = params['freqHz'] ?? 4000;
      band.Q.value = 0.7;

      const drive = ctx.createGain();
      const shaper = makeShaper(ctx, tanhCurve(0.15), '4x');
      const wet = ctx.createGain();

      const applyAmount = (amount: number): void => { drive.gain.value = 1 + amount * 8; };
      applyAmount(params['amount'] ?? 0);
      wet.gain.value = params['mix'] ?? 0;

      input.connect(band).connect(drive).connect(shaper).connect(wet).connect(output);
      input.connect(output);                      // dry stays full

      return {
        setParam: (id, v) => {
          if (id === 'amount') applyAmount(v);
          if (id === 'freqHz') band.frequency.value = v;
          if (id === 'mix') wet.gain.value = v;
        },
      };
    }),
  },

  {
    id: 'widener',
    name: 'Stereo Width',
    category: 'utility',
    hasSidechain: false,
    params: [
      { id: 'width',     name: 'Width',    min: 0,  max: 2,   default: 1,  unit: '×' },
      { id: 'lowMonoHz', name: 'Low Mono', min: 20, max: 400, default: 20, unit: 'Hz' },
    ],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      // Mid/side built from plain gains: M = (L+R)/2, S = (L−R)/2, scale S,
      // then L = M+S, R = M−S.  Everything below `lowMonoHz` is kept out of
      // S so the bass stays centred however wide the top gets.
      const splitter = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);

      const mid = ctx.createGain();
      const side = ctx.createGain();
      const lToMid = ctx.createGain(); lToMid.gain.value = 0.5;
      const rToMid = ctx.createGain(); rToMid.gain.value = 0.5;
      const lToSide = ctx.createGain(); lToSide.gain.value = 0.5;
      const rToSide = ctx.createGain(); rToSide.gain.value = -0.5;

      input.connect(splitter);
      splitter.connect(lToMid, 0);
      splitter.connect(rToMid, 1);
      splitter.connect(lToSide, 0);
      splitter.connect(rToSide, 1);
      lToMid.connect(mid);
      rToMid.connect(mid);
      lToSide.connect(side);
      rToSide.connect(side);

      const sideHigh = ctx.createBiquadFilter();
      sideHigh.type = 'highpass';
      sideHigh.frequency.value = params['lowMonoHz'] ?? 20;
      const sideGain = ctx.createGain();
      sideGain.gain.value = params['width'] ?? 1;
      const sideInverted = ctx.createGain();
      sideInverted.gain.value = -1;

      side.connect(sideHigh).connect(sideGain);
      sideGain.connect(sideInverted);

      mid.connect(merger, 0, 0);
      mid.connect(merger, 0, 1);
      sideGain.connect(merger, 0, 0);
      sideInverted.connect(merger, 0, 1);
      merger.connect(output);

      return {
        setParam: (id, v) => {
          if (id === 'width') sideGain.gain.value = v;
          if (id === 'lowMonoHz') sideHigh.frequency.value = v;
        },
      };
    }),
  },

  {
    id: 'denoise',
    name: 'Denoise',
    category: 'restore',
    hasSidechain: false,
    params: [
      { id: 'thresholdDb', name: 'Threshold', min: -80, max: -10, default: -48, unit: 'dB' },
      { id: 'amount',      name: 'Amount',    min: 0,   max: 1,   default: 0,   unit: '' },
      { id: 'releaseMs',   name: 'Release',   min: 10,  max: 500, default: 120, unit: 'ms' },
    ],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      // Broadband downward expander: the noise floor is pushed down, the
      // performance above the threshold passes untouched.
      const vca = ctx.createGain();
      vca.gain.value = 0;
      const rect = absShaper(ctx);
      const env = smoother(ctx, params['releaseMs'] ?? 120);
      const ratioOf = (amount: number): number => 1 + amount * 5;
      let curve = makeShaper(ctx, makeExpanderCurve(
        params['thresholdDb'] ?? -48, ratioOf(params['amount'] ?? 0),
      ));

      input.connect(rect).connect(env).connect(curve);
      curve.connect(vca.gain);
      input.connect(vca).connect(output);

      const rebuild = (): void => {
        env.disconnect();
        curve.disconnect();
        curve = makeShaper(ctx, makeExpanderCurve(
          params['thresholdDb'] ?? -48, ratioOf(params['amount'] ?? 0),
        ));
        env.connect(curve);
        curve.connect(vca.gain);
      };

      return {
        setParam: (id, v) => {
          if (id === 'releaseMs') { env.frequency.value = timeConstantToHz(v); return; }
          if ((id === 'thresholdDb' || id === 'amount') && v !== params[id]) {
            params[id] = v;
            rebuild();
          }
        },
        dispose: () => { try { curve.disconnect(); } catch { /* ignore */ } },
      };
    }),
  },

  {
    id: 'deesser',
    name: 'De-Esser',
    category: 'dynamics',
    hasSidechain: false,
    params: [
      { id: 'freqHz',      name: 'Freq',      min: 2000, max: 12000, default: 6500, unit: 'Hz' },
      { id: 'thresholdDb', name: 'Threshold', min: -48,  max: 0,     default: -24,  unit: 'dB' },
      { id: 'amount',      name: 'Amount',    min: 0,    max: 1,     default: 0,    unit: '' },
    ],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      // Split the sibilant band off, compress only that, sum back.  A
      // full-band compressor would duck the whole voice on every "s".
      const low = ctx.createBiquadFilter();
      low.type = 'lowpass';
      low.frequency.value = params['freqHz'] ?? 6500;
      const high = ctx.createBiquadFilter();
      high.type = 'highpass';
      high.frequency.value = params['freqHz'] ?? 6500;

      const vca = ctx.createGain();
      vca.gain.value = 0;
      const rect = absShaper(ctx);
      const env = smoother(ctx, 4);
      const ratioOf = (amount: number): number => 1 + amount * 11;
      let curve = makeGainCurve(ctx, params['thresholdDb'] ?? -24, ratioOf(params['amount'] ?? 0));

      input.connect(low).connect(output);
      input.connect(high);
      high.connect(rect).connect(env).connect(curve);
      curve.connect(vca.gain);
      high.connect(vca).connect(output);

      const rebuild = (): void => {
        env.disconnect();
        curve.disconnect();
        curve = makeGainCurve(ctx, params['thresholdDb'] ?? -24, ratioOf(params['amount'] ?? 0));
        env.connect(curve);
        curve.connect(vca.gain);
      };

      return {
        setParam: (id, v) => {
          if (id === 'freqHz') { low.frequency.value = v; high.frequency.value = v; return; }
          if ((id === 'thresholdDb' || id === 'amount') && v !== params[id]) {
            params[id] = v;
            rebuild();
          }
        },
        dispose: () => { try { curve.disconnect(); } catch { /* ignore */ } },
      };
    }),
  },

  {
    id: 'dyneq',
    name: 'Dynamic EQ',
    category: 'eq',
    hasSidechain: false,
    params: [
      { id: 'freqHz',      name: 'Freq',      min: 60,  max: 12000, default: 300, unit: 'Hz' },
      { id: 'q',           name: 'Q',         min: 0.3, max: 8,     default: 1.4, unit: '' },
      { id: 'thresholdDb', name: 'Threshold', min: -48, max: 0,     default: -24, unit: 'dB' },
      { id: 'rangeDb',     name: 'Range',     min: -18, max: 0,     default: 0,   unit: 'dB' },
    ],
    latencyFor: () => 0,
    create: (ctx, params) => withBypass(ctx, (input, output) => {
      // A peaking filter whose GAIN is driven at audio rate by the level in
      // its own band: the cut only happens when that band misbehaves.
      const peak = ctx.createBiquadFilter();
      peak.type = 'peaking';
      peak.frequency.value = params['freqHz'] ?? 300;
      peak.Q.value = params['q'] ?? 1.4;
      peak.gain.value = 0;

      const detector = ctx.createBiquadFilter();
      detector.type = 'bandpass';
      detector.frequency.value = params['freqHz'] ?? 300;
      detector.Q.value = params['q'] ?? 1.4;

      const rect = absShaper(ctx);
      const env = smoother(ctx, 12);
      const scale = ctx.createGain();
      const range = () => Math.abs(params['rangeDb'] ?? 0);
      scale.gain.value = range();
      let curve = makeShaper(ctx, makeDbReductionCurve(
        params['thresholdDb'] ?? -24, 4, -Math.max(1, range()),
      ));

      input.connect(detector).connect(rect).connect(env).connect(curve);
      curve.connect(scale).connect(peak.gain);
      input.connect(peak).connect(output);

      const rebuild = (): void => {
        env.disconnect();
        curve.disconnect();
        curve = makeShaper(ctx, makeDbReductionCurve(
          params['thresholdDb'] ?? -24, 4, -Math.max(1, range()),
        ));
        env.connect(curve);
        curve.connect(scale);
      };

      return {
        setParam: (id, v) => {
          if (id === 'freqHz') { peak.frequency.value = v; detector.frequency.value = v; return; }
          if (id === 'q') { peak.Q.value = v; detector.Q.value = v; return; }
          if (id === 'rangeDb') { params['rangeDb'] = v; scale.gain.value = Math.abs(v); rebuild(); return; }
          if (id === 'thresholdDb' && v !== params[id]) { params[id] = v; rebuild(); }
        },
        dispose: () => { try { curve.disconnect(); } catch { /* ignore */ } },
      };
    }),
  },

  {
    id: 'pitchcorrect',
    name: 'Pitch Correct',
    category: 'pitch',
    hasSidechain: false,
    // Pitch correction reads the whole take before it can decide anything, so
    // it runs in the render path (see audio/varia-actions.ts), not live.
    offline: true,
    params: [
      { id: 'amount',   name: 'Amount',   min: 0, max: 1, default: 0.8, unit: '' },
      { id: 'formant',  name: 'Formant',  min: -6, max: 6, default: 0,  unit: 'st' },
    ],
    latencyFor: () => 0,
    create: (ctx) => withBypass(ctx, (input, output) => {
      // Realtime pass-through; the chain view badges it OFFLINE.
      input.connect(output);
      return { setParam: () => { /* applied at render time */ } };
    }),
  },
];

/** Exponentially decaying noise burst — a serviceable algorithmic tail. */
export function makeImpulse(ctx: BaseAudioContext, decaySec: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(rate * decaySec));
  const buffer = ctx.createBuffer(2, length, rate);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    let seed = c === 0 ? 12345 : 67890;
    for (let i = 0; i < length; i++) {
      // Deterministic LCG — an offline bounce must match the live render.
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const noise = (seed / 0x3fffffff) - 1;
      data[i] = noise * Math.pow(1 - i / length, 2.5);
    }
  }
  return buffer;
}

export function findPlugin(id: string): PluginDescriptor | undefined {
  return PLUGINS.find((p) => p.id === id);
}

export function defaultParams(id: string): Record<string, number> {
  const def = findPlugin(id);
  if (!def) return {};
  const out: Record<string, number> = {};
  for (const p of def.params) out[p.id] = p.default;
  return out;
}

/** Latency a configured insert reports, used by both ADC and the UI. */
export function pluginLatencySamples(
  pluginId: string, params: Record<string, number>, sampleRate: number,
): number {
  return findPlugin(pluginId)?.latencyFor(params, sampleRate) ?? 0;
}
