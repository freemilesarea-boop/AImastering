// AI vocal preset self-test — the preset does what its name promises.
//
// A preset is the one thing a beginner will click, and it is the easiest
// thing to get quietly wrong: it names modules by id and parameters by
// name, so a renamed parameter turns into a silent no-op with no error
// anywhere. The tuning still loads, the chips still light up, and nothing
// happens to the audio.
//
// So this measures the preset the way the DSP tests measure a module: apply
// it to real state, build the real config, push it through the real chain,
// and check the artefact frequency actually leaves.
//
// Run:  pnpm --filter @aimaster/desktop test:vocal-preset

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_MODULE_PARAMETER_DEFS,
  defaultAllModulesState,
  MODULE_IDS,
  type AllModulesParameterState,
} from '../src/renderer/audio/parameters/index.js';
import { buildChainConfig, chainConfigToJson } from '../src/renderer/audio/chain-config.js';
import { LOUI_PRESETS, getPreset } from '../src/renderer/audio/presets/loui-presets.js';
import { presetApplyPlan } from '../src/renderer/audio/presets/preset-to-state.js';
import {
  presetGlossaryFor,
  presetsMissingKorean,
  orphanedPresetGlossaryKeys,
} from '../src/renderer/audio/presets/preset-glossary.js';

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

/** Apply a preset the way the Studio does. */
function applied(presetId: string): AllModulesParameterState {
  const preset = getPreset(presetId)!;
  const plan = presetApplyPlan(preset);
  const next = defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS);
  for (const b of plan.bypasses) next[b.moduleId] = { ...next[b.moduleId], bypass: b.bypass };
  for (const p of plan.parameters) {
    const mod = next[p.moduleId];
    next[p.moduleId] = { ...mod, parameters: { ...mod.parameters, [p.parameterId]: p.value } };
  }
  return next;
}

console.log('\n=== PRESETS — every tuning names something real ===\n');

{
  // A preset that names a parameter which no longer exists applies nothing
  // and reports nothing.  This is the check that makes renaming safe.
  const bad: string[] = [];
  for (const preset of LOUI_PRESETS) {
    for (const moduleId of MODULE_IDS) {
      const mod = preset.tuning[moduleId];
      if (!mod) continue;
      const known = new Set(ALL_MODULE_PARAMETER_DEFS[moduleId].parameters.map((p) => p.id));
      for (const id of Object.keys(mod.parameters)) {
        if (!known.has(id)) bad.push(`${preset.id}: ${moduleId}.${id}`);
      }
    }
  }
  check(
    'every preset parameter exists on its module',
    bad.length === 0,
    bad.length === 0 ? `${LOUI_PRESETS.length} presets checked` : bad.join(', '),
  );
}

{
  const missing = presetsMissingKorean();
  check(
    'every preset has a Korean name and a plain sentence',
    missing.length === 0,
    missing.length === 0 ? `${LOUI_PRESETS.length} presets` : missing.join(', '),
  );
  const orphans = orphanedPresetGlossaryKeys();
  check('no preset translation is orphaned', orphans.length === 0, orphans.join(', ') || 'none');
}

console.log('\n=== AI VOCAL TEXTURE — the artefact actually leaves ===\n');

interface WasmChain {
  setConfigJson(json: string): void;
  processStereo(left: Float32Array, right: Float32Array): void;
}
let Chain: (new (sr: number) => WasmChain) | null = null;
try {
  const p = path.resolve(__dirname_, '../../../packages/dsp-wasm/pkg-node/loui_dsp_wasm.cjs');
  const mod = require_(p) as { LouiMasteringChain?: new (sr: number) => WasmChain };
  Chain = typeof mod.LouiMasteringChain === 'function' ? mod.LouiMasteringChain : null;
} catch { /* reported below */ }

