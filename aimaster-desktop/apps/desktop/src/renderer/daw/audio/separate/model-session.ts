// Turning a descriptor into something that can be run.
//
// Three jobs, and each one is a place a model goes wrong quietly:
//
//   THE RUNTIME IS LOADED ON DEMAND.  `onnxruntime-web` is imported
//   dynamically, so the DSP worker bundle does not carry it and a build
//   without it fails with a sentence rather than a stack trace at start-up.
//
//   THE WEIGHTS ARE CHECKED.  `model.json` declares a sha256 and until now
//   nothing looked at it.  A hash that is written down and never verified is
//   decoration: it makes a half-downloaded file look like a broken model and a
//   swapped file look like a working one.
//
//   THE FAILURE SAYS WHICH OF THE THREE IT WAS.  "Model failed to load" is the
//   same message for a missing runtime, a truncated download and an ONNX file
//   this runtime cannot read, and those have three different fixes.

import type { ModelDescriptor } from './model-registry.js';
import type { InferenceLike, MakeTensor, TensorLike } from './model-run.js';

/** The slice of onnxruntime this needs.  Narrow so a test can stand in for it. */
export interface OrtLike {
  InferenceSession: {
    create(model: Uint8Array, options?: { executionProviders?: string[] }): Promise<unknown>;
  };
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => TensorLike;
  env: { wasm: { numThreads: number; wasmPaths?: string } };
}

export interface OpenedModel {
  session: InferenceLike;
  tensor: MakeTensor;
}

export interface OpenOptions {
  /** Where the runtime's .wasm files live.  A packaged app is not a web root. */
  wasmPaths?: string;
  /**
   * Threads for the runtime.
   *
   * More than one needs cross-origin isolation, which a `file://` document does
   * not have; asking for it there prints a warning and silently falls back, so
   * this asks for what it can actually get.
   */
  numThreads?: number;
  /** Injected for the test; production leaves it out and the import happens. */
  ort?: OrtLike;
}

/** Lower-case hex SHA-256 of `bytes`, via WebCrypto. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new Error('이 환경에는 crypto.subtle 이 없어 가중치를 검증할 수 없습니다');
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const digest = await subtle.digest('SHA-256', view.buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function loadRuntime(): Promise<OrtLike> {
  try {
    // The specifier is built rather than written so a bundler does not follow
    // it: this must stay a runtime decision, not a build-time inclusion.
    const name = ['onnxruntime', 'web'].join('-');
    return (await import(/* @vite-ignore */ name)) as unknown as OrtLike;
  } catch (e) {
    throw new Error('분리 모델 런타임(onnxruntime-web)이 없습니다'
      + ` — 설치하면 모델 스템을 만들 수 있습니다 (${e instanceof Error ? e.message : String(e)})`);
  }
}

/**
 * Verify `weights` against the descriptor and open a session on them.
 *
 * `weights` is the raw ONNX file.  It is hashed before the runtime sees it,
 * because a runtime error on a corrupt file is a confusing way to learn that
 * the download was truncated.
 */
export async function openModel(
  descriptor: ModelDescriptor, weights: Uint8Array,
  options: OpenOptions = {},
): Promise<OpenedModel> {
  if (weights.byteLength === 0) {
    throw new Error(`${descriptor.id}: 가중치 파일이 비어 있습니다 (${descriptor.weights})`);
  }
  const got = await sha256Hex(weights);
  if (got !== descriptor.sha256.toLowerCase()) {
    throw new Error(`${descriptor.id}: 가중치 해시가 다릅니다`
      + ` — model.json 은 ${descriptor.sha256.slice(0, 12)}… 라고 하는데 파일은 ${got.slice(0, 12)}… 입니다.`
      + ' 받다 만 파일이거나 다른 파일입니다');
  }

  const ort = options.ort ?? await loadRuntime();
  ort.env.wasm.numThreads = options.numThreads ?? 1;
  if (options.wasmPaths !== undefined) ort.env.wasm.wasmPaths = options.wasmPaths;

  let session: unknown;
  try {
    session = await ort.InferenceSession.create(weights, { executionProviders: ['wasm'] });
  } catch (e) {
    throw new Error(`${descriptor.id}: 이 런타임이 읽을 수 없는 모델입니다`
      + ` (${e instanceof Error ? e.message : String(e)})`);
  }
  return {
    session: session as InferenceLike,
    tensor: (data, dims) => new ort.Tensor('float32', data, dims),
  };
}
