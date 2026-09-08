/**
 * app-name-selftest.ts — the product has ONE name.
 *
 * The name used to live in seven places: the builder config, the package
 * description, the window title, the wordmark, and three metadata writers
 * that stamp it into every exported file.  Renaming by hand is how a build
 * ends up with a window that says one thing and files that say another —
 * and the file is the half that outlives the app, gets emailed to a label
 * and read by a distributor.
 *
 * The TypeScript half now reads `APP_NAME`, so it cannot drift.  Two files
 * cannot import TypeScript — `electron-builder.yml` decides what the
 * installer and the .app are CALLED, and `package.json` carries the
 * description — so this checks them against the constant instead.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:app-name
 */

import { readFileSync } from 'node:fs';
import { APP_NAME } from '@aimaster/shared-types';

interface T { name: string; pass: boolean; detail: string; }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

const builder = readFileSync('electron-builder.yml', 'utf8');
const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { description?: string };
const html = readFileSync('src/renderer/index.html', 'utf8');

check('the installer and the .app are called what the app calls itself', () => {
  const m = /^productName:\s*(.+)$/m.exec(builder);
  assert(m, 'electron-builder.yml has a productName');
  assert(m![1]!.trim() === APP_NAME,
    `productName is "${m![1]!.trim()}" but APP_NAME is "${APP_NAME}"`);
});

check('the Linux desktop entry agrees', () => {
  const m = /^\s+Name:\s*(.+)$/m.exec(builder);
  assert(m, 'the desktop block has a Name');
  assert(m![1]!.trim() === APP_NAME,
    `desktop Name is "${m![1]!.trim()}" but APP_NAME is "${APP_NAME}"`);
});

check('the package description leads with the name', () => {
  assert(typeof pkg.description === 'string' && pkg.description.startsWith(APP_NAME),
    `description is "${pkg.description}"`);
});

check('the window title is the name', () => {
  const m = /<title>([^<]*)<\/title>/.exec(html);
  assert(m, 'index.html has a title');
  assert(m![1]!.trim() === APP_NAME, `title is "${m![1]!.trim()}"`);
});

check('no source file still hardcodes a name the app no longer has', () => {
  // Only the retired PRODUCT strings.  The `@aimaster/*` package names and
  // the `aimaster-local:` protocol are internal identifiers, not the
  // product's name, and renaming those is a different job with different
  // risks — so they are deliberately not matched here.
  const retired = ['Louver Mastering AI', '<title>AIMASTER</title>'];
  const files = [
    'src/renderer/components/TopBar.tsx',
    'src/renderer/daw/model/provenance.ts',
    'src/renderer/daw/engine/wav.ts',
    'src/renderer/index.html',
    'package.json',
    'electron-builder.yml',
  ];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const old of retired) {
      assert(!src.includes(old), `${f} still says "${old}"`);
    }
  }
});

check('the name still fits the field that stamps it into every WAV', () => {
  // bext's Originator is a FIXED 32 bytes.  A longer name is not rejected —
  // it is silently truncated into the file, so the tag would name an app
  // that does not exist.  Checked with the version, because that is what is
  // actually written.
  const written = `${APP_NAME} 99.99.99`;
  assert(Buffer.byteLength(written, 'utf8') <= 32,
    `"${written}" is ${Buffer.byteLength(written, 'utf8')} bytes, bext allows 32`);
});

console.log('\n=== The product has one name ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
