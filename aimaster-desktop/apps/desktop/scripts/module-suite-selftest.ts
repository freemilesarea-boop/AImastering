// Module suite self-test — parameter state → chain config → real DSP.
//
// The chain config is the one place where a UI parameter becomes an audible
// decision, and it feeds BOTH the realtime preview and the export render.
// A bug here is silent: the knob moves, the number changes, and nothing
// happens to the audio.  So this harness does not stop at the JSON — it
// loads the actual node-target WASM chain, pushes the config through it,
// and measures what came out.
//
// Run:  pnpm --filter @aimaster/desktop test:module-suite

import {
  ALL_MODULE_PARAMETER_DEFS,
  MODULE_IDS,
  defaultAllModulesState,
  type AllModulesParameterState,
  type ModuleId,
  type ParameterValue,
} from '../src/renderer/audio/parameters/index.js';
import { SUITE_PARAMETER_DEFS } from '../src/renderer/audio/parameters/suite-parameter-definitions.js';
import {
  buildChainConfig,
  chainConfigToJson,
  activeModuleIds,
  chainDithersOutput,
  MASTER_NATIVE_BIT_DEPTH,
  DEFAULT_MONITOR,
  monitorAltersOutput,
  type MonitorSettings,
} from '../src/renderer/audio/chain-config.js';
import { buildTranscodePlan, needsTranscode } from '../src/main/utils/audioTranscode.js';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

// ── Harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    passed++;
    console.log(`[PASS] ${name} — ${detail}`);
  } else {
    failed++;
    console.error(`[FAIL] ${name} — ${detail}`);
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────

const SR = 48_000;

function baseState(): AllModulesParameterState {
  return defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS);
}

/**
 * A baseline with the product's default master chain switched off.
 *
 * The shipped defaults are deliberately non-neutral — a gentle EQ curve,
 * glue at 2:1, a 120 Hz low-mono fold.  That is right for a user opening
 * the app and wrong for a test that wants to measure ONE module: without
 * this, every isolation check would be reading the default compressor.
 */
function neutralState(): AllModulesParameterState {
  const s = baseState();
  for (const id of ['eq', 'dynamics', 'imager', 'limiter'] as ModuleId[]) {
    s[id] = { ...s[id], bypass: true };
  }
  return s;
}

/** Clear a module's bypass — needed for the ones that ship switched off. */
function engage(state: AllModulesParameterState, moduleId: ModuleId): AllModulesParameterState {
  return { ...state, [moduleId]: { ...state[moduleId], bypass: false } };
}

function withParam(
  state: AllModulesParameterState,
  moduleId: ModuleId,
  id: string,
  value: ParameterValue,
): AllModulesParameterState {
  return {
    ...state,
    [moduleId]: {
      ...state[moduleId],
      parameters: { ...state[moduleId].parameters, [id]: value },
    },
  };
}

function sine(n: number, freq: number, amp = 0.4): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / SR) * amp;
  return out;
}

function rms(x: Float32Array, from = 0): number {
  let acc = 0;
  for (let i = from; i < x.length; i++) acc += x[i]! * x[i]!;
  return Math.sqrt(acc / (x.length - from));
}

function peak(x: Float32Array): number {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  return m;
}

// ── 1. Config shape ──────────────────────────────────────────────────────

console.log('\n=== MODULE SUITE — state → chain config ===\n');

{
  const cfg = buildChainConfig({ state: baseState() });
  const keys = Object.keys(cfg);
  // The product ships a gentle default master chain — EQ, glue and imager
  // have deliberately non-neutral defaults — so those legitimately appear.
  // What must NOT appear is any suite module the user has not asked for:
  // a default session should cost no restoration, no spectral stage and no
  // character processing.
  const SUITE_KEYS = [
    'denoise', 'dehum', 'deess', 'spectral', 'vintageEq', 'dynamicEq',
    'multiband', 'vintageComp', 'impact', 'lowEndFocus', 'exciter', 'tape',
  ];
  const leaked = SUITE_KEYS.filter((k) => k in cfg);
  check('no suite module is engaged by default', leaked.length === 0, `leaked=[${leaked.join(', ')}]`);
  check('the limiter is always emitted', 'limiter' in cfg, `keys=[${keys.join(', ')}]`);

  const active = activeModuleIds(cfg);
  const stft = ['denoise', 'match-eq', 'spectral-shaper', 'stabilizer'].filter((m) => active.includes(m as never));
  check('no STFT module runs by default', stft.length === 0, `stft active=[${stft.join(', ')}]`);
}

