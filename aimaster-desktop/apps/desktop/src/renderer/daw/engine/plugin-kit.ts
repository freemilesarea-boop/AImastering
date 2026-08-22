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

/**
 * A parameter that is ONE AudioParam, so it can be automated.
 *
 * This is the whole basis of plugin automation here.  `setParam` sets a value
 * now; an AudioParam can be given a ramp that the audio thread walks sample by
 * sample — which means a filter sweep is smooth instead of stepped, and, far
 * more importantly, that the SAME schedule renders in an OfflineAudioContext.
 * Anything driven by timers would be live-only, and a bounce that does not
 * reproduce what you monitored is not a bounce.
 *
 * `map` converts the lane's units into the AudioParam's: a volume lane is in
 * decibels and a GainNode is linear, so the ramp has to be built from mapped
 * values rather than from the raw ones.
 */
export interface AutomatableParam {
  param: AudioParam;
  /** Lane value → AudioParam value.  Identity when absent. */
  map?: (value: number) => number;
}

/** Build an `automatable` lookup from a plain table of the device's params. */
export function automatableFrom(
  table: Record<string, AudioParam | AutomatableParam>,
): (id: string) => AutomatableParam | null {
  return (id: string): AutomatableParam | null => {
    const entry = table[id];
    if (!entry) return null;
    return 'param' in entry ? entry : { param: entry };
  };
}

/**
 * The AudioParams a knob moves, whether the device couples any or not.
 *
 * One place, so a caller never has to know which devices bothered to
 * declare a coupling.
 */
export function paramsDrivenBy(
  instance: Pick<PluginInstance, 'automatable' | 'drives'>, paramId: string,
): AutomatableParam[] {
  const coupled = instance.drives?.(paramId);
  if (coupled && coupled.length > 0) return coupled;
  const single = instance.automatable?.(paramId);
  return single ? [single] : [];
}

export interface PluginInstance {
  input: AudioNode;
  output: AudioNode;
  /** Key input, for plugins that have one. */
  sidechain: AudioNode | null;
  latencySamples: number;
  setParam: (id: string, value: number) => void;
  /**
   * The AudioParam behind one parameter, when there is exactly one.
   *
   * Absent, or returning null, means the parameter cannot be automated — the
   * device rebuilds a curve, splits the value across two nodes, or picks an
   * impulse response.  The UI reads `PluginDescriptor.automatableParams` and
   * only offers lanes for the ones that answer.
   */
  automatable?: (id: string) => AutomatableParam | null;
  /**
   * EVERY AudioParam one knob moves, for callers driving the device from a
   * single scalar.
   *
   * `automatable` answers "is this knob one parameter a lane can ride", and
   * some knobs are not: the compressor's threshold also moves its makeup
   * compensation, and the saturation's drive also moves its level trim.  A
   * lane on one of those alone would leave the other behind, which is why
   * they are not offered as insert lanes.
   *
   * A MACRO is different.  It computes every parameter of the rack from one
   * value, so it can move a coupled pair in step and stay consistent — the
   * coupling is not a problem when one number decides both.  This is how it
   * asks what to move.
   *
   * Absent means "the same as `automatable`" — see `paramsDrivenBy`.
   */
  drives?: (id: string) => AutomatableParam[] | null;
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
  /**
   * Which of `params` can carry an automation lane.
   *
   * Declared on the descriptor because the UI has to build the lane menu
   * without an AudioContext.  The selftest creates every device and checks
   * this list against what the instance actually hands back, so the two
   * cannot drift into offering a lane that does nothing.
   */
  automatableParams?: readonly string[];
  /**
   * Params that move only when ONE SCALAR decides them all — the descriptor
   * side of `PluginInstance.drives`.
   *
   * Declared here for the same reason as `automatableParams`: the UI works
   * out what a macro can do without an AudioContext.  These are deliberately
   * NOT lane targets; they are coupled, and a lane on one alone would leave
   * its partner behind.  The selftest checks this list against what an
   * instance actually hands back.
   */
  drivenParams?: readonly string[];
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
    automatable?: (id: string) => AutomatableParam | null;
    drives?: (id: string) => AutomatableParam[] | null;
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
    ...(built.automatable ? { automatable: built.automatable } : {}),
    ...(built.drives ? { drives: built.drives } : {}),
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

// ── Wet / dry ─────────────────────────────────────────────────────────────────

/**
 * A wet/dry blend whose control is ONE AudioParam, so a lane can ride it.
 *
 * The obvious way — `wet.gain.value = m; dry.gain.value = 1 - m` — writes two
 * parameters from one knob, and there is no way to hand an automation lane
 * "both of those".  So the knob becomes a signal instead: a DC source scaled
 * by `mix`, fed into `wet.gain`, and subtracted from a second DC of 1 into
 * `dry.gain`.  One AudioParam (`mix`) now moves both sides at audio rate, in
 * the offline render exactly as live.
 *
 * The DC is a looping buffer of ones rather than a `ConstantSourceNode`, for
 * the same reason the reverbs use one: the buffer source exists in every
 * implementation this engine renders in, including the self-tests'.
 *
 * The blend is LINEAR, matching what these devices did before — this exists
 * to make the existing control automatable, not to change how it sounds.
 */
export interface WetDry {
  /** Wet path in.  Its gain is driven by the control; do not write it. */
  wet: GainNode;
  /** Dry path in.  Its gain is `1 - mix`; do not write it. */
  dry: GainNode;
  /** The single automatable control, 0 = dry, 1 = wet. */
  mix: AudioParam;
  setMix: (value01: number) => void;
  dispose: () => void;
}

export interface WetDryOptions {
  /**
   * How far the dry side falls as the wet side rises: `dry = 1 - mix × slope`.
   *
   * 1 is a true crossfade.  The chorus uses 0.5, so a fully wet setting still
   * carries half the original — without it the body drops out of the sound
   * at the top of the knob.
   */
  drySlope?: number;
}

export function wetDry(
  ctx: BaseAudioContext, mix01: number, options: WetDryOptions = {},
): WetDry {
  const dc = (value: number): GainNode => {
    const buffer = ctx.createBuffer(1, 128, ctx.sampleRate);
    buffer.getChannelData(0).fill(1);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = value;
    source.connect(gain);
    source.start(0);
    sources.push(source);
    return gain;
  };
  const sources: AudioBufferSourceNode[] = [];

  const clamped = Math.max(0, Math.min(1, mix01));
  const control = dc(clamped);            // carries `mix`
  const unity = dc(1);                    // carries 1
  const invert = ctx.createGain();
  invert.gain.value = -(options.drySlope ?? 1);

  const wet = ctx.createGain();
  const dry = ctx.createGain();
  // Both start at zero: the value arrives entirely through the control
  // signals, so there is never a moment where the knob and the graph disagree.
  wet.gain.value = 0;
  dry.gain.value = 0;

  control.connect(wet.gain);
  unity.connect(dry.gain);
  control.connect(invert).connect(dry.gain);

  return {
    wet,
    dry,
    mix: control.gain,
    setMix: (value) => { control.gain.value = Math.max(0, Math.min(1, value)); },
    dispose: () => {
      for (const source of sources) { try { source.stop(); } catch { /* already stopped */ } }
    },
  };
}

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

