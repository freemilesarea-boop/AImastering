// Dynamics graph self-test — the transfer curve versus the compressor.
//
// The curve on the panel claims "feed this level in, get that level out".
// If the drawing model and the gain computer drift apart — a different
// knee, a ratio applied the other way round, a makeup gain the picture
// forgets — the panel becomes a plausible-looking lie, and nothing errors.
//
// So each case pushes a steady tone at a known peak level through the real
// node-target WASM chain, measures the settled output peak, and compares it
// with what the curve says it should be.
//
// The tone is deliberately steady and the release deliberately slow: the
// curve models the STEADY STATE, so measuring during the attack would be
// testing the drawing against something it never claimed to show.
//
// Run:  pnpm --filter @aimaster/desktop test:dynamics-graph

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_MODULE_PARAMETER_DEFS,
  defaultAllModulesState,
  type AllModulesParameterState,
  type ModuleId,
  type ParameterValue,
} from '../src/renderer/audio/parameters/index.js';
import { buildChainConfig, chainConfigToJson } from '../src/renderer/audio/chain-config.js';
import {
  buildDynamicsGraph,
  outputDbFor,
  reductionDbAt,
  inputDbForReduction,
} from '../src/renderer/audio/modules/dynamics-graph-model.js';

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

function loadChain(): (new (sr: number) => WasmChain) | null {
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

const Chain = loadChain();

if (!Chain) {
  console.error('[FAIL] node-target WASM unavailable — build it with:');
  console.error('       pnpm --filter @loui/dsp-wasm run build:node');
  failed++;
} else {
  /** Settled output peak, in dBFS, for a steady tone at `inDb`. */
  function settledOutputDb(state: AllModulesParameterState, inDb: number, hz = 1000): number {
    const chain = new Chain!(SR);
    chain.setConfigJson(chainConfigToJson(buildChainConfig({ state })));
    const amp = Math.pow(10, inDb / 20);
    const n = SR * 2;
    const left = new Float32Array(n);
    for (let i = 0; i < n; i++) left[i] = Math.sin((2 * Math.PI * hz * i) / SR) * amp;
    const right = Float32Array.from(left);
    for (let off = 0; off < n; off += 512) {
      const end = Math.min(off + 512, n);
      chain.processStereo(left.subarray(off, end), right.subarray(off, end));
    }
    // Last quarter only: by then attack and release have settled.
    let peak = 0;
    for (let i = Math.floor(n * 0.75); i < n; i++) peak = Math.max(peak, Math.abs(left[i]!));
    return 20 * Math.log10(Math.max(peak, 1e-12));
  }

  console.log('\n=== DYNAMICS GRAPH — drawn curve vs measured compression ===\n');

  {
    // A slow release keeps the detector near the tone's peak, which is the
    // steady state the curve describes.
    const edits: Array<[string, ParameterValue]> = [
      ['thresholdDb', -20], ['ratio', 4], ['attackMs', 5], ['releaseMs', 400], ['mixPct', 100],
    ];
    const state = withParams(neutralState(), 'dynamics', edits);
    const spec = buildDynamicsGraph('dynamics', state['dynamics'].parameters)!;
    const curve = spec.curves[0]!.curve;

    let worst = 0;
    let worstAt = 0;
    const rows: string[] = [];
    for (const inDb of [-40, -30, -22, -18, -12, -6]) {
      const drawn = outputDbFor(curve, inDb);
      const heard = settledOutputDb(state, inDb);
      const d = Math.abs(drawn - heard);
      if (d > worst) { worst = d; worstAt = inDb; }
      rows.push(`${inDb}dB→ drawn ${drawn.toFixed(2)} / heard ${heard.toFixed(2)}`);
    }
    check(
      'the transfer curve matches what the compressor does',
      worst < 1.0,
      worst < 1.0 ? `worst ${worst.toFixed(2)} dB at ${worstAt} dBFS in`
        : `worst ${worst.toFixed(2)} dB at ${worstAt} — ${rows.join(' · ')}`,
    );
  }

  {
    // Below the knee the compressor must be doing nothing, and the curve
    // must say so — a picture that bends early would have the user chasing
    // a threshold that is already right.
    const state = withParams(neutralState(), 'dynamics', [
      ['thresholdDb', -12], ['ratio', 8], ['attackMs', 5], ['releaseMs', 400], ['mixPct', 100],
    ]);
    const curve = buildDynamicsGraph('dynamics', state['dynamics'].parameters)!.curves[0]!.curve;
    const heard = settledOutputDb(state, -30);
    check(
      'well below the threshold nothing happens, on screen and in the audio',
      Math.abs(heard - -30) < 0.3 && Math.abs(outputDbFor(curve, -30) - -30) < 0.01,
      `heard ${heard.toFixed(2)} dB for a -30 dB tone`,
    );
  }

  {
    // Parallel mix.  The model blends levels while the DSP sums signals, so
    // this is the one place the curve is an approximation — pin how close.
    const state = withParams(neutralState(), 'dynamics', [
      ['thresholdDb', -24], ['ratio', 8], ['attackMs', 5], ['releaseMs', 400], ['mixPct', 50],
    ]);
    const curve = buildDynamicsGraph('dynamics', state['dynamics'].parameters)!.curves[0]!.curve;
    const drawn = outputDbFor(curve, -6);
    const heard = settledOutputDb(state, -6);
    check(
      'parallel mix is drawn within a dB of the audio',
      Math.abs(drawn - heard) < 1.2,
      `drawn ${drawn.toFixed(2)} / heard ${heard.toFixed(2)} dB (levels vs signals — approximate by construction)`,
    );
  }

  {
    // Multiband: a tone well inside one band must be compressed by that
    // band's curve.  "Well inside" matters — a per-band curve describes the
    // band's gain computer, and near a crossover the band carries less than
    // the whole tone while its neighbour carries the rest uncompressed.  The
    // panel says as much; the test measures where the claim is clean.
    const state = withParams(neutralState(), 'multiband', [
      ['crossover1Hz', 120], ['crossover2Hz', 400], ['crossover3Hz', 12_000],
      ['band2ThresholdDb', -20], ['band2Ratio', 4], ['band2AttackMs', 5], ['band2ReleaseMs', 400],
    ]);
    const spec = buildDynamicsGraph('multiband', state['multiband'].parameters)!;
    const highMid = spec.curves[2]!.curve;
    const drawn = outputDbFor(highMid, -6);
    const heard = settledOutputDb(state, -6, 2000);
    check(
      'a multiband band draws its own curve',
      Math.abs(drawn - heard) < 1.0,
      `drawn ${drawn.toFixed(2)} / heard ${heard.toFixed(2)} dB for a 2 kHz tone`,
    );

    const untouched = settledOutputDb(state, -6, 300);
    check(
      'the other bands stay out of it',
      Math.abs(untouched - -6) < 0.5,
      `${untouched.toFixed(2)} dB for a 300 Hz tone`,
    );
  }

  console.log('\n=== DYNAMICS GRAPH — the live marker ===\n');

  {
    // The marker is placed by inverting the curve through the reported gain
    // reduction.  Round-tripping is the whole correctness argument for it.
    const curve = {
      thresholdDb: -20, ratio: 4, kneeDb: 6, makeupDb: 0, mixPct: 100, mode: 'compress' as const,
    };
    let worst = 0;
    for (const inDb of [-14, -10, -6, -3]) {
      const gr = reductionDbAt(curve, inDb);
      const back = inputDbForReduction(curve, gr);
      worst = Math.max(worst, Math.abs((back ?? -999) - inDb));
    }
    check(
      'reduction inverts back to the level that caused it',
      worst < 0.1,
      `worst ${worst.toFixed(3)} dB`,
    );

    check(
      'no reduction means no marker',
      inputDbForReduction(curve, 0) === null,
      'null at 0 dB GR',
    );
    check(
      'a reduction the curve cannot reach places no marker',
      inputDbForReduction(curve, 40) === null,
      'null at 40 dB GR',
    );
  }

  {
    // A ratio of 1 is the "off" state several modules ship with; the curve
    // must be the unity line, not a bend of zero width.
    const off = buildDynamicsGraph('multiband', neutralState()['multiband'].parameters)!;
    const flat = off.curves.every((c) => Math.abs(outputDbFor(c.curve, -6) - -6) < 1e-9);
    check('a 1:1 band draws the unity line', flat, 'all four bands unity');
  }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