{
  // The limiter panel's character vocabulary predates the engine's; the
  // config must translate rather than hand the engine a name it rejects.
  const state = withParam(baseState(), 'limiter', 'character', 'glue');
  const cfg = buildChainConfig({ state });
  const ENGINE_CHARACTERS = ['clean', 'transparent', 'punchy', 'smooth', 'aggressive'];
  check(
    'limiter character maps to an engine value',
    ENGINE_CHARACTERS.includes(cfg.limiter?.character ?? ''),
    `glue → ${cfg.limiter?.character}`,
  );
}

{
  const state = withParam(baseState(), 'denoise', 'reductionDb', 14);
  const cfg = buildChainConfig({ state });
  check(
    'engaging a module emits it',
    cfg.denoise?.reductionDb === 14,
    `denoise.reductionDb=${cfg.denoise?.reductionDb}`,
  );
  check(
    'activeModuleIds reports the engaged module',
    activeModuleIds(cfg).includes('denoise'),
    `active=[${activeModuleIds(cfg).join(', ')}]`,
  );
}

{
  // "Off" is a decision the render must honour, so a bypassed module is
  // emitted rather than dropped as if it were untouched.
  const base = baseState();
  const state: AllModulesParameterState = {
    ...base,
    exciter: { ...base.exciter, bypass: true },
  };
  const cfg = buildChainConfig({ state });
  check(
    'an explicitly bypassed module is still emitted',
    cfg.exciter?.bypass === true,
    `exciter.bypass=${cfg.exciter?.bypass}`,
  );
  check(
    'a bypassed module is not counted as active',
    !activeModuleIds(cfg).includes('exciter'),
    `active=[${activeModuleIds(cfg).join(', ')}]`,
  );
}

{
  // Match EQ costs an STFT.  Without a reference curve there is nothing to
  // match, so it must not switch itself on.
  const state = withParam(engage(baseState(), 'match-eq'), 'match-eq', 'amountPct', 80);
  const withoutCurve = buildChainConfig({ state });
  const curve = Array.from({ length: 32 }, (_, i) => i * 0.2);
  const withCurve = buildChainConfig({ state, matchTargetCurveDb: curve });
  check(
    'Match EQ stays off without a reference curve',
    withoutCurve.spectral?.matchEnabled !== true,
    `matchEnabled=${withoutCurve.spectral?.matchEnabled}`,
  );
  check(
    'Match EQ engages once a curve is supplied',
    withCurve.spectral?.matchEnabled === true && withCurve.spectral?.targetCurveDb?.length === 32,
    `matchEnabled=${withCurve.spectral?.matchEnabled} curve=${withCurve.spectral?.targetCurveDb?.length}`,
  );
}

{
  // Every module id must have definitions, or its panel renders empty.
  const missing = MODULE_IDS.filter((id) => !ALL_MODULE_PARAMETER_DEFS[id]);
  check('every module id has parameter definitions', missing.length === 0, `missing=[${missing.join(', ')}]`);

  const emptyDefs = MODULE_IDS.filter((id) => ALL_MODULE_PARAMETER_DEFS[id].parameters.length === 0);
  check('no module has an empty parameter list', emptyDefs.length === 0, `empty=[${emptyDefs.join(', ')}]`);

  // A suite binding must name a dotted chain-config path — a bare field
  // name is a knob that silently does nothing.  (The five original modules
  // predate this convention and use EngineSchema-relative paths, so they
  // are checked by their own harnesses, not here.)
  const badPaths: string[] = [];
  for (const id of Object.keys(SUITE_PARAMETER_DEFS) as ModuleId[]) {
    for (const p of ALL_MODULE_PARAMETER_DEFS[id].parameters) {
      if (!p.binding.path.includes('.')) badPaths.push(`${id}.${p.id}`);
    }
  }
  check('every suite binding names a config path', badPaths.length === 0, `bad=[${badPaths.join(', ')}]`);
}

// ── 1b. Dither ───────────────────────────────────────────────────────────

console.log('\n=== DITHER — config + export-path interlock ===\n');

