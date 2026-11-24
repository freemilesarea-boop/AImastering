#!/usr/bin/env node
/**
 * boot-packaged.mjs — boot the PACKAGED app, on any of the three platforms.
 *
 *   node scripts/app-smoke/boot-packaged.mjs <workdir> [cdp-port] [display]
 *
 * This replaces `boot-packaged.sh`, which could only ever run on Linux: bash,
 * Xvfb, curl, ps, and `out/linux-unpacked/@aimasterdesktop` are all in it by
 * name.  That is why, until now, the only platform on which anyone had ever
 * SEEN the packaged app start was Linux — macOS and Windows were built,
 * inspected as files, and shipped unlaunched.
 *
 * Everything the shell version guarded against is guarded here, because each
 * guard was paid for:
 *
 *   • A PACKAGE OLDER THAN THE SOURCE is refused.  A stale app.asar looks
 *     exactly like a fresh one, and 22/22 against code that is not in it is
 *     worse than no run at all.
 *   • THE APP IS COPIED OUT OF THE WORKSPACE first.  `wasmNodeCandidates()`
 *     walks UP from the main bundle before trying `process.resourcesPath`, so
 *     a package launched in place finds the DEV copy of the WASM and the
 *     shipped one is never touched.  The copy's ancestors are then checked,
 *     rather than assumed.
 *   • ANYTHING ALREADY SERVING CDP ON THIS PORT is killed before we measure.
 *     A previous run's app keeps the port, the newcomer serves nothing, and
 *     the flow silently measures the older build.
 *
 * What is deliberately NOT here: a fallback that packages the app when it is
 * missing.  `pnpm dist` is minutes long, and a boot script that silently
 * starts a build is one nobody can predict.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..', '..');

/**
 * Where a packaged app keeps its executable and its resources, per platform.
 *
 * A TABLE, and reachable from outside (`--print-layout <platform>`), because
 * the first version of this knowledge was three `if` arms and the check that
 * was supposed to hold them was a grep for the strings in them: deleting one
 * of the two places 'Contents/MacOS' appears left the grep green and the
 * macOS path broken.  A test that cannot fail is worse than no test.
 */
function layoutFor(platform) {
  if (platform === 'darwin') {
    return { container: 'bundle', exeDir: ['Contents', 'MacOS'], resources: ['Contents', 'Resources'] };
  }
  if (platform === 'win32') {
    return { container: 'win-unpacked', exeDir: [], resources: ['resources'] };
  }
  return { container: 'linux-unpacked', exeDir: [], resources: ['resources'] };
}

/**
 * The switches the app is launched with, per platform.
 *
 * `--no-sandbox` on Linux is the usual container answer.  The three GPU
 * switches on Windows are NOT: they are here because of what the first
 * Windows run of this harness found, and they cost real coverage, so they are
 * written down rather than sprinkled in.
 *
 * On windows-latest the app started, loaded its renderer out of the asar and
 * resolved its bundled ffmpeg — and then Chromium's GPU process died with
 * exit code -1073741819 (0xC0000005, an access violation), which took the
 * renderer with it.  A GitHub Windows runner has no real GPU and no ordinary
 * desktop session; a Windows machine someone actually uses has both.  So the
 * app is run with GPU acceleration OFF there, and the limit is stated out
 * loud: on Windows this harness does not exercise GPU-accelerated rendering.
 * Everything else — the asar, the resources, the engine, the WASM, the
 * render path — it does.
 *
 * `--disable-software-rasterizer` is NOT in that list, and the first attempt
 * had it.  The GPU crash went away and the RENDERER then died with the same
 * access violation two seconds after load — which is what those two switches
 * together ask for: `--disable-gpu` sends rasterization to SwiftShader, and
 * `--disable-software-rasterizer` takes SwiftShader away.  That pair leaves
 * nothing to rasterize with.  The second switch exists to stop a silent
 * fallback on a machine that HAS a GPU; here it removed the only path left.
 *
 * Not applied anywhere else: Linux and macOS pass with the GPU on, and
 * turning it off for them would quietly shrink what they cover.
 *
 * `--enable-logging --v=1` is diagnostic only: it makes Chromium write its
 * own account into the app's log, so the next failure on a machine nobody
 * here can open says more than an exit code.
 */
