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
  /**
   * A number the device STORES rather than a knob anyone turns.
   *
   * The match EQ keeps its measured curve as thirty-two band gains, because a
   * session stores parameters as numbers and a curve has to survive being
   * saved.  Thirty-two knobs in the panel would be unusable and would also be
   * a lie about how the value is set — it is measured, not dialled — so the
   * panel draws the curve and skips these.  Everything else still applies:
   * they are read by `create`, written by `setParam`, and saved.
   */
  curve?: boolean;
}

/** The parameters a panel should show as controls. */
export function knobParams(
  params: readonly PluginParamDef[],
): readonly PluginParamDef[] {
  return params.filter((p) => !p.curve);
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
  /**
   * The two channels as they are RIGHT NOW, for a device that draws the
   * stereo picture.
   *
   * Separate from `analyse` because it is not a number, it is a block: a
   * goniometer is a plot of left against right sample by sample, and there is
   * no summary of it that is still a goniometer.  Fills the caller's arrays
   * and returns false when there is nothing to read, so a panel can hold the
   * last frame rather than flashing an empty scope between blocks.
   */
  scope?: (left: Float32Array, right: Float32Array) => boolean;
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

/**
 * Butterworth, and why it is not 0.707.
 *
 * Web Audio reads `Q` on a LOWPASS or HIGHPASS in DECIBELS, not as a Q
 * factor: alpha = sin(w0) / (2 · 10^(Q/20)).  So the 0.707 that everybody
 * types, meaning maximally flat, is 10^(0.707/20) = 1.085 — a small
 * resonant peak just under the corner.  Measured, a lowpass at 15 kHz
 * written that way reads +0.71 dB AT its own corner where Butterworth is
 * −3.01, and is still +1.5 dB an octave into its own stopband.
 *
 * Harmless in most places and not in two: inside a feedback loop it
 * multiplies the loop gain at one frequency (the plate reverb found this
 * first — a 0.99 loop with a 1 dB peak has a loop gain of 1.11 there, which
 * is an oscillator), and in any device whose whole claim is where its
 * response ends.
 *
 * Peaking, notch, bandpass and allpass take a real Q factor; only lowpass
 * and highpass are in decibels.  Shelves ignore Q entirely.
 */
export const BUTTERWORTH_Q = -3.0103;
/**
 * What a `WaveShaper`'s oversampling and a compressor's look-ahead cost in
 * time — and the answer is a property of the RENDERER, not of the standard.
 *
 * The Web Audio spec says a shaper may oversample and says nothing about
 * latency, and says a compressor has look-ahead without saying how much.  So
 * both were measured, in both renderers this code runs in, by
 * cross-correlating broadband noise against the same noise through an
 * IDENTITY curve.  They do not agree:
 *
 *                        Chromium            node-web-audio-api
 *                        (the app)           (the offline suite)
 *   WaveShaper '4x'      192                 128
 *   WaveShaper '2x'      128                 128
 *   DynamicsCompressor   264 / 288 /         384 / 384 /
 *     at 44.1/48/88.2/96   529 / 576           640 / 640
 *
 * Chromium truncates six milliseconds to whole samples; node rounds the same
 * six milliseconds UP to whole render quanta.  Correlation at the compressor's
 * answer is 1.000 under node and 0.994 under Chromium, so it is a pure delay
 * in one and a delay plus a little filtering in the other — either way it is
 * a delay, measured with the threshold at 0 and the ratio at 1, which is no
 * compression at all.
 *
 * The method is the finding as much as the numbers are.  An IMPULSE through
 * the same shaper peaks at sample 108 under node, and 108 is not the delay:
 * the up and down filters are minimum-phase, so the peak of their response
 * arrives ahead of the group delay.  Aligning a dry path to 108 left twenty
 * samples of error and made a fifty-per-cent blend read 13 dB DOWN — worse
 * than not aligning it at all.
 *
 * It matters in two places and is invisible everywhere else:
 *
 *   · a device that blends a DRY path around an oversampled shaper combs,
 *     because the two sides arrive milliseconds apart
 *   · a device that declares zero latency puts its whole track that far
 *     behind the others, and the DAW's delay compensation believes it
 *
 * The defaults below are CHROMIUM's, because that is what the product runs:
 * the preview and the bounce are both the renderer process, so they agree
 * with each other whether or not anything ever probes.  `probeRendererLatency`
 * measures the host and installs what it finds, and `renderSession` awaits it
 * — which is how the offline suite, running on the other renderer, aligns to
 * its own 128 instead of to Chromium's 192.
 */
const CHROMIUM_OVERSAMPLE_4X = 192;

/** The look-ahead a `DynamicsCompressorNode` costs, in seconds. */
export const DYNAMICS_LOOKAHEAD_SEC = 0.006;

/** What the host actually measured, per sample rate; empty until probed. */
const measured = new Map<number, { oversample4x: number; dynamics: number }>();

/**
 * A delay in seconds that is a WHOLE number of samples at this rate.
 *
 * A device whose latency is a parameter has to delay by exactly what
 * `latencyFor` rounds to, or the difference comes back as a comb: the
 * compensation lines the other paths up against the declared integer while
 * the delay line interpolates to the fraction it was given.
 */
export function wholeSamplesSec(ctx: BaseAudioContext, ms: number): number {
  return Math.round((ms / 1000) * ctx.sampleRate) / ctx.sampleRate;
}

/** How late an oversampled (`4x`) shaper is, in this renderer. */
export function oversampleLatencySamples(sampleRate: number): number {
  return measured.get(sampleRate)?.oversample4x ?? CHROMIUM_OVERSAMPLE_4X;
}

/** How late a `DynamicsCompressorNode` is, in this renderer, at a rate. */
export function dynamicsLatencySamples(sampleRate: number): number {
  return measured.get(sampleRate)?.dynamics
    ?? Math.floor(DYNAMICS_LOOKAHEAD_SEC * sampleRate);
}

/** What a probe found, for a check that wants to state it. */
export function probedLatency(
  sampleRate: number,
): { oversample4x: number; dynamics: number } | null {
  return measured.get(sampleRate) ?? null;
}

const inFlight = new Map<number, Promise<void>>();

/**
 * Measure this renderer's shaper and compressor latency, once per rate.
 *
 * Cheap enough to await before a render — three offline passes over an eighth
 * of a second — and cached, so a session pays for it once.  A renderer with
 * no `OfflineAudioContext` (a test that only touches the model) leaves the
 * defaults in place rather than throwing.
 */
export function probeRendererLatency(sampleRate: number): Promise<void> {
  const already = inFlight.get(sampleRate);
  if (already) return already;
  const run = (async (): Promise<void> => {
    const Offline = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext })
      .OfflineAudioContext;
    if (!Offline) return;
    const n = Math.round(sampleRate / 8);
    const render = async (
      build: (ctx: BaseAudioContext, src: AudioBufferSourceNode) => AudioNode,
    ): Promise<Float32Array> => {
      const ctx = new Offline(1, n, sampleRate);
      const buffer = ctx.createBuffer(1, n, sampleRate);
      const data = buffer.getChannelData(0);
      // Deterministic, so a probe is the same measurement every time.
      let seed = 12345;
      for (let i = 0; i < n; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        data[i] = (seed / 0x7fffffff) * 2 - 1;
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      build(ctx, src).connect(ctx.destination);
      src.start();
      return (await ctx.startRendering()).getChannelData(0);
    };
    const lagOf = (dry: Float32Array, wet: Float32Array): number => {
      let best = { lag: 0, r: -2 };
      const from = Math.round(n * 0.1);
      const to = n - 1600;
      for (let lag = 0; lag <= 1024; lag++) {
        let num = 0, da = 0, db = 0;
        for (let i = from; i < to; i++) {
          const x = dry[i] ?? 0;
          const y = wet[i + lag] ?? 0;
          num += x * y; da += x * x; db += y * y;
        }
        const r = num / Math.sqrt(Math.max(1e-30, da * db));
        if (r > best.r) best = { lag, r };
      }
      return best.lag;
    };
    try {
      const dry = await render((ctx, src) => {
        const g = ctx.createGain();
        src.connect(g);
        return g;
      });
      const shaped = await render((ctx, src) => {
        const w = ctx.createWaveShaper();
        const size = 4096;
        const curve = new Float32Array(size);
        for (let i = 0; i < size; i++) curve[i] = (i / (size - 1)) * 2 - 1;
        w.curve = curve;
        w.oversample = '4x';
        src.connect(w);
        return w;
      });
      const squeezed = await render((ctx, src) => {
        const c = ctx.createDynamicsCompressor();
        c.threshold.value = 0;
        c.ratio.value = 1;
        c.knee.value = 0;
        src.connect(c);
        return c;
      });
      measured.set(sampleRate, {
        oversample4x: lagOf(dry, shaped),
        dynamics: lagOf(dry, squeezed),
      });
    } catch {
      // A renderer that cannot do this keeps the documented defaults.
    }
  })();
  inFlight.set(sampleRate, run);
  return run;
}