{
  // Only a depth BELOW the master's native 24-bit is a reduction.  At 24 and
  // at 32-bit float the stage must not be sent — dither must never turn
  // itself on, and a neutral chain has to stay bit-transparent.
  for (const depth of ['24', '32']) {
    const state = withParam(baseState(), 'export', 'bitDepth', depth);
    const cfg = buildChainConfig({ state });
    check(`no dither at ${depth}-bit`, cfg.dither === undefined, `dither=${JSON.stringify(cfg.dither)}`);
    check(`chainDithersOutput is false at ${depth}-bit`, !chainDithersOutput(cfg), 'false');
  }
  check(
    'the native master depth is what the reduction is judged against',
    MASTER_NATIVE_BIT_DEPTH === 24,
    `${MASTER_NATIVE_BIT_DEPTH}-bit`,
  );
}

{
  let state = withParam(baseState(), 'export', 'bitDepth', '16');
  state = withParam(state, 'export', 'dither', 'shaped');
  const cfg = buildChainConfig({ state });
  check(
    'dither is sent for an integer depth',
    cfg.dither?.bitDepth === 16 && cfg.dither?.mode === 'shaped',
    `${cfg.dither?.bitDepth}-bit ${cfg.dither?.mode}`,
  );
  check('chainDithersOutput is true', chainDithersOutput(cfg), 'true');
}

{
  // Even at mode 'none' the stage is engaged, because quantising the
  // preview is how the user auditions the difference.
  let state = withParam(baseState(), 'export', 'bitDepth', '16');
  state = withParam(state, 'export', 'dither', 'none');
  const cfg = buildChainConfig({ state });
  check(
    "mode 'none' still quantises",
    cfg.dither?.mode === 'none' && chainDithersOutput(cfg),
    `mode=${cfg.dither?.mode}`,
  );
}

{
  // The interlock: once the engine has dithered, ffmpeg must not do it too.
  const withoutFlag = buildTranscodePlan({ format: 'wav', bitDepth: 16, dither: 'tpdf' });
  const withFlag = buildTranscodePlan({
    format: 'wav', bitDepth: 16, dither: 'tpdf', sourceAlreadyDithered: true,
  });
  const hasDitherArg = (args: string[]) => args.some((a) => a.includes('dither_method'));
  check(
    'ffmpeg dithers when the engine did not',
    hasDitherArg(withoutFlag.args),
    withoutFlag.args.join(' '),
  );
  check(
    'ffmpeg does NOT dither an already-dithered source',
    !hasDitherArg(withFlag.args),
    withFlag.args.join(' '),
  );
  check(
    'an already-dithered WAV needs no transcode for dither alone',
    !needsTranscode('wav', { format: 'wav', dither: 'tpdf', sourceAlreadyDithered: true }),
    'no transcode',
  );
  check(
    'dither alone still forces a transcode otherwise',
    needsTranscode('wav', { format: 'wav', dither: 'tpdf' }),
    'transcode',
  );
}

// ── 1c. Monitoring ───────────────────────────────────────────────────────

console.log('\n=== MONITORING — A/B match + delta ===\n');

{
  // The structural guarantee: an export config cannot carry a monitor block,
  // because monitoring is not part of the module state at all.
  const cfg = buildChainConfig({ state: baseState() });
  check('an export config carries no monitor block', cfg.monitor === undefined, `monitor=${cfg.monitor}`);

  const neutral = buildChainConfig({ state: baseState(), monitor: DEFAULT_MONITOR });
  check(
    'neutral monitoring is not emitted either',
    neutral.monitor === undefined,
    `monitor=${JSON.stringify(neutral.monitor)}`,
  );
  check('monitorAltersOutput agrees', !monitorAltersOutput(DEFAULT_MONITOR), 'false');
}

{
  const m: MonitorSettings = { ...DEFAULT_MONITOR, mode: 'delta', deltaGainDb: 12 };
  const cfg = buildChainConfig({ state: baseState(), monitor: m });
  check(
    'delta monitoring is emitted',
    cfg.monitor?.mode === 'delta' && cfg.monitor?.deltaGainDb === 12,
    `${cfg.monitor?.mode} +${cfg.monitor?.deltaGainDb} dB`,
  );
  check('monitorAltersOutput flags it', monitorAltersOutput(m), 'true');
}

{
  const m: MonitorSettings = { ...DEFAULT_MONITOR, loudnessMatch: true };
  const cfg = buildChainConfig({ state: baseState(), monitor: m });
  check(
    'level matching alone engages the stage',
    cfg.monitor?.loudnessMatch === true && cfg.monitor?.mode === 'processed',
    'processed + match',
  );
}

// ── 2. Through the real engine ───────────────────────────────────────────

console.log('\n=== MODULE SUITE — config → Rust chain (node WASM) ===\n');

