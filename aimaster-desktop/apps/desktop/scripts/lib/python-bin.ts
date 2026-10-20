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
