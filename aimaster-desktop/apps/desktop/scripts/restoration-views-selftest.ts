// Restoration views self-test — the pictures versus the processing.
//
// De-hum, de-noise, de-essing and tonal matching are invisible: nothing on
// the panel moves unless a display makes it move. That makes a wrong
// display worse than none, because there is nothing to contradict it. A
// comb drawn at 60 Hz while the engine notches 50 looks completely
// convincing.
//
// So the checks here are the same shape as the EQ ones: for anything the
// view claims about frequency response, measure the real chain and compare.
// For anything the view reads from the engine, drive the real worklet and
// assert the value actually arrives.
//
// Run:  pnpm --filter @aimaster/desktop test:restoration-views

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  ALL_MODULE_PARAMETER_DEFS,
  defaultAllModulesState,
  type AllModulesParameterState,
  type ModuleId,
  type ParameterValue,
} from '../src/renderer/audio/parameters/index.js';
import { buildChainConfig, chainConfigToJson } from '../src/renderer/audio/chain-config.js';

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

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

const SR = 48_000;

interface WasmChain {
  setConfigJson(json: string): void;
  processStereo(left: Float32Array, right: Float32Array): void;
}

function loadChainCtor(): (new (sr: number) => WasmChain) | null {
  try {
    const p = path.resolve(__dirname_, '../../../packages/dsp-wasm/pkg-node/loui_dsp_wasm.cjs');
    const mod = require_(p) as { LouiMasteringChain?: new (sr: number) => WasmChain };
    return typeof mod.LouiMasteringChain === 'function' ? mod.LouiMasteringChain : null;
  } catch {
    return null;
  }
}

function neutralState(): AllModulesParameterState {
  const s = defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS);
  for (const id of ['eq', 'dynamics', 'imager', 'limiter', 'vintage-eq'] as ModuleId[]) {
    s[id] = { ...s[id], bypass: true };
  }
  return s;
}

function withParams(
  state: AllModulesParameterState,
  moduleId: ModuleId,
  edits: Array<[string, ParameterValue]>,
): AllModulesParameterState {
  const params = { ...state[moduleId].parameters };
  for (const [k, v] of edits) params[k] = v;
  return { ...state, [moduleId]: { ...state[moduleId], bypass: false, parameters: params } };
}

const Chain = loadChainCtor();

if (!Chain) {
  console.error('[FAIL] node-target WASM unavailable — build it with:');
  console.error('       pnpm --filter @loui/dsp-wasm run build:node');
  failed++;
} else {
  function measuredGainDb(state: AllModulesParameterState, hz: number): number {
    const chain = new Chain!(SR);
    chain.setConfigJson(chainConfigToJson(buildChainConfig({ state })));
    const n = 1 << 15;
    const amp = 0.2;
    const left = new Float32Array(n);
    for (let i = 0; i < n; i++) left[i] = Math.sin((2 * Math.PI * hz * i) / SR) * amp;
    const right = Float32Array.from(left);
    for (let off = 0; off < n; off += 512) {
      const end = Math.min(off + 512, n);
      chain.processStereo(left.subarray(off, end), right.subarray(off, end));
    }
    let acc = 0;
    for (let i = n / 2; i < n; i++) acc += left[i]! * left[i]!;
    return 20 * Math.log10(Math.sqrt(acc / (n / 2)) / (amp / Math.SQRT2));
  }

  console.log('\n=== RESTORATION VIEWS — the de-hum comb ===\n');

  {
    // The display draws a notch at the mains frequency and its harmonics.
    // Measure that the engine actually notches there — and, critically, at
    // the frequency the CHIP says, since that parameter is an enum string
    // and reading it as a number silently draws 60 Hz for a 50 Hz setting.
    const state = withParams(neutralState(), 'dehum', [
      ['frequencyHz', '50'], ['depthDb', 18], ['harmonics', 4], ['q', 30], ['adaptive', false],
    ]);
    const at50 = measuredGainDb(state, 50);
    const at100 = measuredGainDb(state, 100);
    const at60 = measuredGainDb(state, 60);
    const at400 = measuredGainDb(state, 400);
    check(
      'a 50 Hz setting notches 50 Hz, not 60',
      at50 < -10 && at60 > -3,
      `50 Hz ${at50.toFixed(1)} dB · 60 Hz ${at60.toFixed(1)} dB`,
    );
    check(
      'harmonics are notched too',
      at100 < -10,
      `100 Hz ${at100.toFixed(1)} dB`,
    );
    check(
      'past the last harmonic the comb stops',
      Math.abs(at400) < 1.0,
      `400 Hz ${at400.toFixed(1)} dB with 4 harmonics of 50 Hz`,
    );
  }

  {
    // Depth 0 must be no comb at all, or the picture would show notches the
    // audio does not have.
    const state = withParams(neutralState(), 'dehum', [
      ['frequencyHz', '60'], ['depthDb', 0], ['harmonics', 8], ['adaptive', false],
    ]);
    const at60 = measuredGainDb(state, 60);
    check('depth 0 is no notch', Math.abs(at60) < 0.1, `60 Hz ${at60.toFixed(3)} dB`);
  }
}

