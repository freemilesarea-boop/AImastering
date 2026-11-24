// asar-payload-selftest — does the installer ship the node_modules the app
// still needs at runtime, and nothing else?
//
// electron-builder puts every production dependency into app.asar on its own,
// whatever `files` says.  So `files` grew entries that ADDED files on the
// assumption they were narrowing a package, and the asar carried 137.8 MB of
// `onnxruntime-web` for one 12.9 MB file plus 21.4 MB of libraries that are
// bundled into dist-electron at build time and never resolved as modules.
//
// electron-builder.yml now excludes `node_modules` wholesale and puts back
// exactly two things.  That is cheap and it is also a cliff: the day someone
// adds a specifier to esbuild's EXTERNAL list and not to the yml, the module
// is gone from the asar and the app breaks IN A PACKAGED BUILD ONLY — every
// dev run and every selftest resolves it from the real node_modules tree.
//
// So this test reads both sides and refuses to let them disagree.  Neither is
// a transcription of the other: EXTERNAL is imported from the bundler config
// that esbuild actually runs with, and the runtime file path is read out of
// the handler that reads it.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(__filename);
const yaml = req('js-yaml') as { load(src: string): unknown };
const { EXTERNAL } = req('../esbuild.main.cjs') as { EXTERNAL: string[] };

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const DESKTOP = path.resolve(__dirname, '..');
const BLANKET = '!node_modules/**/*';

const parsed = yaml.load(fs.readFileSync(path.join(DESKTOP, 'electron-builder.yml'), 'utf8'));
const files = (parsed as { files?: unknown }).files;
const list: string[] = Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : [];

/** `node_modules/a/**\/*` → /^node_modules\/a\/.*$/ — enough for these patterns. */
function toRegExp(pattern: string): RegExp {
  // One pass, so a `*` produced by escaping cannot be re-read as a glob.
  const body = pattern.replace(/\*\*\/\*|\*\*|\*|[.+^${}()|[\]\\]/g, (token) => {
    if (token === '**/*' || token === '**') return '.*';
    if (token === '*') return '[^/]*';
    return `\\${token}`;
  });
  return new RegExp(`^${body}$`);
}

console.log('\n── the two sides of the exclusion ──────────────────────────');

// 0. If the parse came back empty every check below would pass by measuring
//    nothing, so prove it read the real list first.
check(
  'the `files` list parsed, with the build outputs in it',
  list.includes('dist/**/*') && list.includes('dist-electron/**/*'),
  `${list.length} entries: ${list.join(' ')}`,
);

check(
  'node_modules is excluded wholesale',
  list.includes(BLANKET),
  'without it electron-builder ships every production dependency regardless of this list',
);

const blanketAt = list.indexOf(BLANKET);
const reincludes = list
  .map((pattern, at) => ({ pattern, at }))
  .filter((e) => !e.pattern.startsWith('!') && e.pattern.startsWith('node_modules/'));

// 1. Order decides: electron-builder takes the LAST pattern that matches, so
//    a re-include written above the exclusion is not a re-include.
check(
  'every node_modules re-include comes after the exclusion',
  reincludes.length > 0 && reincludes.every((e) => e.at > blanketAt),
  reincludes.map((e) => `${e.at}:${e.pattern}`).join(', ') || 'there are none',
);

console.log('\n── what esbuild leaves for the installer to ship ───────────');

// 2. The cliff.  `electron` is the one specifier that needs no line: the
//    runtime provides it and it is not loaded out of the app's node_modules.
const needsShipping = EXTERNAL.filter((s) => s !== 'electron');
check(
  'the bundler config exports the externals, and electron is among them',
  EXTERNAL.includes('electron') && needsShipping.length > 0,
  `EXTERNAL = ${EXTERNAL.join(', ')}`,
);
for (const spec of needsShipping) {
  const covering = reincludes.filter(
    (e) => e.pattern === `node_modules/${spec}` || e.pattern.startsWith(`node_modules/${spec}/`),
  );
  check(
    `\`${spec}\` is external, so the yml puts it back`,
    covering.length > 0 && covering.every((e) => e.at > blanketAt),
    covering.length === 0
      ? 'esbuild emits require("' + spec + '") and the asar would not contain it'
      : covering.map((e) => e.pattern).join(', '),
  );
}

