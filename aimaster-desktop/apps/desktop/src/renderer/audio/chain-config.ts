// Chain config — the single bridge from UI parameter state to the Rust
// `MasteringChain`.
//
// One shape, two consumers:
//
//   • the realtime preview (WASM chain inside the AudioWorklet), and
//   • the offline export render (the same Rust chain via the Node target).
//
// That is the whole point of this module: preview and export cannot drift
// apart, because there is exactly one place that decides what a parameter
// means.  Add a knob and both paths get it.
//
// The config is a DEEP PARTIAL.  `setConfigJson` fills anything absent with
// the module's neutral default, so this builder only emits the modules the
// user has actually engaged.  A session with just a limiter on it sends a
// limiter, not 150 fields — which keeps the per-keystroke message small and
// makes the JSON readable when it turns up in a support bundle.

import type {
  AllModulesParameterState,
  ModuleId,
  ModuleParameterState,
  ParameterValue,
} from './parameters/parameter-state.js';
import { DYN_EQ_BAND_COUNT, MULTIBAND_BAND_COUNT } from './parameters/suite-parameter-definitions.js';

// ── Wire types ───────────────────────────────────────────────────────────
//
// These mirror `MasteringChainConfig` in `dsp-core/crates/loui-dsp`.  Field
// names are camelCase because that is what the Rust side deserialises.

export interface DynEqBandWire {
  enabled?: boolean;
  shape?: 'bell' | 'lowShelf' | 'highShelf';
  mode?: 'down' | 'up';
  frequencyHz?: number;
  q?: number;
  thresholdDb?: number;
  ratio?: number;
  rangeDb?: number;
  attackMs?: number;
  releaseMs?: number;
}

export interface MultibandBandWire {
  mode?: 'compress' | 'expand';
  thresholdDb?: number;
  ratio?: number;
  attackMs?: number;
  releaseMs?: number;
  makeupDb?: number;
  rangeDb?: number;
  mixPct?: number;
  solo?: boolean;
  mute?: boolean;
  bypass?: boolean;
}

/** Filter shapes the free parametric EQ can run.  Matches the Rust enum. */
export type ParametricBandKind = 'highPass' | 'lowPass' | 'bell' | 'lowShelf' | 'highShelf';

/** One band of the free parametric EQ, as it crosses the wire. */
export interface ParametricBandWire {
  kind: ParametricBandKind;
  frequencyHz: number;
  gainDb: number;
  q: number;
  enabled: boolean;
}

/**
 * How many bands the engine runs.  `MAX_PARAMETRIC_BANDS` in
 * `dsp-core/.../mastering/parametric_eq.rs` — surplus bands are dropped
 * silently there, so the UI must not offer more than this.
 */
export const MAX_PARAMETRIC_BANDS = 16;

export interface ChainConfigWire {
  inputGainDb?: number;
  outputGainDb?: number;
  bypass?: boolean;

  declick?: { sensitivity?: number; maxRunSamples?: number; bypass?: boolean };
  dehum?: {
    frequencyHz?: number; harmonics?: number; depthDb?: number;
    q?: number; adaptive?: boolean; bypass?: boolean;
  };
  denoise?: {
    reductionDb?: number; thresholdDb?: number; sharpness?: number;
    smoothing?: number; freqSmoothingBins?: number; autoProfile?: boolean; bypass?: boolean;
  };
  deess?: {
    frequencyHz?: number; thresholdDb?: number; ratio?: number; rangeDb?: number;
    attackMs?: number; releaseMs?: number; wideband?: boolean; bypass?: boolean;
  };

  spectral?: {
    matchEnabled?: boolean; matchAmountPct?: number; matchMaxMoveDb?: number;
    targetCurveDb?: number[];
    shaperEnabled?: boolean; shaperAmountPct?: number; shaperThresholdDb?: number;
    shaperLowHz?: number; shaperHighHz?: number; shaperBlurBins?: number;
    stabilizerEnabled?: boolean; stabilizerAmountPct?: number;
    stabilizerTiltDbPerOct?: number; stabilizerMaxMoveDb?: number;
    curveSmoothingBands?: number; analysisOnly?: boolean; bypass?: boolean;
  };