/**
 * A delay that puts a dry path level with a wet one that has been through an
 * oversampled shaper.
 *
 * Without it a blend is a comb filter with a percentage on it: the two sides
 * arrive milliseconds apart, and at fifty per cent they cancel rather than
 * sum.  Every parallel saturator in this rack had that, and none of them
 * looked wrong.
 */
export function oversampleAlign(ctx: BaseAudioContext): DelayNode {
  const d = ctx.createDelay(0.05);
  d.delayTime.value = oversampleLatencySamples(ctx.sampleRate) / ctx.sampleRate;
  return d;
}

/**
 * One side of a crossover that will be SUMMED BACK, as Linkwitz-Riley.
 *
 * Two cascaded Butterworth sections, which is the only arrangement that adds
 * up to one — and the reason is worth keeping, because the obvious choice is
 * wrong in a way that does not look wrong.
 *
 * A single Butterworth lowpass and highpass at the same corner do NOT sum
 * flat.  Their sum is (s² + ω0²)/(s² + ω0 s/Q + ω0²), whose numerator is zero
 * at the corner FOR ANY Q: the two halves arrive ninety degrees either side
 * of the input and cancel completely.  Measured across a pair at 2 kHz, the
 * sum reads −157 dB at the corner and is still 10 dB down half an octave
 * away — and it is the same hole at every Q, so no amount of tuning closes
 * it.  Cascaded, the same measurement reads 0.0 dB everywhere.
 *
 * `order` is how many sections a side gets: 2 is Linkwitz-Riley and sums
 * flat, 1 is the single pair and does not.
 */
