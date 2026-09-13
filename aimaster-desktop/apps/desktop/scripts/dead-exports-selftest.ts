/**
 * dead-exports-selftest — a ratchet against code nothing reaches.
 *
 * This repo has now had the same problem twice.  An earlier audit found 31
 * FILES nothing imported and deleted them; a later one found 87 exported
 * FUNCTIONS nothing called — 639 lines, plus orphaned imports and two
 * counters that existed only to feed them.  Both were found by sweeping by
 * hand, months apart, which is not a plan.
 *
 * ── Why this does not just count names ──────────────────────────────────────
 *
 * The first version of this file counted how often each exported name appeared
 * across the tree and called a name dead when it appeared once.  A code review
 * of the commit that added it found the hole: the count is per IDENTIFIER, not
 * per DECLARATION.  Two modules exporting `bandPointDb`, or a module exporting
 * `xToHz` while a component declares a private one, put the count at two before
 * anybody calls either — so BOTH are exempt for as long as the other exists.
 * 34 names were declared in two or more files, and five genuinely unreachable
 * exports were hiding behind that: `findNode` (io/cfb.ts), `bandPointDb`
 * (parametric-eq-model.ts), `xToHz` (spectrum-axis.ts), `sameTarget`
 * (model/automation.ts) and `dumpGraph` (shared-audio-graph.ts).
 *
 * So liveness is resolved per declaration instead.  An exported function in
 * file F is live when
 *
 *   · F's own text mentions it more than once — a recursive helper, or one
 *     called twice inside its module, is live code; or
 *   · some file imports that NAME from a specifier that resolves to F; or
 *   · some file imports F wholesale (`import * as ns`, or `export * from`),
 *     which could reach anything F exports; or
 *   · a build script (.mjs/.cjs, which this cannot resolve) mentions the name.
 *
 * The last two are deliberately generous.  Being wrong towards "alive" leaves
 * dead code in the tree; being wrong towards "dead" tells somebody to delete
 * working code, which is how the first sweep here broke the build.
 *
 * ── What it still cannot see ────────────────────────────────────────────────
 *
 * A function reached only through a computed key (`handlers[name]`) looks dead
 * and is not.  Nothing in this repo does that to an exported function today; if
 * something starts, this will say so and the honest fix is an entry in ALLOWED
 * below, with the reason.
 *
 * Run: pnpm --filter @aimaster/desktop test:dead-exports
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); } catch (e: unknown) {
    results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
  }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

/**
 * Exported functions that are genuinely unreferenced and genuinely wanted.
 *
 * Empty, and that is the point: every entry has to earn its place with a
 * reason somebody can check.  "It might be useful later" is not one — the
 * file it would have been useful in can add it back in one line.
 */
const ALLOWED = new Set<string>([
  // The only thing that can ever create `graph.freeEq`, and nothing calls it —
  // so the `useFreeEq` branch of `rewire()` is unreachable and the free-tier EQ
  // is a feature with no handle on it.  Deleting the setter would not fix that,
  // it would only hide it: the branch, the chain type and the node would all
  // have to go too, and whether the free EQ is meant to come back is a product
  // question, not a sweep's.  Kept, named here, and raised.
  'setFreeEqBands',
  // The entitlement bridge's only reader.  `setEntitlement` is still called
  // from `entitlementHandlers`, so deleting this turns the bridge write-only —
  // exactly the shape this file exists to catch.  It is left over from the
  // export gate that was deliberately removed (`export-gate-selftest` asserts
  // `fileHandlers.ts` must NOT read it), so the bridge itself is probably what
  // should go.  Also a product question.
  'getEntitlementPaid',
]);

function find(exts: string[]): string[] {
  const names = exts.map((e) => `-name '*.${e}'`).join(' -o ');
  return execSync(
    String.raw`find src scripts \( ${names} \) | grep -v '/public/' | grep -v '\.d\.ts$'`,
    { encoding: 'utf8', shell: '/bin/bash' },
  ).split('\n').filter((f) => f.trim() !== '');
}

