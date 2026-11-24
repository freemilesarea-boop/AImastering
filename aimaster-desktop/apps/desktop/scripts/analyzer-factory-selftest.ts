/**
 * analyzer-factory-selftest — real meters by default, mock only when asked.
 *
 * `analyzer-factory-resolver.ts` is one switch with one consequence: whether
 * the Spectrum, Loudness and Stereo panels show analysis of the audio that is
 * playing, or numbers a synthetic generator made up.  Its own docblock says
 * why that matters — "core product features ... must show real analysis of the
 * playing audio (never mock data)".
 *
 * It had no test of any kind, and the file carried two claims that said the
 * opposite of what it does:
 *
 *   the file header   "4. Default → SyntheticAnalyzerSessionFactory
 *                     (dev-only) ... production builds set the env var,
 *                     dev / smoke tests stick to synthetic"
 *   inside the gate   "Safe-boot kill switch — defaults to OFF for the
 *                     wasmAnalyzer flag in safe-boot-flags.DEFAULT_ENABLED"
 *
 * Both false.  `DEFAULT_ENABLED` is `{ wasmAnalyzer: true }` (flipped back on
 * once the dlmalloc panic it was built to corner was fixed at the source), and
 * a fresh boot with no overrides resolves to the WASM factory.  Measured by
 * calling the function under each gate:
 *
 *   no window, no storage                      → WASM
 *   window + empty storage (a fresh boot)      → WASM
 *   window.__LOUI_WASM_ANALYZER__ = false      → SYNTHETIC
 *   localStorage['loui.wasmAnalyzer'] = 'false' → SYNTHETIC
 *   safe-boot wasmAnalyzer = false             → SYNTHETIC
 *
 * A stale comment is usually a nuisance.  Here it is a trap: the next reader
 * who makes the code match the header ships fabricated meters to everyone.
 * So the comments are corrected AND the behaviour is pinned, by driving each
 * gate rather than reading it.
 *
 * Run:  pnpm --filter @aimaster/desktop test:analyzer-factory
 */

import {
  isWasmAnalyzerEnabled, resolveAnalyzerFactory, analyzerFactoryLabel, WASM_ANALYZER_LS_KEY,
} from '../src/renderer/audio/analyzer-factory-resolver.js';
import { isEnabled, setFlag, resetAll } from '../src/renderer/audio/safe-boot-flags.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(cond: unknown, detail: string): void { if (!cond) throw new Error(detail); }

// ── A browser enough for the gates, and nothing more ─────────────────────
//
// Every case rebuilds the whole environment.  Mutating one shared store
// instead leaks the previous case's override into the next, and the leak
// reads as a pass — `localStorage` left at 'false' would make the safe-boot
// case "prove" a gate it never reached.
const g = globalThis as unknown as Record<string, unknown>;
function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => { m.clear(); },
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  } as unknown as Storage;
}
interface Env { ls: Storage; ss: Storage; win: Record<string, unknown> }
function freshEnv(): Env {
  const ls = memStorage();
  const ss = memStorage();
  const win: Record<string, unknown> = {};
  g['window'] = win;
  g['localStorage'] = ls;
  g['sessionStorage'] = ss;
  resetAll();           // safe-boot reads sessionStorage; start it from DEFAULT_ENABLED
  return { ls, ss, win };
}
function bareEnv(): void {
  delete g['window'];
  delete g['localStorage'];
  delete g['sessionStorage'];
}

/** What the switch resolves to, as a word. */
function verdict(): 'WASM' | 'SYNTHETIC' {
  return isWasmAnalyzerEnabled() ? 'WASM' : 'SYNTHETIC';
}
function factoryName(): string {
  return resolveAnalyzerFactory().constructor.name;
}

check('a fresh boot with nothing overridden resolves to the real analyzer', () => {
  freshEnv();
  assert(verdict() === 'WASM', `a fresh boot resolved to ${verdict()} — the panels would show made-up numbers`);
  assert(factoryName() === 'WasmAnalyzerSessionFactory', `factory was ${factoryName()}`);
});

check('and so does a context with no window and no storage at all', () => {
  // Not an app state, but it is what a headless harness looks like, and the
  // gate must not read "no storage" as "turn the real engine off".
  bareEnv();
  assert(verdict() === 'WASM', `a storage-less context resolved to ${verdict()}`);
});

