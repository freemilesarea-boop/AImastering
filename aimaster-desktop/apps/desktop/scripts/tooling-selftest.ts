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

import { execFileSync, spawnSync } from 'node:child_process';
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
const bootPkg = read('scripts/app-smoke/boot-packaged.mjs');
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
const probes: Record<string, { asks: RegExp; clears: RegExp; falls: RegExp }> = {
  'boot.sh': {
    asks: /xdpyinfo -display ":\$DISP"/,
    clears: /rm -f "\/tmp\/\.X\$DISP-lock" "\/tmp\/\.X11-unix\/X\$DISP"/,
    falls: /pgrep -f "Xvfb :\$DISP "/,
  },
  'ui-hit-test.mjs': {
    asks: /`xdpyinfo -display \$\{display\}/,
    clears: /\[`\/tmp\/\.X\$\{n\}-lock`, `\/tmp\/\.X11-unix\/X\$\{n\}`\]/,
    falls: /pgrep -f "Xvfb \$\{display\} "/,
  },
  // Added after the Node rewrite dropped the fallback and this file did not
  // notice: `xdpyinfo` is not installed on every machine, the probe therefore
  // answered "dead" for a LIVE server, and the boot deleted that server's lock
  // and socket before failing to start a second one on the same display.  The
  // check existed, for two of the three harnesses.
  'boot-packaged.mjs': {
    asks: /run\('xdpyinfo', \['-display', `:\$\{DISP\}`\]\)/,
    clears: /\[`\/tmp\/\.X\$\{DISP\}-lock`, sock\]/,
    falls: /run\('pgrep', \['-f', `Xvfb :\$\{DISP\} `\]\)/,
  },
};
for (const [what, src] of [
  ['boot.sh', boot], ['ui-hit-test.mjs', hit], ['boot-packaged.mjs', bootPkg],
] as const) {
  const { asks, clears, falls } = probes[what]!;
  check(
    `${what} asks the X server whether it answers, with pgrep only as the fallback`,
    asks.test(src) && falls.test(src),
    `runs xdpyinfo ${asks.test(src) ? '✓' : '✗'}`
      + ` · pgrep fallback ${falls.test(src) ? '✓' : '✗'}`,
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

// ── Nor a PACKAGE older than the code it was built from ──────────────────
//
// The packaged boot said it in prose — "a stale .AppImage looks exactly like
// a fresh one" — and checked nothing.  At the 2026-11-05 feature check the
// app.asar on disk was four days and one bug-fix commit older than HEAD, so
// `smoke:packaged` would have reported 21/21 for a build with none of the
// session repair in it.  Refused rather than rebuilt: `pnpm dist` is minutes,
// and a boot script that silently starts a package build is unpredictable.
check(
  'boot-packaged refuses an app.asar older than the source it should contain',
  /stat\.mtimeMs > asarAt/.test(bootPkg)
    && /run 'pnpm dist' first; 22\/22 on a stale package/.test(bootPkg),
  'it names the file that changed after packaging, and exits 1',
);

// ── And it can boot the package on the platform it was built for ─────────
//
// This is the check that would have existed two years earlier if anyone had
// asked the obvious question.  `boot-packaged.sh` was bash, Xvfb, curl, ps
// and `out/linux-unpacked/@aimasterdesktop`, so the only platform on which
// the packaged app had ever been SEEN to start was Linux; macOS and Windows
// were built, inspected as files, and shipped without ever being launched.
// Rewritten in Node, it has to actually handle all three — and a rewrite
// that quietly drops one is the same hole with a nicer file extension.
//
// Asked by RUNNING it, not by grepping it.  The first version of this check
// matched the strings `'Contents', 'MacOS'` in the file, and deleting one of
// the two places they appear — the one that builds the executable's path —
// left it green with macOS broken.  So the layout is a table the script will
// print for any platform, and this reads what the real code answers.
const layoutOf = (platform: string): { container: string; exeDir: string[]; resources: string[] } => {
  const r = spawnSync('node',
    [path.join(DESKTOP, 'scripts/app-smoke/boot-packaged.mjs'), '--print-layout', platform],
    { encoding: 'utf8' });
  return JSON.parse(r.stdout) as { container: string; exeDir: string[]; resources: string[] };
};
{
  const mac = layoutOf('darwin');
  const win = layoutOf('win32');
  const lin = layoutOf('linux');
  check(
    'boot-packaged knows where the package is on all three platforms',
    mac.container === 'bundle'
      && mac.exeDir.join('/') === 'Contents/MacOS'
      && mac.resources.join('/') === 'Contents/Resources'
      && win.container === 'win-unpacked' && win.resources.join('/') === 'resources'
      && lin.container === 'linux-unpacked' && lin.resources.join('/') === 'resources',
    `${mac.container}/${mac.exeDir.join('/')} · ${win.container} · ${lin.container}`,
  );
}
check(
  'and copies it with the tool that keeps that platform\u2019s package intact',
  /run\('ditto', \[from, dest\]\)/.test(bootPkg)
    && /run\('robocopy', \[from, dest/.test(bootPkg)
    && /run\('cp', \['-a', from, dest\]\)/.test(bootPkg),
  'ditto for the symlinks inside a .app, robocopy for long paths, cp -a for Linux',
);
check(
  'and starts an X server only where there is one to start',
  /process\.platform !== 'linux'\) return null/.test(bootPkg)
    && /xdpyinfo/.test(bootPkg),
  'Xvfb is a Linux answer to a Linux problem',
);
check(
  'boot-packaged waits for a WINDOW, not only for the CDP endpoint',
  /json\/list/.test(bootPkg) && /t\?\.type === 'page'/.test(bootPkg)
    && /const n = await pageTargets\(\);/.test(bootPkg)
    && /if \(pageAt === 0\)/.test(bootPkg)
    && /opened no window within/.test(bootPkg),
  'the browser process answers long before the first window exists — the first'
    + ' Windows run reported "main died before createWindow" for an app that'
    + ' was still starting',
);
// ── And the flow can read a path with a space in it ──────────────────────
//
// RUN, not grepped: the pattern is pulled out of the file and applied to the
// line the app really logs on macOS.  `(\S+)` passed every text check anyone
// would write for it and still read
// `/Users/runner/work/_temp/pkg-smoke/installed/LV DAW.app/.../ffmpeg` as
// `/Users/runner/work/_temp/pkg-smoke/installed/LV` — then reported that the
// PRODUCT had pointed its engine at nothing.  Every path this app ships to on
// macOS has that space in it.
{
  const flow = read('scripts/app-smoke/flow-packaged.mjs');
  const WANT = '/Users/runner/work/_temp/pkg-smoke/installed/LV DAW.app/Contents/Resources/bin/ffmpeg';
  const line = `[2026-11-09T03:04:10.123Z] [INFO] [python] [INFO] ffmpeg  binary: ${WANT}\r\n`;
  const written = /const engineFfmpeg = \/(.+?)\/\.exec\(log\);/.exec(flow)?.[1];
  let got: string | undefined;
  try { got = written === undefined ? undefined : new RegExp(written).exec(line)?.[1]; }
  catch { got = undefined; }
  check(
    'the packaged flow reads the engine\u2019s ffmpeg path up to the end of the line',
    got === WANT,
    written === undefined ? 'no pattern found in the flow' : `read back: ${String(got)}`,
  );
}

check(
  'and checks the copy finished, instead of trusting the copy tool',
  /the copy's app.asar is/.test(bootPkg) && /did not finish/.test(bootPkg),
  'robocopy reports success for "nothing was copied" as readily as for'
    + ' "everything was"; a half-copied app starts and opens nothing',
);
check(
  'and clears the CDP port before anything below it can fail',
  bootPkg.indexOf('await clearThePort();') < bootPkg.indexOf('await startDisplay(WORK);'),
  'the display step died once with the previous run\u2019s app still serving:'
    + ' the flow attached to it and scored 20/22 for a build never launched',
);

check(
  'and writes down where it put the app, rather than having the flow guess',
  /packaged\.json/.test(bootPkg) && /packaged\.json/.test(read('scripts/app-smoke/flow-packaged.mjs')),
  'the resources path differs on all three; two guesses that must agree is how one goes wrong',
);

// ── And neither flow is tied to one machine ──────────────────────────────
//
// Both app flows imported playwright by absolute path —
// `/opt/node22/lib/node_modules/playwright/index.mjs` — which is a path on
// one development container.  They could not run on a CI runner at all, and
// `require.resolve('playwright')` on that same container already answered a
// DIFFERENT path, so the import was one image update away from breaking here
// too.  It is a devDependency now.
{
  const flows = ['scripts/app-smoke/flow.mjs', 'scripts/app-smoke/flow-packaged.mjs'];
  const pkg = JSON.parse(read('package.json')) as {
    devDependencies?: Record<string, string>;
  };
  const absolute = flows.filter((f) => /from '\/[^']+'/.test(read(f)));
  check(
    'neither app flow imports anything by absolute path',
    absolute.length === 0,
    absolute.length === 0 ? flows.length + ' flow(s) clean' : absolute.join(', '),
  );
  check(
    'and the driver they do import is a declared dependency',
    typeof pkg.devDependencies?.['playwright-core'] === 'string'
      && flows.every((f) => /from 'playwright-core'/.test(read(f))),
    `playwright-core ${pkg.devDependencies?.['playwright-core'] ?? '(not declared)'}`,
  );
}

// ── Every package these harnesses import is one they are allowed to ──────
//
// Three rounds of CI were spent on this one shape.  `playwright` came from an
// absolute path on one container; `ws` was somebody else's transitive
// dependency and vanished on Node 20, where the global does not exist;
// `@electron/asar` was reachable only because electron-builder happened to
// hoist it.  A package that resolves is not the same as a package that is
// declared, and the difference only shows up on another machine.
{
  const harnesses = [
    'scripts/ui-hit-test.mjs',
    'scripts/app-smoke/flow.mjs',
    'scripts/app-smoke/flow-packaged.mjs',
  ];
  const pkg = JSON.parse(read('package.json')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  const undeclared: string[] = [];
  for (const f of harnesses) {
    const src = read(f);
    for (const m of src.matchAll(/(?:from|import\()\s*'([^']+)'/g)) {
      const spec = m[1]!;
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
      const name = spec.startsWith('@')
        ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
      if (!declared.has(name)) undeclared.push(`${f.split('/').pop()!} → ${name}`);
    }
  }
  check(
    'every package the three harnesses import is declared in package.json',
    undeclared.length === 0,
    undeclared.length === 0
      ? `${harnesses.length} harnesses, all imports declared`
      : `undeclared: ${[...new Set(undeclared)].join(', ')}`,
  );
}

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