/**
 * Every source file worth searching — the app, not its generated bundles.
 *
 * The dots are escaped and the match is anchored, and that is not pedantry.
 * Written as `grep -v '.d.ts'` this also drops every file whose name merely
 * ENDS in `d.ts` — `aaf-read.ts`, `clipboard.ts`, `automation-record.ts`,
 * `SessionViewGrid.tsx` and eight more.  A sweep blind to twelve files will
 * happily delete something they are the only callers of, which is exactly
 * what happened: the first run of this removed four functions `aaf-read.ts`
 * imports, and only the compiler noticed.
 */
function sourceFiles(): string[] { return find(['ts', 'tsx']); }

/** …plus the build scripts, which import from `src` and are not TypeScript. */
function scriptFiles(): string[] { return find(['mjs', 'cjs']); }

/**
 * Turn a module specifier into the file it means, or null for a bare package.
 *
 * The repo writes relative specifiers with a `.js` suffix that TypeScript maps
 * back to `.ts`, and has exactly one alias, `@` → `src/renderer` (vite.config).
 */
function resolveSpec(spec: string, fromFile: string, known: Set<string>): string | null {
  let base: string;
  if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else if (spec.startsWith('@/')) base = resolve('src/renderer', spec.slice(2));
  else return null;
  const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
  for (const c of [`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`, `${stem}/index.tsx`, base]) {
    const rel = relative(process.cwd(), c);
    // `known` first so the checks below can resolve a made-up file set; disk
    // second so the real run does not depend on what it happened to read.
    if (known.has(rel) || existsSync(c)) return rel;
  }
  return null;
}

/** Every `import`/`export … from '…'` in a file, clause and specifier. */
const FROM = /(?:^|\n)\s*(?:import|export)\s+([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;

/**
 * Every dynamic `import('…')`, which reaches its target by a route no static
 * clause describes.
 *
 * This repo uses three shapes of it — `React.lazy(() => import(p).then((m) =>
 * ({ default: m.Page })))` for the dev pages, `const { a, b } = await
 * import(p)` for the heavy main-process modules, and a bare side-effect load —
 * and the names come off the module object, not out of a brace list.  Rather
 * than parse all three, a dynamically imported module is treated as reached
 * WHOLESALE.  Leaving the first version of this blind to it made four live
 * functions — `DevAnalyzerStreamPage`, `processAudioFileRust`,
 * `encodePreviewMp3`, `measureReferenceCurve` — read as dead.
 */
const DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

interface Graph {
  /** file → names some other file imports from it by name */
  named: Map<string, Set<string>>;
  /** files somebody pulls in wholesale, so anything they export may be reached */
  wholesale: Set<string>;
}

function buildGraph(texts: Map<string, string>): Graph {
  const named = new Map<string, Set<string>>();
  const wholesale = new Set<string>();
  const known = new Set(texts.keys());
  for (const [file, text] of texts) {
    for (const m of text.matchAll(FROM)) {
      const target = resolveSpec(m[2]!, file, known);
      if (target === null) continue;
      const clause = m[1]!;
      if (/^\*/.test(clause) || /\*\s+as\s+/.test(clause)) { wholesale.add(target); continue; }
      const braces = /\{([\s\S]*)\}/.exec(clause);
      if (braces === null) continue; // default import only — reaches no named export
      for (const part of braces[1]!.split(',')) {
        const id = /([A-Za-z0-9_$]+)\s*$/.exec(part.trim().split(/\s+as\s+/)[0]!.trim());
        if (id !== null) {
          let set = named.get(target);
          if (set === undefined) { set = new Set(); named.set(target, set); }
          set.add(id[1]!);
        }
      }
    }
    for (const m of text.matchAll(DYNAMIC)) {
      const target = resolveSpec(m[1]!, file, known);
      if (target !== null) wholesale.add(target);
    }
  }
  return { named, wholesale };
}

/**
 * The same text with comments and string bodies blanked out — code only.
 *
 * `dumpGraph` hid from the first version of this check behind its own error
 * messages: `logAudioEvent('error', 'dumpGraph: no element')` mentions the name
 * twice more, and "mentioned more than once in its own file" read that as a
 * function calling itself.  A `${...}` interpolation is kept, because that IS
 * code and often the only call site of a formatter.
 *
 * Blanking rather than deleting keeps every offset, so nothing shifts.
 */
function codeOnly(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i); const to = end === -1 ? text.length : end;
      blank(i, to); i = to; continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2); const to = end === -1 ? text.length : end + 2;
      blank(i, to); i = to; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) { if (text[j] === '\\') j++; j++; }
      blank(i, Math.min(j + 1, text.length)); i = j + 1; continue;
    }
    if (c === '`') {
      let j = i + 1;
      let run = i;                       // start of the literal run being blanked
      while (j < text.length && text[j] !== '`') {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '$' && text[j + 1] === '{') {
          blank(run, j);                 // literal text before the hole
          let depth = 1; j += 2;
          while (j < text.length && depth > 0) {
            if (text[j] === '{') depth++;
            else if (text[j] === '}') depth--;
            j++;
          }
          run = j; continue;             // the `${...}` body itself is left alone
        }
        j++;
      }
      blank(run, Math.min(j, text.length));
      i = j + 1; continue;
    }
    i++;
  }
  return out.join('');
}