function launchArgs(platform, port) {
  const args = [`--remote-debugging-port=${port}`];
  if (platform === 'linux') args.unshift('--no-sandbox');
  if (platform === 'win32') {
    args.push('--disable-gpu', '--disable-gpu-sandbox', '--enable-logging', '--v=1');
  }
  return args;
}

if (process.argv[2] === '--print-layout') {
  console.log(JSON.stringify(layoutFor(process.argv[3] ?? process.platform)));
  process.exit(0);
}

if (process.argv[2] === '--print-args') {
  console.log(JSON.stringify(launchArgs(process.argv[3] ?? process.platform, 9444)));
  process.exit(0);
}

const argv = process.argv.slice(2).filter((a) => a !== '--blank');
/**
 * `--blank`: load NOTHING into the window and watch it.
 *
 * One question, and it halves the problem.  The Windows renderer dies 1.6 s
 * after loading the app with an access violation and no JavaScript error, and
 * two very different things look exactly like that: Chromium cannot keep a
 * renderer alive on that machine at all, or something our bundle does on the
 * way up kills it.
 *
 * The window the app just opened is the only renderer anyone can get here —
 * Electron has no "new tab", and asking its debugger endpoint for one answers
 * 500 — so the split has to be made in the moment that window is alive: go
 * straight to `about:blank`, which throws away every line of our own code
 * while keeping the same process, the same switches and the same machine.
 *
 * It reports and exits 0 either way.  A run that cannot answer the question
 * is not a build failure.
 */
const BLANK = process.argv.includes('--blank');
const WORK = argv[0];
const PORT = argv[1] ?? '9444';
const DISP = argv[2] ?? '97';
if (!WORK) {
  console.error('usage: boot-packaged.mjs <workdir> [cdp-port] [display]');
  process.exit(2);
}

const die = (msg, extra = '') => {
  console.error(msg);
  if (extra) console.error(extra);
  process.exit(1);
};
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The last lines of the app's own log — the only place that says why. */
function logTail(lines = 25) {
  try {
    return fs.readFileSync(path.join(WORK, 'electron.log'), 'utf8')
      .split(/\r?\n/).slice(-lines).join('\n');
  } catch { return '(no electron.log)'; }
}

/**
 * A raw CDP socket to one target.
 *
 * Playwright will not touch a page it has seen crash — `page.goto()` answers
 * "Page crashed" and stops there — and the crashed window is exactly the one
 * worth navigating: telling a dead target to load `about:blank` is what makes
 * Chromium give it a fresh renderer.  So that one navigation is done by hand.
 */
