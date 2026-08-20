// The parts every device is built from.
//
// Split out of the registry so the device list can grow without the file that
// holds it turning into something nobody can read.  Nothing here knows which
// plugins exist; everything here is what they are made of.
//
// The rule that shapes all of it: NATIVE WEB AUDIO NODES ONLY.  A live channel
// and an offline bounce must be the same graph, so a device that cannot be
// expressed as filters, gains, delays and shapers does not belong in the
// realtime chain — it belongs in the render path, flagged `offline`.

export interface PluginParamDef {
  id: string;
  name: string;
  min: number;
  max: number;
  default: number;
  unit: string;
  /**
   * A list to pick from rather than a range to sweep.
   *
   * The value is still a number — the index — because a session stores
   * parameters as numbers and always has.  What changes is the control: a
   * thirty-one-position knob is unusable, and a list is not.
   */
  choices?: readonly string[];
  /** One line per choice, shown under the picker.  Same length as `choices`. */
  choiceNotes?: readonly string[];
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
  /**
   * Gain reduction right now, in dB (0 = none, negative = pulling down).
   * Present only on devices that actually know — a meter that guesses is
   * worse than no meter.
   */
  reduction?: () => number;
  /**
   * A measurement the device takes of the signal passing through it, for
   * devices whose whole job is to measure.  Present only where it is real.
   */
  analyse?: () => { lufs: number; peakDb: number };
  dispose: () => void;
}

/**
 * How the picker groups devices.
 *
 * Grouped the way a chain is built, not the way the code is organised: an
 * engineer reaches for "something to control dynamics", not for "something
 * implemented with a DynamicsCompressorNode".
 */
export type PluginCategory =
  | 'eq' | 'dynamics' | 'saturation' | 'modulation' | 'delay' | 'reverb'
  | 'imaging' | 'restore' | 'pitch' | 'utility' | 'master'
  // Installed on the machine rather than defined here.
  | 'external';

export interface PluginDescriptor {
  id: string;
  name: string;
  category: PluginCategory;
  /**
   * Devices that cannot run in the realtime graph (they need to look at the
   * whole file).  They stay visible in the chain — greyed, badged OFFLINE —
   * and are applied by the render path instead of silently doing nothing.
   */
  offline?: boolean;
  /**
   * The device runs an LFO whose phase follows the audio context rather than
   * the song position, so a bounce will not reproduce the phase you monitored.
   * True of unsynced modulation everywhere; said out loud here because live
   * and offline are otherwise identical in this engine.
   */
  freeRunning?: boolean;
  params: PluginParamDef[];
  hasSidechain: boolean;
  /** Reported latency, in samples at the context rate — drives ADC. */
  latencyFor: (params: Record<string, number>, sampleRate: number) => number;
  create: (ctx: BaseAudioContext, params: Record<string, number>) => PluginInstance;
}

export const dbToGain = (db: number): number => (db <= -144 ? 0 : Math.pow(10, db / 20));

/** Wrap a processing chain with a bypass path that keeps latency identical. */
export function withBypass(
  ctx: BaseAudioContext,
  build: (input: GainNode, output: GainNode) => {
    setParam: (id: string, v: number) => void;
    dispose?: () => void;
    sidechain?: AudioNode | null;
    setSidechainActive?: (a: boolean) => void;
    reduction?: () => number;
    analyse?: () => { lufs: number; peakDb: number };
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
    // Forwarded explicitly.  Dropping these here is invisible — the meter just
    // reads null forever and looks like a device that is not working hard.
    ...(built.reduction ? { reduction: built.reduction } : {}),
    ...(built.analyse ? { analyse: built.analyse } : {}),
    dispose: () => { built.dispose?.(); },
  };
}

/** |x| shaper — the first stage of every detector here. */
export function absShaper(ctx: BaseAudioContext): WaveShaperNode {
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
export function makeGainCurve(
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
export function tanhCurve(bias = 0): Float32Array<ArrayBuffer> {
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
export function halfWaveGainCurve(amount: number, side: 'positive' | 'negative'): Float32Array<ArrayBuffer> {
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
export function makeExpanderCurve(
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
export function makeDbReductionCurve(
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
export function makeShaper(
  ctx: BaseAudioContext, curve: Float32Array<ArrayBuffer>,
  oversample: OverSampleType = 'none',
): WaveShaperNode {
  const shaper = ctx.createWaveShaper();
  shaper.curve = curve;
  shaper.oversample = oversample;
  return shaper;
}

/** One-pole smoother, expressed as a lowpass corner from a time constant. */
/**
 * The envelope follower behind a level detector.
 *
 * Two poles, not one, and never above `DETECTOR_MAX_HZ`.
 *
 * A single pole at the requested time constant is what a detector "should" be,
 * and it is why the compressor screamed: ask for a 0.1 ms attack and the
 * filter sits at 1591 Hz, so the ripple of the rectified waveform itself walks
 * straight into the gain stage.  That is not compression, it is ring
 * modulation, and on a vocal it is unlistenable.
 *
 * A rectified 440 Hz tone ripples at 880 Hz.  Two poles at 60 Hz put that
 * 46 dB down, which is inaudible, while still settling in about 3 ms — fast
 * enough for a limiter with 2 ms of look-ahead.
 */
const DETECTOR_MAX_HZ = 60;

export interface Smoother {
  input: BiquadFilterNode;
  output: BiquadFilterNode;
  setTimeMs: (timeMs: number) => void;
}

export function smoother(ctx: BaseAudioContext, timeMs: number): Smoother {
  const make = (): BiquadFilterNode => {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 0.7071;
    return f;
  };
  const first = make();
  const second = make();
  first.connect(second);

  const setTimeMs = (ms: number): void => {
    const hz = Math.min(DETECTOR_MAX_HZ, timeConstantToHz(ms));
    first.frequency.value = hz;
    second.frequency.value = hz;
  };
  setTimeMs(timeMs);
  return { input: first, output: second, setTimeMs };
}

export function timeConstantToHz(timeMs: number): number {
  const tau = Math.max(0.0005, timeMs / 1000);
  return Math.max(0.5, Math.min(20_000, 1 / (2 * Math.PI * tau)));
}

// ── Registry ──────────────────────────────────────────────────────────────────


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