interface Dead { name: string; file: string }

function findDead(texts: Map<string, string>, scripts: string[] = []): Dead[] {
  const graph = buildGraph(texts);
  const code = new Map([...texts].map(([f, t]) => [f, codeOnly(t)] as const));
  const scriptText = scripts.map((f) => codeOnly(readFileSync(f, 'utf8'))).join('\n');
  const dead: Dead[] = [];
  for (const [file, text] of texts) {
    for (const m of text.matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)/gm)) {
      const name = m[1]!;
      if (ALLOWED.has(name)) continue;
      if (graph.wholesale.has(file)) continue;
      if (graph.named.get(file)?.has(name) === true) continue;
      if ([...code.get(file)!.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length > 1) continue;
      if (scriptText !== '' && new RegExp(`\\b${name}\\b`).test(scriptText)) continue;
      dead.push({ name, file });
    }
  }
  return dead;
}

function readAll(files: string[]): Map<string, string> {
  const texts = new Map<string, string>();
  for (const f of files) texts.set(f, readFileSync(f, 'utf8'));
  return texts;
}

check('no exported function is left with nothing calling it', () => {
  const dead = findDead(readAll(sourceFiles()), scriptFiles());
  const listed = dead.slice(0, 99).map((d) => `${d.name} (${d.file})`).join('\n    ');
  assert(dead.length === 0,
    `${dead.length} exported function(s) nothing references:\n    ${listed}`
    + (dead.length > 99 ? `\n    … and ${dead.length - 99} more` : '')
    + '\n  Delete them, call them, or add one to ALLOWED with a reason.');
});

check('and no import was left standing with nothing in it', () => {
  // `import { } from './x.js'` is what an orphan-clearing pass leaves when it
  // takes the last specifier off a line and stops there.  It is legal, and it
  // is not nothing: it still imports the module for its side effects, which is
  // the opposite of what the sweep meant.  Four survived the first pass here.
  const empty = sourceFiles().filter((f) => /^import \{\s*\} from /m.test(readFileSync(f, 'utf8')));
  assert(empty.length === 0,
    `${empty.length} file(s) import nothing by name:\n    ${empty.join('\n    ')}`);
});

check('and the sweep is actually looking at the app', () => {
  // Guards the check above from passing because it found nothing to check.
  // A broken `find`, a renamed directory, a regex that stops matching — all
  // of them turn this file into a test that always passes.
  const files = sourceFiles();
  assert(files.length > 400, `only ${files.length} source files found`);
  const declaring = files.filter((f) => /^export (?:async )?function /m.test(readFileSync(f, 'utf8')));
  assert(declaring.length > 150, `only ${declaring.length} files declare an exported function`);
  const graph = buildGraph(readAll(files));
  assert(graph.named.size > 300, `only ${graph.named.size} files are imported from by name`);
});

