// The separator's worker body.
//
// Separating a four-minute song is something like a minute of solid
// arithmetic.  On the UI thread that is a minute of a frozen window, so this
// runs on its own thread and reports back as it goes.
//
// It is bundled to `src/renderer/public/separate.worker.js` by
// `scripts/build-separate-worker.mjs`, and fetched as text and constructed
// from a Blob by `run.ts` — the same route `daw-reader.worker.js` takes, and
// for the same reason: a packaged build is served from `file://`, where
// Chromium refuses to construct a Worker from a URL but allows a Blob.
//
// Nothing in here is algorithm.  Everything it calls is a plain function in
// this directory that the self-test exercises directly, on the main thread,
// with no worker involved.

import { separate, type SeparationOptions } from './separate.js';

export interface SeparateRequest {
  type: 'separate';
  channels: Float32Array[];
  sampleRate: number;
  options: Partial<SeparationOptions>;
}

export type SeparateResponse =
  | { type: 'progress'; fraction: number; what: string }
  | { type: 'done'; report: unknown }
  | { type: 'error'; message: string };

const post = (message: SeparateResponse, transfer: Transferable[] = []): void => {
  (self as unknown as { postMessage: (m: unknown, t: Transferable[]) => void })
    .postMessage(message, transfer);
};

self.onmessage = (event: MessageEvent<SeparateRequest>): void => {
  const request = event.data;
  if (request?.type !== 'separate') return;
  try {
    let lastPost = 0;
    const report = separate(request.channels, request.sampleRate, request.options, (fraction, what) => {
      // Twenty updates a second is plenty; posting per chunk step would spend
      // more time in structured clone than in the separation.
      const now = Date.now();
      if (now - lastPost < 50 && fraction < 1) return;
      lastPost = now;
      post({ type: 'progress', fraction, what });
    });
    // Hand the samples over rather than copying them: four stereo stems of a
    // four-minute song is 360 MB, and a structured clone of that is a pause
    // long enough to look like a crash.
    const transfer: Transferable[] = [];
    for (const stem of report.stems) for (const ch of stem.channels) transfer.push(ch.buffer);
    post({ type: 'done', report }, transfer);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