// ── The readouts the views depend on ─────────────────────────────────────
//
// Drawing from `metrics.tonalCurveDb` is only honest if that field carries
// a measurement. These drive the REAL worklet — the same source the app
// loads — and assert the arrays arrive with sane shapes.

console.log('\n=== RESTORATION VIEWS — engine readouts reach the UI ===\n');

{
  const workletPath = path.resolve(
    __dirname_, '../src/renderer/audio/mastering-chain.worklet.js',
  );
  const source = readFileSync(workletPath, 'utf8');
  const messages: Record<string, unknown>[] = [];
  let now = 0;
  let Ctor: (new (o: unknown) => never) | null = null;

  const sandbox: Record<string, unknown> = {
    sampleRate: SR,
    get currentTime() { return now; },
    registerProcessor: (_n: string, c: new (o: unknown) => never) => { Ctor = c; },
    AudioWorkletProcessor: class {
      port = {
        onmessage: null as ((e: { data: unknown }) => void) | null,
        postMessage: (m: Record<string, unknown>) => { messages.push(m); },
      };
    },
    globalThis: undefined as unknown,
    console,
  };
  sandbox['globalThis'] = sandbox;
  const chainMod = require_(
    path.resolve(__dirname_, '../../../packages/dsp-wasm/pkg-node/loui_dsp_wasm.cjs'),
  ) as { LouiMasteringChain: new (sr: number) => unknown };
  sandbox['__loui_init_mastering'] = () => new chainMod.LouiMasteringChain(SR);

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'mastering-chain.worklet.js' });

  const processor = new (Ctor as unknown as new (o: unknown) => {
    process(i: Float32Array[][], o: Float32Array[][]): boolean;
    port: { onmessage: ((e: { data: unknown }) => void) | null };
  })({ processorOptions: { wasmModule: {} } });

  // The tonal curve is measured BY the spectral stage — with the stage
  // bypassed there is no measurement, only a default of "never observed".
  // That is the state the Match view has to describe honestly, and it is
  // why this harness turns the stage on before expecting numbers.
  processor.port.onmessage?.({
    data: {
      type: 'configJson',
      json: JSON.stringify({ spectral: { analysisOnly: true, bypass: false } }),
      masterBypass: false,
    },
  });

  // Something for the analysers to measure: pink-ish noise plus a tone.
  const BLOCK = 128;
  const input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  const output = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  let phase = 0;
  for (let b = 0; b < Math.floor((SR * 3) / BLOCK); b++) {
    for (let i = 0; i < BLOCK; i++) {
      phase += (2 * Math.PI * 220) / SR;
      const v = Math.sin(phase) * 0.3 + (Math.random() - 0.5) * 0.02;
      input[0]![i] = v;
      input[1]![i] = v;
    }
    processor.process([input], [output]);
    now += BLOCK / SR;
  }

  const last = messages[messages.length - 1];
  check('the worklet still posts metrics', !!last, `${messages.length} messages`);

  const tonal = last?.['tonalCurveDb'];
  check(
    'the tonal curve arrives on the shared 32-band grid',
    Array.isArray(tonal) && tonal.length === 32,
    `${Array.isArray(tonal) ? `${tonal.length} bands` : typeof tonal}`,
  );
  check(
    'the tonal curve is a measurement, not zeros',
    Array.isArray(tonal) && (tonal as number[]).some((v) => v > -139 && v < 0),
    Array.isArray(tonal) ? `peak ${Math.max(...(tonal as number[])).toFixed(1)} dB` : 'absent',
  );

  const profile = last?.['denoiseProfileDb'];
  check(
    'the noise profile is folded to log bands before it crosses the port',
    Array.isArray(profile) && profile.length === 48,
    `${Array.isArray(profile) ? `${profile.length} bands` : typeof profile} (1025 raw bins would be 20× the traffic)`,
  );

  check(
    'per-band and per-module readouts are all present',
    last !== undefined
    && Array.isArray(last['multibandGrDb'])
    && typeof last['deessGrDb'] === 'number'
    && typeof last['dehumDepthDb'] === 'number',
    last ? Object.keys(last).length + ' fields' : 'no message',
  );

  // The whole reason these are read inside `_postMetrics`: the arrays are
  // fresh allocations from WASM, and the audio thread must not make one per
  // block.  Ten seconds of blocks must still be ~100 messages.
  check(
    'the extra readouts did not raise the message rate',
    messages.length > 0 && messages.length <= 40,
    `${messages.length} messages in 3 s (ceiling ≈ 30)`,
  );
}