// 3. And the inverse: electron itself is 100+ MB in node_modules and is NOT
//    something the app loads from there.
check(
  'electron itself is not re-included',
  !reincludes.some((e) => e.pattern.startsWith('node_modules/electron/') || e.pattern === 'node_modules/electron'),
  reincludes.map((e) => e.pattern).join(', '),
);

console.log('\n── what is read as a file rather than required ─────────────');

// 4. `daw:model-runtime` reads the model runtime by path.  Take the path from
//    the handler, not from memory — a rename there with no change here is the
//    same packaged-only break.
const handler = fs.readFileSync(path.join(DESKTOP, 'src', 'main', 'ipc', 'fileHandlers.ts'), 'utf8');
const joinRe = /path\.join\(\s*'node_modules'\s*,\s*((?:'[^']+'\s*,\s*)*)([A-Za-z_$][\w$]*)\s*\)/;
const joined = joinRe.exec(handler);
const nameRe = /const\s+name\s*=\s*'([^']+)'/;
const runtimeName = nameRe.exec(handler)?.[1] ?? '';
const segments = (joined?.[1] ?? '').split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
const runtimeRel = segments.length > 0 && runtimeName !== ''
  ? ['node_modules', ...segments, runtimeName].join('/')
  : '';
check(
  'the handler still builds its path out of node_modules, and it was read',
  runtimeRel !== '' && runtimeRel.endsWith('.wasm'),
  runtimeRel || 'could not read the path out of fileHandlers.ts',
);
check(
  'the file that `daw:model-runtime` reads is re-included',
  reincludes.some((e) => toRegExp(e.pattern).test(runtimeRel)),
  `${runtimeRel} matched none of: ${reincludes.map((e) => e.pattern).join(', ')}`,
);

console.log('\n── and nothing else got back in ────────────────────────────');

// 5. Every re-include has to be justified by one of the two reasons, or the
//    list starts growing back the way it grew the first time.
const byPathPackages = new Set(
  [...handler.matchAll(/path\.join\(\s*'node_modules'\s*,\s*'([^']+)'/g)].map((m) => m[1]!),
);
for (const e of reincludes) {
  const pkg = /^node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(e.pattern)?.[1] ?? '';
  const why = EXTERNAL.includes(pkg)
    ? 'esbuild leaves it external'
    : byPathPackages.has(pkg) ? 'a handler reads it by path' : '';
  check(
    `\`${pkg}\` is back in the asar for a reason`,
    why !== '',
    `${e.pattern} is neither in EXTERNAL (${EXTERNAL.join(', ')}) nor read by path (${[...byPathPackages].join(', ') || 'none'})`,
  );
}

// 6. A pattern that matches nothing on disk is silently dropped by
//    electron-builder, so a typo reads as a working build until the app runs.
function onDisk(rel: string): string | null {
  for (const root of [DESKTOP, path.resolve(DESKTOP, '../..'), path.resolve(DESKTOP, '../../..')]) {
    const full = path.join(root, rel);
    if (fs.existsSync(full)) return full;
  }
  return null;
}
for (const e of reincludes) {
  const literal = e.pattern.split('/').slice(0, e.pattern.includes('*')
    ? e.pattern.split('/').findIndex((s) => s.includes('*'))
    : undefined).join('/');
  check(
    `${literal} exists to be packaged`,
    onDisk(literal) !== null,
    `tried ${DESKTOP}/${literal} and two ancestors — electron-builder skips a pattern that matches nothing`,
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