check('liveness is decided per declaration, not per name', () => {
  // Everything the review caught, as a fixture.  `dup` is exported twice and
  // reached in neither place; the old name-counting rule scored it 2 and let
  // both copies through.  `shadowed` is exported once and shadowed by a
  // private function of the same name, which is the same bug wearing a hat.
  const dead = findDead(new Map([
    ['a.ts', 'export function loop(n: number): number { return n > 0 ? loop(n - 1) : 0; }'],
    ['b.ts', 'export function dup(): void {}'],
    ['c.ts', 'export function dup(): void {}\nexport function reached(): void {}'],
    ['d.ts', "import { reached } from './c.js';\nreached();"],
    ['e.ts', 'export function shadowed(): void {}'],
    ['f.ts', 'function shadowed(): void {}\nshadowed();'],
  ]));
  const names = dead.map((d) => `${d.name}@${d.file}`).sort().join(' ');
  assert(names === 'dup@b.ts dup@c.ts shadowed@e.ts',
    `expected both dups and the shadowed export, got: ${names || '(none)'}`);
});

check('and a module pulled in wholesale keeps all of its exports', () => {
  // `import * as ops` could reach anything, and so could a barrel's
  // `export * from`.  Guessing otherwise would delete working code, so this
  // errs towards alive — and says so rather than leaving it to be discovered.
  const star = findDead(new Map([
    ['g.ts', 'export function viaNamespace(): void {}'],
    ['h.ts', "import * as g from './g.js';\ng;"],
  ]));
  assert(star.length === 0, `namespace import did not keep it alive: ${star.map((d) => d.name).join()}`);
  const barrel = findDead(new Map([
    ['i.ts', 'export function viaBarrel(): void {}'],
    ['j.ts', "export * from './i.js';"],
  ]));
  assert(barrel.length === 0, `barrel re-export did not keep it alive: ${barrel.map((d) => d.name).join()}`);
});

check('and a module reached only by a dynamic import keeps its exports', () => {
  // React.lazy and the main process's deferred loads are the only route in for
  // a handful of modules.  Missing them made `DevAnalyzerStreamPage`,
  // `processAudioFileRust`, `encodePreviewMp3` and `measureReferenceCurve` —
  // all four of them live, all four reachable from the running app — read as
  // dead, which is the direction that gets working code deleted.
  const lazy = findDead(new Map([
    ['k.ts', 'export function Page(): void {}'],
    ['l.ts', "React.lazy(() => import('./k.js').then((m) => ({ default: m.Page })));"],
  ]));
  assert(lazy.length === 0, `lazy import did not keep it alive: ${lazy.map((d) => d.name).join()}`);
  const awaited = findDead(new Map([
    ['m.ts', 'export function heavy(): void {}'],
    ['n.ts', "async function go() { const { heavy } = await import('./m.js'); heavy(); }"],
  ]));
  assert(awaited.length === 0, `awaited import did not keep it alive: ${awaited.map((d) => d.name).join()}`);
});

check('and stripping prose does not strip the code inside a template hole', () => {
  // `codeOnly` blanks strings so a name in an error message cannot vouch for
  // itself.  A `${...}` body is not prose, though, and is often a formatter's
  // only call site — blanking it too would report live code as dead.
  const stripped = codeOnly([
    "const a = 'callMe(1)';",
    '// callMe(2)',
    '/* callMe(3) */',
    'const b = `text ${callMe(4)} more`;',
  ].join('\n'));
  const hits = [...stripped.matchAll(/\bcallMe\b/g)].length;
  assert(hits === 1, `expected only the template hole to survive, ${hits} did:\n${stripped}`);
  assert(stripped.split('\n').length === 4, 'blanking must not move any line');
});

const failed = results.filter((r) => !r.pass);
for (const r of results) {
  // eslint-disable-next-line no-console
  console.log(`${r.pass ? '[PASS]' : '[FAIL]'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
// eslint-disable-next-line no-console
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
