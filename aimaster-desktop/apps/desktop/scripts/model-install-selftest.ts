/**
 * model-install-selftest — whether the model path has a door.
 *
 * It did not.  `model-registry.ts` could validate a descriptor, `model-
 * session.ts` could verify a hash and open an ONNX session, `model-run.ts`
 * could chunk audio through one and expand its masks into the stem tree — 570
 * lines, all of it tested — and the only call to `buildReport` in the entire
 * app passed a hardcoded empty array, because nothing listed the folder.  No
 * IPC handler read it.  No user could get a model in.
 *
 * ── The other half, said out loud ───────────────────────────────────────────
 *
 * Discovery now works and a separation run STILL cannot use what it finds, and
 * that is structural rather than unfinished.  The separator runs in a worker
 * built as one self-contained classic script and constructed from a Blob —
 * the only route that works both under the dev server and in a packaged build
 * served from `file://`.  The runtime loader hides its specifier from the
 * bundler on purpose, so `onnxruntime-web` is a runtime `import()` of a bare
 * name, and a classic worker has no module system to resolve it with.
 *
 * So the panel says so, `MODEL_DISPATCH_READY` is `false`, and the last check
 * in this file holds that constant against the worker that was actually built.
 * The day somebody gets a runtime in there, it fails and tells them to flip
 * it — which is the only way a boolean like that stays true over time.
 *
 * Run: pnpm --filter @aimaster/desktop test:model-install
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  MODEL_DISPATCH_READY, buildReport, describeInstall, describeReport,
  runnableReport, unreachable, type ModelDescriptor,
} from '../src/renderer/daw/audio/separate/model-registry.js';
import { STEM_TREE } from '../src/renderer/daw/audio/separate/stem-tree.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); } catch (e: unknown) {
    results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
  }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

const GOOD: ModelDescriptor = {
  id: 'demo-4', name: 'Demo Four', stems: ['guitar', 'keys'],
  sampleRate: 44_100, channels: 2, weights: 'model.onnx',
  sha256: 'a'.repeat(64), license: 'CC-BY-NC-4.0', commercialUse: false,
};

const DSP_STEMS = STEM_TREE.filter((n) => n.source === 'dsp').map((n) => n.kind);

// ── What the run may claim, versus what is on disk ──────────────────────────

check('a validated model does NOT widen what the stem picker offers', () => {
  // The lie this prevents.  `buildReport` answers "what is installed", which
  // is the right question for the install list and the wrong one for the
  // picker: until a run can dispatch to a model, a file appearing in a folder
  // must not make the picker stop saying "needs a model".
  const installed = buildReport([{ where: '/m/demo', descriptor: GOOD }]);
  assert(installed.model !== null, 'setup: the descriptor should validate');
  assert(installed.available.includes('guitar'), 'setup: the install report counts its stems');

  const forTheRun = runnableReport(installed);
  assert(!forTheRun.available.includes('guitar'),
    'the picker was told it can make a guitar stem, and the run cannot');
  assert(forTheRun.available.length === DSP_STEMS.length,
    `the run should offer exactly the DSP stems, got ${forTheRun.available.length}`);
});

check('and the "needs a model" sentence survives a model being installed', () => {
  const installed = buildReport([{ where: '/m/demo', descriptor: GOOD }]);
  const gap = unreachable(runnableReport(installed));
  assert(gap.stems.includes('guitar'), 'guitar quietly became reachable');
  assert(gap.why.length > 0, 'and the sentence explaining why went away');
});

check('the two sentences say different things, and both are true', () => {
  const installed = buildReport([{ where: '/m/demo', descriptor: GOOD }]);
  const named = describeReport(installed);
  const status = describeInstall(installed, '/m');
  assert(named.includes('Demo Four'), `the install line must name the model: ${named}`);
  assert(status.includes('비상업'), `and its licence: ${status}`);
  assert(!MODEL_DISPATCH_READY && !/사용됩니다$/.test(status),
    `the status must not claim the run uses it: ${status}`);
});

check('with nothing installed, the message says WHERE to put one', () => {
  // The question a user with no models actually has.  "없습니다" alone is a
  // dead end; the folder path is the answer.
  const empty = buildReport([]);
  const status = describeInstall(empty, '/home/u/.config/LV DAW/stem-models');
  assert(status.includes('/home/u/.config/LV DAW/stem-models'), status);
  assert(status.includes('model.json'), `and what to put in it: ${status}`);
});

check('a folder that was looked at and failed is reported, not swallowed', () => {
  // The whole point of scanning.  "There is a model here and its hash is
  // wrong" is the answer somebody with a half-finished 300 MB download needs.
  const scan = buildReport([
    { where: '/m/broken', error: 'model.json 을 읽지 못했습니다 — Unexpected end of JSON input' },
    { where: '/m/wrong', descriptor: { id: 'x' } },
  ]);
  assert(scan.model === null, 'nothing should have validated');
  assert(scan.tried.length === 2, `both folders should be reported, got ${scan.tried.length}`);
  assert(scan.tried.every((p) => p.reason.length > 0), 'every entry needs a reason to act on');
  const status = describeInstall(scan, '/m');
  assert(/2곳/.test(status), `the count belongs in the summary: ${status}`);
});

check('a good model after a broken one still wins', () => {
  // Order is what the user happens to have in the folder, not a preference.
  const scan = buildReport([
    { where: '/m/broken', error: 'model.json 이 없습니다' },
    { where: '/m/good', descriptor: GOOD },
  ]);
  assert(scan.model?.id === 'demo-4', 'the valid one should have been taken');
  assert(scan.tried.length === 1, 'and the broken one should still be listed');
});

check('a second valid model is skipped, and says why', () => {
  const scan = buildReport([
    { where: '/m/a', descriptor: GOOD },
    { where: '/m/b', descriptor: { ...GOOD, id: 'other', name: 'Other' } },
  ]);
  assert(scan.model?.path === '/m/a', 'the first should win');
  assert(scan.tried.length === 1 && scan.tried[0]?.where === '/m/b', 'the second should be explained');
});

// ── The constant, held against the thing it describes ───────────────────────

check('dispatch is off exactly while nothing dispatches', () => {
  // The first version of this check was wrong in an instructive way.  It
  // asserted that `separate.worker.js` carries no inference runtime — reading
  // that as proof dispatch was impossible.  It was proof of nothing: the right
  // design puts the runtime in a SECOND worker, so that assertion would have
  // stayed true straight through dispatch being built, and the check would
  // never have fired.
  //
  // What the constant actually claims is that no separation run reaches a
  // model.  So that is what is checked, against the app rather than against a
  // bundle: if anybody calls `runModel` from `src/`, or flips the constant
  // without doing so, this fails and says which way round it is.
  // A CALL, not a mention: this file's own explanation names `runModel`, and
  // so does the comment beside the constant.  Prose is not dispatch.
  const appFiles = execSync(
    "grep -rl 'runModel(' src/ --include=*.ts --include=*.tsx || true",
    { encoding: 'utf8' },
  ).split('\n').filter((f) => f.trim() !== '' && !f.endsWith('model-run.ts'));

  if (MODEL_DISPATCH_READY) {
    assert(appFiles.length > 0,
      'MODEL_DISPATCH_READY is true but nothing in src/ calls runModel');
    return;
  }
  assert(appFiles.length === 0,
    `something now dispatches to a model (${appFiles.join(', ')}) — `
    + 'flip MODEL_DISPATCH_READY so the panel stops saying it does not');
});

check('and the route that would turn it on is still available', () => {
  // Measured rather than assumed, because the reason written next to the
  // constant was wrong once already.  Two facts carry the plan:
  //
  //   · `onnxruntime-web/wasm` bundles to a classic IIFE — 71 KB, no warnings
  //     — so a model worker needs no module system, exactly like the
  //     separator worker that already exists.
  //   · `env.wasm.wasmBinary` accepts the 12.86 MB runtime as BYTES and makes
  //     `wasmPaths` irrelevant, so nothing has to be fetched from `file://`.
  //
  // If either goes away in a dependency bump, the plan changes and this says
  // so before somebody spends a day on it.
  const ortRoot = '../../node_modules/onnxruntime-common';
  const env = readFileSync(`${ortRoot}/lib/env.ts`, 'utf8');
  assert(/wasmBinary\?:\s*ArrayBufferLike/.test(env),
    'onnxruntime no longer accepts the runtime as bytes — dispatch would need a fetch again');
  assert(/wasmPaths.*will\s*\n?\s*\*\s*be ignored|wasmPaths` property will/.test(env),
    'wasmBinary no longer documents that it overrides wasmPaths');

  const pkg = JSON.parse(readFileSync('../../node_modules/onnxruntime-web/package.json', 'utf8')) as {
    exports: Record<string, { require?: string }>;
  };
  assert(typeof pkg.exports['./wasm']?.require === 'string',
    'onnxruntime-web/wasm no longer ships a classic build to bundle');
});

check('the runtime loader still hides its specifier from the bundler', () => {
  // The other half of the same wall, and the reason it is deliberate: written
  // plainly, a bundler would inline onnxruntime-web into every build whether
  // or not the user has a model.  If this ever becomes a plain import, the
  // dispatch question changes and so should the constant.
  const source = readFileSync('src/renderer/daw/audio/separate/model-session.ts', 'utf8');
  assert(!/from ['"]onnxruntime-web['"]/.test(source),
    'the runtime is now a static import — the wall this constant describes has moved');
  assert(/await import\(/.test(source), 'the runtime should still load at runtime');
});

check('the main process is the only thing that lists the folder', () => {
  // The seam: a filesystem in main, the rules in the renderer.  If the
  // renderer ever reads the folder itself, it is reaching past the preload
  // bridge and the channel allowlist stops meaning anything.
  const install = readFileSync('src/renderer/daw/audio/separate/model-install.ts', 'utf8');
  assert(/daw:stem-models/.test(install), 'the scan should go through the IPC channel');
  assert(!/node:fs|require\(['"]fs/.test(install), 'the renderer is reading disk directly');
  const preload = readFileSync('src/preload/index.ts', 'utf8');
  assert(/'daw:stem-models'/.test(preload), 'the channel is not on the preload allowlist');
});

check('a scan that fails comes back as a report, not as a throw', () => {
  // A panel that shows nothing because the scan failed is worse than one that
  // says the scan failed.  Every outcome has to arrive in the same shape.
  const install = readFileSync('src/renderer/daw/audio/separate/model-install.ts', 'utf8');
  assert(/catch/.test(install), 'the scan can throw at the caller');
  const failed = buildReport([{ where: '—', error: '모델 폴더를 읽지 못했습니다' }]);
  assert(failed.model === null && failed.tried.length === 1,
    'a failure should render through the same report every other outcome uses');
});

const failed = results.filter((r) => !r.pass);
for (const r of results) {
  // eslint-disable-next-line no-console
  console.log(`${r.pass ? '[PASS]' : '[FAIL]'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
// eslint-disable-next-line no-console
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
