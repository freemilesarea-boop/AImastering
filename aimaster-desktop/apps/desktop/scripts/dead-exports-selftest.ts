/**
 * dead-exports-selftest — a ratchet against code nothing reaches.
 *
 * This repo has now had the same problem twice.  An earlier audit found 31
 * FILES nothing imported and deleted them; a later one found 87 exported
 * FUNCTIONS nothing called — 639 lines, plus 19 orphaned imports and two
 * counters that existed only to feed them.  Both were found by sweeping by
 * hand, months apart, which is not a plan.
 *
 * ── What this can and cannot see ────────────────────────────────────────────
 *
 * It counts occurrences of each exported function's NAME across every source
 * file, and calls a name dead when it appears exactly once — its own
 * declaration.  That misses two things, and both are stated rather than
 * pretended away:
 *
 *   · a function reached through a computed key (`handlers[name]`) looks dead
 *     and is not.  Nothing in this repo does that to an exported function
 *     today; if something starts, this will say so and the honest fix is an
 *     entry in ALLOWED below, with the reason.
 *   · a name that also appears in prose — a comment, a Korean string — looks
 *     alive and may not be.  That is the safe direction to be wrong in.
 *
 * Run: pnpm --filter @aimaster/desktop test:dead-exports
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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
const ALLOWED = new Set<string>();

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
function sourceFiles(): string[] {
  return execSync(
    String.raw`find src scripts \( -name '*.ts' -o -name '*.tsx' \) `
    + String.raw`| grep -v '/public/' | grep -v '\.d\.ts$'`,
    { encoding: 'utf8', shell: '/bin/bash' },
  ).split('\n').filter((f) => f.trim() !== '');
}

interface Dead { name: string; file: string }

function readAll(): Map<string, string> {
  const texts = new Map<string, string>();
  for (const f of sourceFiles()) texts.set(f, readFileSync(f, 'utf8'));
  return texts;
}

function findDead(texts: Map<string, string>): Dead[] {
  // Declarations first, then ONE pass counting every name across every file.
  // Re-grepping per symbol is what made the by-hand sweeps take minutes.
  const declared: Dead[] = [];
  for (const [file, text] of texts) {
    for (const m of text.matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)/gm)) {
      declared.push({ name: m[1]!, file });
    }
  }
  const counts = new Map<string, number>();
  for (const d of declared) counts.set(d.name, 0);
  const word = new RegExp(`\\b(${[...counts.keys()].join('|')})\\b`, 'g');
  for (const text of texts.values()) {
    for (const m of text.matchAll(word)) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  }
  return declared.filter((d) => (counts.get(d.name) ?? 0) <= 1 && !ALLOWED.has(d.name));
}

check('no exported function is left with nothing calling it', () => {
  const dead = findDead(readAll());
  const listed = dead.slice(0, 12).map((d) => `${d.name} (${d.file})`).join('\n    ');
  assert(dead.length === 0,
    `${dead.length} exported function(s) nothing references:\n    ${listed}`
    + (dead.length > 12 ? `\n    … and ${dead.length - 12} more` : '')
    + '\n  Delete them, call them, or add one to ALLOWED with a reason.');
});

check('and no import was left standing with nothing in it', () => {
  // `import { } from './x.js'` is what an orphan-clearing pass leaves when it
  // takes the last specifier off a line and stops there.  It is legal, and it
  // is not nothing: it still imports the module for its side effects, which is
  // the opposite of what the sweep meant.  Four survived the first pass here.
  const empty: string[] = [];
  for (const f of sourceFiles()) {
    const text = readFileSync(f, 'utf8');
    if (/^import \{\s*\} from /m.test(text)) empty.push(f);
  }
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
});

check('a name used only inside its own file still counts as used', () => {
  // The rule is "nothing references it", not "nothing OUTSIDE it references
  // it".  A recursive helper, or one called twice within its module, is live
  // code, and deleting it would break the build — which is the other way this
  // check could do damage if it were written the obvious way.
  //
  // This runs the real counting over a made-up file set rather than asserting
  // on a regex, so that rewriting findDead to skip the declaring file — the
  // obvious "optimisation" — fails here instead of deleting live code.
  const dead = findDead(new Map([
    ['a.ts', 'export function loop(n: number): number { return n > 0 ? loop(n - 1) : 0; }'],
    ['b.ts', 'export function orphan(): void {}'],
    ['c.ts', 'export function reached(): void {}'],
    ['d.ts', 'import { reached } from "./c"; reached();'],
  ]));
  const names = dead.map((d) => d.name).sort().join(',');
  assert(names === 'orphan', `expected only orphan to be dead, got: ${names || '(none)'}`);
});

const failed = results.filter((r) => !r.pass);
for (const r of results) {
  // eslint-disable-next-line no-console
  console.log(`${r.pass ? '[PASS]' : '[FAIL]'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
// eslint-disable-next-line no-console
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
