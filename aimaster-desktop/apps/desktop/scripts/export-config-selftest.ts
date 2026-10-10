// export-config-selftest — proves the realtime preview and the offline
// export draw from the SAME parameter state (single source of truth), and
// documents exactly which params reach the offline render.
//
// Run: pnpm tsx scripts/export-config-selftest.ts

import { summarizePending } from '../src/renderer/audio/engine-bridge/pending-summary.js';
import { stateToChainConfig } from '../src/renderer/audio/realtime-mastering-chain.js';
import { buildChainConfig } from '../src/renderer/audio/chain-config.js';
import { defaultAllModulesState } from '../src/renderer/audio/parameters/parameter-state.js';
import { ALL_MODULE_PARAMETER_DEFS } from '../src/renderer/audio/parameters/module-parameter-definitions.js';
import type { AllModulesParameterState } from '../src/renderer/audio/parameters/index.js';
import type { MasteringOptions } from '@aimaster/shared-types';

const baseOptions = {
  targetLufs: -14, targetTp: -1, stereoWidth: 1, outputGainDb: 0,
  sampleRate: 48000, bitDepth: 24,
} as unknown as MasteringOptions;

function setParam(state: AllModulesParameterState, mod: keyof AllModulesParameterState, id: string, v: number | boolean): AllModulesParameterState {
  return {
    ...state,
    [mod]: { ...state[mod], parameters: { ...state[mod].parameters, [id]: v } },
  };
}

let fail = 0;
const check = (name: string, pass: boolean, detail: string) => {
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} — ${detail}`);
  if (!pass) fail++;
};

console.log('\n=== EXPORT ↔ REALTIME CONFIG SINGLE-SOURCE-OF-TRUTH ===\n');

const base = defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS);

// 1) outputGainDb edit reaches BOTH realtime chain config AND export override.
{
  const edited = setParam(base, 'eq', 'outputGainDb', -24);
  const rt = stateToChainConfig(edited);
  const sum = summarizePending(edited, {}, baseOptions);
  check('Output -24dB → realtime config', rt.outputGainDb === -24, `realtime.outputGainDb=${rt.outputGainDb}`);
  check('Output -24dB → export override', sum.renderOverride.outputGainDb === -24, `export.outputGainDb=${sum.renderOverride.outputGainDb}`);
}

// 2) imager width edit reaches both (export as stereoWidth, value /100).
{
  const edited = setParam(base, 'imager', 'widthPct', 0);
  const rt = stateToChainConfig(edited);
  const sum = summarizePending(edited, {}, baseOptions);
  check('Width 0% → realtime config', rt.imgWidthPct === 0, `realtime.imgWidthPct=${rt.imgWidthPct}`);
  check('Width 0% → export override', sum.renderOverride.stereoWidth === 0, `export.stereoWidth=${sum.renderOverride.stereoWidth}`);
}

// 2b) Stereoize has to do TWO things, and each one alone looks fine.
//
// It decides whether the imager section is emitted at all (nothing else in
// the module has moved from its default), and it is a field inside that
// section.  parameter-reach-selftest is satisfied by either on its own: with
// the field dropped, flipping the switch still makes the SECTION appear, and
// the sweep reads that as "reaches an engine".  So both halves are asserted
// here, on one state with nothing else touched.
{
  const edited = setParam(base, 'imager', 'stereoize', true);
  const img = buildChainConfig({ state: edited }).imager;
  check('Stereoize reaches the imager config',
    img?.stereoize === true, `wire.imager.stereoize=${String(img?.stereoize)}`);
  const rt = stateToChainConfig(edited);
  check('Stereoize reaches the preview config too',
    rt.imgStereoize === true, `realtime.imgStereoize=${String(rt.imgStereoize)}`);

  // The OTHER half, in the only state where it decides anything.  The imager
  // ships with low-mono at 120 Hz and the low and mid-high bands at 40 % and
  // 110 %, every one of which already counts as moved — so the section is
  // emitted whatever the switch says, and asserting "stereoize engages the
  // imager" from the defaults would pass with nothing holding it up.  Put
  // every other imager control at neutral first; then the switch is the only
  // reason there is to emit the module at all.
  const neutral = ['widthPct', 'bandLowPct', 'bandMidLowPct', 'bandMidHighPct', 'bandHighPct']
    .reduce((st, id) => setParam(st, 'imager', id, 100),
      setParam(base, 'imager', 'lowMonoHz', 20));
  const quiet = buildChainConfig({ state: neutral }).imager;
  const alone = buildChainConfig({ state: setParam(neutral, 'imager', 'stereoize', true) }).imager;
  check('Stereoize on its own is reason enough to engage the imager',
    quiet === undefined && alone?.stereoize === true,
    `neutral imager ${quiet === undefined ? 'absent' : 'present'}`
    + `, with the switch ${String(alone?.stereoize)}`);
}

// 3) EQ air reaches realtime config and the Rust offline render (via
//    chainConfig = stateToChainConfig(state) passed to audio:master-rust-experimental).
//    It does NOT reach the Python renderOverride — Python uses only loudness /
//    stereoWidth / outputGainDb.  The test asserts the Python path correctly,
//    which is the source-of-truth for the pending-summary module.
{
  const edited = setParam(base, 'eq', 'airDb', 24);
  const rt = stateToChainConfig(edited);
  const sum = summarizePending(edited, {}, baseOptions);
  const inPythonOverride = 'airDb' in sum.renderOverride || Object.keys(sum.renderOverride).some((k) => k.toLowerCase().includes('air'));
  check('EQ Air +24dB → realtime config', rt.eqAirDb === 24, `realtime.eqAirDb=${rt.eqAirDb}`);
  check('EQ Air not in Python renderOverride (Rust render applies it via chainConfig)', !inPythonOverride,
    `python override keys=[${Object.keys(sum.renderOverride).join(',')}]`);
}

console.log(`\n=== ${fail === 0 ? 'ALL EXPORT-CONFIG TESTS PASS' : `${fail} FAILED`} ===\n`);
if (fail) process.exit(1);