  vintageEq?: {
    lowFrequencyHz?: number; lowBoostDb?: number; lowCutDb?: number;
    highFrequencyHz?: number; highBoostDb?: number; highCutDb?: number;
    highBandwidth?: number; bypass?: boolean;
  };
  parametricEq?: { bands?: ParametricBandWire[]; bypass?: boolean };
  eq?: {
    // Frequency and Q travel with every band: the graph editor drags a node
    // in two axes and sets its width on the wheel.  Omitting them keeps the
    // classic 120 Hz / 3 kHz / 12 kHz layout.
    lowCutHz?: number; lowCutQ?: number;
    lowShelfHz?: number; lowShelfDb?: number; lowShelfQ?: number;
    presenceHz?: number; presenceDb?: number; presenceQ?: number;
    airHz?: number; airDb?: number; airQ?: number;
    adaptive?: boolean; bypass?: boolean;
  };
  dynamicEq?: { bands?: DynEqBandWire[]; bypass?: boolean };

  multiband?: { crossoverHz?: number[]; bands?: MultibandBandWire[]; bypass?: boolean };
  dynamics?: {
    thresholdDb?: number; ratio?: number; attackMs?: number;
    releaseMs?: number; mixPct?: number; bypass?: boolean;
  };
  vintageComp?: {
    thresholdDb?: number; ratio?: number; attackMs?: number;
    makeupDb?: number; characterPct?: number; mixPct?: number; bypass?: boolean;
  };
  impact?: { crossoverHz?: number[]; impactPct?: number[]; bypass?: boolean };
  lowEndFocus?: {
    mode?: 'punchy' | 'smooth'; frequencyHz?: number;
    contrastPct?: number; gainDb?: number; bypass?: boolean;
  };

  exciter?: {
    mode?: 'warm' | 'retro' | 'tape' | 'tube' | 'triode';
    crossoverHz?: number[]; bandAmountPct?: number[];
    driveDb?: number; outputDb?: number; bypass?: boolean;
  };
  tape?: {
    speed?: '7.5ips' | '15ips' | '30ips'; driveDb?: number; bias?: number;
    wowFlutterPct?: number; mixPct?: number; bypass?: boolean;
  };

  imager?: {
    widthPct?: number; lowMonoHz?: number;
    bandWidthPct?: number[]; crossoverHz?: number[]; bypass?: boolean;
  };
  limiter?: {
    ceilingDbtp?: number; lookaheadMs?: number; isp?: boolean;
    driveDb?: number;
    character?: 'clean' | 'transparent' | 'punchy' | 'smooth' | 'aggressive';
    bypass?: boolean;
  };
  dither?: {
    /** Target depth.  32 = float, which makes the stage a pass-through. */
    bitDepth?: number;
    mode?: 'none' | 'tpdf' | 'shaped';
    autoBlank?: boolean;
    bypass?: boolean;
  };
  monitor?: {
    mode?: MonitorMode;
    loudnessMatch?: boolean;
    matchTarget?: MatchTarget;
    deltaGainDb?: number;
  };
}

// ── Monitoring ───────────────────────────────────────────────────────────

/** What the monitor stage sends to the output. */
export type MonitorMode = 'processed' | 'bypass' | 'delta';

/** Which path the loudness match brings the other one to. */
export type MatchTarget = 'dry' | 'wet';

/**
 * Monitoring settings.
 *
 * Deliberately NOT part of the module parameter state.  Monitoring is a
 * judgement tool, not a processing decision: it belongs to the session, it
 * must not be saved into a preset, and — most importantly — it must never
 * reach an export by accident.  Keeping it out of the state means
 * `buildChainConfig({ state })` cannot emit it unless a caller explicitly
 * asks, which is a structural guarantee rather than a convention.
 */
