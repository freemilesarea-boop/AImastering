// Running the plugin host, and cleaning up after it.
//
// The host is forked, not required.  Everything about a third-party plugin is
// someone else's decision — their memory management, their threading, their
// idea of what to do on a malformed buffer — so it gets its own process and a
// deadline, and both a crash and a hang come back as an error on one bounce
// rather than as a lost session.
//
// The fork-and-wait itself lives in `host-runner.ts`, which needs no Electron
// and is therefore testable.  What is left here is the two things that do need
// Electron: where the worker was built to, and where scratch audio goes.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { app } from 'electron';
import { HOST_TIMEOUT_MS, type HostJob, type HostResult } from './host-protocol.js';
import { runJobInProcess } from './host-runner.js';
import { log } from '../utils/logger.js';

/** Where the forked worker lives, next to the built main process. */
function workerPath(): string {
  return path.join(__dirname, 'plugin-host.js');
}

export function hostScratchDir(): string {
  const dir = path.join(app.getPath('temp'), 'loui-host');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function newScratchFile(suffix: string): string {
  return path.join(hostScratchDir(), `${crypto.randomUUID()}${suffix}`);
}

export function runHostJob(job: HostJob): Promise<HostResult> {
  return runJobInProcess(job, {
    workerPath: workerPath(),
    onTimeout: (j) => log.warn(`[host] job ${j.id} timed out after ${HOST_TIMEOUT_MS} ms`),
  });
}

/** Remove scratch audio left by finished or abandoned jobs. */
export function sweepHostScratch(everything = false): void {
  const dir = hostScratchDir();
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (!everything && now - fs.statSync(file).mtimeMs < 10 * 60 * 1000) continue;
      fs.unlinkSync(file);
    } catch { /* another run got there first */ }
  }
}
