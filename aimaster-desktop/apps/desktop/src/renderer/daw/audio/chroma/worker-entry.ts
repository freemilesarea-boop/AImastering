// The chord detector's worker body.
//
// Reading the chords out of a four-minute clip is about eight seconds of
// solid arithmetic — measured at roughly 29× real time at 44.1 kHz.  On the
// UI thread that is eight seconds of frozen window, and worse than the freeze
// is what it does to the progress display: a blocked main thread cannot paint,
// so the "분석 중 40 %" the button wants to show never appears and the app
// looks hung rather than busy.
//
// Same route as the separator's worker, for the same reason: bundled to
// `src/renderer/public/chord.worker.js`, fetched as text and constructed from
// a Blob, because a packaged build is served from `file://` where Chromium
// refuses `new Worker(url)` but allows a Blob.
//
// Nothing in here is algorithm.  Everything it calls is a plain function in
// this directory that the self-test exercises directly, on the main thread,
// with no worker involved.

import {
  detectChordsFromAudio, type DetectChordsOptions,
} from './chord-detect-audio.js';

export interface ChordRequest {
  type: 'chords';
  samples: Float32Array;
  sampleRate: number;
  options: Omit<DetectChordsOptions, 'onProgress' | 'bass'> & { bass?: Float32Array | null };
}

export type ChordResponse =
  | { type: 'progress'; fraction: number; what: string }
  | { type: 'done'; readout: unknown }
  | { type: 'error'; message: string };

const post = (message: ChordResponse): void => {
  (self as unknown as { postMessage: (m: unknown) => void }).postMessage(message);
};

self.onmessage = (event: MessageEvent<ChordRequest>): void => {
  const request = event.data;
  if (request?.type !== 'chords') return;
  try {
    let lastPost = 0;
    const readout = detectChordsFromAudio(request.samples, request.sampleRate, {
      ...request.options,
      onProgress: (fraction, what) => {
        const now = Date.now();
        if (now - lastPost < 50 && fraction < 1) return;
        lastPost = now;
        post({ type: 'progress', fraction, what });
      },
    });
    // The readout is small — a few dozen chords and a grid — so it goes back
    // as a plain clone.  Nothing here is worth transferring.
    post({ type: 'done', readout });
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