interface WasmChain {
  setConfigJson(json: string): void;
  monitoringActive(): boolean;
  monitorLoudnessDeltaDb(): number;
  monitorMatchGainDb(): number;
  processStereo(left: Float32Array, right: Float32Array): void;
  latencySamples(): number;
  multibandGrDb(): Float64Array | number[];
  deessGrDb(): number;
  dynamicEqGainsDb(): Float64Array | number[];
  safetyEvents(): number;
  reset(): void;
}

function loadChain(): (new (sr: number) => WasmChain) | null {
  const candidates = [
    path.resolve(__dirname_, '../../../packages/dsp-wasm/pkg-node/loui_dsp_wasm.cjs'),
  ];
  for (const p of candidates) {
    try {
      const mod = require_(p) as { LouiMasteringChain?: new (sr: number) => WasmChain };
      if (typeof mod.LouiMasteringChain === 'function') return mod.LouiMasteringChain;
    } catch { /* try next */ }
  }
  return null;
}

const Chain = loadChain();

if (!Chain) {
  // Not a silent skip: without the WASM build this harness proves nothing
  // about the audio, and saying so is the point.
  console.error('[FAIL] node-target WASM unavailable — build it with:');
  console.error('       pnpm --filter @loui/dsp-wasm run build:node');
  failed++;
} else {
  /**
   * Push a config through the chain and hand back the processed audio.
   *
   * Fed in 512-sample blocks, the way the real hosts call it — the monitor's
   * dry tap is bounded by the chain's block scratch, so a single giant call
   * would skip monitoring entirely and quietly pass tests that should fail.
   */
  function render(
    state: AllModulesParameterState,
    input: Float32Array,
    opts?: { matchTargetCurveDb?: number[]; monitor?: MonitorSettings },
  ): { left: Float32Array; latency: number; safety: number; chain: WasmChain } {
    const chain = new Chain!(SR);
    const cfg = buildChainConfig({ state, ...(opts ?? {}) });
    chain.setConfigJson(chainConfigToJson(cfg));
    const left = Float32Array.from(input);
    const right = Float32Array.from(input);
    const BLK = 512;
    for (let off = 0; off < left.length; off += BLK) {
      const end = Math.min(off + BLK, left.length);
      chain.processStereo(left.subarray(off, end), right.subarray(off, end));
    }
    return { left, latency: chain.latencySamples(), safety: chain.safetyEvents(), chain };
  }

  const tone1k = sine(SR, 1_000);

  {
    // The neutral chain is a wire apart from the limiter's lookahead.
    const { left, latency } = render(neutralState(), tone1k);
    let worst = 0;
    for (let i = 0; i < tone1k.length; i++) worst = Math.max(worst, Math.abs(left[i]! - tone1k[i]!));
    check('neutral config is transparent', worst < 1e-6, `worst delta ${worst.toExponential(2)}`);
    check('neutral config adds no latency', latency === 0, `latency=${latency}`);
  }

  {
    // De-esser: a 9 kHz tone must duck, a 200 Hz tone must not.
    let state = withParam(neutralState(), 'deess', 'rangeDb', 12);
    state = withParam(state, 'deess', 'thresholdDb', -30);

    const sib = sine(SR / 2, 9_000, 0.6);
    const sibOut = render(state, sib).left;
    const sibDelta = 20 * Math.log10(rms(sibOut, sib.length / 2) / rms(sib, sib.length / 2));
    check('de-esser ducks sibilance', sibDelta < -3, `${sibDelta.toFixed(1)} dB`);

    const body = sine(SR / 2, 200, 0.6);
    const bodyOut = render(state, body).left;
    const bodyDelta = 20 * Math.log10(rms(bodyOut, body.length / 2) / rms(body, body.length / 2));
    check('de-esser leaves the body alone', Math.abs(bodyDelta) < 1, `${bodyDelta.toFixed(2)} dB`);
  }

  {
    // Dynamic EQ band 0, down mode on 250 Hz.
    let state = withParam(neutralState(), 'dynamic-eq', 'band0Enabled', true);
    state = withParam(state, 'dynamic-eq', 'band0FrequencyHz', 250);
    state = withParam(state, 'dynamic-eq', 'band0ThresholdDb', -30);
    state = withParam(state, 'dynamic-eq', 'band0Ratio', 4);
    state = withParam(state, 'dynamic-eq', 'band0RangeDb', 9);

    const input = sine(SR / 2, 250, 0.6);
    const { left, chain } = render(state, input);
    const delta = 20 * Math.log10(rms(left, input.length / 2) / rms(input, input.length / 2));
    const gains = Array.from(chain.dynamicEqGainsDb());
    check('dynamic EQ cuts the band it is aimed at', delta < -3, `${delta.toFixed(1)} dB`);
    check('dynamic EQ reports its applied gain', gains[0]! < -1, `band0=${gains[0]?.toFixed(1)} dB`);
  }

  {
    // Multiband band 0 (low) compressing, high band untouched.
    let state = withParam(neutralState(), 'multiband', 'band0ThresholdDb', -30);
    state = withParam(state, 'multiband', 'band0Ratio', 8);

    const low = sine(SR / 2, 60, 0.7);
    const lowRes = render(state, low);
    const lowDelta = 20 * Math.log10(rms(lowRes.left, low.length / 2) / rms(low, low.length / 2));
    const gr = Array.from(lowRes.chain.multibandGrDb());
    check('multiband compresses its low band', lowDelta < -5, `${lowDelta.toFixed(1)} dB`);
    check('multiband reports per-band GR', gr[0]! > 5, `band GR=[${gr.map((v) => v.toFixed(1)).join(', ')}]`);

    const high = sine(SR / 2, 9_000, 0.7);
    const highOut = render(state, high).left;
    const highDelta = 20 * Math.log10(rms(highOut, high.length / 2) / rms(high, high.length / 2));
    check('multiband leaves other bands alone', Math.abs(highDelta) < 1.5, `${highDelta.toFixed(2)} dB`);
  }

  {
    // Latency must be reported when the STFT modules engage — a monitoring
    // engineer needs the real figure, not a guess.
    const quiet = withParam(neutralState(), 'denoise', 'reductionDb', 12);
    const withDenoise = render(quiet, tone1k).latency;
    check('engaging de-noise reports latency', withDenoise > 0, `${withDenoise} samples`);

    const both = withParam(engage(quiet, 'spectral-shaper'), 'spectral-shaper', 'amountPct', 60);
    const withBoth = render(both, tone1k).latency;
    check(
      'the spectral stage adds its own frame',
      withBoth > withDenoise,
      `${withDenoise} → ${withBoth} samples`,
    );
  }

  {
    // Everything at once must stay finite, under the ceiling, and must not
    // trip the chain's safety layer.
    let state = neutralState();
    const edits: [ModuleId, string, ParameterValue][] = [
      ['declick', 'sensitivity', 5],
      ['dehum', 'depthDb', 18],
      ['denoise', 'reductionDb', 12],
      ['deess', 'rangeDb', 8],
      ['spectral-shaper', 'amountPct', 60],
      ['stabilizer', 'amountPct', 50],
      ['vintage-eq', 'lowBoostDb', 5],
      ['vintage-eq', 'lowCutDb', 5],
      ['dynamic-eq', 'band0Enabled', true],
      ['multiband', 'band0Ratio', 3],
      ['multiband', 'band0ThresholdDb', -24],
      ['dynamics', 'ratio', 2],
      ['dynamics', 'thresholdDb', -20],
      ['vintage-comp', 'ratio', 2.5],
      ['impact', 'band0Pct', 40],
      ['impact', 'band2Pct', -20],
      ['low-end-focus', 'contrastPct', 60],
      ['exciter', 'band2Pct', 40],
      ['exciter', 'band3Pct', 60],
      ['tape', 'mixPct', 50],
      ['tape', 'driveDb', 8],
      ['imager', 'widthPct', 130],
      ['limiter', 'driveDb', 6],
      ['limiter', 'character', 'aggressive'],
    ];
    for (const [mod, id, value] of edits) state = withParam(state, mod, id, value);
    // These ship switched off — engage them so the stress case really does
    // run everything at once.
    for (const id of ['declick', 'spectral-shaper', 'stabilizer', 'eq', 'dynamics',
                      'imager', 'limiter'] as ModuleId[]) {
      state = engage(state, id);
    }

    const cfg = buildChainConfig({ state });
    const emitted = Object.keys(cfg).length;
    check('the full chain emits every engaged module', emitted >= 15, `${emitted} module blocks`);

    const res = render(state, sine(SR, 220, 0.6));
    const finite = res.left.every(Number.isFinite);
    const ceiling = Math.pow(10, -1 / 20);
    check('full chain output stays finite', finite, `finite=${finite}`);
    check(
      'full chain output stays under the ceiling',
      peak(res.left) <= ceiling + 1e-3,
      `peak=${peak(res.left).toFixed(4)} ceiling=${ceiling.toFixed(4)}`,
    );
    check('full chain does not trip the safety layer', res.safety === 0, `safetyEvents=${res.safety}`);
  }

  {
    // Dither must actually quantise the rendered audio, and must leave a
    // float master alone.
    let state = withParam(neutralState(), 'export', 'bitDepth', '16');
    state = withParam(state, 'export', 'dither', 'tpdf');
    const res = render(state, sine(SR / 4, 1_000, 0.4));
    const scale = 32_768;
    const quantised = Array.from(res.left).every(
      (s) => Math.abs(s * scale - Math.round(s * scale)) < 1e-6,
    );
    check('16-bit dither quantises the render', quantised, 'all samples on a 16-bit step');

    const floatState = withParam(neutralState(), 'export', 'bitDepth', '32');
    const input = sine(SR / 4, 1_000, 0.4);
    const floatRes = render(floatState, input);
    let worst = 0;
    for (let i = 0; i < input.length; i++) {
      worst = Math.max(worst, Math.abs(floatRes.left[i]! - input[i]!));
    }
    check('32-bit float render is untouched', worst < 1e-6, `worst delta ${worst.toExponential(2)}`);
  }

  {
    // Bypass monitoring must give back the input, delayed to match whatever
    // latency the engaged modules introduced.  Anything else and the A/B is
    // comparing two different moments in the song.
    const state = withParam(neutralState(), 'denoise', 'reductionDb', 12);
    const input = sine(SR, 440, 0.4);
    const res = render(state, input, {
      monitor: { ...DEFAULT_MONITOR, mode: 'bypass' },
    });
    let worst = 0;
    for (let i = res.latency; i < input.length; i++) {
      worst = Math.max(worst, Math.abs(res.left[i]! - input[i - res.latency]!));
    }
    check(
      'bypass monitoring returns the latency-aligned dry',
      worst < 1e-5,
      `latency ${res.latency}, worst delta ${worst.toExponential(2)}`,
    );
  }

  {
    // Delta of a chain that only delays must be silence.  One sample of
    // misalignment and this fails, which is the point of having it.
    const state = withParam(neutralState(), 'denoise', 'reductionDb', 12);
    const res = render(state, new Float32Array(SR), {
      monitor: { ...DEFAULT_MONITOR, mode: 'delta' },
    });
    let peakVal = 0;
    for (let i = res.latency; i < res.left.length; i++) {
      peakVal = Math.max(peakVal, Math.abs(res.left[i]!));
    }
    check('delta of a silent pass is silent', peakVal < 1e-6, `residual ${peakVal.toExponential(2)}`);
  }

  {
    // The headline behaviour: a chain whose only effect is level must A/B as
    // near-identical once matched.
    const base = neutralState();
    const state: AllModulesParameterState = {
      ...base,
      eq: { ...base.eq, bypass: false, parameters: { ...base.eq.parameters, outputGainDb: 6 } },
    };
    const input = sine(SR * 12, 1_000, 0.2);
    const res = render(state, input, {
      monitor: { ...DEFAULT_MONITOR, loudnessMatch: true },
    });
    const tail = input.length - SR;
    const deltaDb = 20 * Math.log10(rms(res.left, tail) / rms(input, tail));
    check(
      'level matching neutralises a pure gain change',
      Math.abs(deltaDb) < 1.0,
      `${deltaDb.toFixed(2)} dB from dry`,
    );
    check(
      'the chain reports what it added',
      Math.abs(res.chain.monitorLoudnessDeltaDb() - 6) < 1.0,
      `${res.chain.monitorLoudnessDeltaDb().toFixed(2)} dB`,
    );
    check(
      'the match gain is reported for the UI',
      Math.abs(res.chain.monitorMatchGainDb() + 6) < 1.0,
      `${res.chain.monitorMatchGainDb().toFixed(2)} dB`,
    );
  }

  {
    // Monitoring must be inert unless asked for.
    const res = render(neutralState(), sine(SR / 4, 1_000, 0.3));
    check('monitoring is off without a monitor config', !res.chain.monitoringActive(), 'inactive');
  }

  {
    // A malformed config must be rejected whole, not applied halfway.
    const chain = new Chain!(SR);
    let rejected = false;
    try {
      chain.setConfigJson('{"limiter":{"ceilingDbtp":"loud"}}');
    } catch {
      rejected = true;
    }
    check('a malformed config is rejected', rejected, `rejected=${rejected}`);
  }
}

// ── Result ───────────────────────────────────────────────────────────────

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
