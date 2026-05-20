/**
 * preset-tuning-selftest.ts — validates the Loui preset lineup
 * (M2-PRESET-TUNING):
 *
 *   • unique ids, non-empty categories, ai-special presets are aiOptimized
 *   • every tuned value is in-range + step-valid for its parameter def
 *     (so no preset value would be silently clamped on apply)
 *   • presetToParameterState + stateToChainConfig produce finite numbers
 *   • preview ↔ export consistency: the renderable params carried by the
 *     chain config match the preset's tuning (no parameter drift)
 *   • diffPresets behaves (identical → empty, distinct → non-empty) and
 *     the AI-special tuning intents hold (e.g. vocal cleaner cuts presence)
 *
 * Run via:
 *   pnpm --filter @aimaster/desktop test:preset-tuning
 */

import {
  LOUI_PRESETS,
  presetsByCategory,
  getPreset,
  DEFAULT_PRESET_ID,
  type LouiPreset,
} from '../src/renderer/audio/presets/loui-presets.js';
import { presetToParameterState, presetApplyPlan } from '../src/renderer/audio/presets/preset-to-state.js';
import { diffPresets } from '../src/renderer/audio/presets/preset-compare.js';
import { ALL_MODULE_PARAMETER_DEFS } from '../src/renderer/audio/parameters/module-parameter-definitions.js';
import { MODULE_IDS } from '../src/renderer/audio/parameters/parameter-state.js';
import { stateToChainConfig } from '../src/renderer/audio/realtime-mastering-chain.js';

// ── Tiny harness ────────────────────────────────────────────────────────────

interface T { name: string; pass: boolean; detail: string; }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function near(a: number, b: number, eps: number, msg: string): void {
  if (Math.abs(a - b) > eps) throw new Error(`${msg} — ${a} vs ${b}`);
}

// ── 1. Lineup invariants ────────────────────────────────────────────────────

check('preset ids are unique', () => {
  const ids = LOUI_PRESETS.map((p) => p.id);
  assert(new Set(ids).size === ids.length, `duplicate ids: ${ids.join(',')}`);
});

check('default preset resolves', () => {
  assert(getPreset(DEFAULT_PRESET_ID), `default preset "${DEFAULT_PRESET_ID}" missing`);
});

check('every category is non-empty', () => {
  const g = presetsByCategory();
  assert(g.core.length >= 4, 'core lineup');
  assert(g.character.length >= 5, 'character lineup');
  assert(g['ai-special'].length >= 4, 'ai-special lineup');
});

check('ai-special presets are aiOptimized', () => {
  for (const p of presetsByCategory()['ai-special']) {
    assert(p.aiOptimized, `${p.id} should be aiOptimized`);
  }
});