export function crossoverSide(
  ctx: BaseAudioContext, kind: 'lowpass' | 'highpass', hz: number, order = 2,
): { input: BiquadFilterNode; output: BiquadFilterNode; setHz: (v: number) => void } {
  const sections: BiquadFilterNode[] = [];
  for (let i = 0; i < Math.max(1, order); i++) {
    const f = ctx.createBiquadFilter();
    f.type = kind;
    f.frequency.value = hz;
    f.Q.value = BUTTERWORTH_Q;
    if (sections.length > 0) sections[sections.length - 1]!.connect(f);
    sections.push(f);
  }
  return {
    input: sections[0]!,
    output: sections[sections.length - 1]!,
    setHz: (v) => { for (const f of sections) f.frequency.value = v; },
  };
}

/**
 * A `ChannelSplitter` that does not throw half a mono signal away.
 *
 * A splitter's `channelInterpretation` is fixed at `discrete` and cannot be
 * set — assigning to it throws — so a MONO source reaching one fills channel
 * 0 and leaves channel 1 silent.  Every mid/side device here is built on a
 * splitter, and on a mono track each of them answered with a left-only
 * signal: the side comes out as half the input instead of zero, and
 * L = M + S is the whole thing while R = M − S is nothing.
 *
 * Measured in Chromium, a mono tone through a bare splitter with channel 1
 * taken out: left −0.00 dB, right −230.97 dB.  Through this one: both −0.00.
 *
 * The offline renderer these tests run in up-mixes on its own and shows none
 * of it, which is why the check that guards this is structural.
 */
export function stereoSplit(
  ctx: BaseAudioContext,
): { input: GainNode; splitter: ChannelSplitterNode } {
  const input = ctx.createGain();
  input.channelCount = 2;
  input.channelCountMode = 'explicit';
  input.channelInterpretation = 'speakers';
  const splitter = ctx.createChannelSplitter(2);
  input.connect(splitter);
  return { input, splitter };
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
    scope?: (left: Float32Array, right: Float32Array) => boolean;
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
    // Forwarded explicitly, and every one of these has to be listed here or
    // it is silently dropped: the meter reads null forever and looks like a
    // device that is not working hard, or a scope stays empty and looks like
    // silence.  TypeScript does not catch the omission, because a builder
    // returning an extra key through a conditional spread is not an object
    // literal and so escapes the excess-property check.  `plugin-rack` has a
    // check that every optional member a builder returns survives this.
    ...(built.reduction ? { reduction: built.reduction } : {}),
    ...(built.analyse ? { analyse: built.analyse } : {}),
    ...(built.scope ? { scope: built.scope } : {}),
    dispose: () => { built.dispose?.(); },
  };
}

