/**
 * engine-binary — can the packaged app actually spawn its Python engine?
 *
 * `resolvePaths()` in `src/main/ipc/audioHandlers.ts` says it plainly: a
 * PACKAGED app spawns `<resources>/bin/engine`, so that no user needs Python
 * installed.  CI builds it with PyInstaller into `apps/desktop/public/bin/`
 * before packaging, and `electron-builder.yml` ships `public/bin` → `bin`.
 *
 * `pnpm dist` does NOT build it, and nothing used to say so.  Run locally it
 * produced a 128 MB .deb and a 202 MB AppImage that install, launch, show the
 * UI — and fail on the first thing a user does, with
 * "오디오 처리 엔진이 응답하지 않습니다".  Measured on the real artifact: the
 * deb's `resources/bin/` held ffmpeg and ffprobe and nothing else, and the
 * packaged app answered `audio:analyze` with
 * `spawn .../resources/bin/engine ENOENT`.
 *
 * So this is a check, not a copy: there is nothing to copy, because building
 * it needs a Python venv and PyInstaller.  The point is to fail BEFORE
 * electron-builder spends four minutes producing something broken.
 *
 * IT CHECKS THAT THE BINARY RUNS, NOT THAT THE FILE IS THERE.  The first
 * version of this gate only called `existsSync`, and it waved through a
 * binary built with CI's exact PyInstaller command that could not start at
 * all:
 *
 *   ModuleNotFoundError: No module named 'backports'
 *   [PYI-1683:ERROR] Failed to execute script 'pyi_rth_pkgres'
 *
 * setuptools ≥ 71 vendors `jaraco.context`, which imports
 * `backports.tarfile`; PyInstaller's `pyi_rth_pkgres` runtime hook imports
 * `pkg_resources`, which pulls that chain in, and the vendored `backports`
 * namespace package is not collected.  The engine itself never imports
 * `pkg_resources` (checked: no reference anywhere under `app/`), so CI now
 * excludes it and `setuptools` outright.  Measured on the two binaries side
 * by side, with empty stdin:
 *
 *   before  exit 1, 4.05 s, traceback, no READY
 *   after   exit 0, 3.74 s, "READY" on stderr, 1.2 MB smaller
 *
 * A file that exists and a file that runs were the same thing right up to
 * the moment they were not, and the gate believed the wrong one.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** The file name the packaged main process will spawn, per platform. */
function engineBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'engine.exe' : 'engine';
}

/**
 * The handshake `app/main.py` documents: "stderr → developer logs only
 * (READY signal + structured log lines)".  So the judge reads both streams
 * and looks for that word — not for an empty stderr, which a working engine
 * never has.
 */
const ENGINE_READY = 'READY';

/** Generous: the onefile binary unpacks ~38 MB of itself on every start, and
 *  a cold CI runner is slower than the 3.7 s measured here. */
const PROBE_TIMEOUT_MS = 120_000;

/** The PyInstaller invocation CI uses, so the message can name it exactly. */
const BUILD_HINT = [
  'Build it the way CI does (.github/workflows/build.yml):',
  '',
  '  cd aimaster-desktop/services/python-audio',
  '  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt',
  '  .venv/bin/pip install "pyinstaller==6.11.1"',
  '  .venv/bin/pyinstaller --clean --noconfirm --onefile --name engine \\',
  '    --distpath ../../apps/desktop/public/bin \\',
  '    --hidden-import soundfile --hidden-import numpy \\',
  '    --collect-all soundfile --collect-all numpy \\',
  '    --exclude-module pkg_resources --exclude-module setuptools \\',
  '    app/main.py',
  '',
  'The --exclude-module line is not optional: without it the binary builds',
  'and then dies on startup with "No module named \'backports\'".  (It used',
  'to say "the last line", which is `app/main.py` — the one line nobody',
  'would drop.)',
  '',
  'That command WRITES a new engine.spec over the one in the repo (any',
  'PyInstaller run with --name does).  The committed spec is hand-written',
  'and commented; restore it afterwards rather than committing the',
  'generated one.',
  '',
  'Measured on this machine, 2026-10-19: PyInstaller 6.22.3 against the',
  'pinned requirements produced a 38 MB `engine` that reaches READY and',
  'answers `analyze` in 0.6 s.  The container loses public/bin when it is',
  'recreated, so this is the command to run before `pnpm dist` or',
  '`pnpm smoke:packaged` in a fresh one.',
].join('\n');