async function rawTarget() {
  const WS = globalThis.WebSocket ?? (await import('ws')).WebSocket;
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const target = (Array.isArray(list) ? list : [])
    .find((t) => t?.type === 'page' && !String(t?.url ?? '').startsWith('devtools://'));
  if (!target?.webSocketDebuggerUrl) throw new Error('no page target to talk to');
  const ws = new WS(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP socket failed')), { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(msg.error.message)); else slot.resolve(msg.result);
  });
  // Every call has a deadline.  A crashed target accepts `Page.navigate` and
  // then never answers it, and a probe that hangs there is worse than one
  // that says it could not tell: the job sits for its whole timeout and the
  // log ends mid-sentence, which is what the first run of this did.
  const send = (method, params = {}, ms = 8000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} did not answer in ${ms} ms`));
    }, ms);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    try { ws.send(JSON.stringify({ id, method, params })); }
    catch (err) { clearTimeout(timer); pending.delete(id); reject(err); }
  });
  return {
    send,
    close: () => { try { ws.close(); } catch { /* already gone */ } },
    async answers() {
      try {
          const r = await send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, 4000);
        return r?.result?.value === 2;
      } catch { return false; }
    },
  };
}

/** How many real pages the app has open; 0 while it is still starting. */
async function pageTargets() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return 0;
    const targets = await r.json();
    if (!Array.isArray(targets)) return 0;
    return targets.filter((t) => t?.type === 'page' && !String(t?.url ?? '').startsWith('devtools://')).length;
  } catch { return 0; }
}

// ── Where the package is, per platform ────────────────────────────────────────
//
// Found rather than named.  The executable is called after `productName`, so
// every rename would silently break a hardcoded path — and this is a gate, so
// it must fail loudly instead.

/** Files directly inside `dir`, with their full paths. */
const filesIn = (dir) => {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isFile()).map((e) => path.join(dir, e.name));
};

const HELPERS = [
  'chrome_crashpad_handler', 'chrome-sandbox', 'crashpad_handler',
  'squirrel', 'elevate', 'notification_helper',
];
const isHelper = (file) => {
  const base = path.basename(file, path.extname(file)).toLowerCase();
  return HELPERS.includes(base);
};

/** The one executable in a package directory that is the app itself. */
function mainExecutable(dir, { windows = false } = {}) {
  const candidates = filesIn(dir).filter((f) => {
    if (isHelper(f)) return false;
    if (windows) return path.extname(f).toLowerCase() === '.exe';
    if (/\.(so|so\.\d+|dll|dylib|bin|pak|dat|json|html|txt|md|icns|png)$/i.test(f)) return false;
    try { fs.accessSync(f, fs.constants.X_OK); } catch { return false; }
    return true;
  });
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return null;
  // More than one: prefer the one named after the product, then the largest.
  const product = productName();
  const named = candidates.find((f) => path.basename(f, path.extname(f)) === product);
  if (named) return named;
  return candidates.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
}

/** `productName` from electron-builder.yml — the name every artefact takes. */
function productName() {
  try {
    const yml = fs.readFileSync(path.join(DESKTOP, 'electron-builder.yml'), 'utf8');
    return /^productName:\s*(.+?)\s*$/m.exec(yml)?.[1]?.replace(/^["']|["']$/g, '') ?? '';
  } catch { return ''; }
}

/** The .app bundles under out/, which electron-builder names by arch. */
function appBundles(out) {
  const found = [];
  for (const entry of fs.readdirSync(out, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(out, entry.name);
    if (entry.name.endsWith('.app')) { found.push(dir); continue; }
    for (const inner of fs.readdirSync(dir, { withFileTypes: true })) {
      if (inner.isDirectory() && inner.name.endsWith('.app')) found.push(path.join(dir, inner.name));
    }
  }
  return found;
}

/**
 * The packaged app for this platform: what to copy, what to launch inside the
 * copy, and where its resources are.
 */
function locate() {
  const out = path.join(DESKTOP, 'out');
  if (!fs.existsSync(out)) die(`no out/ at ${out} — run 'pnpm dist' first`);
  const layout = layoutFor(process.platform);

  let root;
  if (layout.container === 'bundle') {
    const apps = appBundles(out);
    if (apps.length === 0) die(`no .app under ${out} — run 'pnpm dist' first`);
    // One arch is built per job; if a tree has both, the newest is this run's.
    root = apps.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  } else {
    root = path.join(out, layout.container);
    if (!fs.existsSync(root)) {
      die(`no ${layout.container} at ${root} — run 'pnpm dist' first`);
    }
  }

  const exeDir = path.join(root, ...layout.exeDir);
  const exe = mainExecutable(exeDir, { windows: process.platform === 'win32' });
  if (!exe) die(`no executable in ${exeDir}`);
  return {
    copy: root,
    copiedName: path.basename(root),
    exeIn: (copied) => path.join(copied, ...layout.exeDir, path.basename(exe)),
    resourcesIn: (copied) => path.join(copied, ...layout.resources),
  };
}

// ── Is the package newer than the code it claims to be? ───────────────────────

function refuseIfStale(asar) {
  const asarAt = fs.statSync(asar).mtimeMs;
  const roots = ['src', 'electron', 'esbuild.main.cjs', 'package.json']
    .map((p) => path.join(DESKTOP, p))
    .filter((p) => fs.existsSync(p));
  const stack = [...roots];
  while (stack.length > 0) {
    const at = stack.pop();
    const stat = fs.statSync(at);
    if (stat.isDirectory()) {
      if (path.basename(at) === 'node_modules') continue;
      for (const e of fs.readdirSync(at)) stack.push(path.join(at, e));
      continue;
    }
    if (stat.mtimeMs > asarAt) {
      die(`app.asar is OLDER than the source — ${path.relative(DESKTOP, at)} changed after it was packaged`,
        "         run 'pnpm dist' first; 22/22 on a stale package means nothing");
    }
  }
  const when = new Date(asarAt).toISOString().slice(0, 16).replace('T', ' ');
  console.log(`package  app.asar is newer than src/ (${when})`);
}

// ── Copying it somewhere a user's install would be ────────────────────────────

function copyOut(from, intoDir, name) {
  fs.rmSync(intoDir, { recursive: true, force: true });
  fs.mkdirSync(intoDir, { recursive: true });
  const dest = path.join(intoDir, name);
  if (process.platform === 'win32') {
    // robocopy, not fs.cp: it is the one copy on Windows that handles long
    // paths and junctions without surprises.  Exit codes below 8 are success.
    const r = run('robocopy', [from, dest, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'],
      { shell: false });
    if ((r.status ?? 8) >= 8) die(`robocopy failed (${r.status})`, r.stderr ?? '');
  } else if (process.platform === 'darwin') {
    // ditto, not cp: a .app is full of symlinks inside Frameworks, and a copy
    // that dereferences them is not the app that was built.
    const r = run('ditto', [from, dest]);
    if (r.status !== 0) die('ditto failed', r.stderr ?? '');
  } else {
    const r = run('cp', ['-a', from, dest]);
    if (r.status !== 0) die('cp -a failed', r.stderr ?? '');
  }
  return dest;
}

/** Prove the copy has no workspace above it, rather than assuming it. */
function refuseIfShadowed(mainDir) {
  let at = mainDir;
  for (;;) {
    if (fs.existsSync(path.join(at, 'packages', 'dsp-wasm', 'pkg-node', 'loui_dsp_wasm.cjs'))) {
      die(`✗ ${mainDir} has a workspace above it — the packaged WASM copy would be shadowed.`,
        '  Pick a workdir outside the repo.');
    }
    const up = path.dirname(at);
    if (up === at) return;
    at = up;
  }
}

// ── The display, on the one platform that needs one ───────────────────────────

async function startDisplay(work) {
  if (process.platform !== 'linux') return null;
  const sock = `/tmp/.X11-unix/X${DISP}`;
  // `xdpyinfo -display` is the real question — does this display ANSWER — and
  // a socket file satisfies a plain existence check with no server behind it.
  // But xdpyinfo is not installed everywhere, and where it is missing a check
  // that always says "dead" is worse than no check: this script deleted a LIVE
  // server's lock and socket, then failed to start a second Xvfb on the
  // display the first one was still holding.  So the process is the fallback,
  // and only in that direction — the same two-step `boot.sh` has carried for
  // exactly this reason.
  const alive = () => {
    const asked = run('xdpyinfo', ['-display', `:${DISP}`]);
    if (asked.error === undefined && asked.status !== null) return asked.status === 0;
    const ps = run('pgrep', ['-f', `Xvfb :${DISP} `]);
    return ps.status === 0;
  };
  if (fs.existsSync(sock) && alive()) {
    console.log(`display  :${DISP} (reusing the one already running)`);
    return `:${DISP}`;
  }
  // A socket or lock with no server behind it is what Xvfb refuses to start
  // over, and what a plain existence check reads as success.
  for (const stale of [`/tmp/.X${DISP}-lock`, sock]) fs.rmSync(stale, { force: true });
  const log = fs.openSync(path.join(work, 'xvfb.log'), 'w');
  const xvfb = spawn('Xvfb', [`:${DISP}`, '-screen', '0', '1600x1000x24'],
    { stdio: ['ignore', log, log], detached: true });
  xvfb.unref();
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    if (fs.existsSync(sock) && alive()) break;
    await sleep(300);
  }
  if (!fs.existsSync(sock)) die(`X${DISP} socket missing after 15s`);
  console.log(`display  :${DISP}`);
  return `:${DISP}`;
}

// ── The port ──────────────────────────────────────────────────────────────────

async function cdpAnswers(ms = 2000) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, {
      signal: AbortSignal.timeout(ms),
    });
    return r.ok;
  } catch { return false; }
}

function killWhoeverHoldsThePort() {
  const flag = `remote-debugging-port=${PORT}`;
  if (process.platform === 'win32') {
    run('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${flag}*' }`
      + ' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }']);
    return;
  }
  const ps = run('ps', ['-eo', 'pid,args']);
  for (const line of (ps.stdout ?? '').split('\n')) {
    if (!line.includes(flag)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
}

async function clearThePort() {
  if (!await cdpAnswers()) return;
  console.log(`CDP      :${PORT} answered BEFORE launch — killing the previous run's app`);
  killWhoeverHoldsThePort();
  for (let i = 0; i < 20; i++) {
    if (!await cdpAnswers(1000)) { console.log(`CDP      :${PORT} is clear`); return; }
    await sleep(500);
  }
  die(`something is STILL serving CDP on ${PORT} — refusing to measure it`);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

const where = locate();
fs.mkdirSync(WORK, { recursive: true });

const asar = path.join(where.resourcesIn(where.copy), 'app.asar');
if (!fs.existsSync(asar)) die(`no app.asar at ${asar} — run 'pnpm dist' first`);
refuseIfStale(asar);

const installed = path.join(WORK, 'installed');
const copied = copyOut(where.copy, installed, where.copiedName);
const APP = where.exeIn(copied);
const RESOURCES = where.resourcesIn(copied);
if (!fs.existsSync(APP)) die(`the copy has no executable at ${APP}`);
// The copy is CHECKED, not assumed.  `robocopy` reports success for "nothing
// was copied" (exit 0) as readily as for "everything was" (exit 1), so a copy
// that half-happened would hand the launcher an app whose asar is missing or
// truncated — which starts, fails to find its main script, and looks exactly
// like a product that cannot open a window.
{
  const copiedAsar = path.join(RESOURCES, 'app.asar');
  if (!fs.existsSync(copiedAsar)) die(`the copy has no app.asar at ${copiedAsar}`);
  const was = fs.statSync(asar).size;
  const now = fs.statSync(copiedAsar).size;
  if (was !== now) die(`the copy's app.asar is ${now} bytes, the original is ${was} — the copy did not finish`);
}
refuseIfShadowed(path.join(RESOURCES, 'app.asar', 'dist-electron', 'main'));
console.log(`install  ${APP}  (no workspace above it)`);

// The port is cleared FIRST, before anything below can fail.  It used to be
// cleared after the display came up, and when the display step died the
// previous run's app was still serving CDP: the flow attached to it and
// reported 20/22 for a build that had never been launched.  A boot that stops
// must leave nothing behind for the next step to mistake for its own work.
await clearThePort();
const display = await startDisplay(WORK);

// No AIMASTER_FFMPEG/AIMASTER_FFPROBE, unlike the dev boot: a packaged app
// resolves both from <resources>/bin itself, and supplying them would hide it
// if that ever stopped working.
const env = { ...process.env };
if (display) env.DISPLAY = display;
const logPath = path.join(WORK, 'electron.log');
const log = fs.openSync(logPath, 'w');
const args = launchArgs(process.platform, PORT);
if (args.includes('--disable-gpu')) {
  console.log('gpu      OFF — this runner\u2019s GPU process crashes; GPU rendering is not covered here');
}
const app = spawn(APP, args, { env, stdio: ['ignore', log, log], detached: true });
app.unref();
console.log(`pid      ${app.pid}`);

let up = false;
for (let i = 0; i < 90; i++) {
  if (await cdpAnswers(2000)) { up = true; break; }
  await sleep(1000);
}
if (!up) {
  die(`CDP down after 90s — see ${logPath}`, logTail());
}
console.log(`packaged CDP on ${PORT}`);

// And then for a WINDOW.
//
// `/json/version` is answered by the browser process, which is up long before
// the first window exists — so waiting only for it hands the flow a CDP
// endpoint with no page in it, and the flow reports "main died before
// createWindow" for an app that was merely still starting.  That is what the
// first Windows run of this script said, and it was the harness talking.
//
// Waited for HERE rather than in the flow because this is where the app's log
// is: if no window ever appears, the reason is in that log, and a failure
// that prints the reason is worth more than one that names a file.
let pageAt = 0;
for (let i = 0; i < 60; i++) {
  const n = await pageTargets();
  if (n > 0) { pageAt = n; break; }
  await sleep(1000);
}
if (pageAt === 0) {
  die(`the app answered CDP but opened no window within 60s — see ${logPath}`, logTail());
}
console.log(`window   ${pageAt} page target(s)`);

if (BLANK) {
  const WATCH = 8;
  const SECONDS = 10;
  const say = (line) => console.log(`  ${line}`);
  const answers = async (pg) => {
    try { return (await pg.evaluate(() => 1 + 1)) === 2; } catch { return false; }
  };
  let verdict = 'unknown';
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const pages = browser.contexts()[0]?.pages() ?? [];
    const win = pages.find((p) => !p.url().startsWith('devtools://')) ?? pages[0] ?? null;
    if (!win) {
      say('the window went away before anything could look at it');
      verdict = 'unknown — no page to watch';
    } else {
      // FIRST the real thing, because a verdict about our bundle is worth
      // nothing on a machine where our bundle did not die.  The app gets the
      // same look the smoke would give it.
      say(`watching the app's own page for up to ${WATCH}s`);
      let died = 0;
      for (let i = 1; i <= WATCH; i++) {
        await sleep(1000);
        if (!await answers(win)) { died = i; break; }
      }
      if (died === 0) {
        say(`the app's page answered every second for ${WATCH}s`);
        verdict = 'nothing to split — the app\u2019s renderer does not die on this machine';
      } else {
        say(`the app's page stopped answering after ${died}s — now emptying the window`);
        // By hand, over a raw socket: Playwright has written this page off.
        const raw = await rawTarget();
        await raw.send('Page.enable').catch(() => {});
        // Not awaited for an answer: a crashed target takes the navigation
        // and never replies to it, but it DOES act on it.
        raw.send('Page.navigate', { url: 'about:blank' }).catch(() => {});
        await sleep(3000);
        if (!await raw.answers()) {
          say('the emptied window would not answer at all');
          verdict = 'chromium — this machine could not give the app a working renderer even with nothing in it';
        } else {
          say(`emptied; watching it for ${SECONDS}s with none of our code in it`);
          let alive = 0;
          for (let i = 1; i <= SECONDS; i++) {
            await sleep(1000);
            if (!await raw.answers()) {
              say(`the BLANK window stopped answering after ${i}s too`);
              verdict = 'chromium — a page with none of our code in it dies here as well';
              break;
            }
            alive = i;
          }
          if (verdict === 'unknown') {
            say(`the blank window answered every second for ${alive}s`);
            verdict = 'our bundle — the same process keeps an empty renderer alive, and only ours dies';
          }
        }
        raw.close();
      }
    }
  } catch (err) {
    say(`the probe could not finish: ${String(err?.message ?? err)}`);
    verdict = `unknown — ${String(err?.message ?? err)}`;
  }
  console.log(`  VERDICT  ${verdict}`);
  console.log(logTail(12));
  process.exit(0);
}

// ── And it is still there a moment later ────────────────────────────────────
//
// A window that appears and then dies is not a window, and until this existed
// the harness could not tell the two apart: the boot saw one page target, the
// flow connected a second later, found none, and said "main died before
// createWindow" — which was wrong twice over.  On the Windows runner the page
// appeared at +1.0s and the renderer died at +1.9s, in the gap between the
// two processes, with nobody listening to what it said on the way out.
//
// So the renderer is watched here, from before it can die, and whatever it
// says is printed.  An access violation says nothing — but a thrown error, a
// failed import or a console error does, and those were being thrown away.
const SETTLE_MS = 4000;
{
  const said = [];
  let watched = null;
  let watchedPage = null;
  try {
    watched = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const pages = watched.contexts()[0]?.pages() ?? [];
    watchedPage = pages.find((p) => !p.url().startsWith('devtools://')) ?? pages[0] ?? null;
    if (watchedPage) {
      // EVERY line, not only the errors.
      //
      // The Windows renderer dies 1.6 s after load with an access violation
      // and no JavaScript error at all, so the error channel is empty and
      // says nothing.  What it does leave is the ordinary log the app writes
      // on its way up, and the LAST of those lines is the closest thing to a
      // pointer at what it was doing when the process went away.
      watchedPage.on('pageerror', (e) => said.push(`pageerror: ${String(e?.message ?? e)}`));
      watchedPage.on('console', (m) => said.push(`${m.type()}: ${m.text()}`.slice(0, 200)));
      watchedPage.on('crash', () => said.push('--- the page crashed here ---'));
    }
  } catch (err) {
    said.push(`could not watch the page: ${String(err?.message ?? err)}`);
  }
  await sleep(SETTLE_MS);

  // ASKED, not counted.  The first version of this check called
  // `pageTargets()` again and passed — because `/json/list` goes on listing
  // the target of a renderer that has already crashed.  On the Windows runner
  // the renderer died at +1.6s, the count still said 1 at +4s, and the harness
  // went on to repeat its old wrong sentence.  The only question that cannot
  // be answered by a dead page is one the page has to run.
  let alive = false;
  if (watchedPage) {
    try { alive = (await watchedPage.evaluate(() => 1)) === 1; } catch { alive = false; }
  } else {
    alive = (await pageTargets()) > 0;
  }
  if (!alive) {
    const log = logTail();
    // The tail, because the last thing it said is the interesting end.
    const lastWords = said.slice(-20);
    const crashed = /render-process-gone/.test(log);
    die(crashed
      ? `the app opened a window and its RENDERER crashed within ${SETTLE_MS} ms — see ${logPath}`
      : `the app opened a window and lost it within ${SETTLE_MS} ms — see ${logPath}`,
    `${lastWords.length > 0
        ? `the renderer's last ${lastWords.length} line(s), oldest first:\n  ${lastWords.join('\n  ')}\n\n`
        : 'the renderer said nothing at all on the way out\n\n'}`
      + log);
  }
  if (said.length > 0) {
    console.log(`window   the renderer logged ${said.length} line(s) while settling, last 5:`);
    for (const line of said.slice(-5)) console.log(`         ${line}`);
  }
  // NOT closed.  `browser.close()` over a CDP connection closes the APP, and
  // the flow is about to attach to it — closing here would leave the flow
  // with the same "no page" it was sent to explain.  The socket is dropped by
  // this process exiting instead, which Chromium survives.
  void watched;
}

// What the flow needs to know, written down rather than recomputed from a
// platform-shaped guess on the other side.
fs.writeFileSync(path.join(WORK, 'packaged.json'), `${JSON.stringify({
  platform: process.platform,
  arch: os.arch(),
  app: APP,
  resources: RESOURCES,
  port: Number(PORT),
  pid: app.pid,
}, null, 2)}\n`);

// Written synchronously above, so there is nothing in flight.  The exit is
// explicit because the CDP socket opened to watch the renderer would
// otherwise keep this process alive, and closing it the polite way closes the
// app with it.
process.exit(0);
