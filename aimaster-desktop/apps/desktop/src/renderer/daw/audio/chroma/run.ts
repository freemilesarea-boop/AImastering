// Starting the chord detector, and what to do when the thread will not start.
//
// The same shape as the separator's `run.ts`, and the same refusal: running
// the job inline "as a fallback" would freeze the window for seconds with no
// way to cancel and no progress visible, which is worse than saying why it
// could not run.  The caller decides what to do with the refusal — for chord
// detection the answer is to fall back to the main thread ONLY if the caller
// explicitly asks, because for a short clip a blocking second is fine and for
// a whole song it is not.

import type { ChordReadout } from './chord-segment.js';
import type { DetectChordsOptions } from './chord-detect-audio.js';

export const CHORD_WORKER_URL = './chord.worker.js';

export type ChordProgress = (fraction: number, what: string) => void;

export interface ChordRun {
  result: Promise<ChordReadout>;
  cancel(): void;
}

async function spawn(): Promise<Worker> {
  if (typeof Worker === 'undefined') throw new Error('이 환경에는 Worker 가 없습니다');
  const response = await fetch(CHORD_WORKER_URL);
  if (!response.ok) {
    throw new Error(`코드 분석 워커를 읽지 못했습니다 (${CHORD_WORKER_URL}, ${response.status})`);
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
 * Detect chords on a worker thread.
 *
 * `samples` and `bass` are COPIED, not transferred: the caller made them by
 * slicing a clip out of the decode cache and may well want to run a second
 * analysis with a different vocabulary without decoding again.  A minute of
 * mono audio is 5 MB, which is a clone worth paying for.
 */
export function runChordDetection(
  samples: Float32Array, sampleRate: number,
  options: Omit<DetectChordsOptions, 'onProgress' | 'bass'> & { bass?: Float32Array | null } = {},
  onProgress: ChordProgress = () => {},
): ChordRun {
  let worker: Worker | null = null;
  let settled = false;
  let cancelled = false;
  let abort: ((message: string) => void) | null = null;

  const result = new Promise<ChordReadout>((resolve, reject) => {
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
        readout?: ChordReadout; message?: string;
      }>) => {
        const data = event.data;
        if (data.type === 'progress') { onProgress(data.fraction ?? 0, data.what ?? ''); return; }
        if (data.type === 'done' && data.readout) {
          if (settled) return;
          settled = true;
          w.terminate();
          worker = null;
          resolve(data.readout);
          return;
        }
        if (data.type === 'error') fail(data.message ?? '코드 분석에 실패했습니다');
      };
      // A worker that dies takes the job with it and says nothing, so this is
      // not optional: without it the promise never settles and the button
      // spins for ever.
      w.onerror = (e) => fail(`코드 분석 워커가 죽었습니다: ${e.message || '이유 없음'}`);
      w.onmessageerror = () => fail('코드 분석 워커의 응답을 읽지 못했습니다');
      w.postMessage({ type: 'chords', samples, sampleRate, options });
    }).catch((err: unknown) => {
      fail(err instanceof Error ? err.message : String(err));
    });
  });

  return {
    result,
    cancel(): void {
      cancelled = true;
      worker?.terminate();
      worker = null;
      abort?.('코드 분석을 취소했습니다');
    },
  };
}
