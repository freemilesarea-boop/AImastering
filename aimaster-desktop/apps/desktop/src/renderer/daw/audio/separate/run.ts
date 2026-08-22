// Starting the separator, and what to do when the thread will not start.
//
// The work belongs off the UI thread — a four-minute song is about a minute of
// arithmetic, and a minute of frozen window is indistinguishable from a hang.
// So the default is a Worker.
//
// But the worker can fail to start, and there is a wrong way to handle that.
// Running the same job inline "as a fallback" would freeze the app for a
// minute with no way to cancel, which is worse than not offering the feature.
// So this REFUSES instead, with the reason, and the panel shows it — the same
// rule the plugin host follows for a missing addon.

import type { SeparationOptions, SeparationReport } from './separate.js';

export const SEPARATE_WORKER_URL = './separate.worker.js';

export interface SeparationRun {
  /** Resolves with the report, or rejects with the reason it could not run. */
  result: Promise<SeparationReport>;
  /** Stop the work and reject `result`.  Safe to call after it has finished. */
  cancel(): void;
}

export type ProgressListener = (fraction: number, what: string) => void;

/**
 * Same route as `daw-reader.worker.js`: fetch the source, build a Blob, start
 * from that.  A packaged build is a `file://` document, where Chromium refuses
 * `new Worker(url)` outright but allows a Blob URL.
 */
async function spawn(): Promise<Worker> {
  if (typeof Worker === 'undefined') throw new Error('이 환경에는 Worker 가 없습니다');
  const response = await fetch(SEPARATE_WORKER_URL);
  if (!response.ok) {
    throw new Error(`분리 워커를 읽지 못했습니다 (${SEPARATE_WORKER_URL}, ${response.status})`);
  }
  const blob = new Blob([await response.text()], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    return new Worker(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Separate `channels` on a worker thread.
 *
 * The input buffers are TRANSFERRED, not copied — a four-minute stereo file is
 * 90 MB and copying it costs a visible pause.  The caller must not touch them
 * afterwards; `separateClip` hands over slices it made for the purpose.
 */
export function runSeparation(
  channels: Float32Array[], sampleRate: number,
  options: Partial<SeparationOptions> = {},
  onProgress: ProgressListener = () => {},
): SeparationRun {
  let worker: Worker | null = null;
  let settled = false;
  let cancelled = false;
  let abort: ((message: string) => void) | null = null;

  const result = new Promise<SeparationReport>((resolve, reject) => {
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      worker?.terminate();
      worker = null;
      reject(new Error(message));
    };
    abort = fail;

    void spawn().then((w) => {
      if (cancelled) { w.terminate(); return; }
      worker = w;
      w.onmessage = (event: MessageEvent<{
        type: string; fraction?: number; what?: string;
        report?: SeparationReport; message?: string;
      }>) => {
        const data = event.data;
        if (data.type === 'progress') { onProgress(data.fraction ?? 0, data.what ?? ''); return; }
        if (data.type === 'done' && data.report) {
          if (settled) return;
          settled = true;
          w.terminate();
          worker = null;
          resolve(data.report);
          return;
        }
        if (data.type === 'error') fail(data.message ?? '분리에 실패했습니다');
      };
      // A worker that dies takes the job with it and says nothing, so the
      // error handler is not optional: without it the promise never settles
      // and the panel spins for ever.
      w.onerror = (e) => fail(`분리 워커가 죽었습니다: ${e.message || '이유 없음'}`);
      w.onmessageerror = () => fail('분리 워커의 응답을 읽지 못했습니다');
      w.postMessage(
        { type: 'separate', channels, sampleRate, options },
        channels.map((c) => c.buffer),
      );
    }).catch((err: unknown) => {
      fail(err instanceof Error ? err.message : String(err));
    });
  });

  return {
    result,
    cancel(): void {
      cancelled = true;
      // Rejecting matters as much as terminating: a cancel that only killed
      // the thread would leave the caller awaiting a promise nothing will ever
      // settle, and the panel would spin for ever on a job that is gone.
      abort?.('분리를 취소했습니다');
    },
  };
}
