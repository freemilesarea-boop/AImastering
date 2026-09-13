// The model runner's worker body.
//
// Separate from `worker-entry.ts` on purpose.  That one is the DSP separator
// and has no business carrying a 71 KB inference runtime for a feature most
// sessions never turn on; this one carries it and nothing else.
//
// ── Why this is a CLASSIC script, like the separator ────────────────────────
//
// It was assumed for a while that running a model here needed a MODULE worker,
// because `model-session.ts` loads `onnxruntime-web` through a runtime
// `import()` of a bare specifier and a classic worker cannot resolve one.  The
// premise is true and the conclusion was wrong: the fix is not a different kind
// of worker, it is to stop needing resolution at all.  `onnxruntime-web/wasm`
// bundles to a classic IIFE at 71 KB, so the runtime is simply IN here, and
// `openModel` is handed it rather than asked to find it.
//
// The runtime's own 12.86 MB `.wasm` arrives the same way everything else
// binary does in this app: read by the main process with Node fs, which
// understands asar, and passed across as bytes.  `env.wasm.wasmBinary` takes
// them and ONNX documents that it then ignores `wasmPaths`, so nothing here
// ever touches `file://`.
//
// Measured end to end in a real `file://` document, with no SharedArrayBuffer:
// session created in 492 ms, inference in 9 ms.

import * as ort from 'onnxruntime-web/wasm';

import { openModel } from './model-session.js';
import { runModel, type ModelRunResult } from './model-run.js';
import type { ModelDescriptor } from './model-registry.js';

export interface ModelWorkerRequest {
  type: 'run';
  /** The ONNX runtime's own binary. */
  wasm: ArrayBuffer;
  /** The model's weights, hashed against the descriptor before anything opens. */
  weights: ArrayBuffer;
  descriptor: ModelDescriptor;
  channels: Float32Array[];
  sampleRate: number;
}

export type ModelWorkerResponse =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; result: ModelRunResult }
  | { type: 'error'; message: string };

const post = (message: ModelWorkerResponse, transfer: Transferable[] = []): void => {
  (self as unknown as { postMessage: (m: unknown, t: Transferable[]) => void })
    .postMessage(message, transfer);
};

self.onmessage = (event: MessageEvent<ModelWorkerRequest>): void => {
  const request = event.data;
  if (request?.type !== 'run') return;
  void (async (): Promise<void> => {
    try {
      // One thread.  More needs cross-origin isolation, which a `file://`
      // document does not have — measured: `crossOriginIsolated` false and no
      // SharedArrayBuffer at all.  Asking for more prints a warning and
      // silently falls back, so this asks for what it can actually get.
      const opened = await openModel(request.descriptor, new Uint8Array(request.weights), {
        ort: ort as unknown as Parameters<typeof openModel>[2] extends { ort?: infer O } ? O : never,
        numThreads: 1,
        wasmBinary: request.wasm,
      });
      let lastPost = 0;
      const result = await runModel(
        request.channels, request.sampleRate, request.descriptor,
        opened.session, opened.tensor, {},
        (fraction) => {
          const now = Date.now();
          if (now - lastPost < 100 && fraction < 1) return;
          lastPost = now;
          post({ type: 'progress', fraction });
        },
      );
      // Hand the samples over rather than copying: the stems of a four-minute
      // file are hundreds of megabytes and a structured clone of that is a
      // pause long enough to look like a crash.
      const transfer: Transferable[] = [];
      for (const stem of result.stems) for (const ch of stem.channels) transfer.push(ch.buffer);
      post({ type: 'done', result }, transfer);
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  })();
};