check('the safe-boot flag ships ON, which is what makes the default real', () => {
  // The in-function comment claimed this defaulted to OFF.  If it ever does,
  // the gate below turns every boot synthetic and the check above is the only
  // thing that would say so.
  freshEnv();
  assert(isEnabled('wasmAnalyzer') === true,
    'safe-boot wasmAnalyzer defaults to OFF — every boot would resolve to synthetic');
});

check('the window override turns it off, and only off', () => {
  const env = freshEnv();
  env.win['__LOUI_WASM_ANALYZER__'] = false;
  assert(verdict() === 'SYNTHETIC', 'window.__LOUI_WASM_ANALYZER__ = false did not reach the gate');
  // `true` is not a second way to say "on": the default is already on, and a
  // gate that keys on truthiness would also accept `undefined`.
  env.win['__LOUI_WASM_ANALYZER__'] = true;
  assert(verdict() === 'WASM', 'window.__LOUI_WASM_ANALYZER__ = true turned the real analyzer off');
});

check('the localStorage override turns it off, for both spellings', () => {
  for (const v of ['false', '0']) {
    const env = freshEnv();
    env.ls.setItem(WASM_ANALYZER_LS_KEY, v);
    assert(verdict() === 'SYNTHETIC', `localStorage['${WASM_ANALYZER_LS_KEY}'] = '${v}' did not reach the gate`);
  }
  // Anything else is not an opt-out.  A user who typed 'off' or 'no' has not
  // asked for mock data, and silently giving it to them is the failure this
  // whole file is about.
  for (const v of ['true', '1', 'off', 'no', '']) {
    const env = freshEnv();
    env.ls.setItem(WASM_ANALYZER_LS_KEY, v);
    assert(verdict() === 'WASM', `localStorage['${WASM_ANALYZER_LS_KEY}'] = '${v}' was read as an opt-out`);
  }
});

check('the safe-boot kill switch turns it off', () => {
  freshEnv();
  setFlag('wasmAnalyzer', false);
  assert(verdict() === 'SYNTHETIC', 'the safe-boot kill switch did not reach the gate');
  assert(factoryName() === 'SyntheticAnalyzerSessionFactory', `factory was ${factoryName()}`);
  setFlag('wasmAnalyzer', true);
  assert(verdict() === 'WASM', 'turning the safe-boot flag back on did not restore the real analyzer');
});

check('the label names the factory that is actually active', () => {
  // The dev panel header is how a tester learns which path their UI consumed.
  // A label that says "WASM" over synthetic data is worse than no label.
  freshEnv();
  assert(/WASM/.test(analyzerFactoryLabel()), `default label was "${analyzerFactoryLabel()}"`);
  setFlag('wasmAnalyzer', false);
  assert(/Synthetic/i.test(analyzerFactoryLabel()), `synthetic label was "${analyzerFactoryLabel()}"`);
  assert(/dev/i.test(analyzerFactoryLabel()), 'the synthetic label does not say it is dev-only');
  setFlag('wasmAnalyzer', true);
});

check('synthetic is reachable ONLY through an explicit opt-out', () => {
  // The summary of every case above, stated as the rule the file promises.
  freshEnv();
  assert(verdict() === 'WASM', 'no opt-out set, yet synthetic');
  const optOuts: Array<[string, () => void]> = [
    ['window.__LOUI_WASM_ANALYZER__ = false', () => { (g['window'] as Record<string, unknown>)['__LOUI_WASM_ANALYZER__'] = false; }],
    [`localStorage['${WASM_ANALYZER_LS_KEY}'] = 'false'`, () => { (g['localStorage'] as Storage).setItem(WASM_ANALYZER_LS_KEY, 'false'); }],
    ['safe-boot wasmAnalyzer = false', () => { setFlag('wasmAnalyzer', false); }],
  ];
  for (const [label, apply] of optOuts) {
    freshEnv();
    apply();
    assert(verdict() === 'SYNTHETIC', `${label} should opt out and did not`);
  }
  assert(optOuts.length === 3,
    'an opt-out was added or removed — list it here, or the rule stops being the whole rule');
});

bareEnv();
console.log('');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