/** |x| shaper — the first stage of every detector here. */
export function absShaper(ctx: BaseAudioContext, points = 1025): WaveShaperNode {
  // ODD, and that is the whole of it.  A WaveShaper interpolates linearly
  // between curve points, and |x| is piecewise linear — so a curve with a
  // point exactly AT zero reproduces it exactly, at every level, forever.
  // A curve with an even number of points has no such point: the two either
  // side of zero hold the same value, interpolation between them is flat, and
  // the rectifier reports that value for everything quieter than it.
  //
  // At the 1024 points this used to have, that floor was 2/1023 → 9.77e-4,
  // and measured it is exactly what every detector in this app was doing:
  //
  //     tone at  -40 dBFS   detector read -43.9 dBFS   (2A/π, correct)
  //     tone at  -60 dBFS   detector read -60.2 dBFS
  //     tone at  -70 dBFS   detector read -60.2 dBFS
  //     tone at  -80 dBFS   detector read -60.2 dBFS
  //
  // Every dynamics device here shares this rectifier, so below −60 dBFS all
  // of them were looking at a constant — a gate with its threshold at −70 dB
  // could never close, and an upward compressor, whose entire job is down
  // there, could not work at all.
  const n = Math.max(3, points % 2 === 0 ? points + 1 : points);
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
  input: AudioNode;
  output: AudioNode;
  setTimeMs: (timeMs: number) => void;
}

/**
 * The envelope follower behind a level detector.
 *
 * Four poles, not one, and never faster than `DETECTOR_MIN_MS`.
 *
 * A single pole at the requested time constant is what a detector "should" be,
 * and it is why the compressor screamed: ask for a 0.1 ms attack and the
 * filter sits at 1591 Hz, so the ripple of the rectified waveform itself walks
 * straight into the gain stage.  That is not compression, it is ring
 * modulation, and on a vocal it is unlistenable.
 *
 * A rectified 100 Hz tone ripples at 200 Hz.  Four poles at the 60 Hz ceiling
 * put that 45 dB down, measured, while still settling in 8.96 ms — and 8.96 ms
 * is therefore the fastest any knob here can honestly offer.  Every device's
 * own minimum is at or above it, so nothing is clamped behind the user's back.
 *
 * The lag is rebuilt rather than retuned because its coefficients are fixed
 * when it is made; the input and output gains stay put so callers never have
 * to re-wire.
 *
 * The output carries π/2, and that is the calibration.  A rectified sine
 * averages to 2A/π, so a detector that stops there reports every sine
 * 3.92 dB under its own amplitude — and every device that compares this
 * against a threshold marked in decibels is wrong by that much.  Measured,
 * before this:
 *
 *     ducker set to −24 dB      started ducking at −20.1 dB
 *     limiter set to −6 dB      let a 0 dBFS sine out at −2.07 dB
 *
 * The limiter is the one that makes it a defect rather than an offset: a
 * ceiling is a promise, and it was passing min(3.92, input − ceiling) over
 * the number on the panel.  π/2 puts a sine back where the meter says it is.
 *
 * Anything with a different crest factor lands somewhere else — a square
 * reads 1.96 dB high — and that is what an average-responding detector IS.
 * It is the right kind here: these devices act on how loud a passage is, and
 * the limiter has a `lookaheadMs` and a true-peak stage for what peaks do.
 */
export function smoother(ctx: BaseAudioContext, timeMs: number): Smoother {
  const input = ctx.createGain();
  const output = ctx.createGain();
  output.gain.value = Math.PI / 2;
  let lag = detectorLag(ctx, timeMs);
  input.connect(lag.input);
  lag.output.connect(output);

  return {
    input,
    output,
    setTimeMs: (ms) => {
      try { input.disconnect(lag.input); lag.output.disconnect(); } catch { /* gone */ }
      lag = detectorLag(ctx, ms);
      input.connect(lag.input);
      lag.output.connect(output);
    },
  };
}

