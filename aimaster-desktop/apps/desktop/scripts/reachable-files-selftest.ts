/**
 * reachable-files-selftest — a ratchet against FILES nothing reaches.
 *
 * `dead-exports-selftest` guards exports: a function or const that nothing
 * references fails it.  Nothing guarded the file itself, and the difference
 * is not academic — a module whose exports all reference each other is
 * perfectly alive by that measure and reachable from nowhere.  The repo has
 * found 31 such files by hand once already.
 *
 * ── Why this is harder than it looks, and how it was got wrong ──────────────
 *
 * An audit of this tree reported "60 source files unreachable from any product
 * entry point" and proposed deleting them.  Every one of the sixty was alive.
 *
 * The mistake was assuming the app is the only way in.  It is one of FOUR:
 *
 *   1. the product      — main.tsx, main/index.ts, preload/index.ts
 *   2. the test suite   — every script `pnpm test` runs, and every other
 *                         program in scripts/, which someone runs by hand
 *   3. Storybook        — `.storybook/` is configured, `pnpm build-storybook`
 *                         works, and 37 of the sixty are its components.  A
 *                         story IS a caller; dead-exports-selftest says so in
 *                         its own docblock and this file is the other half of
 *                         that argument
 *   4. build entries    — worker bundles.  `worker-entry.ts` is imported by
 *                         nothing because esbuild takes it as an ENTRY, named
 *                         in scripts/build-*-worker.mjs.  Two files, and a
 *                         graph that does not know this calls both of them
 *                         dead
 *
 * So the entry set is discovered, not listed: the scripts come from the
 * directory, the stories from the Storybook glob, and the build entries from
 * the build scripts' own source.  A new worker bundle cannot silently become
 * un-vouched-for because somebody forgot to update a constant here.
 *
 * ── What it reports ─────────────────────────────────────────────────────────
 *
 * Not just pass/fail.  For every file it says WHICH surface keeps it alive,
 * because "alive only because of Storybook" is a thing a future reader should
 * be able to see without re-deriving it — which is exactly what the audit
 * above failed to do.
 *
 * Run via:
 *   pnpm --filter @aimaster/desktop test:reachable-files
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import ts from 'typescript';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e: unknown) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

/**
 * Files that are reachable from nowhere and meant to be.
 *
 * Empty, and the bar for adding to it is a reason somebody can check — the
 * same bar dead-exports-selftest sets.  "It might be useful later" is not one.
 */
const ALLOWED = new Set<string>([]);

function find(exts: string[], roots = 'src scripts'): string[] {
  const names = exts.map((e) => `-name '*.${e}'`).join(' -o ');
  return execSync(
    String.raw`find ${roots} \( ${names} \) | grep -v '/public/' | grep -v '\.d\.ts$'`,
    { encoding: 'utf8', shell: '/bin/bash' },
  ).split('\n').filter((f) => f.trim() !== '');
}

const SOURCES = find(['ts', 'tsx']);
const KNOWN = new Set(SOURCES);

