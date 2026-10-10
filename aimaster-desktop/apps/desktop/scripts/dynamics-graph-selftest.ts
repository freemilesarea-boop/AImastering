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
  dynamicsGrDb(): number;
  multibandGrDb(): Float64Array;
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
  /** What a settled steady tone at `inDb` came out at, and what the meters
   *  said while it did.  One run: the reading has to describe the audio the
   *  same run produced, or the comparison is between two different states.
   */
  function settled(
    state: AllModulesParameterState,
    inDb: number,
    hz = 1000,
  ): { outDb: number; dynamicsGr: number; bandGr: readonly number[] } {
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
    return {
      outDb: 20 * Math.log10(Math.max(peak, 1e-12)),
      dynamicsGr: chain.dynamicsGrDb(),
      bandGr: Array.from(chain.multibandGrDb()),
    };
  }

  /** Settled output peak, in dBFS, for a steady tone at `inDb`. */
  function settledOutputDb(state: AllModulesParameterState, inDb: number, hz = 1000): number {
    return settled(state, inDb, hz).outDb;
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
    // Parallel mix.  The curve sums the wet and dry SIGNALS, which is what
    // the DSP does, so this is not an approximation and the tolerance says
    // so: a model that blended the dB values instead would read several dB
    // low here and nothing else in this file would notice.
    const state = withParams(neutralState(), 'dynamics', [
      ['thresholdDb', -24], ['ratio', 8], ['attackMs', 5], ['releaseMs', 400], ['mixPct', 50],
    ]);
    const curve = buildDynamicsGraph('dynamics', state['dynamics'].parameters)!.curves[0]!.curve;
    const drawn = outputDbFor(curve, -6);
    const heard = settledOutputDb(state, -6);
    check(
      'parallel mix is drawn where the audio lands',
      Math.abs(drawn - heard) < 0.3,
      `drawn ${drawn.toFixed(2)} / heard ${heard.toFixed(2)} dB`,
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

  console.log('\n=== DYNAMICS GRAPH — the reported reduction ===\n');

  {
    // The GR meter and the curve sit in the same panel and have to be the
    // same number.  A meter that reports the WET path's reduction instead
    // of the output's reads high the moment the mix comes off 100%, and
    // the marker — placed by inverting the curve through that number —
    // lands at a level the signal never reached.
    const markers: number[] = [];
    for (const mixPct of [100, 88, 50, 40]) {
      const state = withParams(neutralState(), 'dynamics', [
        ['thresholdDb', -30], ['ratio', 10], ['attackMs', 5], ['releaseMs', 400],
        ['mixPct', mixPct],
      ]);
      const curve = buildDynamicsGraph('dynamics', state['dynamics'].parameters)!.curves[0]!.curve;
      const inDb = -6;
      const run = settled(state, inDb);
      const heardGr = inDb - run.outDb;
      check(
        `the dynamics GR meter reports the reduction heard at ${mixPct}% wet`,
        Math.abs(run.dynamicsGr - heardGr) < 0.35 && heardGr > 1,
        `meter ${run.dynamicsGr.toFixed(2)} / heard ${heardGr.toFixed(2)} dB`,
      );
      markers.push(inputDbForReduction(curve, run.dynamicsGr) ?? NaN);
    }
    // The detector sits before the mix, so the same tone has to put the
    // marker in the same place at every mix setting.  With a meter that
    // scaled the wet figure by the mix, the dot slid down the curve as the
    // user turned a knob that changes nothing the detector can see.
    const spread = Math.max(...markers) - Math.min(...markers);
    check(
      'the live marker stays put as the wet mix changes',
      spread < 0.2,
      `${markers.map((m) => m.toFixed(2)).join(' / ')} dBFS across 100/88/50/40% wet`,
    );
    // And the place it stays is the level the DETECTOR settled on, which
    // for a sine is a little under the crest: a peak follower is dragged
    // toward the zero crossings between peaks, and at 5 ms attack / 400 ms
    // release that costs 0.78 dB.  Measured independently, not asserted
    // from the same code path.
    const crest = -6;
    check(
      'the marker sits at the level the detector settled on',
      Math.abs((markers[0] ?? NaN) - (crest - 0.78)) < 0.15,
      `marker ${(markers[0] ?? NaN).toFixed(2)} dBFS for a ${crest.toFixed(2)} dBFS crest`,
    );
  }

  {
    // Same for a multiband band, whose meter used to leave the mix out
    // altogether: the reading sat still while the band's output moved.
    const readings: number[] = [];
    for (const mixPct of [100, 50]) {
      const state = withParams(neutralState(), 'multiband', [
        ['crossover1Hz', 120], ['crossover2Hz', 400], ['crossover3Hz', 12_000],
        ['band2ThresholdDb', -30], ['band2Ratio', 10], ['band2AttackMs', 5],
        ['band2ReleaseMs', 400], ['band2MixPct', mixPct],
      ]);
      const inDb = -6;
      const run = settled(state, inDb, 2000);
      const heardGr = inDb - run.outDb;
      const meter = run.bandGr[2] ?? 0;
      readings.push(meter);
      check(
        `a multiband band's GR meter reports the reduction heard at ${mixPct}% wet`,
        Math.abs(meter - heardGr) < 0.6 && heardGr > 1,
        `meter ${meter.toFixed(2)} / heard ${heardGr.toFixed(2)} dB`,
      );
    }
    check(
      'halving a band\'s wet mix moves its GR reading',
      (readings[0] ?? 0) - (readings[1] ?? 0) > 3,
      `${(readings[0] ?? 0).toFixed(2)} dB at 100% wet, ${(readings[1] ?? 0).toFixed(2)} at 50%`,
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