/**
 * Poles in the detector, all of them real.
 *
 * Not a Butterworth cascade, and the difference is the whole of this block.
 * A Butterworth's poles are complex, so its step response OVERSHOOTS — about
 * 11% for four poles, which is unremarkable in a filter and ruinous in an
 * envelope.  Measured, a step from 1 down to 0.01 through the four-pole
 * Butterworth this used to be:
 *
 *     the envelope went NEGATIVE and climbed back to 0.01 from underneath
 *
 * An envelope that goes negative is not a level, and everything downstream
 * reads it as one.  On the way back up it crosses a gate's ramp from below,
 * and the gate re-opens on a signal that has already stopped: measured on a
 * burst ending into a quiet tone, the gate shut, then opened again 180 ms
 * later to −8 dB for 50 ms.  A compressor does the same thing with its gain.
 *
 * Identical real poles cannot overshoot a monotone input, ever, at any count.
 * What they cost is skirt: for the same settling time their corner sits
 * higher, so there is less rejection of the ripple the rectifier leaves.
 * Measured, a 100 Hz tone rectified (so ripple at 200 Hz) at the fastest
 * setting this allows:
 *
 *     2 real poles  −32.3 dB      6 real poles  −39.8 dB
 *     4 real poles  −39.0 dB      8 real poles  −38.2 dB
 *     the four-pole Butterworth that rang:  −45.4 dB
 *
 * Six is the best of them — more poles push the corner up faster than the
 * extra slope buys back — and it gives away 5.6 dB against a filter that
 * cannot be used as an envelope.  At any setting slower than about 50 ms the
 * ripple is below −85 dB either way.
 */
export const DETECTOR_POLES = 6;

/**
 * How long a cascade of `poles` identical one-poles takes to reach 63.2%, in
 * units of one pole's time constant.
 *
 * Solved rather than looked up: the step response of N identical poles is
 * 1 − e^(−u)·Σ u^k/k!, and this is the u where that reaches 0.632.  One pole
 * gives 1, two give 2.1456, six give 6.507 — roughly N + ½, which is not a
 * rule worth relying on, which is why it is solved.
 */
function settleFactor(poles: number): number {
  const missing = (u: number): number => {
    let sum = 0, term = 1;
    for (let k = 0; k < poles; k++) { sum += term; term *= u / (k + 1); }
    return 1 - Math.exp(-u) * sum - 0.632;
  };
  let low = 0, high = 60;
  for (let i = 0; i < 200; i++) {
    const mid = (low + high) / 2;
    if (missing(mid) < 0) low = mid; else high = mid;
  }
  return (low + high) / 2;
}

export const DETECTOR_SETTLE = settleFactor(DETECTOR_POLES);

/**
 * The fastest a detector here can honestly be asked to be.
 *
 * The ripple ceiling, and the number is inherited rather than rederived: it
 * is what the previous detector's 60 Hz corner amounted to, every device's
 * parameter minimum was moved to it, and the measurement above is taken at
 * it.  Below it the detector starts reading the rectified waveform instead of
 * its level.
 */
export const DETECTOR_MIN_MS = 8.96;

/** One pole's time constant, for a detector asked to settle in `timeMs`. */
export function detectorTau(timeMs: number): number {
  return Math.max(DETECTOR_MIN_MS, timeMs) / 1000 / DETECTOR_SETTLE;
}

/**
 * The lag every level detector in this app is built from.
 *
 * `IIRFilterNode` rather than `BiquadFilterNode`, and that is the second half
 * of this block's history.  A biquad derives its coefficients from cos(ω₀),
 * and as ω₀ goes to zero that cosine goes to one — so a detector's corner,
 * which is a fraction of a hertz, lands where the arithmetic has nothing
 * left.  Measured in Chromium, the DC gain of ONE lowpass `BiquadFilterNode`:
 *
 *     0.5 Hz  ×5.49      2 Hz  ×1.87       13.4 Hz  ×0.99
 *       1 Hz  ×12.66     3 Hz  ×1.39         20 Hz  ×1.00
 *    1.34 Hz  ×18.49     5 Hz  ×1.14         40 Hz  ×1.00
 *
 * A detector passes DC untouched or it is not a detector; at 1.34 Hz, which
 * is what a 400 ms release asks for, it multiplied it by eighteen.  The
 * offline renderer these tests run in computes the same coefficients in wider
 * arithmetic and shows none of it.  A one-pole handed its coefficient
 * directly has no cosine to lose, and both renderers agree to every digit.
 *
 * The coefficients are fixed when the node is made, so changing the time
 * means building a new lag — which is what `smoother` does.
 */