// ── Space modules ────────────────────────────────────────────────────────
//
// Reverb and delay are the two modules where "it sounds like nothing" and
// "it is not wired" are indistinguishable by ear at the levels a master
// uses. So both are measured through the full state → config → chain path,
// not just unit-tested in Rust.

console.log('\n=== SPACE — reverb and delay reach the audio ===\n');

if (Chain) {
  const renderTail = (state: AllModulesParameterState, n: number): Float32Array => {
    const chain = new Chain!(SR);
    chain.setConfigJson(chainConfigToJson(buildChainConfig({ state })));
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    left[0] = 1.0;
    right[0] = 1.0;
    for (let off = 0; off < n; off += 512) {
      const end = Math.min(off + 512, n);
      chain.processStereo(left.subarray(off, end), right.subarray(off, end));
    }
    return left;
  };
  const peakIn = (x: Float32Array, from: number, to: number): number => {
    let m = 0;
    for (let i = from; i < Math.min(to, x.length); i++) m = Math.max(m, Math.abs(x[i]!));
    return m;
  };

  {
    const state = withParams(neutralState(), 'delay', [
      ['mixPct', 50], ['timeMs', 120], ['feedbackPct', 0], ['stereoOffsetPct', 0],
    ]);
    const out = renderTail(state, SR);
    const at = Math.round(0.120 * SR);
    check(
      'a delay repeat arrives at the time it was set to',
      peakIn(out, at - 40, at + 40) > 0.2 && peakIn(out, 1000, at - 400) < 0.02,
      `peak at 120 ms = ${peakIn(out, at - 40, at + 40).toFixed(3)}`,
    );
  }

  {
    // Mix 0 must leave the chain bit-transparent, or an unused space module
    // would quietly cost transparency on every session.
    const state = withParams(neutralState(), 'delay', [['mixPct', 0], ['timeMs', 120]]);
    const cfg = buildChainConfig({ state });
    check(
      'a silent delay is not even sent to the engine',
      cfg.delay === undefined,
      JSON.stringify(cfg.delay ?? null),
    );
  }

  {
    const state = withParams(neutralState(), 'reverb', [
      ['mixPct', 60], ['sizePct', 80], ['preDelayMs', 0], ['dampingPct', 30],
    ]);
    const out = renderTail(state, SR * 2);
    const early = peakIn(out, Math.round(0.05 * SR), Math.round(0.3 * SR));
    check(
      'a reverb tail follows the impulse',
      early > 0.001,
      `tail peak ${early.toExponential(2)} between 50 and 300 ms`,
    );

    const big = renderTail(withParams(neutralState(), 'reverb', [
      ['mixPct', 60], ['sizePct', 98], ['preDelayMs', 0], ['dampingPct', 0],
    ]), SR * 3);
    const small = renderTail(withParams(neutralState(), 'reverb', [
      ['mixPct', 60], ['sizePct', 5], ['preDelayMs', 0], ['dampingPct', 0],
    ]), SR * 3);
    const lateBig = peakIn(big, SR, SR * 2);
    const lateSmall = peakIn(small, SR, SR * 2);
    check(
      'size changes how long the tail lasts',
      lateBig > lateSmall * 3,
      `late peak small ${lateSmall.toExponential(2)} vs large ${lateBig.toExponential(2)}`,
    );
  }

  {
    const state = withParams(neutralState(), 'reverb', [['mixPct', 0], ['sizePct', 80]]);
    check(
      'a silent reverb is not even sent to the engine',
      buildChainConfig({ state }).reverb === undefined,
      'absent',
    );
  }

  {
    // Both modules feed themselves.  A runaway here is not a wrong sound,
    // it is a burst of noise at whatever the output stage allows.
    const state = withParams(
      withParams(neutralState(), 'reverb', [['mixPct', 100], ['sizePct', 100], ['dampingPct', 0]]),
      'delay', [['mixPct', 100], ['feedbackPct', 95], ['timeMs', 30]],
    );
    const out = renderTail(state, SR * 5);
    const early = peakIn(out, 0, SR);
    const late = peakIn(out, SR * 4, SR * 5);
    check(
      'the two feedback modules together still decay',
      out.every(Number.isFinite) && late <= early,
      `${early.toFixed(3)} → ${late.toFixed(3)} over five seconds`,
    );
  }
}

