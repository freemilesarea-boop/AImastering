// python-bin — the interpreter that has the engine's dependencies.
//
// Three selftests spawned a bare `python3`, which is the interpreter on PATH
// and not necessarily the one the engine's requirements were installed into.
// On this machine they are the same, so it passed for as long as the suite
// only ever ran here.  The first CI run said otherwise: build.yml installs
// into `services/python-audio/.venv`, the selftest asked `python3`, and step
// 141 of 223 failed with
//
//     [FAIL] the Python engine’s test dependencies are installed — missing
//            (ModuleNotFoundError: No module named 'pytest')
//
// after 140 steps had passed.  The app's own bridge already had the answer —
// `process.env['AIMASTER_PYTHON'] ?? 'python3'` — so this follows it and adds
// the venv, which is where a project that has one keeps its dependencies.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

/** services/python-audio, from apps/desktop/scripts/lib. */
const SERVICE = path.resolve(__dirname, '..', '..', '..', '..', 'services', 'python-audio');

/**
 * In order: an explicit `AIMASTER_PYTHON` (what the app honours), the
 * service's venv, then PATH.  Returns a path or the bare name — both are
 * things `spawnSync` accepts.
 */
export function pythonBin(): string {
  const explicit = process.env['AIMASTER_PYTHON'];
  if (explicit !== undefined && explicit !== '') return explicit;

  const venv = process.platform === 'win32'
    ? path.join(SERVICE, '.venv', 'Scripts', 'python.exe')
    : path.join(SERVICE, '.venv', 'bin', 'python3');
  try {
    if (fs.statSync(venv).isFile()) return venv;
  } catch { /* no venv — fall through to PATH */ }

  return 'python3';
}

/** Where `pythonBin()` came from, for a failure message that can be acted on. */
export function pythonBinSource(): 'AIMASTER_PYTHON' | 'venv' | 'PATH' {
  const explicit = process.env['AIMASTER_PYTHON'];
  if (explicit !== undefined && explicit !== '') return 'AIMASTER_PYTHON';
  return pythonBin() === 'python3' ? 'PATH' : 'venv';
}

/**
 * Point the engine at the ffmpeg pair this repository SHIPS.
 *
 * A selftest that spawns the engine has to answer the same question
 * `boot.sh` answers for the smoke runs and `applyBundledFfmpegEnv()` answers
 * for the packaged app: which ffmpeg, which ffprobe.  `python-rpc-selftest`
 * did not, and on a runner with neither on PATH the engine replied
 * "'ffprobe'을 찾을 수 없습니다" to four checks — step 142 of 223, after the
 * python gate at 141 had just been fixed to stop asking PATH the same way.
 *
 * `ffmpeg-static` and `@ffprobe-installer` are what boot.sh uses, so they are
 * what this uses; `public/bin` is the fallback for a checkout where
 * `prebuild.cjs` has run.  Sets nothing it cannot resolve — an unset variable
 * leaves the engine's own resolution alone, which is the right outcome on a
 * machine that has ffmpeg on PATH.
 */
export function applyShippedFfmpegEnv(): { ffmpeg: string | null; ffprobe: string | null } {
  const req = createRequire(__filename);
  const resolved: { ffmpeg: string | null; ffprobe: string | null } = { ffmpeg: null, ffprobe: null };

  const pick = (candidates: (() => string | null)[]): string | null => {
    for (const candidate of candidates) {
      let value: string | null = null;
      try { value = candidate(); } catch { value = null; }
      if (value === null) continue;
      try { if (fs.statSync(value).isFile()) return value; } catch { /* next */ }
    }
    return null;
  };

  resolved.ffmpeg = pick([
    () => process.env['AIMASTER_FFMPEG'] ?? null,
    () => req('ffmpeg-static') as string,
    () => path.join(__dirname, '..', '..', 'public', 'bin', 'ffmpeg'),
  ]);
  resolved.ffprobe = pick([
    () => process.env['AIMASTER_FFPROBE'] ?? null,
    () => (req('@ffprobe-installer/ffprobe') as { path: string }).path,
    () => path.join(__dirname, '..', '..', 'public', 'bin', 'ffprobe'),
  ]);

  if (resolved.ffmpeg !== null) process.env['AIMASTER_FFMPEG'] = resolved.ffmpeg;
  if (resolved.ffprobe !== null) process.env['AIMASTER_FFPROBE'] = resolved.ffprobe;
  return resolved;
}
