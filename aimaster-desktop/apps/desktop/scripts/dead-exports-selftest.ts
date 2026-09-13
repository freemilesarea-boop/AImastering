/**
 * dead-exports-selftest — a ratchet against code nothing reaches.
 *
 * This repo has now had the same problem three times.  An audit found 31 FILES
 * nothing imported; a later one found 87 exported FUNCTIONS nothing called;
 * a code review of the ratchet written to stop the next one found that it was
 * counting the wrong thing, and behind that 10 more functions and 21 exported
 * CONSTANTS.  Sweeping by hand, months apart, is not a plan.
 *
 * ── Why this uses the compiler's parser ─────────────────────────────────────
 *
 * Two earlier versions of this file read the source as text, and text lies:
 *
 *   · counting how often a NAME appears cannot tell two declarations apart.
 *     Two modules exporting `bandPointDb`, or a module exporting `xToHz` while
 *     a component declares a private one, put the count at two before anybody
 *     calls either — so BOTH were exempt for as long as the other existed.
 *   · blanking comments and string bodies by hand, to stop a function's own
 *     error messages vouching for it, cannot see a regex literal.  On
 *     `.replace(/[<>:"/\\|?*]/g, ' ')` the `"` inside the character class
 *     opened a string that swallowed the next 25 lines, and `DRUM_INSTRUMENT_ID`
 *     — used one line below its declaration — was reported dead.  That is the
 *     direction that deletes working code.
 *
 * So nothing here reads the source as text.  TypeScript parses each file and
 * this walks the tree: an identifier in the AST is an identifier, never a word
 * inside a comment, a string or a regex, and a declaration is a node with a
 * position rather than a name that might belong to somebody else.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * An exported function or const in file F is live when
 *
 *   · F's own code mentions it again — a recursive helper, or one used twice
 *     inside its module, is live code; or
 *   · some file imports that NAME from a specifier that resolves to F; or
 *   · some file pulls F in wholesale — `import * as ns`, `export * from`, or a
 *     dynamic `import()`, any of which could reach anything F exports; or
 *   · a `.mjs`/`.cjs` build script mentions the name.
 *
 * The last two are deliberately generous.  Being wrong towards "alive" leaves
 * dead code in the tree; being wrong towards "dead" tells somebody to delete
 * working code, which is how the first sweep here broke the build.
 *
 * What it still cannot see: a function reached only through a computed key
 * (`handlers[name]`).  Nothing in this repo does that to an export today; if
 * something starts, this will say so and the fix is an ALLOWED entry.
 *
 * Run: pnpm --filter @aimaster/desktop test:dead-exports
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import ts from 'typescript';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); } catch (e: unknown) {
    results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
  }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

/**
 * Exports that are genuinely unreferenced and genuinely wanted.
 *
 * Every entry has to earn its place with a reason somebody can check.  "It
 * might be useful later" is not one — the file it would have been useful in
 * can add it back in one line.
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

/** …plus the build scripts, which are not TypeScript and are not parsed. */
function scriptFiles(): string[] { return find(['mjs', 'cjs']); }

/**
 * …minus the files whose exports are a framework's contract, not a caller's.
 *
 * Storybook discovers a story by enumerating the module's named exports; no
 * file imports `SpotifyLoud` from `StereoScopePanel.stories.tsx` and none ever
 * will.  Judging those by who imports them marks all 170 of them dead.
 *
 * They stay in `sourceFiles` — and so in the import graph — because a story IS
 * one of the real callers of the component it renders.  Dropping them from the
 * search entirely made eleven live components (`LouiTopBar`, `LouiABCompare`,
 * `DraggableEQCurveEditor` …) read as dead: their story file was the importer
 * that had been vouching for them.  Candidate and reference are two different
 * sets, and conflating them breaks it in both directions.
 */
