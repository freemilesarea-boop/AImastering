// Finding a workspace file from code whose directory moves.
//
// The main process runs from two different depths: `src/main/...` under tsx
// (selftests, the parity harness) and `dist-electron/main` once esbuild has
// bundled it (dev and packaged alike).  Code that reaches a workspace file
// by counting `..` segments is therefore right in one of them and wrong in
// the other, and the wrong one is usually the app:
//
//   `../../../../../packages/dsp-wasm/pkg-node` was correct from
//   `src/main/offline`, where every selftest runs, and one level too high
//   from `dist-electron/main`, where the app runs.  So the offline render
//   engine was never found by the app, every Studio render fell back to an
//   engine that cannot read a chain config, and the master came out as the
//   original — while the tests stayed green.
//
// Walking up cannot be wrong at one depth and right at another, which is
// why every such path goes through here now.

import path from 'node:path';
import fs from 'node:fs';

/**
 * The dev-mode Python entry point, relative to the workspace root.
 *
 * Here rather than in the IPC handler that uses it so a test can check the
 * path without importing a module that pulls in `electron`.
 */
export const PYTHON_ENTRY_REL = 'services/python-audio/app/main.py';

/**
 * `relative` joined onto `fromDir` and each of its ancestors, nearest
 * first.
 *
 * Pure, and takes its starting directory as an argument, so a test can ask
 * about a directory it is not running in — which is the only way to check
 * the one that matters.
 */
export function ancestorCandidates(fromDir: string, relative: string): string[] {
  const out: string[] = [];
  let dir = path.resolve(fromDir);
  for (;;) {
    out.push(path.join(dir, relative));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}

/**
 * The first ancestor-relative candidate that exists, or null.
 *
 * Returns the path rather than a boolean so the caller can log which one
 * won: a file resolved from the wrong place is the kind of thing that works
 * on one machine and not another.
 */
export function findUp(fromDir: string, relative: string): string | null {
  for (const c of ancestorCandidates(fromDir, relative)) {
    try { if (fs.existsSync(c)) return c; } catch { /* unreadable — try the next */ }
  }
  return null;
}