export interface MonitorSettings {
  mode: MonitorMode;
  /**
   * Level-match the two paths before comparing.  Without this an A/B
   * compares makeup gain, not processing — the louder version wins almost
   * every time regardless of whether it is better.
   */
  loudnessMatch: boolean;
  matchTarget: MatchTarget;
  /** Make-up on the delta so a small difference is audible. */
  deltaGainDb: number;
}

/** Neutral monitoring — hear the master, unaltered. */
export const DEFAULT_MONITOR: MonitorSettings = {
  mode: 'processed',
  loudnessMatch: false,
  matchTarget: 'dry',
  deltaGainDb: 0,
};

/** Whether a monitor setting would change what comes out of the chain. */
export function monitorAltersOutput(m: MonitorSettings | undefined): boolean {
  if (!m) return false;
  return m.mode !== 'processed' || m.loudnessMatch;
}

/**
 * The limiter's UI character vocabulary predates the engine's.
 *
 * The panel offers Transparent / Glue / Aggressive / Classic — names users
 * have been choosing from since before the maximizer existed.  The engine
 * speaks Clean / Transparent / Punchy / Smooth / Aggressive.  Passing the UI
 * string straight through would make the engine reject the config, so the
 * two vocabularies are mapped here rather than renaming either side out
 * from under its users.
 */
const LIMITER_CHARACTER: Record<string, NonNullable<NonNullable<ChainConfigWire['limiter']>['character']>> = {
  transparent: 'transparent',
  glue: 'smooth',        // "warms transients" → the slow-release character
  aggressive: 'aggressive',
  classic: 'punchy',     // "vintage, soft saturation" → soft clip + fast release
  // The engine's own names pass through untouched, so a preset authored
  // against the engine vocabulary keeps working.
  clean: 'clean',
  punchy: 'punchy',
  smooth: 'smooth',
};

/**
 * Bit depth the engine renders its master at.
 *
 * Only a target BELOW this counts as a reduction worth dithering.  Exported
 * so the UI can grey out the dither controls at depths where they would do
 * nothing, rather than offering a choice that has no effect.
 */
export const MASTER_NATIVE_BIT_DEPTH = 24;

/**
 * The EQ's classic band layout, and the single place it is written down on
 * this side of the wire.
 *
 * These MUST match `EqConfig::default()` in `dsp-core/.../mastering/eq.rs`.
 * They are sent explicitly rather than left to the Rust defaults so a state
 * that has never touched a frequency still round-trips to the same numbers
 * the graph editor is drawing — a curve drawn at 3 kHz while the DSP filters
 * at some other frequency is worse than no curve at all.
 */
export const EQ_BAND_DEFAULTS = {
  lowCutQ: 0.707,
  lowShelfHz: 120,
  lowShelfQ: 0.707,
  presenceHz: 3000,
  presenceQ: 1.1,
  airHz: 12_000,
  airQ: 0.707,
} as const;

// ── Reading state ────────────────────────────────────────────────────────

