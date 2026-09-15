// Running an installed model, on its own worker.
//
// The DSP separator produces the base stems; this splits ONE of them further
// using whatever model the user installed.  That order is not an
// implementation detail — `expandStems` replaces a parent with its children,
// which is what keeps the sum exact, and a model that produced its own top
// level would have to be trusted to cover the record, which nothing checks.
//
// Everything binary arrives as bytes over IPC rather than being fetched: the
// runtime's 12.86 MB `.wasm` and the model's weights both live somewhere a
// `file://` document cannot reliably read, and the main process reads both
// with Node fs, which understands asar.

import { expandStems, type ModelRunResult } from './model-run.js';
import type { ModelDescriptor } from './model-registry.js';
import { stemNode, type StemKind } from './stem-tree.js';
import type { ModelWorkerRequest, ModelWorkerResponse } from './model-worker-entry.js';

export const MODEL_WORKER_URL = './model.worker.js';

interface BytesReply { bytes: Uint8Array; from: string; size: number }

/** Both binaries, fetched from main.  Throws with what it looked for. */
async function loadBinaries(
  descriptor: ModelDescriptor, dir: string,
): Promise<{ wasm: ArrayBuffer; weights: ArrayBuffer; runtimeFrom: string }> {
  const api = window.electronAPI;
  if (!api?.invoke) throw new Error('파일 접근을 사용할 수 없습니다');
  const runtime = await api.invoke('daw:model-runtime') as BytesReply;
  const weights = await api.invoke('daw:model-weights', {
    dir, weights: descriptor.weights,
  }) as BytesReply;
  const own = (r: BytesReply): ArrayBuffer =>
    r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength) as ArrayBuffer;
  return { wasm: own(runtime), weights: own(weights), runtimeFrom: runtime.from };
}

/**
 * Same route the separator's worker takes: fetch the bundle as text, build a
 * Blob, start from that.  A packaged build is a `file://` document, where
 * Chromium refuses `new Worker(url)` outright but allows a Blob URL.
 */
async function spawn(): Promise<Worker> {
  if (typeof Worker === 'undefined') throw new Error('이 환경에는 Worker 가 없습니다');
  const response = await fetch(MODEL_WORKER_URL);
  if (!response.ok) {
    throw new Error(`모델 워커를 읽지 못했습니다 (${MODEL_WORKER_URL}, ${response.status})`);
  }
  const url = URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
  try {
    return new Worker(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export type ModelDispatchProgress = (fraction: number) => void;

/**
 * Split `channels` with the model, on a worker.
 *
 * The input buffers are TRANSFERRED.  The caller must not touch them
 * afterwards — `splitWithModel` below hands over copies it made for the
 * purpose, because the stem they came from is still going into the session.
 */
export async function runModelOnWorker(
  descriptor: ModelDescriptor, dir: string,
  channels: Float32Array[], sampleRate: number,
  onProgress: ModelDispatchProgress = () => {},
): Promise<ModelRunResult> {
  const { wasm, weights } = await loadBinaries(descriptor, dir);
  const worker = await spawn();
  try {
    return await new Promise<ModelRunResult>((resolve, reject) => {
      worker.onerror = (e) => reject(new Error(e.message || '모델 워커가 죽었습니다'));
      worker.onmessage = (event: MessageEvent<ModelWorkerResponse>) => {
        const data = event.data;
        if (data.type === 'progress') { onProgress(data.fraction); return; }
        if (data.type === 'error') { reject(new Error(data.message)); return; }
        resolve(data.result);
      };
      const request: ModelWorkerRequest = {
        type: 'run', wasm, weights, descriptor, channels, sampleRate,
      };
      worker.postMessage(request, [wasm, weights, ...channels.map((c) => c.buffer)]);
    });
  } finally {
    worker.terminate();
  }
}

/** The stem a model's outputs all descend from, or null when they do not. */
export function modelParent(stems: readonly StemKind[]): StemKind | null {
  if (stems.length === 0) return null;
  const parents = new Set(stems.map((k) => stemNode(k).parent));
  if (parents.size !== 1) return null;
  const [only] = [...parents];
  return only ?? null;
}

/**
 * Whether this model is worth running for what the user asked for.
 *
 * Two reasons to say no, and both are worth saying rather than running
 * anyway: a model whose stems do not share one parent cannot be folded in
 * without leaving the record's energy counted twice somewhere and nowhere
 * else, and a model nobody asked anything of is two minutes of inference for
 * stems that get thrown away.
 */
export function modelApplies(
  descriptor: ModelDescriptor, wanted: readonly StemKind[],
): { ok: true; parent: StemKind } | { ok: false; reason: string } {
  const parent = modelParent(descriptor.stems);
  if (parent === null) {
    return {
      ok: false,
      reason: `${descriptor.name} 의 스템들이 한 부모에서 갈라지지 않습니다 — 합이 원본이 되지 않습니다`,
    };
  }
  const asked = descriptor.stems.filter((k) => wanted.includes(k));
  if (asked.length === 0) {
    return { ok: false, reason: `${descriptor.name} 이(가) 만드는 스템은 이번에 고르지 않았습니다` };
  }
  return { ok: true, parent };
}

export { expandStems };