if (!Chain) {
  console.error('[FAIL] node-target WASM unavailable — pnpm --filter @loui/dsp-wasm run build:node');
  failed++;
} else {
  const magnitudeAt = (x: Float32Array, hz: number): number => {
    const from = x.length >> 1;
    const n = x.length - from;
    const w = (2 * Math.PI * hz) / SR;
    const coeff = 2 * Math.cos(w);
    let s1 = 0;
    let s2 = 0;
    for (let i = from; i < x.length; i++) {
      const s0 = x[i]! + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / (n * 0.5);
  };

  const render = (state: AllModulesParameterState, tones: Array<[number, number]>): Float32Array => {
    const chain = new Chain!(SR);
    chain.setConfigJson(chainConfigToJson(buildChainConfig({ state })));
    const n = 1 << 15;
    const left = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (const [hz, amp] of tones) v += Math.sin((2 * Math.PI * hz * i) / SR) * amp;
      left[i] = v;
    }
    const right = Float32Array.from(left);
    for (let off = 0; off < n; off += 512) {
      const end = Math.min(off + 512, n);
      chain.processStereo(left.subarray(off, end), right.subarray(off, end));
    }
    return left;
  };

  const state = applied('ai-vocal-texture');
  const cfg = buildChainConfig({ state });

  check(
    'the preset engages the module that does the repair',
    cfg.topRebuild !== undefined && (cfg.topRebuild.amountPct ?? 0) > 0,
    `amount ${cfg.topRebuild?.amountPct ?? 0}%`,
  );
  check(
    'it engages the spectral shaper that catches what survives',
    cfg.spectral !== undefined && cfg.spectral.shaperEnabled === true,
    `shaper ${cfg.spectral?.shaperEnabled === true ? 'on' : 'off'}`,
  );
  check(
    'it engages the de-esser',
    cfg.deess !== undefined && (cfg.deess.rangeDb ?? 0) > 0,
    `range ${cfg.deess?.rangeDb ?? 0} dB`,
  );
  check(
    'it narrows the top rather than the whole image',
    (cfg.imager?.bandWidthPct?.[3] ?? 100) < 90 && (cfg.imager?.widthPct ?? 100) === 100,
    `high band ${cfg.imager?.bandWidthPct?.[3] ?? 100}% · overall ${cfg.imager?.widthPct ?? 100}%`,
  );
  check(
    'it does not decide how loud the record is',
    (cfg.limiter?.ceilingDbtp ?? 0) === -1,
    'streaming defaults left in place',
  );

  {
    // The measurement that matters: a 4.5 kHz body with a 12 kHz stand-in
    // for the artefact.  After the preset the artefact frequency must be
    // materially down, and the body must still be there.
    const MATERIAL: Array<[number, number]> = [[4500, 0.35], [12_000, 0.06]];
    const dry = render(defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS), MATERIAL);
    const wet = render(state, MATERIAL);

    const artefactDb = 20 * Math.log10(magnitudeAt(wet, 12_000) / magnitudeAt(dry, 12_000));
    check(
      'the artefact frequency is pushed down',
      artefactDb < -6,
      `${artefactDb.toFixed(1)} dB at 12 kHz`,
    );

    const bodyDb = 20 * Math.log10(magnitudeAt(wet, 4500) / magnitudeAt(dry, 4500));
    check(
      'the voice it was generated from survives',
      Math.abs(bodyDb) < 4,
      `${bodyDb.toFixed(1)} dB at 4.5 kHz`,
    );
  }

  {
    // A preset must not be a wall of processing: modules it does not name
    // stay where they were, or auditioning one would throw away work.
    const before = defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS);
    const after = applied('ai-vocal-texture');
    const untouched = ['tape', 'reverb', 'delay', 'vintage-comp', 'multiband'] as const;
    const changed = untouched.filter(
      (id) => JSON.stringify(before[id]) !== JSON.stringify(after[id]),
    );
    check(
      'modules the preset does not mention are left alone',
      changed.length === 0,
      changed.length === 0 ? untouched.join(', ') + ' unchanged' : changed.join(', '),
    );
  }

  {
    const ko = presetGlossaryFor('ai-vocal-texture');
    check(
      'the preset explains itself in Korean',
      !!ko && ko.plain.length > 20 && ko.ko.length > 0,
      ko ? `${ko.ko} — ${ko.plain.slice(0, 30)}…` : 'missing',
    );
  }
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