export interface DetectorLag {
  input: AudioNode;
  output: AudioNode;
}

export function detectorLag(ctx: BaseAudioContext, timeMs: number): DetectorLag {
  const a = 1 - Math.exp(-1 / (detectorTau(timeMs) * ctx.sampleRate));
  const first = ctx.createIIRFilter([a, 0], [1, -(1 - a)]);
  let last: AudioNode = first;
  for (let i = 1; i < DETECTOR_POLES; i++) {
    const next = ctx.createIIRFilter([a, 0], [1, -(1 - a)]);
    last.connect(next);
    last = next;
  }
  return { input: first, output: last };
}

/**
 * A detector with a real attack and a real release.
 *
 * `smoother` has one time constant.  A device that wants two — fast to
 * follow the signal up, slow to let it back down — cannot get them from one
 * filter, and the two devices in this app that advertise both knobs
 * (`ducker`, `gate`) hand them to the same `setTimeMs`, so whichever the user
 * touched last is the only one that does anything.
 *
 * Two lags and a maximum gives both, and the maximum is native:
 *
 *     max(a, b) = (a + b + |a − b|) / 2
 *
 * — a sum, a difference and a `WaveShaper` holding |x|.  When the signal
 * rises the fast one is above, so the envelope rises at the attack; when it
 * falls the fast one drops below, so the envelope falls at the release.
 *
 * The absolute-value shaper is given far more points than `absShaper`'s
 * default for a reason particular to this use: the difference between two
 * envelopes of a quiet signal is itself tiny, and coarse steps there turn the
 * maximum back into an average exactly where an upward compressor works.
 *
 * Half, for the average in that maximum — and π/2 on top of it, which is the
 * calibration.  A rectified sine averages to 2A/π, so a detector that stops
 * there reports every sine 3.92 dB below its own amplitude and a threshold
 * knob marked in decibels is wrong by that much.  π/2 puts a sine back where
 * the meter says it is.  Anything with a different crest factor lands
 * somewhere else, which is what an average-responding detector IS — a square
 * reads 1.96 dB high — and it is the right kind for a device that acts on how
 * loud a passage is rather than on what its peaks do.
 */
export interface EnvelopeFollower {
  /** Rectified level in. */
  input: AudioNode;
  /** The envelope out. */
  output: AudioNode;
  setAttackMs: (ms: number) => void;
  setReleaseMs: (ms: number) => void;
  dispose: () => void;
}

export function envelopeFollower(
  ctx: BaseAudioContext, attackMs: number, releaseMs: number,
): EnvelopeFollower {
  const input = ctx.createGain();
  const sum = ctx.createGain();
  const difference = ctx.createGain();
  const negate = ctx.createGain();
  negate.gain.value = -1;
  const magnitude = absShaper(ctx, 32_769);
  difference.connect(magnitude).connect(sum);
  const half = ctx.createGain();
  // Half for the average in max(a,b), and π/2 for the calibration `smoother`
  // carries — see it for why a detector that reports 2A/π is wrong about
  // every threshold built on it.
  half.gain.value = Math.PI / 4;
  sum.connect(half);

  let fast = detectorLag(ctx, attackMs);
  let slow = detectorLag(ctx, releaseMs);
  const wire = (pair: DetectorLag, invert: boolean): void => {
    input.connect(pair.input);
    pair.output.connect(sum);
    if (invert) pair.output.connect(negate);
    else pair.output.connect(difference);
  };
  negate.connect(difference);
  wire(fast, false);
  wire(slow, true);

  // The coefficients are fixed when the node is made, so a new time means a
  // new pair — the same swap the transfer curves do, for the same reason.
  const replace = (which: 'fast' | 'slow', ms: number): void => {
    const old = which === 'fast' ? fast : slow;
    try { input.disconnect(old.input); old.output.disconnect(); } catch { /* already gone */ }
    const next = detectorLag(ctx, ms);
    if (which === 'fast') fast = next; else slow = next;
    wire(next, which === 'slow');
  };

  return {
    input,
    output: half,
    setAttackMs: (ms) => replace('fast', ms),
    setReleaseMs: (ms) => replace('slow', ms),
    dispose: () => {
      try { fast.output.disconnect(); slow.output.disconnect(); } catch { /* ignore */ }
      try { magnitude.disconnect(); negate.disconnect(); } catch { /* ignore */ }
    },
  };
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

