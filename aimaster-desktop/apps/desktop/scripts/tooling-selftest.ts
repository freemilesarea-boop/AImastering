/**
 * tooling-selftest — the tools that check the app, checked.
 *
 * Three of this project's checks were found broken by reading them rather
 * than by running them, which is the wrong way round:
 *
 *   · `ui-hit-test.mjs` decided "is there an X server?" with
 *     `existsSync('/tmp/.X98-lock')`.  A lock file outlives the server that
 *     made it, so a stale one made the script print "using the X server
 *     already on :98" and then blame the debugger when nothing could
 *     connect.  `app-smoke/boot.sh` had already paid for that lesson and
 *     written the fix down; the other tool never got it.
 *   · the same script had no answer to a previous run's Electron still
 *     serving the CDP port — the hazard `boot.sh` calls "the most dangerous
 *     thing in this script", having once watched a deliberately broken build
 *     report 26/26 green because the app answering was four minutes old.  In
 *     this container it attached to the SMOKE run's leftover app (both use
 *     9333) and timed out "waiting for the window to render".
 *   · `react-hooks/exhaustive-deps` was `'off'` with the comment "plugin not
 *     installed".  The plugin was installed and listed.  Turning it on found
 *     24 findings: six were real and are fixed, eighteen were deliberate and
 *     now say so.
 *
 * So the two boot paths are held to the same three rules, and the rule that
 * catches stale closures is held open.
 */
export {};

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const DESKTOP = path.resolve(__dirname, '..');
const read = (p: string): string => readFileSync(path.join(DESKTOP, p), 'utf8');

const boot = read('scripts/app-smoke/boot.sh');
const hit = read('scripts/ui-hit-test.mjs');

console.log('\n=== the tools that check the app ===\n');

// ── Both ask the display, rather than asking the filesystem ──────────────
//
// Matched as CODE, not as words.  The first version of these two checks
// grepped for `xdpyinfo` and `.X11-unix` anywhere in the file, and both
// survived having the real line deleted: the comments above each fix name
// what they fix, which is how this codebase writes, so a grep for the word
// finds the explanation and calls it the implementation.  `xdpyinfo -display`
// and a removal naming both paths are things only the running code says.
const probes: Record<string, { asks: RegExp; clears: RegExp }> = {
  'boot.sh': {
    asks: /xdpyinfo -display ":\$DISP"/,
    clears: /rm -f "\/tmp\/\.X\$DISP-lock" "\/tmp\/\.X11-unix\/X\$DISP"/,
  },
  'ui-hit-test.mjs': {
    asks: /`xdpyinfo -display \$\{display\}/,
    clears: /\[`\/tmp\/\.X\$\{n\}-lock`, `\/tmp\/\.X11-unix\/X\$\{n\}`\]/,
  },
};
for (const [what, src] of [['boot.sh', boot], ['ui-hit-test.mjs', hit]] as const) {
  const { asks, clears } = probes[what]!;
  check(
    `${what} asks the X server whether it answers, with pgrep only as the fallback`,
    asks.test(src) && /pgrep -f "Xvfb/.test(src),
    `runs xdpyinfo ${asks.test(src) ? '✓' : '✗'}`
      + ` · pgrep fallback ${/pgrep -f "Xvfb/.test(src) ? '✓' : '✗'}`,
  );
  check(
    `${what} clears a stale LOCK and a stale SOCKET in one go, not one of the two`,
    clears.test(src),
    'Xvfb refuses to start while either is there',
  );
}

// ── Neither measures an app it did not launch ────────────────────────────
check(
  'boot.sh takes the CDP port before launching, and refuses if it stays busy',
  /answered BEFORE launch/.test(boot) && /refusing to measure it/.test(boot),
);
check(
  'ui-hit-test.mjs does the same, by the same two steps',
  /answered BEFORE launch/.test(hit) && /refusing to measure it/.test(hit)
    && /remote-debugging-port=\$\{port\}/.test(hit),
  'it attached to the smoke run’s leftover app before this existed',
);
check(
  'and ui-hit-test waits for the display by asking it, not by sleeping',
  /until\(`the X server on/.test(hit) && !/await sleep\(2000\);\s*\n\s*console\.log\(`Xvfb/.test(hit),
);
check(
  'a debugger timeout in ui-hit-test says what the display was doing',
  /displayIsDead\(display\)/.test(hit) && /the display is the/.test(hit),
  'the message used to send the reader to look at Electron',
);

// ── Nor a dev server older than the code it serves ───────────────────────
check(
  'boot.sh restarts a vite that started before the newest file under src/',
  /find src -type f -newermt "-\$\{VITE_AGE\} seconds"/.test(boot)
    && /kill -9 "\$VITE_PID"/.test(boot),
  'a mixed module graph gave the UI one store and the harness another:'
    + ' 25 steps failed naming the product, 69/69 on a fresh server',
);

// ── The rule that catches stale closures stays on ────────────────────────
{
  const rc = read('.eslintrc.cjs');
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const ruleLine = /'react-hooks\/exhaustive-deps':\s*'([a-z]+)'/.exec(rc);
  check(
    'react-hooks/exhaustive-deps is not off',
    ruleLine !== null && ruleLine[1] !== 'off',
    ruleLine ? `set to '${ruleLine[1]}'` : 'the rule is not configured at all',
  );
  check(
    'and lint fails on a warning, so "warn" is not a way of ignoring it',
    /--max-warnings 0/.test(pkg.scripts['lint'] ?? ''),
    pkg.scripts['lint'] ?? '(no lint script)',
  );
  check(
    'and react-hooks is in the plugin list, which is what "not installed" denied',
    /plugins:\s*\[[^\]]*'react-hooks'/.test(rc),
  );
}

// ── Nobody takes the cheap way out ───────────────────────────────────────
//
// A file-wide `eslint-disable react-hooks/exhaustive-deps` with no matching
// `enable` silences every hook in the file, including the ones written next
// year.  Eighteen findings were annotated one at a time for this reason.
{
  const hits = execFileSync('grep', [
    '-rln', '--include=*.ts', '--include=*.tsx',
    'eslint-disable react-hooks/exhaustive-deps', path.join(DESKTOP, 'src'),
  ], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const unbounded = hits.filter((f) => {
    const src = readFileSync(f, 'utf8');
    const off = (src.match(/eslint-disable react-hooks\/exhaustive-deps/g) ?? []).length;
    const on = (src.match(/eslint-enable react-hooks\/exhaustive-deps/g) ?? []).length;
    return off !== on;
  }).map((f) => path.relative(DESKTOP, f));
  check(
    'no file silences the rule for its whole length',
    unbounded.length === 0,
    unbounded.length === 0
      ? `${hits.length} bounded disable/enable pair(s)`
      : `unbounded in: ${unbounded.join(', ')}`,
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
