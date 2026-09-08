/**
 * export-gate-selftest.ts — the master export must never ask for a licence.
 *
 * Louver is sold as a paid download, so every copy that runs has already been
 * paid for.  A licence gate on export can therefore only ever fire on a
 * customer — and it did: saving a WAV opened the activation dialog and
 * refused to write the file.  The gate was removed from the main process and
 * from the renderer's error handling.
 *
 * This test is a source-level guard rather than a behavioural one, because
 * the thing being asserted is an ABSENCE: there is no gate left to call.  It
 * reads the shipped sources and fails if a paywall reappears in the export
 * path, in any of the three shapes it previously took.
 *
 * Run via:
 *   pnpm --filter @aimaster/desktop test:export-gate
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC  = path.resolve(HERE, '..', 'src');

interface T { name: string; pass: boolean; detail: string; }
const results: T[] = [];

function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

/** Source with `//` and `/* *\/` comments blanked, so prose can't trip a check. */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ');
}

/** Every .ts/.tsx under a directory, recursively. */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

// ── 1. The main-process save handlers refuse nothing ────────────────────────
// This is the decisive one: the gate lived here so it could not be bypassed
// from devtools.  If it comes back, it comes back here.

const FILE_HANDLERS = 'main/ipc/fileHandlers.ts';

check('save handlers never emit LICENSE_REQUIRED', () => {
  const src = code(FILE_HANDLERS);
  assert(!src.includes('LICENSE_REQUIRED'),
    'fileHandlers.ts still throws the paywall sentinel');
});

check('save handlers do not consult licence or entitlement state', () => {
  const src = code(FILE_HANDLERS);
  for (const needle of ['licenseService', 'getEntitlementPaid', 'licensePaid', 'paidStatus']) {
    assert(!src.includes(needle), `fileHandlers.ts reads ${needle}`);
  }
});

check('the three export handlers are still registered', () => {
  const src = code(FILE_HANDLERS);
  for (const ch of ['file:save-wav', 'file:save-audio', 'file:batch-save-wav']) {
    assert(src.includes(ch), `${ch} handler is missing — export would break outright`);
  }
});

// ── 2. Lossless formats are not singled out ────────────────────────────────
// The old gate let MP3 through as a free preview and blocked wav/flac/aiff.
// A format allow-list in the save path is the fingerprint of that design.

check('no format allow-list splits lossless from lossy', () => {
  const src = code(FILE_HANDLERS);
  for (const needle of ['FREE_EXPORT_EXTS', 'isMasterExport']) {
    assert(!src.includes(needle), `fileHandlers.ts still defines ${needle}`);
  }
});

// ── 3. Nothing in the renderer turns a save error into a key prompt ────────

check('no renderer code reacts to LICENSE_REQUIRED', () => {
  const offenders: string[] = [];
  for (const f of walk(path.join(SRC, 'renderer'))) {
    const rel = path.relative(SRC, f);
    const src = code(rel);
    if (src.includes('LICENSE_REQUIRED') || src.includes('handleLicenseRequired')) {
      offenders.push(rel);
    }
  }
  assert(offenders.length === 0,
    `renderer still handles the paywall sentinel: ${offenders.join(', ')}`);
});

// ── 4. The activation dialog only opens when the user opens it ─────────────
// `setShowModal(true)` is the single entry point to LicenseModal.  It may be
// called from the licence UI itself (a user clicking "activate"), but no
// export or save path may call it.

check('setShowModal(true) is not reachable from a save path', () => {
  const offenders: string[] = [];
  for (const f of walk(path.join(SRC, 'renderer'))) {
    const rel = path.relative(SRC, f);
    if (rel.includes('LicenseModal') || rel.includes('licenseStore')) continue;  // the dialog's own UI
    if (/setShowModal\s*\(\s*true\s*\)/.test(code(rel))) offenders.push(rel);
  }
  assert(offenders.length === 0,
    `something outside the licence UI opens the activation dialog: ${offenders.join(', ')}`);
});

check('saving never decrements a trial counter', () => {
  const offenders: string[] = [];
  for (const f of walk(path.join(SRC, 'renderer'))) {
    const rel = path.relative(SRC, f);
    if (code(rel).includes('license:decrement-trial')) offenders.push(rel);
  }
  assert(offenders.length === 0,
    `a trial counter is still being spent: ${offenders.join(', ')}`);
});

// ── 5. The licence system itself is untouched ──────────────────────────────
// Removing the gate is not the same as removing licensing: activation still
// exists for anyone who has a key.  Deleting it would be a different (and
// unrequested) change, so assert it survived.

check('licence activation still exists', () => {
  const store = code('renderer/stores/licenseStore.ts');
  assert(store.includes("'license:activate'"), 'activation IPC call is gone');
  assert(store.includes("'license:status'"),   'status IPC call is gone');
  assert(fs.existsSync(path.join(SRC, 'renderer/components/LicenseModal.tsx')),
    'LicenseModal was deleted — activation is no longer possible at all');
});

// ── Print summary ──────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;

console.log('\n=== export gate (must stay absent) ===\n');
for (const r of results) {
  console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n=== ${passed} passed, ${failed} failed ===`);

if (failed > 0) process.exit(1);
