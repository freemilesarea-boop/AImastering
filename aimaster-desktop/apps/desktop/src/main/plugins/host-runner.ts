// Forking the host, waiting for it, and surviving whichever way it goes wrong.
//
// Split out of `host.ts` because that file needs Electron for its scratch
// directory and this part needs nothing at all.  The interesting behaviour —
// a plugin that crashes the process, a plugin that never answers — is exactly
// the behaviour that has to be tested, and it can only be tested if the code
// under test can run in plain Node.
//
// One process per job.  A long-lived host would amortise startup, but it would
// also carry one plugin's corrupted state into the next job, and a fork costs
// tens of milliseconds against a bounce that takes seconds.

import { fork, type ChildProcess } from 'node:child_process';
import { HOST_TIMEOUT_MS, type HostJob, type HostResult } from './host-protocol.js';

export interface RunnerOptions {
  /** The forked entry point. */
  workerPath: string;
  timeoutMs?: number;
  /** Node flags for the child — the self-tests use this to load TypeScript. */
  execArgv?: string[];
  onTimeout?: (job: HostJob) => void;
}

/**
 * Run one job in a fresh process.
 *
 * Resolves with the host's own result, or with a failure that says which of
 * the two ways it went wrong: the process died, or it never answered.  Both
 * are things a plugin does, and both have to be reportable rather than fatal —
 * this promise does not reject.
 */
export function runJobInProcess(job: HostJob, options: RunnerOptions): Promise<HostResult> {
  const timeoutMs = options.timeoutMs ?? HOST_TIMEOUT_MS;
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = fork(options.workerPath, [], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        ...(options.execArgv ? { execArgv: options.execArgv } : {}),
      });
    } catch (err) {
      resolve({ ok: false, error: `플러그인 호스트를 시작하지 못했습니다: ${String(err)}`, stages: [] });
      return;
    }

    let settled = false;
    const finish = (result: HostResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve(result);
    };

    const timer = setTimeout(() => {
      options.onTimeout?.(job);
      finish({ ok: false, error: '플러그인이 응답하지 않아 중단했습니다', stages: [] });
    }, timeoutMs);
    // A pending timer must not be the reason the process stays alive.
    timer.unref?.();

    child.on('message', (message: unknown) => {
      const reply = message as { id: string; result: HostResult };
      if (reply?.id !== job.id) return;
      finish(reply.result);
    });

    child.on('error', (err) => {
      finish({ ok: false, error: `호스트 오류: ${err.message}`, stages: [] });
    });

    child.on('exit', (code, signal) => {
      // Exiting before answering is what a crashing plugin looks like.
      finish({
        ok: false,
        error: signal
          ? `플러그인이 호스트를 종료시켰습니다 (${signal})`
          : `호스트가 코드 ${code} 로 끝났습니다`,
        stages: [],
      });
    });

    try {
      child.send(job);
    } catch (err) {
      finish({ ok: false, error: `작업을 전달하지 못했습니다: ${String(err)}`, stages: [] });
    }
  });
}
