// EQ graph self-test — the curve on screen versus the audio in the chain.
//
// A draggable EQ graph makes one promise: the shape you drew is the shape
// you will hear.  It is very easy to break that promise quietly — a band
// whose frequency the DSP ignores, a Q the UI maps differently from the
// engine, a derived node that writes the wrong parameter.  None of those
// show up as an error; the graph just becomes decoration.
//
// So this harness does not check that the drawing code runs.  For each
// case it:
//
//   1. builds graph bands from real parameter state,
//   2. asks the model for the gain it would DRAW at a frequency,
//   3. measures what the real node-target WASM chain actually DOES at that
//      frequency, and
//   4. fails if they disagree by more than a fraction of a dB.
//
// Run:  pnpm --filter @aimaster/desktop test:eq-graph

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
  buildGraphBands,
  bandEdits,
  combinedGainDbAt,
  bandwidthToQ,
  qToBandwidth,
  freeBandsToGraph,
  freeBandToWire,
  makeFreeBand,
  type GraphBand,
  type FreeEqBand,
} from '../src/renderer/audio/modules/eq-graph-model.js';

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
  reset(): void;
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

/** Everything off, so one module can be measured on its own. */
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
  /** Measured gain of the whole chain at one frequency, in dB. */
  function measuredGainDb(state: AllModulesParameterState, hz: number): number {
    const chain = new Chain!(SR);
    chain.setConfigJson(chainConfigToJson(buildChainConfig({ state })));
    const n = 1 << 15;
    const amp = 0.2;
    const left = new Float32Array(n);
    for (let i = 0; i < n; i++) left[i] = Math.sin((2 * Math.PI * hz * i) / SR) * amp;
    const right = Float32Array.from(left);
    const BLK = 512;
    for (let off = 0; off < n; off += BLK) {
      const end = Math.min(off + BLK, n);
      chain.processStereo(left.subarray(off, end), right.subarray(off, end));
    }
    // Second half only — the first half is filter warm-up.
    let acc = 0;
    for (let i = n / 2; i < n; i++) acc += left[i]! * left[i]!;
    const out = Math.sqrt(acc / (n / 2));
    return 20 * Math.log10(out / (amp / Math.SQRT2));
  }

  /**
   * The heart of the harness: drawn versus heard, at several frequencies.
   */
  function compareCurve(
    name: string,
    moduleId: ModuleId,
    edits: Array<[string, ParameterValue]>,
    probes: number[],
    tolDb = 0.4,
  ): void {
    const state = withParams(neutralState(), moduleId, edits);
    const bands = buildGraphBands(moduleId, state[moduleId].parameters);
    if (!bands) {
      check(name, false, `no graph bands for ${moduleId}`);
      return;
    }
    let worst = 0;
    let worstAt = 0;
    const rows: string[] = [];
    for (const hz of probes) {
      const drawn = combinedGainDbAt(bands, hz, SR);
      const heard = measuredGainDb(state, hz);
      const d = Math.abs(drawn - heard);
      if (d > worst) { worst = d; worstAt = hz; }
      rows.push(`${hz}Hz drawn ${drawn.toFixed(2)} / heard ${heard.toFixed(2)}`);
    }
    check(
      name,
      worst < tolDb,
      worst < tolDb
        ? `worst ${worst.toFixed(2)} dB @ ${worstAt} Hz`
        : `worst ${worst.toFixed(2)} dB @ ${worstAt} Hz — ${rows.join(' · ')}`,
    );
  }

  console.log('\n=== EQ GRAPH — drawn curve vs measured response ===\n');

  compareCurve(
    'EQ: a bell dragged to 800 Hz is heard at 800 Hz',
    'eq',
    [['lowCutHz', 20], ['lowShelfDb', 0], ['airDb', 0], ['adaptive', false],
      ['presenceHz', 800], ['presenceDb', 8], ['presenceQ', 2.5]],
    [200, 500, 800, 1200, 3000],
  );

  compareCurve(
    'EQ: a high-Q bell is as narrow on screen as in the audio',
    'eq',
    [['lowCutHz', 20], ['lowShelfDb', 0], ['airDb', 0], ['adaptive', false],
      ['presenceHz', 2000], ['presenceDb', -10], ['presenceQ', 8]],
    [1400, 1800, 2000, 2200, 2800],
  );

  compareCurve(
    'EQ: shelves land where the nodes are drawn',
    'eq',
    [['lowCutHz', 20], ['adaptive', false],
      ['lowShelfHz', 300], ['lowShelfDb', -6], ['lowShelfQ', 0.9],
      ['presenceDb', 0], ['airHz', 6000], ['airDb', 5], ['airQ', 0.6]],
    [50, 150, 300, 1000, 6000, 14_000],
  );

  compareCurve(
    'EQ: the high-pass corner is drawn where it filters',
    'eq',
    [['lowCutHz', 90], ['lowCutQ', 1.4], ['lowShelfDb', 0], ['presenceDb', 0],
      ['airDb', 0], ['adaptive', false]],
    [30, 60, 90, 140, 400],
  );

  compareCurve(
    'EQ: the adaptive dip is drawn, not hidden',
    'eq',
    [['lowCutHz', 20], ['lowShelfDb', 0], ['presenceDb', 0], ['airDb', 0], ['adaptive', true]],
    [1000, 3000, 4000, 5500],
  );

  compareCurve(
    'Vintage EQ: boost and attenuation draw the Pultec interaction',
    'vintage-eq',
    [['lowFrequencyHz', 60], ['lowBoostDb', 8], ['lowCutDb', 6],
      ['highFrequencyHz', 10_000], ['highBoostDb', 0], ['highCutDb', 0]],
    [30, 60, 120, 190, 400],
  );

  compareCurve(
    'Vintage EQ: the high section draws its bell and shelf',
    'vintage-eq',
    [['lowBoostDb', 0], ['lowCutDb', 0],
      ['highFrequencyHz', 8000], ['highBoostDb', 7], ['highBandwidth', 0.8], ['highCutDb', 5]],
    [3000, 6000, 8000, 12_000, 18_000],
  );

  // ── Interaction mapping ────────────────────────────────────────────────
  //
  // A node writes parameters.  These checks pin the arithmetic that turns a
  // pointer position into a config value — the part a curve comparison
  // cannot see, because it only ever reads state that was already correct.

  console.log('\n=== EQ GRAPH — node gestures write the right parameters ===\n');

  const eqState = withParams(neutralState(), 'eq', [['presenceHz', 3000], ['presenceDb', 0]]);
  const eqBands = buildGraphBands('eq', eqState['eq'].parameters)!;
  const presence = eqBands.find((b) => b.id === 'presence')!;

  {
    const edits = bandEdits(presence, { hz: 5000, gainDb: 4, q: 3 });
    const map = new Map(edits);
    check(
      'dragging a bell writes frequency, gain and Q together',
      map.get('presenceHz') === 5000 && map.get('presenceDb') === 4 && map.get('presenceQ') === 3,
      JSON.stringify(edits),
    );
  }

  {
    // A drag can leave the graph; the config must not follow it there.
    const edits = new Map(bandEdits(presence, { hz: 99_000, gainDb: 400, q: -5 }));
    check(
      'a drag off the graph is clamped, not written raw',
      edits.get('presenceHz') === 16_000 && edits.get('presenceDb') === 18 && edits.get('presenceQ') === 0.3,
      JSON.stringify([...edits]),
    );
  }

  {
    const lowCut = eqBands.find((b) => b.id === 'lowCut')!;
    const edits = new Map(bandEdits(lowCut, { hz: 60, gainDb: 9, q: 2 }));
    check(
      'a high-pass node ignores the gain axis',
      edits.get('lowCutHz') === 60 && edits.get('lowCutQ') === 2 && !edits.has('lowCutDb'),
      JSON.stringify([...edits]),
    );
  }

  {
    // The Pultec's scoop is drawn 1.6 octaves above the boost shelf and has
    // no frequency control of its own — dragging it must move the shared
    // low frequency, which is what the hardware does.
    const vState = withParams(neutralState(), 'vintage-eq', [['lowFrequencyHz', 60], ['lowCutDb', 4]]);
    const vBands = buildGraphBands('vintage-eq', vState['vintage-eq'].parameters)!;
    const atten = vBands.find((b) => b.id === 'lowAtten')!;
    const drawnHz = atten.hz;
    const edits = new Map(bandEdits(atten, { hz: 100 * Math.pow(2, 1.6), gainDb: -9 }));
    check(
      'the Pultec scoop is drawn above its shelf',
      Math.abs(drawnHz - 60 * Math.pow(2, 1.6)) < 0.01,
      `${drawnHz.toFixed(1)} Hz for a 60 Hz shelf`,
    );
    check(
      'dragging the scoop moves the shared low frequency',
      Math.abs((edits.get('lowFrequencyHz') ?? 0) - 100) < 0.01,
      `lowFrequencyHz=${edits.get('lowFrequencyHz')?.toFixed(2)}`,
    );
    check(
      'a scoop drawn negative is written as a positive cut',
      edits.get('lowCutDb') === 9,
      `lowCutDb=${edits.get('lowCutDb')}`,
    );
  }

  // ── Free parametric EQ ─────────────────────────────────────────────────

  console.log('\n=== EQ GRAPH — the free band list ===\n');

  {
    const base = neutralState();
    const mk = (bands: FreeEqBand[]) =>
      buildChainConfig({ state: base, parametricBands: bands.map(freeBandToWire) });

    /** Measure the chain with a free band list. */
    const heardWith = (bands: FreeEqBand[], hz: number): number => {
      const chain = new Chain!(SR);
      chain.setConfigJson(chainConfigToJson(mk(bands)));
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
    };

    const one: FreeEqBand = { ...makeFreeBand(1000, 9), q: 4 };
    check(
      'a hand-drawn band reaches the audio',
      Math.abs(heardWith([one], 1000) - 9) < 0.5,
      `${heardWith([one], 1000).toFixed(2)} dB at 1 kHz`,
    );

    const drawn = combinedGainDbAt(freeBandsToGraph([one]), 1000, SR);
    check(
      'the free curve matches the free audio',
      Math.abs(drawn - heardWith([one], 1000)) < 0.4,
      `drawn ${drawn.toFixed(2)} / heard ${heardWith([one], 1000).toFixed(2)} dB`,
    );

    // Many bands, because "unlimited" is the whole point of this module.
    const many: FreeEqBand[] = Array.from({ length: 10 }, () => ({ ...makeFreeBand(1000, 1), q: 2 }));
    const stacked = heardWith(many, 1000);
    check(
      'ten stacked bands all run',
      Math.abs(stacked - 10) < 0.6,
      `${stacked.toFixed(2)} dB from ten +1 dB bells`,
    );

    // Over capacity: the engine drops the surplus silently, so the builder
    // must cap rather than let bands vanish without anyone noticing.
    const over: FreeEqBand[] = Array.from({ length: 24 }, () => ({ ...makeFreeBand(1000, 1), q: 2 }));
    check(
      'the band list is capped at what the engine runs',
      (mk(over).parametricEq?.bands?.length ?? 0) === 16,
      `${mk(over).parametricEq?.bands?.length} bands sent for 24 drawn`,
    );

    const disabled: FreeEqBand = { ...makeFreeBand(1000, 9), enabled: false };
    check(
      'a disabled band is left out of the config',
      mk([disabled]).parametricEq === undefined,
      JSON.stringify(mk([disabled]).parametricEq ?? null),
    );

    // A pass filter has no gain in the engine.  If the UI sent its leftover
    // gain the drawn curve would show a boost the audio never applies.
    const hp: FreeEqBand = { ...makeFreeBand(500, 12), kind: 'highpass' };
    check(
      'a pass filter sends no gain',
      freeBandToWire(hp).gainDb === 0 && freeBandToWire(hp).kind === 'highPass',
      JSON.stringify(freeBandToWire(hp)),
    );
    const hpDrawn = combinedGainDbAt(freeBandsToGraph([hp]), 125, SR);
    const hpHeard = heardWith([hp], 125);
    check(
      'a hand-drawn high-pass is drawn where it filters',
      Math.abs(hpDrawn - hpHeard) < 0.4,
      `drawn ${hpDrawn.toFixed(2)} / heard ${hpHeard.toFixed(2)} dB at 125 Hz`,
    );

    check(
      'no bands means no parametric stage at all',
      mk([]).parametricEq === undefined,
      'absent',
    );
  }

  {
    // Q on the graph is bandwidth on the front panel; the two must be
    // exact inverses or the wheel gesture would drift on every turn.
    const round = qToBandwidth(bandwidthToQ(0.35));
    check(
      'bandwidth ↔ Q round-trips',
      Math.abs(round - 0.35) < 1e-9,
      `0.35 → Q ${bandwidthToQ(0.35).toFixed(4)} → ${round.toFixed(4)}`,
    );
  }

  {
    // Bypassing the module must empty the curve, or a bypassed EQ would
    // still draw a shape it is not applying.
    const state = withParams(neutralState(), 'eq', [['presenceDb', 9]]);
    const bypassed: AllModulesParameterState = { ...state, eq: { ...state['eq'], bypass: true } };
    const heard = measuredGainDb(bypassed, 3000);
    check(
      'a bypassed EQ is flat in the audio',
      Math.abs(heard) < 0.05,
      `${heard.toFixed(3)} dB at 3 kHz`,
    );
  }

  {
    // The old wire had no frequency or Q fields.  A state that never sets
    // them must still produce the classic layout, or every saved preset
    // would shift the day this shipped.
    const stripped = (db: number): AllModulesParameterState => {
      const s = withParams(neutralState(), 'eq', [['presenceDb', db]]);
      delete (s['eq'].parameters as Record<string, unknown>)['presenceHz'];
      delete (s['eq'].parameters as Record<string, unknown>)['presenceQ'];
      return s;
    };
    // Differenced against the same state with the bell flat, so the EQ's
    // other default bands (a +1.2 dB low shelf, +2 dB of air) cancel out
    // and what is left is the bell alone.
    const lifted = stripped(6);
    const flat = stripped(0);
    const heardLift = measuredGainDb(lifted, 3000) - measuredGainDb(flat, 3000);
    const bands = buildGraphBands('eq', lifted['eq'].parameters) as GraphBand[];
    const drawn = combinedGainDbAt(bands, 3000, SR);
    const drawnFlat = combinedGainDbAt(
      buildGraphBands('eq', flat['eq'].parameters) as GraphBand[], 3000, SR,
    );
    check(
      'a state with no frequency/Q keeps the classic 3 kHz bell',
      Math.abs(heardLift - 6) < 0.3 && Math.abs((drawn - drawnFlat) - heardLift) < 0.3,
      `bell lift: drawn ${(drawn - drawnFlat).toFixed(2)} / heard ${heardLift.toFixed(2)} dB`,
    );
  }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