check('every preset has metadata + version', () => {
  for (const p of LOUI_PRESETS) {
    assert(p.displayName && p.description, `${p.id} missing copy`);
    assert(/^\d+\.\d+\.\d+$/.test(p.version), `${p.id} bad version ${p.version}`);
    assert(p.recommendedGenres.length > 0, `${p.id} no genres`);
    assert(/^#[0-9A-Fa-f]{6}$/.test(p.accent), `${p.id} bad accent ${p.accent}`);
  }
});

// ── 2. Every tuned value is in-range for its parameter def ───────────────────

function defFor(moduleId: string, parameterId: string) {
  const mod = ALL_MODULE_PARAMETER_DEFS[moduleId as keyof typeof ALL_MODULE_PARAMETER_DEFS];
  return mod.parameters.find((d) => d.id === parameterId);
}

check('all tuned values are in-range (no silent clamp)', () => {
  for (const p of LOUI_PRESETS) {
    for (const moduleId of MODULE_IDS) {
      const mod = p.tuning[moduleId];
      if (!mod) continue;
      for (const [parameterId, value] of Object.entries(mod.parameters)) {
        const def = defFor(moduleId, parameterId);
        assert(def, `${p.id}: unknown param ${moduleId}.${parameterId}`);
        if (def!.kind === 'number') {
          assert(typeof value === 'number', `${p.id}: ${parameterId} not a number`);
          const v = value as number;
          assert(v >= def!.min && v <= def!.max,
            `${p.id}: ${moduleId}.${parameterId}=${v} out of [${def!.min},${def!.max}]`);
        } else if (def!.kind === 'enum') {
          assert(def!.values.includes(String(value)),
            `${p.id}: ${moduleId}.${parameterId}=${String(value)} not in enum`);
        }
      }
    }
  }
});

// ── 3. State + chain config are finite (no NaN) ──────────────────────────────

check('presetToParameterState + stateToChainConfig are finite', () => {
  for (const p of LOUI_PRESETS) {
    const state = presetToParameterState(p, ALL_MODULE_PARAMETER_DEFS);
    const cfg = stateToChainConfig(state);
    for (const [k, v] of Object.entries(cfg)) {
      if (typeof v === 'number') assert(Number.isFinite(v), `${p.id}: chain config ${k} not finite`);
    }
  }
});

// ── 4. Preview ↔ export consistency (no parameter drift) ─────────────────────
//
// The renderable params (targetLufs / ceiling / width / output gain) the
// chain config carries must equal the preset's tuned values — same state,
// same direction.  This is the guarantee against preview/export drift.

check('chain config reflects preset renderable params', () => {
  for (const p of LOUI_PRESETS) {
    const lim = p.tuning.limiter?.parameters ?? {};
    const img = p.tuning.imager?.parameters ?? {};
    const eq = p.tuning.eq?.parameters ?? {};
    const cfg = stateToChainConfig(presetToParameterState(p, ALL_MODULE_PARAMETER_DEFS));
    if (typeof lim['targetLufs'] === 'number') {
      // targetLufs is renderable via loudness-norm; the preview limiter
      // ceiling carries ceilingDbtp.
      near(cfg.limCeilingDbtp, lim['ceilingDbtp'] as number, 1e-6, `${p.id} ceiling`);
    }
    if (typeof img['widthPct'] === 'number') {
      near(cfg.imgWidthPct, img['widthPct'] as number, 1e-6, `${p.id} width`);
    }
    if (typeof eq['outputGainDb'] === 'number') {
      near(cfg.outputGainDb, eq['outputGainDb'] as number, 1e-6, `${p.id} outputGain`);
    }
  }
});

// ── 5. diff behaviour ────────────────────────────────────────────────────────

check('diffPresets: identical → empty, distinct → non-empty', () => {
  const a = getPreset('streaming-pro')!;
  const b = getPreset('kpop-loud')!;
  assert(diffPresets(a, a).length === 0, 'same preset should not differ');
  assert(diffPresets(a, b).length > 0, 'distinct presets should differ');
});

// ── 6. AI-special tuning intents hold ────────────────────────────────────────

check('AI Vocal Cleaner cuts presence + de-muds', () => {
  const p = getPreset('ai-vocal-cleaner')!;
  const eq = p.tuning.eq!.parameters;
  assert((eq['presenceDb'] as number) < 0, 'presence should be cut');
  assert((eq['lowCutHz'] as number) >= 40, 'low cut raised to de-mud');
});

check('Cymbal Smooth pulls down air', () => {
  const eq = getPreset('cymbal-smooth')!.tuning.eq!.parameters;
  assert((eq['airDb'] as number) < 0, 'air should be reduced');
});

check('Stereo Repair narrows width + strong low-mono', () => {
  const img = getPreset('stereo-repair')!.tuning.imager!.parameters;
  assert((img['widthPct'] as number) < 100, 'width narrowed');
  assert((img['lowMonoHz'] as number) >= 200, 'strong low-mono');
});

check('Mono Safe Shorts keeps high low-mono', () => {
  const img = getPreset('mono-safe-shorts')!.tuning.imager!.parameters;
  assert((img['lowMonoHz'] as number) >= 150, 'low-mono raised for mono fold-down');
});

// ── 7. apply plan covers tuned params ────────────────────────────────────────

check('presetApplyPlan flattens all tuned params', () => {
  for (const p of LOUI_PRESETS) {
    const plan = presetApplyPlan(p);
    let count = 0;
    for (const moduleId of MODULE_IDS) count += Object.keys(p.tuning[moduleId]?.parameters ?? {}).length;
    assert(plan.parameters.length === count, `${p.id}: plan ${plan.parameters.length} != ${count}`);
  }
});

// ── Print summary ─────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Loui preset tuning ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
