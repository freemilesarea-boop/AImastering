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
  category: 'utility' | 'eq' | 'dynamics' | 'delay' | 'reverb';
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