function declaringFiles(): string[] {
  return sourceFiles().filter((f) => !/\.stories\.tsx?$/.test(f));
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function walk(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  node.forEachChild((c) => { walk(c, fn); });
}

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

interface Decl { name: string; file: string; what: 'function' | 'const'; isDefault: boolean }

interface FileFacts {
  decls: Decl[];
  /** how many times each identifier appears in this file's own code */
  idents: Map<string, number>;
  /** names this file imports, per resolved target file */
  named: Map<string, Set<string>>;
  /** target files this file pulls in wholesale */
  wholesale: Set<string>;
  /** target files this file takes the DEFAULT export of */
  defaults: Set<string>;
}

function factsOf(file: string, source: ts.SourceFile, known: Set<string>): FileFacts {
  const decls: Decl[] = [];
  const idents = new Map<string, number>();
  const named = new Map<string, Set<string>>();
  const wholesale = new Set<string>();
  const defaults = new Set<string>();

  const addNamed = (target: string, name: string): void => {
    let set = named.get(target);
    if (set === undefined) { set = new Set(); named.set(target, set); }
    set.add(name);
  };
  const has = (n: ts.Node, k: ts.SyntaxKind): boolean =>
    ts.getModifiers(n as ts.HasModifiers)?.some((m) => m.kind === k) === true;
  const exported = (n: ts.Node): boolean => has(n, ts.SyntaxKind.ExportKeyword);
  // `export default function Foo` is reached by a DEFAULT import, which names
  // no name.  Judging it by who imports `Foo` marks every default-exported
  // component dead — `LicenseModal`, `TopBar`, `AlbumPanel` and 90 more.
  const isDefault = (n: ts.Node): boolean => has(n, ts.SyntaxKind.DefaultKeyword);

  walk(source, (n) => {
    if (ts.isIdentifier(n)) idents.set(n.text, (idents.get(n.text) ?? 0) + 1);

    if (ts.isFunctionDeclaration(n) && exported(n) && n.name !== undefined) {
      decls.push({ name: n.name.text, file, what: 'function', isDefault: isDefault(n) });
    }
    if (ts.isVariableStatement(n) && exported(n)) {
      for (const d of n.declarationList.declarations) {
        // Destructured forms (`export const { a, b } = …`) are skipped rather
        // than half-parsed; guessing at a binding list is how a sweep starts
        // deleting things it did not understand.
        if (ts.isIdentifier(d.name)) {
          decls.push({ name: d.name.text, file, what: 'const', isDefault: false });
        }
      }
    }

    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const target = resolveSpec(n.moduleSpecifier.text, file, known);
      if (target === null) return;
      if (n.importClause?.name !== undefined) defaults.add(target);
      const b = n.importClause?.namedBindings;
      if (b !== undefined && ts.isNamespaceImport(b)) { wholesale.add(target); return; }
      if (b !== undefined && ts.isNamedImports(b)) {
        for (const el of b.elements) addNamed(target, (el.propertyName ?? el.name).text);
      }
    }
    if (ts.isExportDeclaration(n) && n.moduleSpecifier !== undefined
      && ts.isStringLiteral(n.moduleSpecifier)) {
      const target = resolveSpec(n.moduleSpecifier.text, file, known);
      if (target === null) return;
      // `export * from './x.js'` re-exports everything, name unknown here.
      if (n.exportClause === undefined) { wholesale.add(target); return; }
      if (ts.isNamedExports(n.exportClause)) {
        for (const el of n.exportClause.elements) {
          const from = (el.propertyName ?? el.name).text;
          if (from === 'default') defaults.add(target); else addNamed(target, from);
        }
      } else wholesale.add(target);
    }
    // `import('./x.js')` — React.lazy, and the main process's deferred loads.
    // The names come off the module object, not a brace list, so the target is
    // treated as reached wholesale rather than parsed three different ways.
    // …and `require('./x.js')`, which the selftests use to defer a load past a
    // top-level side effect.  `glossary-selftest.ts` reaches `GRAPH_EQ_MODULES`
    // that way and no other, so missing it reported a live constant dead.
    if (ts.isCallExpression(n)
      && (n.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) {
      const a = n.arguments[0];
      if (a !== undefined && ts.isStringLiteral(a)) {
        const target = resolveSpec(a.text, file, known);
        if (target !== null) wholesale.add(target);
      }
    }
  });

  return { decls, idents, named, wholesale, defaults };
}

function findDead(
  texts: Map<string, string>, scripts: string[] = [], declaring?: string[],
): Decl[] {
  const known = new Set(texts.keys());
  const facts = new Map<string, FileFacts>();
  for (const [file, text] of texts) facts.set(file, factsOf(file, parse(file, text), known));

  const named = new Map<string, Set<string>>();
  const wholesale = new Set<string>();
  const defaults = new Set<string>();
  for (const f of facts.values()) {
    for (const t of f.wholesale) wholesale.add(t);
    for (const t of f.defaults) defaults.add(t);
    for (const [t, set] of f.named) {
      let all = named.get(t);
      if (all === undefined) { all = new Set(); named.set(t, all); }
      for (const n of set) all.add(n);
    }
  }

  const scriptText = scripts.map((f) => readFileSync(f, 'utf8')).join('\n');
  const dead: Decl[] = [];
  for (const file of declaring ?? [...texts.keys()]) {
    const f = facts.get(file);
    if (f === undefined) continue;
    if (wholesale.has(file)) continue;
    for (const d of f.decls) {
      if (ALLOWED.has(d.name)) continue;
      if (d.isDefault ? defaults.has(file) : named.get(file)?.has(d.name) === true) continue;
      if ((f.idents.get(d.name) ?? 0) > 1) continue;
      if (scriptText !== '' && new RegExp(`\\b${d.name}\\b`).test(scriptText)) continue;
      dead.push(d);
    }
  }
  return dead;
}

function readAll(files: string[]): Map<string, string> {
  const texts = new Map<string, string>();
  for (const f of files) texts.set(f, readFileSync(f, 'utf8'));
  return texts;
}

check('no export is left with nothing referencing it', () => {
  const dead = findDead(readAll(sourceFiles()), scriptFiles(), declaringFiles());
  const listed = dead.slice(0, 14).map((d) => `${d.what} ${d.name} (${d.file})`).join('\n    ');
  assert(dead.length === 0,
    `${dead.length} export(s) nothing references:\n    ${listed}`
    + (dead.length > 14 ? `\n    … and ${dead.length - 14} more` : '')
    + '\n  Delete them, use them, or add one to ALLOWED with a reason.');
});

check('and no import was left standing with nothing in it', () => {
  // `import { } from './x.js'` is what an orphan-clearing pass leaves when it
  // takes the last specifier off a line and stops there.  It is legal, and it
  // is not nothing: it still imports the module for its side effects, which is
  // the opposite of what the sweep meant.  Four survived an earlier pass here.
  const empty = sourceFiles().filter((f) => {
    let bad = false;
    walk(parse(f, readFileSync(f, 'utf8')), (n) => {
      if (!ts.isImportDeclaration(n)) return;
      const b = n.importClause?.namedBindings;
      if (b !== undefined && ts.isNamedImports(b) && b.elements.length === 0) bad = true;
    });
    return bad;
  });
  assert(empty.length === 0,
    `${empty.length} file(s) import nothing by name:\n    ${empty.join('\n    ')}`);
});

check('and the sweep is actually looking at the app', () => {
  // Guards the checks above from passing because they found nothing to check.
  // A broken `find`, a renamed directory, a parser that stops matching — all
  // of them turn this file into a test that always passes.
  const files = sourceFiles();
  assert(files.length > 400, `only ${files.length} source files found`);
  const known = new Set(files);
  let declaring = 0, importing = 0;
  for (const f of files) {
    const facts = factsOf(f, parse(f, readFileSync(f, 'utf8')), known);
    if (facts.decls.length > 0) declaring++;
    if (facts.named.size > 0 || facts.wholesale.size > 0) importing++;
  }
  assert(declaring > 300, `only ${declaring} files declare an export`);
  assert(importing > 300, `only ${importing} files import from another source file`);
});

check('liveness is decided per declaration, not per name', () => {
  // `dup` is exported twice and reached in neither place; counting names
  // scored it 2 and let both copies through.  `shadowed` is exported once and
  // shadowed by a private function of the same name — the same bug in a hat.
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

check('and an exported const is judged the same way as a function', () => {
  // `parametric-eq-model.ts` finished a function-only sweep as eight exported
  // constants nothing had read since the curve code they bounded was deleted,
  // and the ratchet called that file clean.  An `export const f = () => {}` is
  // a function wearing a const, and was invisible for the same reason.
  const dead = findDead(new Map([
    ['g.ts', 'export const KEPT = 1;\nexport const GONE = 2;\nexport const arrow = () => KEPT;'],
    ['h.ts', "import { KEPT } from './g.js';\nKEPT;"],
  ]));
  const names = dead.map((d) => `${d.what} ${d.name}`).sort().join(', ');
  assert(names === 'const GONE, const arrow', `expected GONE and arrow, got: ${names || '(none)'}`);
});

check('and a default export is judged by who default-imports it', () => {
  // `export default function LicenseModal()` is reached by `import LicenseModal
  // from …`, which names no name.  Matching it against NAMED imports — which is
  // what an AST-blind rule does by accident — reported 90 live components dead,
  // `LicenseModal`, `TopBar` and `AlbumPanel` among them.
  const dead = findDead(new Map([
    ['t.ts', 'export default function Taken(): void {}'],
    ['u.ts', "import Taken from './t.js';\nTaken();"],
    ['v.ts', 'export default function Untaken(): void {}'],
  ]));
  const names = dead.map((d) => d.name).sort().join(', ');
  assert(names === 'Untaken', `expected only Untaken, got: ${names || '(none)'}`);
});

check('and a require() reaches what an import would', () => {
  // The selftests use `require` to defer a load past a top-level side effect.
  // `glossary-selftest.ts` reaches `GRAPH_EQ_MODULES` that way and no other, and
  // `LouiToneDynamicsViews`'s `REGISTRY_ONLY_VIEWS` the same — both read as dead
  // until the walk learned the call.
  const dead = findDead(new Map([
    ['w.ts', 'export const TABLE = new Set<string>();'],
    ['x.ts', "const m = require('./w.js') as { TABLE: Set<string> };\nm.TABLE.has('a');"],
  ]));
  assert(dead.length === 0, `require did not keep it alive: ${dead.map((d) => d.name).join()}`);
});

check('and a module pulled in wholesale keeps all of its exports', () => {
  // `import * as ops` could reach anything, and so could a barrel's
  // `export * from`, and so could a dynamic import — React.lazy and the main
  // process's deferred loads are the only route into several modules.  Missing
  // the last one made `DevAnalyzerStreamPage`, `processAudioFileRust`,
  // `encodePreviewMp3` and `measureReferenceCurve` read as dead while every
  // one of them was reachable from the running app.
  const cases: Array<[string, Map<string, string>]> = [
    ['namespace', new Map([
      ['i.ts', 'export function viaNamespace(): void {}'],
      ['j.ts', "import * as i from './i.js';\ni;"],
    ])],
    ['barrel', new Map([
      ['k.ts', 'export function viaBarrel(): void {}'],
      ['l.ts', "export * from './k.js';"],
    ])],
    ['lazy', new Map([
      ['m.ts', 'export function Page(): void {}'],
      ['n.ts', "const L = () => import('./m.js').then((x) => ({ default: x.Page }));\nL;"],
    ])],
    ['awaited', new Map([
      ['o.ts', 'export function heavy(): void {}'],
      ['p.ts', "async function go() { const { heavy } = await import('./o.js'); heavy(); }\ngo;"],
    ])],
  ];
  for (const [label, files] of cases) {
    const dead = findDead(files);
    assert(dead.length === 0, `${label} did not keep it alive: ${dead.map((d) => d.name).join()}`);
  }
});

check('and a name in a comment, a string or a regex is not a reference', () => {
  // This is what the hand-written stripper was for, and what it got wrong: on
  // `.replace(/[<>:"/\\|?*]/g, ' ')` the `"` inside the character class opened
  // a string that swallowed the next 25 lines, and `DRUM_INSTRUMENT_ID` — used
  // one line below its declaration — was reported dead.  The parser has no
  // such ambiguity, and a `${...}` hole stays code because it IS code.
  const dead = findDead(new Map([
    ['q.ts', [
      'export function alibi(): void {}',      // only ever "used" in prose
      "const s = 'alibi';",
      '// alibi',
      '/* alibi */',
      'const r = /["alibi]/g;',
      'void s; void r;',
    ].join('\n')],
    ['r.ts', [
      'export function fmt(n: number): string { return `${n}`; }',
      'export function shout(n: number): string { return `say ${fmt(n)}!`; }',
    ].join('\n')],
    ['s.ts', "import { shout } from './r.js';\nshout(1);"],
  ]));
  const names = dead.map((d) => d.name).sort().join(', ');
  assert(names === 'alibi',
    `prose must not vouch and a template hole must: expected alibi, got: ${names || '(none)'}`);
});

const failed = results.filter((r) => !r.pass);
for (const r of results) {
  // eslint-disable-next-line no-console
  console.log(`${r.pass ? '[PASS]' : '[FAIL]'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
// eslint-disable-next-line no-console
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
