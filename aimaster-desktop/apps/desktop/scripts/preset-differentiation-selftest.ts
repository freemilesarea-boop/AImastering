/**
 * preset-differentiation-selftest.ts — v1.1 lineup differentiation + a
 * parameter-level sanity pass (M2-PRESET-v1.1).
 *
 *   • every pair of presets differs in ≥3 parameters (no near-duplicates)
 *   • every AI-special preset differs from every Core preset in ≥4 params
 *   • loud / wide families really are louder / wider than the streaming
 *     reference; YouTube Safe is genuinely softer + safer than Streaming Pro
 *   • parameter sanity: true-peak headroom, anti-tear on loud presets,
 *     phase protection on wide presets, no over-compression on dynamic
 *     presets, finite chain config
 *
 * Prints a per-preset minimum-difference summary (feeds
 * PRESET_DIFFERENTIATION_REPORT.md).
 *
 * Run via:
 *   pnpm --filter @aimaster/desktop test:preset-differentiation
 */

import {
  LOUI_PRESETS,
  getPreset,
  presetsByCategory,
  type LouiPreset,
} from '../src/renderer/audio/presets/loui-presets.js';
import { diffPresets } from '../src/renderer/audio/presets/preset-compare.js';
import { presetToParameterState } from '../src/renderer/audio/presets/preset-to-state.js';
import { ALL_MODULE_PARAMETER_DEFS } from '../src/renderer/audio/parameters/module-parameter-definitions.js';
import { stateToChainConfig } from '../src/renderer/audio/realtime-mastering-chain.js';

interface T { name: string; pass: boolean; detail: string; }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }

const num = (p: LouiPreset, mod: 'eq'|'dynamics'|'imager'|'limiter', id: string, d: number): number => {
  const v = p.tuning[mod]?.parameters?.[id];
  return typeof v === 'number' ? v : d;
};
const lufs = (p: LouiPreset) => num(p, 'limiter', 'targetLufs', -14);
const ceil = (p: LouiPreset) => num(p, 'limiter', 'ceilingDbtp', -1);
const width = (p: LouiPreset) => num(p, 'imager', 'widthPct', 100);
const lowMono = (p: LouiPreset) => num(p, 'imager', 'lowMonoHz', 120);
const air = (p: LouiPreset) => num(p, 'eq', 'airDb', 0);
const ratio = (p: LouiPreset) => num(p, 'dynamics', 'ratio', 1);
const mix = (p: LouiPreset) => num(p, 'dynamics', 'mixPct', 100);

// ── 1. Pairwise differentiation (≥3 params) ─────────────────────────────────

check('every preset pair differs in ≥3 parameters', () => {
  for (let i = 0; i < LOUI_PRESETS.length; i++) {
    for (let j = i + 1; j < LOUI_PRESETS.length; j++) {
      const a = LOUI_PRESETS[i]!, b = LOUI_PRESETS[j]!;
      const n = diffPresets(a, b).length;
      assert(n >= 3, `${a.id} vs ${b.id} only differ in ${n} params`);
    }
  }
});

// ── 2. AI-special vs Core (≥4 params) ───────────────────────────────────────

check('AI-special presets differ from every Core preset in ≥4 params', () => {
  const g = presetsByCategory();
  for (const ai of g['ai-special']) {
    for (const core of g.core) {
      const n = diffPresets(ai, core).length;
      assert(n >= 4, `${ai.id} vs ${core.id} only differ in ${n} params`);
    }
  }
});

// ── 3. Loud / wide families ─────────────────────────────────────────────────

check('loud presets are louder than the streaming reference', () => {
  const ref = lufs(getPreset('streaming-pro')!);
  for (const id of ['kpop-loud', 'edm-wide', 'ai-pop', 'mono-safe-shorts']) {
    assert(lufs(getPreset(id)!) > ref, `${id} should target louder than streaming-pro`);
  }
});

check('wide presets are wider; narrow/repair presets are narrower', () => {
  const ref = width(getPreset('streaming-pro')!);
  assert(width(getPreset('edm-wide')!) > 130, 'edm-wide should be wide');
  assert(width(getPreset('kpop-loud')!) > ref, 'kpop-loud wider than ref');
  assert(width(getPreset('stereo-repair')!) < 95, 'stereo-repair should narrow');
});

check('YouTube Safe is softer + safer than Streaming Pro', () => {
  const yt = getPreset('youtube-safe')!, sp = getPreset('streaming-pro')!;
  assert(air(yt) < air(sp), 'YouTube Safe should have less air');
  assert(ceil(yt) < ceil(sp), 'YouTube Safe should have a lower (safer) ceiling');
  assert(diffPresets(yt, sp).length >= 3, 'YouTube Safe vs Streaming Pro ≥3 diffs');
});

// ── 4. Parameter sanity ─────────────────────────────────────────────────────

check('all presets keep true-peak headroom (ceiling ∈ [-3,-0.5])', () => {
  for (const p of LOUI_PRESETS) {
    const c = ceil(p);
    assert(c <= -0.5 && c >= -3, `${p.id}: unsafe ceiling ${c}`);
  }
});

check('loud presets (LUFS ≥ -10) keep ceiling ≤ -1.0 (anti-tear)', () => {
  for (const p of LOUI_PRESETS) {
    if (lufs(p) >= -10) assert(ceil(p) <= -1.0, `${p.id}: loud but ceiling ${ceil(p)} > -1.0`);
  }
});

check('wide presets (width > 130) protect the low end (lowMono ≥ 150)', () => {
  for (const p of LOUI_PRESETS) {
    if (width(p) > 130) assert(lowMono(p) >= 150, `${p.id}: wide but lowMono ${lowMono(p)} < 150`);
  }
});

check('dynamic / natural presets are not over-compressed', () => {
  const piano = getPreset('piano-natural')!;
  assert(ratio(piano) <= 1.6 && mix(piano) <= 70, 'Piano Natural must stay dynamic');
  for (const id of ['lofi-warm', 'vintage-soft', 'ballad-vocal']) {
    assert(ratio(getPreset(id)!) <= 2.6, `${id}: ratio too high for its character`);
  }
});

check('no extreme width (≤ 150) anywhere', () => {
  for (const p of LOUI_PRESETS) assert(width(p) <= 150, `${p.id}: width ${width(p)} too extreme`);
});

check('chain config is finite for every preset', () => {
  for (const p of LOUI_PRESETS) {
    const cfg = stateToChainConfig(presetToParameterState(p, ALL_MODULE_PARAMETER_DEFS));
    for (const [k, v] of Object.entries(cfg)) {
      if (typeof v === 'number') assert(Number.isFinite(v), `${p.id}: ${k} not finite`);
    }
  }
});

// ── Per-preset min-difference summary (report data) ─────────────────────────

console.log('\n=== Loui preset differentiation (v1.1) ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);

console.log('\n--- min parameter diff vs all other presets ---');
for (const p of LOUI_PRESETS) {
  let min = Infinity; let closest = '';
  for (const q of LOUI_PRESETS) {
    if (q.id === p.id) continue;
    const n = diffPresets(p, q).length;
    if (n < min) { min = n; closest = q.id; }
  }
  console.log(`${p.id.padEnd(18)} min=${min} (closest: ${closest})`);
}

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