/** Shorten captured output for an error message. */
function tail(s, n = 400) {
  const t = String(s).trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

/**
 * Start the engine with empty stdin and see whether it reaches READY.
 *
 * Empty stdin rather than a request: the handshake is what the bridge waits
 * for, and a request would make this gate depend on the RPC surface too.
 * The engine closes on EOF, so this returns on its own.
 */
function probeEngine(full, timeoutMs = PROBE_TIMEOUT_MS) {
  const r = spawnSync(full, [], {
    input: '', timeout: timeoutMs, encoding: 'utf8', maxBuffer: 1 << 22,
  });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  // The timeout comes back as `error.code === 'ETIMEDOUT'`, NOT as a signal —
  // `signal` is set too, but the error is what `spawnSync` reports first, and
  // a check written against `signal` alone reported "could not be spawned"
  // for a binary that had spawned fine and simply never finished starting.
  // A test with a `sleep 30` stub is what found that.
  if (r.error && /** @type {{code?: string}} */ (r.error).code === 'ETIMEDOUT') {
    return { ok: false, detail: `killed after ${timeoutMs} ms without printing ${ENGINE_READY}:\n${tail(out)}` };
  }
  if (r.error) return { ok: false, detail: `could not be spawned: ${r.error.message}` };
  if (r.signal) {
    return { ok: false, detail: `killed by ${r.signal} without printing ${ENGINE_READY}` };
  }
  if (r.status !== 0) {
    return { ok: false, detail: `exited ${r.status} on startup:\n${tail(out)}` };
  }
  if (!out.includes(ENGINE_READY)) {
    return { ok: false, detail: `exited 0 but never printed ${ENGINE_READY}:\n${tail(out)}` };
  }
  return { ok: true, detail: '' };
}

/**
 * What the gate found: 'ok', 'missing', 'broken', or 'unverifiable'.
 *
 * 'unverifiable' is a cross-platform build — a win32 `engine.exe` cannot be
 * executed on this host, so its presence is all that can be checked.  That
 * is reported rather than silently treated as ok, because it is the one
 * case where this gate's guarantee is weaker than it looks.
 *
 * Pure apart from the filesystem and the injected probe, so a test can hand
 * it a temp dir and a stub verdict.
 */
// `_env` is unused on purpose: the override is a decision about what to DO
// with a status, not part of the status, so it is read by `engineMessage` and
// `engineWaived` instead.  The slot stays so these all take their arguments
// in the same order.
function engineStatus(binDir, platform = process.platform, _env = process.env, probe = probeEngine) {
  const name = engineBinaryName(platform);
  const full = path.join(binDir, name);
  if (!fs.existsSync(full)) return { state: 'missing', name, full, detail: '' };
  if (platform !== process.platform) {
    return { state: 'unverifiable', name, full, detail: `cannot run a ${platform} binary on ${process.platform}` };
  }
  const v = probe(full);
  return v.ok
    ? { state: 'ok', name, full, detail: '' }
    : { state: 'broken', name, full, detail: v.detail };
}

/**
 * Why packaging should stop given a status already taken, or null.
 *
 * Split out from `engineBlocker` so a caller that has the status in hand can
 * get the message without starting the engine a second time — four seconds
 * for an answer it already has.
 */
function engineMessage(s, env = process.env) {
  if (s.state === 'ok' || s.state === 'unverifiable') return null;
  if (env['AIMASTER_ALLOW_NO_ENGINE'] === '1') return null;

  const head = s.state === 'missing'
    ? [`✗ ${s.name}: not found at ${s.full}`]
    : [`✗ ${s.name}: present at ${s.full} but it cannot start`, '', s.detail];

  return [
    ...head,
    '',
    'A packaged build spawns this binary for every analysis and every',
    'Python-path render.  Without it the installer still builds, still',
    'launches, and fails on the first file the user opens.',
    '',
    BUILD_HINT,
    '',
    'Or set AIMASTER_ALLOW_NO_ENGINE=1 to package without it on purpose —',
    'the result cannot analyse audio.',
  ].join('\n');
}

/** Why packaging should stop, or null when it should not. */
function engineBlocker(binDir, platform = process.platform, env = process.env, probe = probeEngine) {
  return engineMessage(engineStatus(binDir, platform, env, probe), env);
}

/** True when the engine is unusable but the operator said to continue anyway. */
function engineWaived(binDir, platform = process.platform, env = process.env, probe = probeEngine) {
  const s = engineStatus(binDir, platform, env, probe);
  return (s.state === 'missing' || s.state === 'broken')
    && env['AIMASTER_ALLOW_NO_ENGINE'] === '1';
}

module.exports = {
  engineBinaryName, engineBlocker, engineWaived, engineStatus, engineMessage, probeEngine,
  ENGINE_READY, PROBE_TIMEOUT_MS,
};