function num(m: ModuleParameterState | undefined, id: string, fallback: number): number {
  const v = m?.parameters[id];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function bool(m: ModuleParameterState | undefined, id: string, fallback: boolean): boolean {
  const v = m?.parameters[id];
  return typeof v === 'boolean' ? v : fallback;
}

function str<T extends string>(m: ModuleParameterState | undefined, id: string, fallback: T): T {
  const v: ParameterValue | undefined = m?.parameters[id];
  return typeof v === 'string' ? (v as T) : fallback;
}

/**
 * Whether a module should be emitted at all.
 *
 * A module the user has not engaged is simply left out — the chain's own
 * neutral default is exactly what we would have sent, and leaving it out
 * keeps the payload (and the debug bundle) readable.  A module that is
 * *explicitly bypassed* IS emitted, because "off" is a decision the render
 * has to honour even when the parameters underneath look neutral.
 */
function engaged(m: ModuleParameterState | undefined, active: boolean): boolean {
  if (!m) return false;
  return active || m.bypass;
}

// ── Builder ──────────────────────────────────────────────────────────────

export interface ChainConfigInput {
  state: Partial<AllModulesParameterState>;
  /** Input trim ahead of the chain, in dB. */
  inputGainDb?: number;
  /**
   * Output trim after the chain, in dB.
   *
   * Optional: when omitted the builder reads the EQ module's `outputGainDb`,
   * which is where the UI's Output Gain knob lives.  Passing it explicitly
   * overrides that — used by callers that stage gain themselves.
   */
  outputGainDb?: number;
  /** Master bypass — the whole chain becomes a pass-through. */
  masterBypass?: boolean;
  /**
   * Reference curve for Match EQ, 32 dB values on the shared log grid.
   * Match EQ stays off without one, since matching to nothing is a no-op
   * that would still cost an STFT.
   */
  matchTargetCurveDb?: readonly number[];
  /**
   * Monitoring (A/B + delta).  Omit for an export — the result would not be
   * the master.
   */
  monitor?: MonitorSettings;
  /**
   * Free parametric EQ bands.
   *
   * Passed alongside the parameter state rather than inside it: the state
   * is a flat map of named scalars per module, and this list has no fixed
   * length or fixed names.  Same reason `matchTargetCurveDb` lives here.
   */
  parametricBands?: readonly ParametricBandWire[];
}

/**
 * Build the chain config for the current parameter state.
 *
 * Only engaged modules appear in the result.  The function is pure and
 * allocation-light enough to call on every parameter change; the caller
 * decides how to debounce.
 */
export function buildChainConfig(input: ChainConfigInput): ChainConfigWire {
  const s = input.state;
  const cfg: ChainConfigWire = {};

  if (input.inputGainDb) cfg.inputGainDb = input.inputGainDb;
  // The EQ panel's Output Gain is the chain's output trim.  Reading it here
  // rather than in one caller means every path behaves the same — it was
  // previously only applied by the realtime bridge, so the same knob did
  // nothing when the config was built directly.
  const outputGainDb = input.outputGainDb ?? num(s.eq, 'outputGainDb', 0);
  if (outputGainDb) cfg.outputGainDb = outputGainDb;
  if (input.masterBypass) cfg.bypass = true;

  // ── Restoration ────────────────────────────────────────────────────────
  const declick = s.declick;
  if (engaged(declick, !declick?.bypass)) {
    // De-click has no "amount" — it is on or off, so its bypass IS its
    // engagement.  Default state has it bypassed.
    cfg.declick = {
      sensitivity: num(declick, 'sensitivity', 6),
      maxRunSamples: num(declick, 'maxRunSamples', 16),
      bypass: declick!.bypass,
    };
  }

  const dehum = s.dehum;
  const dehumDepth = num(dehum, 'depthDb', 0);
  if (engaged(dehum, dehumDepth > 0)) {
    cfg.dehum = {
      frequencyHz: Number(str(dehum, 'frequencyHz', '60')),
      harmonics: num(dehum, 'harmonics', 6),
      depthDb: dehumDepth,
      q: num(dehum, 'q', 30),
      adaptive: bool(dehum, 'adaptive', true),
      bypass: dehum!.bypass,
    };
  }

  const denoise = s.denoise;
  const denoiseReduction = num(denoise, 'reductionDb', 0);
  if (engaged(denoise, denoiseReduction > 0)) {
    cfg.denoise = {
      reductionDb: denoiseReduction,
      thresholdDb: num(denoise, 'thresholdDb', 0),
      sharpness: num(denoise, 'sharpness', 1),
      smoothing: num(denoise, 'smoothing', 0.6),
      autoProfile: bool(denoise, 'autoProfile', true),
      bypass: denoise!.bypass,
    };
  }

  const deess = s.deess;
  const deessRange = num(deess, 'rangeDb', 0);
  if (engaged(deess, deessRange > 0)) {
    cfg.deess = {
      frequencyHz: num(deess, 'frequencyHz', 6500),
      thresholdDb: num(deess, 'thresholdDb', -30),
      ratio: num(deess, 'ratio', 4),
      rangeDb: deessRange,
      attackMs: num(deess, 'attackMs', 1),
      releaseMs: num(deess, 'releaseMs', 60),
      wideband: bool(deess, 'wideband', false),
      bypass: deess!.bypass,
    };
  }

  // ── Spectral stage: three UI modules, one config block ─────────────────
  const match = s['match-eq'];
  const shaper = s['spectral-shaper'];
  const stab = s.stabilizer;
  const target = input.matchTargetCurveDb;
  const matchOn = !!match && !match.bypass && num(match, 'amountPct', 0) > 0 && !!target?.length;
  const shaperOn = !!shaper && !shaper.bypass && num(shaper, 'amountPct', 0) > 0;
  const stabOn = !!stab && !stab.bypass && num(stab, 'amountPct', 0) > 0;

  if (matchOn || shaperOn || stabOn) {
    cfg.spectral = {
      matchEnabled: matchOn,
      matchAmountPct: num(match, 'amountPct', 50),
      matchMaxMoveDb: num(match, 'maxMoveDb', 9),
      ...(target?.length ? { targetCurveDb: [...target] } : {}),
      shaperEnabled: shaperOn,
      shaperAmountPct: num(shaper, 'amountPct', 50),
      shaperThresholdDb: num(shaper, 'thresholdDb', 8),
      shaperLowHz: num(shaper, 'lowHz', 1000),
      shaperHighHz: num(shaper, 'highHz', 16000),
      shaperBlurBins: num(shaper, 'blurBins', 12),
      stabilizerEnabled: stabOn,
      stabilizerAmountPct: num(stab, 'amountPct', 40),
      stabilizerTiltDbPerOct: num(stab, 'tiltDbPerOct', -1.5),
      stabilizerMaxMoveDb: num(stab, 'maxMoveDb', 6),
      curveSmoothingBands: num(match, 'smoothingBands', 2),
    };
  }

  // ── Tone ───────────────────────────────────────────────────────────────
  const veq = s['vintage-eq'];
  const veqActive =
    num(veq, 'lowBoostDb', 0) > 0 || num(veq, 'lowCutDb', 0) > 0 ||
    num(veq, 'highBoostDb', 0) > 0 || num(veq, 'highCutDb', 0) > 0;
  if (engaged(veq, veqActive)) {
    cfg.vintageEq = {
      lowFrequencyHz: num(veq, 'lowFrequencyHz', 60),
      lowBoostDb: num(veq, 'lowBoostDb', 0),
      lowCutDb: num(veq, 'lowCutDb', 0),
      highFrequencyHz: num(veq, 'highFrequencyHz', 10000),
      highBoostDb: num(veq, 'highBoostDb', 0),
      highCutDb: num(veq, 'highCutDb', 0),
      highBandwidth: num(veq, 'highBandwidth', 0.5),
      bypass: veq!.bypass,
    };
  }

  // Free parametric EQ.  Disabled bands are dropped rather than sent: the
  // engine caps at MAX_PARAMETRIC_BANDS and drops the surplus silently, so
  // sending sixteen mutes to use band seventeen would lose it.
  const peq = s['parametric-eq'];
  const freeBands = (input.parametricBands ?? [])
    .filter((b) => b.enabled && Number.isFinite(b.frequencyHz))
    .slice(0, MAX_PARAMETRIC_BANDS);
  if (freeBands.length > 0 && !(peq?.bypass ?? false)) {
    cfg.parametricEq = { bands: freeBands.map((b) => ({ ...b })), bypass: false };
  }

  const eq = s.eq;
  const eqActive =
    num(eq, 'lowCutHz', 20) > 20 || num(eq, 'lowShelfDb', 0) !== 0 ||
    num(eq, 'presenceDb', 0) !== 0 || num(eq, 'airDb', 0) !== 0 ||
    bool(eq, 'adaptive', false);
  if (engaged(eq, eqActive)) {
    cfg.eq = {
      lowCutHz: num(eq, 'lowCutHz', 20),
      lowCutQ: num(eq, 'lowCutQ', EQ_BAND_DEFAULTS.lowCutQ),
      lowShelfHz: num(eq, 'lowShelfHz', EQ_BAND_DEFAULTS.lowShelfHz),
      lowShelfDb: num(eq, 'lowShelfDb', 0),
      lowShelfQ: num(eq, 'lowShelfQ', EQ_BAND_DEFAULTS.lowShelfQ),
      presenceHz: num(eq, 'presenceHz', EQ_BAND_DEFAULTS.presenceHz),
      presenceDb: num(eq, 'presenceDb', 0),
      presenceQ: num(eq, 'presenceQ', EQ_BAND_DEFAULTS.presenceQ),
      airHz: num(eq, 'airHz', EQ_BAND_DEFAULTS.airHz),
      airDb: num(eq, 'airDb', 0),
      airQ: num(eq, 'airQ', EQ_BAND_DEFAULTS.airQ),
      adaptive: bool(eq, 'adaptive', false),
      bypass: eq!.bypass,
    };
  }

  const deq = s['dynamic-eq'];
  if (deq) {
    const bands: DynEqBandWire[] = [];
    let any = false;
    for (let i = 0; i < DYN_EQ_BAND_COUNT; i++) {
      const on = bool(deq, `band${i}Enabled`, false);
      if (on) any = true;
      bands.push({
        enabled: on,
        shape: str(deq, `band${i}Shape`, 'bell'),
        mode: str(deq, `band${i}Mode`, 'down'),
        frequencyHz: num(deq, `band${i}FrequencyHz`, 1000),
        q: num(deq, `band${i}Q`, 1),
        thresholdDb: num(deq, `band${i}ThresholdDb`, -24),
        ratio: num(deq, `band${i}Ratio`, 3),
        rangeDb: num(deq, `band${i}RangeDb`, 6),
        attackMs: num(deq, `band${i}AttackMs`, 10),
        releaseMs: num(deq, `band${i}ReleaseMs`, 120),
      });
    }
    if (engaged(deq, any)) {
      cfg.dynamicEq = { bands, bypass: deq.bypass };
    }
  }

  // ── Dynamics ───────────────────────────────────────────────────────────
  const mb = s.multiband;
  if (mb) {
    const bands: MultibandBandWire[] = [];
    let any = false;
    for (let i = 0; i < MULTIBAND_BAND_COUNT; i++) {
      const ratio = num(mb, `band${i}Ratio`, 1);
      const makeup = num(mb, `band${i}MakeupDb`, 0);
      const solo = bool(mb, `band${i}Solo`, false);
      const mute = bool(mb, `band${i}Mute`, false);
      if (ratio > 1 || makeup !== 0 || solo || mute) any = true;
      bands.push({
        mode: str(mb, `band${i}Mode`, 'compress'),
        thresholdDb: num(mb, `band${i}ThresholdDb`, 0),
        ratio,
        attackMs: num(mb, `band${i}AttackMs`, 10),
        releaseMs: num(mb, `band${i}ReleaseMs`, 120),
        makeupDb: makeup,
        mixPct: num(mb, `band${i}MixPct`, 100),
        solo,
        mute,
      });
    }
    if (engaged(mb, any)) {
      cfg.multiband = {
        crossoverHz: [
          num(mb, 'crossover1Hz', 120),
          num(mb, 'crossover2Hz', 800),
          num(mb, 'crossover3Hz', 5000),
        ],
        bands,
        bypass: mb.bypass,
      };
    }
  }

  const dyn = s.dynamics;
  if (engaged(dyn, num(dyn, 'ratio', 1) > 1)) {
    cfg.dynamics = {
      thresholdDb: num(dyn, 'thresholdDb', 0),
      ratio: num(dyn, 'ratio', 1),
      attackMs: num(dyn, 'attackMs', 10),
      releaseMs: num(dyn, 'releaseMs', 120),
      mixPct: num(dyn, 'mixPct', 100),
      bypass: dyn!.bypass,
    };
  }

  const vc = s['vintage-comp'];
  if (engaged(vc, num(vc, 'ratio', 1) > 1)) {
    cfg.vintageComp = {
      thresholdDb: num(vc, 'thresholdDb', -18),
      ratio: num(vc, 'ratio', 1),
      attackMs: num(vc, 'attackMs', 10),
      makeupDb: num(vc, 'makeupDb', 0),
      characterPct: num(vc, 'characterPct', 40),
      mixPct: num(vc, 'mixPct', 100),
      bypass: vc!.bypass,
    };
  }

  const impact = s.impact;
  if (impact) {
    const pct = Array.from({ length: MULTIBAND_BAND_COUNT }, (_, i) => num(impact, `band${i}Pct`, 0));
    if (engaged(impact, pct.some((v) => v !== 0))) {
      cfg.impact = {
        crossoverHz: [
          num(impact, 'crossover1Hz', 120),
          num(impact, 'crossover2Hz', 800),
          num(impact, 'crossover3Hz', 5000),
        ],
        impactPct: pct,
        bypass: impact.bypass,
      };
    }
  }

  const lef = s['low-end-focus'];
  const lefActive = num(lef, 'contrastPct', 0) > 0 || num(lef, 'gainDb', 0) !== 0;
  if (engaged(lef, lefActive)) {
    cfg.lowEndFocus = {
      mode: str(lef, 'mode', 'punchy'),
      frequencyHz: num(lef, 'frequencyHz', 150),
      contrastPct: num(lef, 'contrastPct', 0),
      gainDb: num(lef, 'gainDb', 0),
      bypass: lef!.bypass,
    };
  }

  // ── Character ──────────────────────────────────────────────────────────
  const exc = s.exciter;
  if (exc) {
    const amounts = Array.from({ length: MULTIBAND_BAND_COUNT }, (_, i) => num(exc, `band${i}Pct`, 0));
    const active = amounts.some((v) => v > 0) || num(exc, 'outputDb', 0) !== 0;
    if (engaged(exc, active)) {
      cfg.exciter = {
        mode: str(exc, 'mode', 'tube'),
        crossoverHz: [
          num(exc, 'crossover1Hz', 120),
          num(exc, 'crossover2Hz', 800),
          num(exc, 'crossover3Hz', 5000),
        ],
        bandAmountPct: amounts,
        driveDb: num(exc, 'driveDb', 6),
        outputDb: num(exc, 'outputDb', 0),
        bypass: exc.bypass,
      };
    }
  }

  const tape = s.tape;
  if (engaged(tape, num(tape, 'mixPct', 0) > 0)) {
    cfg.tape = {
      speed: str(tape, 'speed', '15ips'),
      driveDb: num(tape, 'driveDb', 0),
      bias: num(tape, 'bias', 0),
      wowFlutterPct: num(tape, 'wowFlutterPct', 0),
      mixPct: num(tape, 'mixPct', 0),
      bypass: tape!.bypass,
    };
  }

  // ── Stereo + output ────────────────────────────────────────────────────
  const img = s.imager;
  if (img) {
    const bandWidths = [
      num(img, 'bandLowPct', 100),
      num(img, 'bandMidLowPct', 100),
      num(img, 'bandMidHighPct', 100),
      num(img, 'bandHighPct', 100),
    ];
    const active =
      num(img, 'widthPct', 100) !== 100 ||
      num(img, 'lowMonoHz', 20) > 20 ||
      bandWidths.some((w) => w !== 100);
    if (engaged(img, active)) {
      cfg.imager = {
        widthPct: num(img, 'widthPct', 100),
        lowMonoHz: num(img, 'lowMonoHz', 20),
        bandWidthPct: bandWidths,
        bypass: img.bypass,
      };
    }
  }

  // The limiter is always emitted: it is the output stage, and a render
  // without an explicit ceiling is a render that can clip.
  const lim = s.limiter;
  cfg.limiter = {
    ceilingDbtp: num(lim, 'ceilingDbtp', -1),
    lookaheadMs: num(lim, 'lookaheadMs', 2.5),
    isp: bool(lim, 'isp', true),
    driveDb: num(lim, 'driveDb', 0),
    character: LIMITER_CHARACTER[str(lim, 'character', 'clean')] ?? 'clean',
    bypass: lim?.bypass ?? false,
  };

  // ── Dither ─────────────────────────────────────────────────────────────
  // Driven by the export module: dither only means anything against a
  // target bit depth, so the two live together.
  //
  // Engaged only when the target is BELOW the master's native depth.  The
  // engine renders at 24-bit, so 24-bit and 32-bit float are not
  // reductions and need no dither — sending it there would break the
  // chain's bit-transparency and add noise nobody asked for.  Dither is the
  // last irreversible step before a file is written; it does not turn
  // itself on.
  //
  // At 16-bit the stage is sent even at mode 'none', because quantising the
  // preview is how the user hears what their dither choice is buying them.
  const exp = s.export;
  const depth = Number(str(exp, 'bitDepth', String(MASTER_NATIVE_BIT_DEPTH)));
  if (exp && Number.isFinite(depth) && depth < MASTER_NATIVE_BIT_DEPTH) {
    cfg.dither = {
      bitDepth: depth,
      mode: str(exp, 'dither', 'tpdf'),
      autoBlank: bool(exp, 'ditherAutoBlank', true),
      bypass: exp.bypass,
    };
  }

  // ── Monitoring ─────────────────────────────────────────────────────────
  // Emitted only when it would actually do something, so an export config
  // never carries a monitor block at all.
  if (monitorAltersOutput(input.monitor)) {
    const m = input.monitor!;
    cfg.monitor = {
      mode: m.mode,
      loudnessMatch: m.loudnessMatch,
      matchTarget: m.matchTarget,
      deltaGainDb: m.deltaGainDb,
    };
  }

  return cfg;
}

/** Serialise a config for `LouiMasteringChain.setConfigJson`. */
export function chainConfigToJson(cfg: ChainConfigWire): string {
  return JSON.stringify(cfg);
}

/**
 * Modules the config actually carries, in chain order.  Used by the UI's
 * "active chain" readout so the user can see what is really running rather
 * than what is merely visible on screen.
 */
export function activeModuleIds(cfg: ChainConfigWire): ModuleId[] {
  const out: ModuleId[] = [];
  const push = (id: ModuleId, block: { bypass?: boolean } | undefined) => {
    if (block && !block.bypass) out.push(id);
  };
  push('declick', cfg.declick);
  push('dehum', cfg.dehum);
  push('denoise', cfg.denoise);
  push('deess', cfg.deess);
  if (cfg.spectral?.matchEnabled) out.push('match-eq');
  if (cfg.spectral?.shaperEnabled) out.push('spectral-shaper');
  if (cfg.spectral?.stabilizerEnabled) out.push('stabilizer');
  push('vintage-eq', cfg.vintageEq);
  push('eq', cfg.eq);
  push('dynamic-eq', cfg.dynamicEq);
  push('multiband', cfg.multiband);
  push('dynamics', cfg.dynamics);
  push('vintage-comp', cfg.vintageComp);
  push('impact', cfg.impact);
  push('low-end-focus', cfg.lowEndFocus);
  push('exciter', cfg.exciter);
  push('tape', cfg.tape);
  push('imager', cfg.imager);
  push('limiter', cfg.limiter);
  // Dither lives on the export module, so that is the row that lights up.
  if (cfg.dither && !cfg.dither.bypass) out.push('export');
  return out;
}

/**
 * Whether the chain config quantises to its target bit depth.
 *
 * The export's file writer must NOT dither again when this is true: two
 * independent dither stages give you two noise floors and none of the
 * benefit of either.
 */
export function chainDithersOutput(cfg: ChainConfigWire): boolean {
  const d = cfg.dither;
  if (!d || d.bypass || cfg.bypass) return false;
  return typeof d.bitDepth === 'number' && d.bitDepth < 32;
}