// ── Every live module is reachable ───────────────────────────────────────
//
// A rack row without `paramModuleId` opens an empty panel and renders no
// bypass switch — the module is present in the engine, listed in the rack,
// and completely unusable. Dynamic EQ, Exciter and Low End Focus all
// shipped that way, and nothing failed: the definitions existed, the DSP
// existed, only the pointer between them was missing.

console.log('\n=== MODULE REGISTRY — every live module opens its panel ===\n');

{
  const { LOUI_MODULES } = require_(
    '../src/renderer/audio/modules/loui-module-suite.js',
  ) as typeof import('../src/renderer/audio/modules/loui-module-suite.js');

  // Registry rows that deliberately share another module's parameters.
  const SHARED: Record<string, string> = {
    maximizer: 'limiter',
    'harshness-control': 'spectral-shaper',
    'reference-match': 'match-eq',
    'ai-harshness-guard': 'dynamic-eq',
    dither: 'export',
  };

  const live = LOUI_MODULES.filter((m) => m.status === 'live');
  const orphans = live.filter((m) => !m.paramModuleId && !SHARED[m.id]);
  check(
    'every live module points at a parameter module',
    orphans.length === 0,
    orphans.length === 0
      ? `${live.length} live modules all reachable`
      : `unreachable: ${orphans.map((m) => m.id).join(', ')}`,
  );

  const badTargets = live
    .filter((m) => m.paramModuleId)
    .filter((m) => !ALL_MODULE_PARAMETER_DEFS[m.paramModuleId!]);
  check(
    'every pointer resolves to real definitions',
    badTargets.length === 0,
    badTargets.length === 0 ? 'all resolve' : badTargets.map((m) => m.id).join(', '),
  );

  // A module with a panel but no parameters is the other half of the same
  // failure; the free EQ is the one intentional case.
  const PARAMETERLESS = new Set(['parametric-eq']);
  const empty = live
    .filter((m) => m.paramModuleId && !PARAMETERLESS.has(m.paramModuleId))
    .filter((m) => (ALL_MODULE_PARAMETER_DEFS[m.paramModuleId!]?.parameters.length ?? 0) === 0);
  check(
    'no live module opens an empty panel',
    empty.length === 0,
    empty.length === 0 ? 'none' : empty.map((m) => m.id).join(', '),
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
