/**
 * model-dispatch-selftest — the wiring that lets a run reach a model.
 *
 * Discovery landed first and dispatch did not, for a reason this file's
 * ancestor got wrong: it was claimed that a classic Blob worker could not host
 * `onnxruntime-web` because the loader uses a bare-specifier `import()`.  The
 * premise was true; the conclusion was not.  Bundling the runtime removes the
 * need to resolve anything, and `env.wasm.wasmBinary` removes the need to
 * fetch anything — and with both gone, `file://` stops mattering.
 *
 * What is pinned here:
 *
 *   · the committed worker bundle matches the TypeScript it was built from,
 *     and actually contains a runtime rather than a promise of one;
 *   · the rule that decides whether a model applies to what the user asked
 *     for, including the two cases where running it would be worse than not;
 *   · that the model's stems arrive carrying the SAME measurements its
 *     siblings have, because a stem with no confidence draws as a blank bar
 *     next to stems that have one;
 *   · that a model failure is a note on a finished report, never a thrown
 *     separation — the DSP stems are what the user asked for and they are
 *     already made.
 *
 * The inference itself is covered by model-run-selftest, which drives the same
 * `runModel` against the repo's own fixture model.  What this file cannot do
 * is run the WORKER: that needs a DOM, a Blob URL and a `file://` document,
 * and it was verified by driving Electron instead — classic Blob worker
 * constructed, runtime instantiated from bytes, session created in 492 ms,
 * inference in 9 ms.
 *
 * Run: pnpm --filter @aimaster/desktop test:model-dispatch
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { modelApplies, modelParent } from '../src/renderer/daw/audio/separate/model-dispatch.js';
import { expandStems } from '../src/renderer/daw/audio/separate/model-run.js';
import { MODEL_DISPATCH_READY, type ModelDescriptor } from '../src/renderer/daw/audio/separate/model-registry.js';
import type { StemKind } from '../src/renderer/daw/audio/separate/stem-tree.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); } catch (e: unknown) {
    results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
  }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

const base: Omit<ModelDescriptor, 'stems'> = {
  id: 'demo', name: 'Demo', sampleRate: 44_100, channels: 2,
  weights: 'model.onnx', sha256: 'a'.repeat(64),
  license: 'CC-BY-NC-4.0', commercialUse: false,
};
const withStems = (stems: StemKind[]): ModelDescriptor => ({ ...base, stems });

// ── The bundle ──────────────────────────────────────────────────────────────

check('the committed worker matches the TypeScript it was built from', () => {
  // Same guarantee `separate.worker.js` has, and for the same reason: the
  // output is committed so `pnpm dev` works, and a committed build drifts.
  execFileSync('node', ['scripts/build-model-worker.mjs', '--check'], { stdio: 'pipe' });
});

check('and it is a classic script carrying a real runtime', () => {
  // The two facts the whole design rests on.  If the bundle stopped being
  // classic, the Blob route breaks in a packaged build; if the runtime were
  // not in it, dispatch would be back to resolving a bare specifier.
  const worker = readFileSync('src/renderer/public/model.worker.js', 'utf8');
  assert(!/^\s*(export|import)\s/m.test(worker), 'the bundle is no longer a classic script');
  assert(/InferenceSession|ortWasm|onnxruntime/i.test(worker),
    'the bundle carries no inference runtime');
  // Big enough to be a runtime, small enough that the 12.86 MB .wasm is not
  // in it — that arrives as bytes at run time and must not be inlined.
  const kb = worker.length / 1024;
  assert(kb > 40 && kb < 600, `the bundle is ${kb.toFixed(0)} KB, which is not a bundled runtime`);
});

check('and nothing fetches the runtime binary', () => {
  // The other half of why `file://` stopped mattering.  A path would have to
  // be right on every platform and inside an asar; bytes do not.
  const entry = readFileSync('src/renderer/daw/audio/separate/model-worker-entry.ts', 'utf8');
  assert(/wasmBinary/.test(entry), 'the worker no longer passes the runtime as bytes');
  // A property assignment, not a mention: the comment above it explains that
  // ONNX ignores `wasmPaths` once bytes are given, and prose is not a setting.
  assert(!/wasmPaths\s*[:=]/.test(entry), 'the worker is setting a path for the runtime again');
});

// ── Whether a model applies at all ──────────────────────────────────────────

check('a model whose stems share one parent can be folded in', () => {
  const parent = modelParent(['guitar', 'keys']);
  assert(parent === 'other', `guitar and keys hang off 그 외, got ${String(parent)}`);
  const applies = modelApplies(withStems(['guitar', 'keys']), ['guitar', 'vocals']);
  assert(applies.ok, applies.ok ? '' : applies.reason);
});

check('and one whose stems do not is refused, with the reason', () => {
  // The failure that is invisible afterwards: half-replacing a stem leaves
  // the record's energy counted twice in one place and not at all in another,
  // and neither shows up in a waveform.
  assert(modelParent(['guitar', 'kick']) === null, 'guitar and kick have different parents');
  const applies = modelApplies(withStems(['guitar', 'kick']), ['guitar']);
  assert(!applies.ok, 'a model spanning two parents was accepted');
  assert(!applies.ok && applies.reason.includes('합이 원본'),
    applies.ok ? '' : `the reason should say what breaks: ${applies.reason}`);
});

check('a model nobody asked anything of is skipped, not run', () => {
  // Inference is minutes.  Running it for stems that are then filtered out is
  // the kind of waste that reads as the app having hung.
  const applies = modelApplies(withStems(['guitar', 'keys']), ['vocals', 'drums', 'bass']);
  assert(!applies.ok, 'a model with nothing wanted from it was accepted');
  assert(!applies.ok && applies.reason.includes('고르지 않았습니다'),
    applies.ok ? '' : applies.reason);
});

check('one stem is a parent set of one, and still applies', () => {
  const applies = modelApplies(withStems(['guitar']), ['guitar']);
  assert(applies.ok, applies.ok ? '' : applies.reason);
  assert(applies.ok && applies.parent === 'other', 'it replaces 그 외');
});

check('an empty model declares nothing and is refused', () => {
  assert(modelParent([]) === null, 'an empty stem list has no parent');
  assert(!modelApplies(withStems([]), ['guitar']).ok, 'a model with no stems was accepted');
});

// ── Folding the children in ─────────────────────────────────────────────────

interface Stem { kind: StemKind; channels: Float32Array[]; energyShare: number; confidence: number; peak: number }
const stem = (kind: StemKind, over: Partial<Stem> = {}): Stem => ({
  kind, channels: [new Float32Array(4)], energyShare: 0.25, confidence: 0.5, peak: 0.1, ...over,
});

check('the children replace the parent in place, and the siblings are untouched', () => {
  const before = [stem('vocals'), stem('drums'), stem('bass'), stem('other')];
  const after = expandStems(before, 'other', [stem('guitar'), stem('keys')]);
  assert(after.map((s) => s.kind).join(',') === 'vocals,drums,bass,guitar,keys',
    after.map((s) => s.kind).join(','));
  assert(!after.some((s) => s.kind === 'other'), 'the parent is still there as well as its children');
});

check('and they arrive with the measurements their siblings have', () => {
  // A stem without them draws as a blank bar next to stems that have one,
  // which reads as "the separator failed here" rather than "nobody measured".
  const after = expandStems(
    [stem('other')], 'other',
    [stem('guitar', { confidence: 0.81, energyShare: 0.4, peak: 0.3 })],
  );
  const guitar = after.find((s) => s.kind === 'guitar');
  assert(guitar !== undefined, 'no guitar stem');
  assert(typeof guitar!.confidence === 'number' && guitar!.confidence > 0, 'no confidence');
  assert(typeof guitar!.energyShare === 'number', 'no energy share');
  assert(typeof guitar!.peak === 'number', 'no peak');
});

check('replacing a stem that is not there is refused rather than guessed', () => {
  let threw = '';
  try { expandStems([stem('vocals')], 'other', [stem('guitar')]); }
  catch (e) { threw = e instanceof Error ? e.message : String(e); }
  assert(threw.length > 0, 'it silently did something');
  assert(threw.includes('없는데'), threw);
});

check('and so is a child that already exists elsewhere in the set', () => {
  // Same part in two stems means the record is counted twice, which the sum
  // check would catch and the waveform would not.
  let threw = '';
  try { expandStems([stem('vocals'), stem('other')], 'other', [stem('vocals'), stem('guitar')]); }
  catch (e) { threw = e instanceof Error ? e.message : String(e); }
  assert(threw.includes('이미 있습니다'), threw || 'a duplicate stem was accepted');
});

// ── The failure posture ─────────────────────────────────────────────────────

check('a model failure is a note, never a thrown separation', () => {
  // The user asked for stems and the DSP pass already made them.  Throwing
  // away two minutes of finished work because an optional extra split failed
  // is the wrong trade, so the run catches and annotates.
  const source = readFileSync('src/renderer/daw/edit/separate-actions.ts', 'utf8');
  const block = source.slice(source.indexOf('if (options.model)'), source.indexOf('const source ='));
  assert(block.length > 0, 'the model step is not where this check thinks it is');
  assert(/catch \(err\)/.test(block), 'the model step does not catch');
  assert(/notes: \[\.\.\.report\.notes/.test(block), 'a failure is not recorded on the report');
  assert(!/throw /.test(block), 'the model step can throw away a finished separation');
});

check('the model runs AFTER the DSP pass, not instead of it', () => {
  // `expandStems` replaces a parent with children, which is what keeps the
  // sum exact.  A model producing its own top level would have to be trusted
  // to cover the record, and nothing checks that.
  const source = readFileSync('src/renderer/daw/edit/separate-actions.ts', 'utf8');
  const dsp = source.indexOf('await run.result');
  const model = source.indexOf('if (options.model)');
  assert(dsp >= 0 && model > dsp, 'the model step no longer follows the DSP separation');
});

check('the constant agrees that dispatch exists', () => {
  assert(MODEL_DISPATCH_READY, 'dispatch is wired and the constant still says it is not');
});

const failed = results.filter((r) => !r.pass);
for (const r of results) {
  // eslint-disable-next-line no-console
  console.log(`${r.pass ? '[PASS]' : '[FAIL]'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
// eslint-disable-next-line no-console
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
