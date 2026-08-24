/**
 * modules-selftest.ts — Loui Module Suite honesty (OZONE-STYLE-MODULE-SUITE).
 *
 * Guarantees the UI never implies a module does more than it really does,
 * and that "live"/"export" claims are backed by the real renderable map.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:modules
 */

import { LOUI_MODULES, getModule, CHAIN_MODULE_IDS, activeModules } from '../src/renderer/audio/modules/loui-module-suite.js';
import { validateAllModules } from '../src/renderer/audio/modules/module-support-matrix.js';
import { RENDERABLE_MAP_LOOKUP } from '../src/renderer/audio/engine-bridge/renderable-map.js';

interface T { name: string; pass: boolean; detail: string; }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

check('module ids are unique', () => {
  const ids = LOUI_MODULES.map((m) => m.id);
  assert(new Set(ids).size === ids.length, `dupes: ${ids.join(',')}`);
});

check('status honesty rules hold for every module', () => {
  const v = validateAllModules();
  assert(v.length === 0, v.join(' | '));
});

check('paramModuleId references a real param module', () => {
  const valid = new Set(['eq', 'dynamics', 'imager', 'limiter', 'export']);
  for (const m of LOUI_MODULES) {
    if (m.paramModuleId) assert(valid.has(m.paramModuleId), `${m.id}: bad paramModuleId ${m.paramModuleId}`);
  }
});

check('export-renderable claims are backed by RENDERABLE_MAP', () => {
  // The export pipeline honours exactly these engine targets.
  const renderable = new Set(Object.values(RENDERABLE_MAP_LOOKUP)); // targetLufs/targetTp/stereoWidth/outputGainDb
  assert(renderable.has('targetLufs'), 'targetLufs renderable');
  assert(renderable.has('targetTp'), 'targetTp renderable');
  assert(renderable.has('stereoWidth'), 'stereoWidth renderable');
  // Limiter + Maximizer + Imager claim export support → must be backed.
  assert(getModule('limiter')!.exportSupport !== 'none', 'limiter export backed (targetTp)');
  assert(getModule('maximizer')!.exportSupport !== 'none', 'maximizer export backed (targetLufs)');
  assert(getModule('imager')!.exportSupport !== 'none', 'imager export backed (stereoWidth)');
});

check('planned modules are bypassed by default + cost-free claims', () => {
  for (const m of LOUI_MODULES) {
    if (m.status === 'planned') {
      assert(m.defaultBypass === true, `${m.id}: planned should default bypassed`);
      assert(m.previewSupport === 'none' && m.exportSupport === 'none', `${m.id}: planned must claim no support`);
    }
  }
});

check('chain modules map to the Rust signal flow order', () => {
  // input gain → EQ → dynamics → imager → limiter → output
  const expectFirst = ['eq', 'dynamic-eq', 'dynamics', 'imager', 'limiter', 'maximizer'];
  for (const id of expectFirst) assert(CHAIN_MODULE_IDS.includes(id), `chain missing ${id}`);
  assert(CHAIN_MODULE_IDS.indexOf('eq') < CHAIN_MODULE_IDS.indexOf('limiter'), 'EQ before limiter');
  assert(CHAIN_MODULE_IDS.indexOf('dynamics') < CHAIN_MODULE_IDS.indexOf('imager'), 'dynamics before imager');
});

check('AI modules are preset-backed + honestly preview-only/planned', () => {
  for (const m of LOUI_MODULES.filter((x) => x.category === 'ai')) {
    if (m.status === 'preview-only') assert(m.presetBacked === true, `${m.id}: preview-only AI module must be preset-backed`);
    assert(m.status === 'preview-only' || m.status === 'planned', `${m.id}: AI module unexpected status ${m.status}`);
  }
});

check('every module has copy + a valid visual', () => {
  const visuals = new Set(['eq-curve', 'spectrum', 'gr-meter', 'vectorscope', 'lowend-meter', 'none']);
  for (const m of LOUI_MODULES) {
    assert(m.displayName && m.description, `${m.id}: missing copy`);
    assert(visuals.has(m.visual), `${m.id}: bad visual ${m.visual}`);
  }
});

// The status fields above are checked against the renderable maps, so a module
// cannot claim 'live' without backing.  The DESCRIPTION is not checked by
// anything, and that is where the untrue claim actually got in: the limiter
// advertised "True-peak-safe ceiling with lookahead + ISP" while the preview
// limiter approximates inter-sample peaks with 0.3 dB of fixed headroom and
// does no oversampling at all (dsp-core .../mastering/limiter.rs says so in its
// own doc comment).  The lookahead was real; the ISP was not.
//
// A description is marketing copy that ships inside the product, so it gets the
// same rule as a status flag: it may say what the code does.  These are the
// phrases that were used to claim more than that.
check('no description claims a true-peak guarantee the preview does not have', () => {
  const banned = [
    'True-peak-safe',
    'true-peak-safe',
    '+ ISP',
    'true-peak protected',
  ];
  for (const m of LOUI_MODULES) {
    for (const phrase of banned) {
      assert(
        !m.description.includes(phrase),
        `${m.id}: description claims "${phrase}" — the preview limiter has no oversampling, `
        + 'so say where the guarantee holds (export) and where it is an approximation (preview)',
      );
    }
  }
});

check('activeModules excludes planned', () => {
  assert(activeModules().every((m) => m.status !== 'planned'), 'active has planned');
  assert(activeModules().length < LOUI_MODULES.length, 'some planned exist');
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Loui module suite honesty ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
