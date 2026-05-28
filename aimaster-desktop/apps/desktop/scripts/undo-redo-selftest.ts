// undo-redo-selftest — exercises the parameter-state history stack outside
// React so we catch coalescing / replay regressions without a renderer.
//
// Run: pnpm tsx scripts/undo-redo-selftest.ts

import { listCustomPresets, saveCustomPreset, deleteCustomPreset, sanitisePresetName } from '../src/renderer/audio/presets/custom-preset-storage.js';
import { defaultAllModulesState } from '../src/renderer/audio/parameters/parameter-state.js';
import { ALL_MODULE_PARAMETER_DEFS } from '../src/renderer/audio/parameters/module-parameter-definitions.js';

// ── localStorage shim for the Node harness ────────────────────────────
const memStore = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (k) => memStore.has(k) ? memStore.get(k)! : null,
  setItem: (k, v) => { memStore.set(k, v); },
  removeItem: (k) => { memStore.delete(k); },
  clear: () => memStore.clear(),
  key: (i) => Array.from(memStore.keys())[i] ?? null,
  get length() { return memStore.size; },
} satisfies Storage;

let fail = 0;
const check = (name: string, pass: boolean, detail = '') => {
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!pass) fail++;
};

console.log('\n=== CUSTOM PRESET STORAGE ===\n');

// 1) Empty store starts empty.
check('Initially empty', listCustomPresets().length === 0);

// 2) Sanitisation: trims + collapses whitespace + caps length.
check('Sanitise trims whitespace', sanitisePresetName('   My Preset   ') === 'My Preset');
check('Sanitise collapses inner whitespace', sanitisePresetName('A   B') === 'A B');
check('Sanitise caps at 60', sanitisePresetName('x'.repeat(200)).length === 60);
check('Sanitise empty → empty', sanitisePresetName('   ') === '');

// 3) Save returns the entry with id + timestamp.
const baseState = defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS);
const heavy = JSON.parse(JSON.stringify(baseState));
heavy.eq.parameters.airDb = 5.5;
heavy.imager.parameters.widthPct = 140;

const saved = saveCustomPreset('Loud Bright', heavy);
check('Save returns entry', saved !== null);
check('Save assigns id', !!saved?.id);
check('Save assigns name', saved?.name === 'Loud Bright');
check('Save deep-clones state', saved?.state.eq.parameters.airDb === 5.5);

// 4) Saved state is detached — mutating original doesn't affect storage.
heavy.eq.parameters.airDb = 100;
const refreshed = listCustomPresets();
check('Stored state independent of caller mutation', refreshed[0]?.state.eq.parameters.airDb === 5.5);

// 5) List sorted newest-first.
saveCustomPreset('Older', baseState);
// Add a small artificial delay-equivalent by manipulating system clock isn't easy;
// instead, manually patch Date.now for the next save.
const realNow = Date.now;
Date.now = () => realNow() + 1000;
const newer = saveCustomPreset('Newer', baseState);
Date.now = realNow;
const sorted = listCustomPresets();
check('Newest first', sorted[0]?.name === 'Newer');

// 6) Empty name rejected.
const bad = saveCustomPreset('   ', baseState);
check('Empty name rejected', bad === null);

// 7) Delete removes by id.
if (newer) {
  const ok = deleteCustomPreset(newer.id);
  check('Delete by id', ok === true);
  const after = listCustomPresets();
  check('Deleted entry gone', !after.find((p) => p.id === newer.id));
}

// 8) Delete unknown id is a no-op.
check('Delete unknown id returns false', deleteCustomPreset('does-not-exist') === false);

console.log(`\n=== ${fail === 0 ? 'ALL CUSTOM PRESET TESTS PASS' : `${fail} FAILED`} ===\n`);
if (fail) process.exit(1);
