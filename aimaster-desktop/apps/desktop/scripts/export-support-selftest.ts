/**
 * export-support-selftest.ts — export-renderable honesty (OZONE-MODULE-NEXT-4).
 *
 * Guarantees the export-support classification matches what Python truly
 * honours (the 4 renderable params + sample rate / bit depth) and never
 * marks an unsupported EQ/Dynamics/Limiter-detail knob as export-exact.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:export-support
 */

import {
  classifyParamExport, exportSupportMatrix, summarizeChangedExport,
} from '../src/renderer/audio/engine-bridge/export-parameter-adapter.js';
import { ALL_MODULE_PARAMETER_DEFS } from '../src/renderer/audio/parameters/module-parameter-definitions.js';
import { RENDERABLE_MAP_LOOKUP } from '../src/renderer/audio/engine-bridge/renderable-map.js';
import { getModule } from '../src/renderer/audio/modules/loui-module-suite.js';

interface T { name: string; pass: boolean; detail: string; }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function support(mod: 'eq'|'dynamics'|'imager'|'limiter'|'export', id: string) {
  const def = ALL_MODULE_PARAMETER_DEFS[mod].parameters.find((d) => d.id === id)!;
  assert(def, `missing ${mod}.${id}`);
  return classifyParamExport(def);
}

check('the four renderable params are export-exact', () => {
  eqStr(support('limiter', 'targetLufs'), 'exact', 'targetLufs');
  eqStr(support('limiter', 'ceilingDbtp'), 'exact', 'ceilingDbtp');
  eqStr(support('imager', 'widthPct'), 'exact', 'widthPct');
  eqStr(support('eq', 'outputGainDb'), 'exact', 'outputGainDb');
});

check('exact set equals the renderable map size (no over-claiming)', () => {
  const exactCount = exportSupportMatrix().filter((r) => r.support === 'exact').length;
  eqNum(exactCount, Object.keys(RENDERABLE_MAP_LOOKUP).length, 'exact count == renderable map');
});

check('EQ tone params are preview-only (Python has no EQ band control)', () => {
  for (const id of ['lowCutHz', 'lowShelfDb', 'presenceDb', 'airDb']) {
    eqStr(support('eq', id), 'preview-only', `eq.${id}`);
  }
});

check('Dynamics params are preview-only (Python uses fixed style presets)', () => {
  for (const id of ['thresholdDb', 'ratio', 'attackMs', 'releaseMs', 'mixPct']) {
    eqStr(support('dynamics', id), 'preview-only', `dyn.${id}`);
  }
});

check('Limiter lookahead / ISP are preview-only (ffmpeg alimiter lacks them)', () => {
  eqStr(support('limiter', 'lookaheadMs'), 'preview-only', 'lookaheadMs');
  eqStr(support('limiter', 'isp'), 'preview-only', 'isp');
});

check('imager low-mono is preview-only', () => {
  eqStr(support('imager', 'lowMonoHz'), 'preview-only', 'lowMonoHz');
});

check('export sample rate / bit depth are export-only', () => {
  eqStr(support('export', 'sampleRate'), 'export-only', 'sampleRate');
  eqStr(support('export', 'bitDepth'), 'export-only', 'bitDepth');
});

check('dither is export-only now that it has DSP; format is still planned', () => {
  // This test used to say dither was 'planned', and it was right — the
  // parameter existed with no adapter behind it.  It has one now
  // (daw/audio/dither.ts), reached by both encoders, so it grades the same as
  // sampleRate and bitDepth: it changes the EXPORT render and not the
  // preview, because the preview never leaves float and has no word length to
  // reduce.
  eqStr(support('export', 'dither'), 'export-only', 'dither');
  // Format genuinely is still planned — nothing writes anything but WAV.
  eqStr(support('export', 'format'), 'planned', 'format');
});

check('no param is "approximate" today (honest — none auto-approximated)', () => {
  assert(exportSupportMatrix().every((r) => r.support !== 'approximate'), 'approximate must be empty');
});

check('module-suite statuses are consistent with export support', () => {
  // Modules with an export-exact core claim live; EQ/Dynamics claim preview-only.
  eqStr(getModule('limiter')!.status, 'live', 'limiter live');
  eqStr(getModule('maximizer')!.status, 'live', 'maximizer live');
  eqStr(getModule('imager')!.status, 'live', 'imager live');
  eqStr(getModule('eq')!.status, 'preview-only', 'eq preview-only');
  eqStr(getModule('dynamics')!.status, 'preview-only', 'dynamics preview-only');
});

check('summarizeChangedExport buckets correctly', () => {
  const s = summarizeChangedExport([
    { moduleId: 'limiter', parameterId: 'targetLufs' },   // exact
    { moduleId: 'eq', parameterId: 'presenceDb' },        // preview-only
    { moduleId: 'eq', parameterId: 'airDb' },             // preview-only
    { moduleId: 'export', parameterId: 'sampleRate' },    // export-only
  ]);
  eqNum(s.exact, 1, 'exact'); eqNum(s.previewOnly, 2, 'previewOnly'); eqNum(s.exportOnly, 1, 'exportOnly');
  assert(s.text.includes('1 exact') && s.text.includes('2 preview-only'), `text: ${s.text}`);
});

function eqStr(a: string, b: string, m: string): void { if (a !== b) throw new Error(`${m} — got ${a}, want ${b}`); }
function eqNum(a: number, b: number, m: string): void { if (a !== b) throw new Error(`${m} — got ${a}, want ${b}`); }

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== export support honesty ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
