/**
 * ui-hit-test — is every control actually under the mouse?
 *
 * Layout bugs that hide a control are invisible to everything else we run.
 * Types pass, lint passes, the suite has no DOM, and — the part that matters —
 * a browser test written the ordinary way passes too, because Playwright's
 * `click()` dispatches to the ELEMENT.  A test that presses all seven buttons
 * in a lane header goes green while a user can press three.
 *
 * Two real defects were found this way and neither was findable otherwise:
 *
 *   · the chord lane header was laid out as if it had the width of the
 *     arrangement.  In a 167 px track column its `flex-1` spacer collapsed, the
 *     row asked for 270 px, and `overflow: visible` painted 파트 / 오디오에서 /
 *     8마디 / + over the lane's own chips.  Four of the seven chord-track
 *     actions could not be clicked.
 *   · `DawButton` was a `fixed` overlay above the TopBar's flex row, and a
 *     fixed overlay above a flow layout collides at some width.  It covered 42
 *     of the 66 px of the 스튜디오 chip, centre included: clicking the middle of
 *     스튜디오 opened the DAW.
 *
 * So this asks the only question that catches them: for every interactive
 * element, does `document.elementFromPoint` at its centre return that element?
 *
 * ── No new dependency ───────────────────────────────────────────────────────
 *
 * It speaks CDP directly over Node 22's built-in WebSocket and fetch.  The
 * whole sweep is `Runtime.evaluate`; nothing here needs a driver.  Playwright
 * would have meant either a 300 MB install for browsers we do not use, or
 * playwright-core as a dependency for one script.
 *
 * ── Running it ──────────────────────────────────────────────────────────────
 *
 *   pnpm --filter @aimaster/desktop ui:hit-test
 *
 * It starts the dev server and Electron itself and stops them again.  On a
 * headless Linux box it brings up Xvfb; on a Mac it uses the display you have.
 * Exit code is the number of covered controls, so it drops into CI unchanged.
 *
 * ── What it does not cover ──────────────────────────────────────────────────
 *
 * Only what is ON SCREEN.  A control scrolled below the fold is skipped, because
 * "outside the viewport" is a different question and a scrollable panel makes it
 * a non-question — an earlier version of this reported 21 such controls on HOME
 * and every one was fine.  HOME therefore probes about six: the mastering page's
 * preset cards live below the fold at this window size.  That is the honest
 * limit, not a bug to paper over — the two defects this found were both in
 * chrome that is always in view, which is where covered controls actually hurt.
 *
 * It also sweeps one window size.  A collision that only happens at 900 px wide
 * will not show up here.
 */

import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const APP = path.resolve(HERE, '..');
const CDP_PORT = Number(process.env.UI_HIT_TEST_CDP_PORT ?? 9333);
/**
 * Its own port, so a run never fights the dev server a developer already has.
 *
 * This used to have to be 5173: `main/index.ts` hardcoded that URL and read no
 * override, so a server on any other port was simply not what the window
 * loaded.  `VITE_DEV_SERVER_URL` is honoured now — loopback http only — and
 * this passes it through.
 */
const VITE_PORT = Number(process.env.UI_HIT_TEST_VITE_PORT ?? 5199);
const DISPLAY_NUM = process.env.UI_HIT_TEST_DISPLAY ?? ':98';
const KEEP = process.argv.includes('--keep');

