#!/usr/bin/env node
/**
 * run-selftests.mjs — run the selftest chain without a pnpm process per step.
 *
 * `pnpm test` used to be 221 `pnpm test:<name> &&` links.  Measured on this
 * machine, warm:
 *
 *     pnpm run test:shortcuts                       1182 ms
 *     node_modules/.bin/tsx scripts/shortcuts-…ts    345 ms
 *
 * — so each link paid about 730 ms to pnpm for reading a manifest and
 * spawning a shell, and the suite spent roughly 2.7 minutes doing that 221
 * times before any test did work.  This runs the same command strings, taken
 * from the same `test:<name>` entries in package.json, with node_modules/.bin
 * on PATH instead.
 *
 * What it must not do is quietly run fewer steps than the chain did, so the
 * order file and package.json are held to each other: every `test:*` script
 * must be listed exactly once, and every listed name must exist.  The two
 * scripts deliberately left out are named here, not skipped silently.
 *
 * Order comes from suite-order.json because order is not derivable — the
 * chain was hand-ordered, and `Object.keys` would quietly reshuffle it.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');

/** Defined as `test:*` but not part of the chain, each for a stated reason. */
const NOT_IN_SUITE = new Map([
  ['python', 'runs the whole pytest suite; test:python-suite is its gate in the chain'],
  ['release-smoke', 'needs a built dist/ and out/, so it runs after packaging'],
]);

const pkg = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
const order = JSON.parse(fs.readFileSync(path.join(HERE, 'suite-order.json'), 'utf8'));

const defined = Object.keys(pkg.scripts)
  .filter((k) => k.startsWith('test:'))
  .map((k) => k.slice(5));

const problems = [];
const seen = new Set();
for (const name of order) {
  if (seen.has(name)) problems.push(`suite-order.json lists test:${name} twice`);
  seen.add(name);
  if (!pkg.scripts[`test:${name}`]) problems.push(`suite-order.json lists test:${name}, which package.json does not define`);
  if (NOT_IN_SUITE.has(name)) problems.push(`test:${name} is both listed and excluded`);
}
for (const name of defined) {
  if (seen.has(name) || NOT_IN_SUITE.has(name)) continue;
  problems.push(`package.json defines test:${name} and nothing runs it — add it to suite-order.json, or to NOT_IN_SUITE with a reason`);
}
if (problems.length > 0) {
  console.error(`\n✗ the suite list and package.json disagree:\n   ${problems.join('\n   ')}\n`);
  process.exit(1);
}

const binDirs = [
  path.join(DESKTOP, 'node_modules', '.bin'),
  path.resolve(DESKTOP, '..', '..', 'node_modules', '.bin'),
];
const env = { ...process.env, PATH: `${binDirs.join(path.delimiter)}${path.delimiter}${process.env.PATH ?? ''}` };

console.log(`\nrunning ${order.length} selftests (${defined.length} defined, ${NOT_IN_SUITE.size} run elsewhere)\n`);

const started = Date.now();
const slow = [];
for (let i = 0; i < order.length; i++) {
  const name = order[i];
  const command = pkg.scripts[`test:${name}`];
  console.log(`» ${String(i + 1).padStart(3)}/${order.length} test:${name}`);
  const at = Date.now();
  const run = spawnSync(command, { cwd: DESKTOP, env, shell: true, stdio: 'inherit' });
  const took = Date.now() - at;
  slow.push([name, took]);
  if (run.status !== 0 || run.error) {
    console.error(`\n✗ test:${name} failed after ${(took / 1000).toFixed(1)}s`
      + `${run.error ? ` — ${run.error.message}` : ` (exit ${run.status}${run.signal ? `, signal ${run.signal}` : ''})`}`);
    console.error(`  command: ${command}`);
    console.error(`  ${i} of ${order.length} steps had passed\n`);
    process.exit(run.status === 0 || run.status === null ? 1 : run.status);
  }
}

const total = (Date.now() - started) / 1000;
slow.sort((a, b) => b[1] - a[1]);
console.log(`\n✓ ${order.length}/${order.length} selftests passed in ${total.toFixed(1)}s`);
console.log(`  slowest: ${slow.slice(0, 5).map(([n, ms]) => `test:${n} ${(ms / 1000).toFixed(1)}s`).join(', ')}\n`);