/** The `.js`-suffixed relative specifiers this repo writes, plus the `@` alias. */
function resolveSpec(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else if (spec.startsWith('@/')) base = resolve('src/renderer', spec.slice(2));
  else return null;
  const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
  for (const c of [`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, `${stem}/index.tsx`, base]) {
    const rel = relative(process.cwd(), c);
    if (KNOWN.has(rel)) return rel;
  }
  return null;
}

/**
 * Every file this one pulls in — static, dynamic, re-export and require alike.
 *
 * Read with the compiler's parser rather than by regex, for the reason
 * dead-exports-selftest gives at length: a hand-written scanner cannot tell a
 * specifier from the same characters inside a string, a comment or a regex,
 * and it got that wrong twice before.
 */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = new Set<string>();
  const add = (spec: string): void => { const r = resolveSpec(spec, file); if (r !== null) out.add(r); };
  const walk = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n))
        && n.moduleSpecifier !== undefined && ts.isStringLiteral(n.moduleSpecifier)) {
      add(n.moduleSpecifier.text);
    }
    if (ts.isCallExpression(n)) {
      const first = n.arguments[0];
      const dynamic = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const required = ts.isIdentifier(n.expression) && n.expression.text === 'require';
      if ((dynamic || required) && first !== undefined && ts.isStringLiteral(first)) add(first.text);
    }
    n.forEachChild(walk);
  };
  walk(src);
  return [...out];
}

const GRAPH = new Map<string, string[]>(SOURCES.map((f) => [f, importsOf(f)]));

function reachedFrom(roots: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = roots.filter((r) => KNOWN.has(r));
  while (stack.length > 0) {
    const f = stack.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const next of GRAPH.get(f) ?? []) if (!seen.has(next)) stack.push(next);
  }
  return seen;
}

// ── The four ways in, each discovered rather than listed ─────────────────────

const PRODUCT_ENTRIES = [
  'src/renderer/main.tsx', 'src/main/index.ts', 'src/preload/index.ts',
];

/** Every program in scripts/ — a selftest, a benchmark or a hand-run harness. */
const SCRIPT_ENTRIES = SOURCES.filter((f) => /^scripts\/[^/]+\.tsx?$/.test(f));

/** Every story, matched the way `.storybook/main.ts` matches them. */
const STORY_ENTRIES = SOURCES.filter((f) => /^src\/renderer\/.*\.stories\.tsx?$/.test(f));

/**
 * Every source file a build script hands to a bundler as an entry.
 *
 * Read out of the .mjs rather than listed here: these are the files nothing
 * imports BY DESIGN, so a list that has to be maintained by hand is a list
 * that will be wrong the first time somebody adds a worker.
 */
function buildEntries(): string[] {
  const out = new Set<string>();
  for (const script of find(['mjs', 'cjs'], 'scripts')) {
    const text = readFileSync(script, 'utf8');
    for (const m of text.matchAll(/'((?:src|\.\.\/src)\/[^']+\.tsx?)'/g)) {
      const spec = (m[1] as string).replace(/^\.\.\//, '');
      if (KNOWN.has(spec)) out.add(spec);
    }
  }
  return [...out];
}
const BUILD_ENTRIES = buildEntries();

const SURFACES: [string, string[]][] = [
  ['product', PRODUCT_ENTRIES],
  ['scripts', SCRIPT_ENTRIES],
  ['storybook', STORY_ENTRIES],
  ['build entry', BUILD_ENTRIES],
];
const REACHED = new Map(SURFACES.map(([name, roots]) => [name, reachedFrom(roots)] as const));

function surfacesFor(file: string): string[] {
  return SURFACES.map(([n]) => n).filter((n) => (REACHED.get(n) as Set<string>).has(file));
}

const orphans = SOURCES.filter((f) => surfacesFor(f).length === 0 && !ALLOWED.has(f));

// ── The checks ───────────────────────────────────────────────────────────────

check('the sweep is looking at the app, not at nothing', () => {
  // Every check below is vacuously true over an empty file list, and a `find`
  // that silently stops matching is how that happens.
  assert(SOURCES.length > 400, `only ${SOURCES.length} source files found`);
  assert(PRODUCT_ENTRIES.every((e) => KNOWN.has(e)),
    `a product entry point moved: ${PRODUCT_ENTRIES.filter((e) => !KNOWN.has(e)).join(', ')}`);
  assert(SCRIPT_ENTRIES.length > 100, `only ${SCRIPT_ENTRIES.length} scripts found`);
  assert(STORY_ENTRIES.length > 10, `only ${STORY_ENTRIES.length} stories found`);
  assert(BUILD_ENTRIES.length >= 2,
    `only ${BUILD_ENTRIES.length} build entries found — the worker bundles are read from scripts/build-*.mjs`);
});

check('the graph resolves the specifier shapes this repo writes', () => {
  // Every one of these has broken a sweep in this repo before: the `.js`
  // suffix TypeScript maps back to `.ts`, the `@` alias, a folder index, and
  // the dynamic import that four live functions were reached by.
  const total = [...GRAPH.values()].reduce((n, e) => n + e.length, 0);
  assert(total > 1000, `only ${total} edges resolved — the resolver is not matching`);
  const app = REACHED.get('product') as Set<string>;
  assert(app.size > 300, `the product reaches only ${app.size} files`);
  assert(app.has('src/renderer/App.tsx'), 'the product graph does not reach App.tsx');
});

check('every file is reachable from at least one of the four surfaces', () => {
  assert(orphans.length === 0,
    `${orphans.length} file(s) nothing reaches: ${orphans.join(', ')}`);
});

check('the worker bundles are vouched for by their build script, not by an import', () => {
  // These are the two the audit called dead.  They are entries; esbuild takes
  // them by path.  If this stops holding, either a worker was deleted or the
  // build script stopped naming it — and both are worth failing over.
  for (const worker of [
    'src/renderer/daw/audio/chroma/worker-entry.ts',
    'src/renderer/daw/audio/separate/worker-entry.ts',
  ]) {
    assert(KNOWN.has(worker), `${worker} is gone`);
    assert(BUILD_ENTRIES.includes(worker), `${worker} is no longer a build entry`);
    const byImport = SOURCES.some((f) => f !== worker && (GRAPH.get(f) ?? []).includes(worker));
    assert(!byImport, `${worker} is imported now — it is an entry, so check the bundling still makes sense`);
  }
});

check('a story is a caller, and the design system is alive because of it', () => {
  // The other half of the argument dead-exports-selftest makes.  37 files are
  // reachable ONLY through Storybook; an audit read that as "dead" and was
  // wrong.  Holding it here means the next reader sees the reason.
  const storyOnly = SOURCES.filter((f) => {
    const s = surfacesFor(f);
    return s.length === 1 && s[0] === 'storybook' && !/\.stories\.tsx?$/.test(f);
  });
  assert(storyOnly.length > 0,
    'nothing is story-only any more — if the Loui workbench was removed, remove this check with it');
  assert(existsSync('.storybook'),
    `${storyOnly.length} files are alive only through Storybook, and .storybook/ is gone`);
});

check('nothing is allow-listed without a reason', () => {
  // ALLOWED is empty today.  If it stops being empty, every entry has to name
  // a file that exists — an allow-list with stale entries hides the next one.
  for (const f of ALLOWED) assert(KNOWN.has(f), `ALLOWED names a file that is gone: ${f}`);
});

// ── Report ───────────────────────────────────────────────────────────────────

const tally = new Map<string, number>();
for (const f of SOURCES) {
  const key = surfacesFor(f).join(' + ') || 'NOTHING';
  tally.set(key, (tally.get(key) ?? 0) + 1);
}

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;

console.log('\n=== reachable files: every file has a way in ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${SOURCES.length} source files, reached by:`);
for (const [key, n] of [...tally].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${key}`);
}
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