const children = [];
function bg(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true, ...opts });
  child.unref();
  children.push(child);
  return child;
}
function stopAll() {
  for (const c of children) {
    // Detached, so the group is the thing to signal; the direct kill is the
    // fallback for a child that never became a group leader.
    try { process.kill(-c.pid, 'SIGTERM'); } catch { /* already gone */ }
    try { c.kill('SIGTERM'); } catch { /* already gone */ }
  }
  // Xvfb and vite both ignore a polite request often enough to matter, and a
  // leftover holds the display and the port against the next run.
  setTimeout(() => {
    for (const c of children) {
      try { process.kill(-c.pid, 'SIGKILL'); } catch { /* already gone */ }
      try { c.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }, 1500).unref();
}

/** Wait for a predicate, or give up with a sentence that says what was waited for. */
async function until(what, fn, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

const noProxy = { ...process.env, NO_PROXY: '*', no_proxy: '*' };
async function reachable(url) {
  try { const r = await fetch(url); return r.ok; } catch { return false; }
}

// ── CDP, by hand ──────────────────────────────────────────────────────────────

/** The page target, not the background ones — matched by its http(s) url. */
async function pageTarget() {
  // Called while polling, so "not listening yet" is an answer, not a failure.
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    return list.find((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string');
  } catch { return undefined; }
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  const open = new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP socket failed')), { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    const slot = pending.get(msg.id);
    if (slot === undefined) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(msg.error.message));
    else slot.resolve(msg.result);
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return {
    open,
    close: () => ws.close(),
    /** `Runtime.evaluate` has no execution context until the domain is on. */
    enable: () => send('Runtime.enable', {}),
    /** Run an expression in the page and hand back its value. */
    async evaluate(expression) {
      const r = await send('Runtime.evaluate', {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true, returnByValue: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description
          ?? r.exceptionDetails.text ?? 'evaluate failed');
      }
      return r.result.value;
    },
  };
}

// ── The probe ─────────────────────────────────────────────────────────────────
//
// Runs inside the page.  Returns the controls whose own centre belongs to
// somebody else, and the counts that say whether the sweep had anything to
// look at — a pass because the screen was empty is not a pass.

const PROBE = `
  const out = [];
  let probed = 0;
  const vis = (el) => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden'
      && s.opacity !== '0' && s.pointerEvents !== 'none';
  };
  const label = (el) => ((el.textContent || '').trim() || el.getAttribute('title')
    || el.getAttribute('aria-label') || el.tagName).replace(/\\s+/g, ' ').slice(0, 24);
  for (const el of document.querySelectorAll('button, select, input, [role=button]')) {
    if (!vis(el) || el.disabled) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    // Off-screen is a different defect and a scrollable panel makes it a
    // non-defect; this one is only about who owns the pixel.
    if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue;
    probed++;
    const cx = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2));
    const cy = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
    const hit = document.elementFromPoint(cx, cy);
    if (hit === el || el.contains(hit) || (hit && hit.contains(el))) continue;
    out.push({
      what: label(el),
      box: Math.round(r.left) + ',' + Math.round(r.top)
        + ' ' + Math.round(r.width) + 'x' + Math.round(r.height),
      blocker: hit ? hit.tagName + '.' + (hit.className || '').toString()
        .replace(/\\s+/g, ' ').slice(0, 44) : 'none',
    });
  }
  return { covered: out, probed };
`;

// ── Driving the app ───────────────────────────────────────────────────────────

const clickByText = (text) => `
  const b = [...document.querySelectorAll('button')]
    .find((x) => x.textContent.trim() === ${JSON.stringify(text)});
  if (b) b.click();
  return b !== undefined;
`;

const DISMISS = `
  for (const t of ['무시', '닫기', '취소']) {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === t);
    if (b) b.click();
  }
  return true;
`;

const WINDOW_MODES = ['EDIT', 'MIX', 'KEY', 'CHAIN', 'SESSION', 'STEPS', 'WARP',
  'SPECTRAL', 'VOCAL', 'STEMS', 'RESTORE', 'REFERENCE', 'AI'];
/** The views whose lane headers change once the session has content in them. */
const POPULATED = ['EDIT', 'MIX', 'SESSION', 'STEPS', 'KEY'];

/** Wait until the page stops adding controls — two equal reads in a row. */
async function settle(cdp, maxMs = 8000) {
  const count = () => cdp.evaluate(
    "return document.querySelectorAll('button, select, input, [role=button]').length;");
  const deadline = Date.now() + maxMs;
  let last = -1;
  let stable = 0;
  for (;;) {
    const now = await count();
    // Three equal reads, not two: a render stalled for one poll looks exactly
    // like a render that has finished, and calling it finished is how HOME got
    // swept with six controls on it.
    stable = now === last ? stable + 1 : 0;
    if (stable >= 2) return now;
    last = now;
    if (Date.now() > deadline) return now;
    await sleep(450);
  }
}

async function sweep(cdp) {
  const findings = [];
  let probedTotal = 0;
  /**
   * Probe, and if anything is covered, wait and probe again.
   *
   * A toast is supposed to sit over the window — the 뼈대 action raises one and
   * it covered SESSION's 타임라인에 펼치기 for as long as it was up.  That is the
   * notification working, not a layout defect.  What matters is the resting
   * state: a control still covered after the transients have gone is one a
   * user cannot reach by waiting.
   */
  const look = async (view) => {
    let { covered, probed } = await cdp.evaluate(PROBE);
    if (covered.length > 0) {
      await sleep(4000);
      ({ covered, probed } = await cdp.evaluate(PROBE));
    }
    probedTotal += probed;
    for (const c of covered) findings.push({ view, ...c });
    const mark = covered.length === 0 ? 'clean' : `${covered.length} COVERED`;
    console.log(`  ${view.padEnd(20)} ${String(probed).padStart(3)} probed   ${mark}`);
    for (const c of covered) {
      console.log(`       "${c.what}" at ${c.box}\n         under ${c.blocker}`);
    }
  };

  await cdp.evaluate(DISMISS);

  // The app reopens on whatever page it was last left on, so where the sweep
  // starts is not a given — left to itself it launched straight into the DAW
  // and swept six controls under the name HOME, never seeing the mastering
  // page at all.  That page is where the 스튜디오 / DAW overlap lived.  So go
  // there on purpose, and wait for the preset grid rather than for a delay.
  await cdp.evaluate(clickByText('\u2190 \ud648'));
  await sleep(700);
  await cdp.evaluate(DISMISS);
  await until('the mastering home to render its presets', async () => {
    try {
      return await cdp.evaluate(
        "return document.body.innerText.includes('\uc804\uccb4 \ud504\ub9ac\uc14b \ub458\ub7ec\ubcf4\uae30');");
    } catch { return false; }
  }, 20000);
  await settle(cdp);
  await look('HOME');

  await cdp.evaluate(clickByText('DAW'));
  await sleep(2500);
  await cdp.evaluate(DISMISS);
  for (const mode of WINDOW_MODES) {
    await cdp.evaluate(clickByText(mode));
    await sleep(600);
    await cdp.evaluate(DISMISS);
    await settle(cdp);
    await look(`${mode} (empty)`);
  }

  // With content.  The chord-lane defect existed only once the lane had
  // chords in it, so an empty-session sweep would have called it clean.
  await cdp.evaluate(clickByText('EDIT'));
  await sleep(500);
  for (let i = 0; i < 2; i++) {
    await cdp.evaluate(`
      const b = [...document.querySelectorAll('button')]
        .find((x) => x.textContent.includes('+ 트랙'));
      if (b) b.click();
      return true;
    `);
    await sleep(500);
  }
  await cdp.evaluate(clickByText('뼈대'));
  await sleep(700);
  await cdp.evaluate(DISMISS);

  const state = await cdp.evaluate(`
    const { useDawStore } = await import('/stores/dawStore.ts');
    const s = useDawStore.getState().session;
    return { tracks: s.tracks.length, chords: (s.chordTrack || []).length };
  `);
  console.log(`\n  session for the populated pass: ${state.tracks} tracks, ${state.chords} chords`);
  if (state.tracks < 2 || state.chords < 4) {
    throw new Error(`the populated pass had nothing to look at (${state.tracks} tracks, `
      + `${state.chords} chords) — a clean sweep of an empty screen is not a clean sweep`);
  }

  for (const mode of POPULATED) {
    await cdp.evaluate(clickByText(mode));
    await sleep(700);
    await cdp.evaluate(DISMISS);
    await settle(cdp);
    await look(`${mode} (populated)`);
  }
  return { findings, probedTotal };
}

// ── Bringing the app up and taking it down ────────────────────────────────────

function haveXvfb() {
  return spawnSync('sh', ['-c', 'command -v Xvfb'], { encoding: 'utf8' }).status === 0;
}

/**
 * Does the display ANSWER?  `existsSync` on the lock file asked the wrong
 * question: `/tmp/.X98-lock` and `/tmp/.X11-unix/X98` outlive the server that
 * made them, so a stale pair made this script report "using the X server
 * already on :98" and then blame the debugger when nothing could connect.
 *
 * Same test, same order and same reason as `app-smoke/boot.sh` — ask the
 * server with `xdpyinfo`, fall back to looking for the process only when
 * `xdpyinfo` is not installed, and only in that direction.  `boot-shares`
 * in `tooling-selftest` holds the two to each other.
 */
function displayIsDead(display) {
  const run = (cmd) => spawnSync('sh', ['-c', cmd], { encoding: 'utf8' }).status === 0;
  if (run('command -v xdpyinfo')) return !run(`xdpyinfo -display ${display} > /dev/null 2>&1`);
  return !run(`pgrep -f "Xvfb ${display} " > /dev/null 2>&1`);
}

/**
 * Take the CDP port, or refuse to measure.
 *
 * `boot.sh` learned this one at full price: launching a second Electron does
 * NOT take the port from the first.  The newcomer starts and serves nothing
 * while the tool connects to the OLD app and measures code that is no longer
 * on disk — a deliberately broken build once reported 26/26 green that way.
 * This script had none of that check, and in this container it attached to
 * the smoke run's leftover app (the two share port 9333) and timed out
 * "waiting for the window to render" on a page it never launched.
 */
async function ownCdpPort(port) {
  const url = `http://127.0.0.1:${port}/json/version`;
  if (!await reachable(url)) return;
  console.log(`CDP      :${port} answered BEFORE launch — killing the previous run's Electron`);
  // By PID from the port in its own argv; `pkill -f` would match this script.
  spawnSync('sh', ['-c',
    `ps -eo pid,args --no-headers | grep -F -- "remote-debugging-port=${port}"`
    + " | grep -v grep | awk '{print $1}' | xargs -r kill -9"], { encoding: 'utf8' });
  try {
    await until(`CDP :${port} to go quiet`, async () => !await reachable(url), 10_000);
  } catch {
    throw new Error(`something is STILL serving CDP on ${port} — refusing to measure it,`
      + ' because the app that answers would not be the one this run built');
  }
  console.log(`CDP      :${port} is clear`);
}

/** The files a dead server leaves behind, which Xvfb then refuses to start over. */
function clearStaleDisplay(display) {
  const n = display.replace(':', '');
  const leftovers = [`/tmp/.X${n}-lock`, `/tmp/.X11-unix/X${n}`].filter((f) => existsSync(f));
  if (leftovers.length === 0) return false;
  console.log(`display  ${display} had a stale lock/socket — removing`);
  for (const f of leftovers) { try { rmSync(f, { force: true }); } catch { /* not ours */ } }
  return true;
}

async function main() {
  const linux = process.platform === 'linux';
  let display = process.env.DISPLAY ?? '';

  // A Mac has a screen.  A headless Linux box needs one made for it.
  if (linux && display === '') {
    if (!haveXvfb()) {
      console.error('no DISPLAY and no Xvfb — install Xvfb or run this on a desktop session');
      process.exit(2);
    }
    display = DISPLAY_NUM;
    // A second Xvfb on a display that is already taken exits immediately and
    // says nothing, and the run then quietly borrows the first one — which is
    // fine until cleanup, where it would kill a server it did not start.  So
    // decide explicitly, and only own what this run brought up.
    if (!displayIsDead(display)) {
      console.log(`using the X server already on ${display}`);
    } else {
      clearStaleDisplay(display);
      bg('Xvfb', [display, '-screen', '0', '1600x1000x24']);
      // Ask the display whether it answers, rather than sleeping a fixed two
      // seconds and hoping.
      await until(`the X server on ${display}`,
        async () => !displayIsDead(display), 20_000);
      console.log(`Xvfb on ${display}`);
    }
  }

  await ownCdpPort(CDP_PORT);

  const env = { ...noProxy, ...(display ? { DISPLAY: display } : {}) };

  if (await reachable(`http://127.0.0.1:${VITE_PORT}/`)) {
    console.log(`using the dev server already on ${VITE_PORT}`);
  } else {
    console.log(`vite on ${VITE_PORT} …`);
    bg('pnpm', ['exec', 'vite', '--port', String(VITE_PORT), '--strictPort'], { cwd: APP, env });
    await until(`the dev server on ${VITE_PORT}`,
      () => reachable(`http://127.0.0.1:${VITE_PORT}/`));
  }

  const electronBin = path.resolve(APP, '../../node_modules/electron/dist/electron');
  if (!existsSync(electronBin) && !existsSync(`${electronBin}.exe`)) {
    console.error(`electron is not installed at ${electronBin} — run pnpm install`);
    process.exit(2);
  }
  // Root on Linux cannot use the sandbox; a normal desktop user can and should.
  const sandbox = linux && typeof process.getuid === 'function' && process.getuid() === 0
    ? ['--no-sandbox'] : [];
  console.log(`electron with CDP on ${CDP_PORT} …`);
  bg(electronBin, [...sandbox, `--remote-debugging-port=${CDP_PORT}`, '.'], {
    cwd: APP,
    env: { ...env, VITE_DEV_SERVER_URL: `http://localhost:${VITE_PORT}` },
  });
  // The debugger is the LAST thing to come up, so it is the first thing
  // blamed.  Twice in this container the real cause was the display — a
  // stale lock with no server behind it — and the message sent the reader to
  // look at Electron.  So when it times out, say what the display was doing.
  try {
    await until(`the app's debugger on ${CDP_PORT}`, async () => await pageTarget() !== undefined);
  } catch (err) {
    const where = display === '' ? 'no DISPLAY set'
      : displayIsDead(display) ? `and ${display} is not answering either — the display is the`
        + ' likelier cause (a stale /tmp/.X*-lock with no server behind it does this)'
        : `while ${display} answers, so the display is not the cause`;
    throw new Error(`${err instanceof Error ? err.message : String(err)} — ${where}`);
  }

  const target = await pageTarget();
  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.open;
  await cdp.enable();
  // The renderer is up but the document may still be loading, and React may
  // not have painted.  Both look the same from here: no buttons yet.
  await until('the window to render', async () => {
    try {
      return await cdp.evaluate("return document.querySelectorAll('button').length > 4;");
    } catch { return false; }
  });
  await sleep(1500);

  console.log('\n=== every control, is its own centre its own? ===\n');
  const { findings, probedTotal } = await sweep(cdp);
  cdp.close();

  console.log(`\n${probedTotal} controls probed across ${WINDOW_MODES.length + POPULATED.length + 1} views`);
  if (probedTotal < 200) {
    console.error(`only ${probedTotal} controls probed — the sweep did not see the app`);
    process.exit(2);
  }
  if (findings.length === 0) {
    console.log('no control is covered by anything\n');
    return 0;
  }
  console.log(`\n${findings.length} control(s) cannot be clicked where they are drawn:\n`);
  for (const f of findings) console.log(`  ${f.view}: "${f.what}" at ${f.box} under ${f.blocker}`);
  console.log('');
  return findings.length;
}

let code = 2;
try {
  code = await main();
} catch (err) {
  console.error(`\nui-hit-test failed: ${err instanceof Error ? err.message : String(err)}`);
  code = 2;
} finally {
  if (!KEEP) stopAll();
  else console.log('--keep: the app and dev server are still running');
}
process.exit(code);
