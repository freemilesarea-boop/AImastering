/**
 * engine-binary — is the PyInstaller `engine` binary where packaging needs it?
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
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** The file name the packaged main process will spawn, per platform. */
function engineBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'engine.exe' : 'engine';
}

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
  '    app/main.py',
].join('\n');

/**
 * Why packaging should stop, or null when it should not.
 *
 * Pure: takes the directory and platform rather than reading the world, so a
 * test can hand it a temp dir with and without the file.
 */
function engineBlocker(binDir, platform = process.platform, env = process.env) {
  const name = engineBinaryName(platform);
  const full = path.join(binDir, name);
  if (fs.existsSync(full)) return null;
  if (env['AIMASTER_ALLOW_NO_ENGINE'] === '1') return null;
  return [
    `✗ ${name}: not found at ${full}`,
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

/** True when the engine is absent but the operator said to continue anyway. */
function engineWaived(binDir, platform = process.platform, env = process.env) {
  return !fs.existsSync(path.join(binDir, engineBinaryName(platform)))
    && env['AIMASTER_ALLOW_NO_ENGINE'] === '1';
}

module.exports = { engineBinaryName, engineBlocker, engineWaived };
