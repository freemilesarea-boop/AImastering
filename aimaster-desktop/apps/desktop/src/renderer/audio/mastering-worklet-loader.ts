// Mastering-worklet loader — wires the no-modules WASM build of
// loui-dsp-wasm into an AudioWorkletProcessor (M2-full-NEXT).
//
// The audio thread cannot fetch, await, or `import` — so the heavy lifting
// happens here on the MAIN thread:
//
//   1. fetch + compile the no-modules `.wasm` → a `WebAssembly.Module`.
//   2. `audioWorklet.addModule(glueUrl)` — evaluates the no-modules
//      wasm-bindgen glue inside `AudioWorkletGlobalScope`; its appended
//      bootstrap exposes `globalThis.__loui_init_mastering`.
//   3. `audioWorklet.addModule(workletUrl)` — registers the
//      `loui-mastering-chain` processor.
//   4. construct the node, handing the compiled module to the processor
//      via `processorOptions.wasmModule`; the processor calls
//      `__loui_init_mastering(module, sampleRate)` synchronously.
//
// Everything is OFF by default (gated by the realtime-preview flag at the
// call site).  This module only *enables* the path; it never turns it on.
//
// On ANY failure the loader rejects with a coded reason; callers fall
// back to the existing re-render preview — audio is never interrupted.

// ── Asset URLs (deliverable 5) ────────────────────────────────────────
//
// All three assets ship from Vite's `public/` dir (copied verbatim by
// build-wasm-worklet.sh), served at stable root-relative URLs under the
// renderer base — the SAME convention as analyzer-tap.worklet.js.  This
// avoids the `new URL(..., import.meta.url)` tree-shake fragility and is
// identical in dev and prod (see DEV_PROD_ASSET_PATHS.md).
export const MASTERING_WORKLET_URL = './mastering-chain.worklet.js';
export const MASTERING_WASM_GLUE_URL = './loui-mastering-wasm.nomodules.js';
export const MASTERING_WASM_BINARY_URL = './loui-mastering-wasm.nomodules.wasm';

/** Stable, machine-readable failure reasons (never throws raw strings). */
export type MasteringWorkletLoadCode =
  | 'wasm-fetch-failed'
  | 'wasm-compile-failed'
  | 'glue-module-failed'
  | 'processor-module-failed'
  | 'node-construct-failed'
  | 'timeout'
  | 'unsupported';

export class MasteringWorkletLoadError extends Error {
  constructor(readonly code: MasteringWorkletLoadCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'MasteringWorkletLoadError';
  }
}

/** Progress phases — surfaced to the debug panel as the load proceeds. */
export type MasteringWorkletPhase =
  | 'idle'
  | 'compiling-wasm'
  | 'loading-glue'
  | 'loading-processor'
  | 'constructing-node'
  | 'ready'
  | 'failed';

export interface MasteringWorkletLoadState {
  phase: MasteringWorkletPhase;
  /** The no-modules .wasm compiled to a module on the main thread. */
  wasmCompiled: boolean;
  /** The wasm-bindgen glue module evaluated in the worklet scope. */
  glueLoaded: boolean;
  /** The processor module registered (`loui-mastering-chain`). */
  processorRegistered: boolean;
  /** The AudioWorkletNode constructed (chain init happens in its ctor). */
  nodeConstructed: boolean;
  /** Coded reason the load failed, if any. */
  failureReason?: MasteringWorkletLoadCode;
  /** Last error message (for the debug panel). */
  lastError?: string;
}

export function initialMasteringWorkletLoadState(): MasteringWorkletLoadState {
  return {
    phase: 'idle',
    wasmCompiled: false,
    glueLoaded: false,
    processorRegistered: false,
    nodeConstructed: false,
  };
}

export interface LoadMasteringWorkletOptions {
  sampleRate: number;
  channels?: number;
  /** Overrides for non-default bundling setups (tests, custom hosts). */
  workletUrl?: string;
  glueUrl?: string;
  wasmUrl?: string;
  /** Abort the load if it exceeds this many ms (default 5000). */
  timeoutMs?: number;
  /** Receives load-state updates so the UI can show progress. */
  onPhase?: (state: MasteringWorkletLoadState) => void;
}

export interface LoadedMasteringWorklet {
  node: AudioWorkletNode;
  wasmModule: WebAssembly.Module;
}

// addModule is idempotent per (context, url) but evaluating the glue twice
// would re-run the bootstrap; we de-dupe per AudioContext to be safe.
const glueLoadedFor = new WeakSet<BaseAudioContext>();
const processorLoadedFor = new WeakSet<BaseAudioContext>();

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => { onTimeout(); reject(new MasteringWorkletLoadError('timeout', `mastering worklet load exceeded ${ms}ms`)); }, ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Load + register the mastering worklet and construct its node.  Resolves
 * with the node (already initialised inside its constructor) and the
 * compiled module.  Rejects with a `MasteringWorkletLoadError` on any
 * failure — the caller must fall back to the re-render preview.
 */
export async function loadMasteringWorklet(
  ctx: AudioContext,
  opts: LoadMasteringWorkletOptions,
): Promise<LoadedMasteringWorklet> {
  const state = initialMasteringWorkletLoadState();
  const emit = (patch: Partial<MasteringWorkletLoadState>) => {
    Object.assign(state, patch);
    opts.onPhase?.({ ...state });
  };

  const workletUrl = opts.workletUrl ?? MASTERING_WORKLET_URL;
  const glueUrl = opts.glueUrl ?? MASTERING_WASM_GLUE_URL;
  const wasmUrl = opts.wasmUrl ?? MASTERING_WASM_BINARY_URL;
  const timeoutMs = opts.timeoutMs ?? 5000;

  if (typeof WebAssembly !== 'object' || typeof ctx.audioWorklet === 'undefined') {
    emit({ phase: 'failed', failureReason: 'unsupported', lastError: 'AudioWorklet/WebAssembly unavailable' });
    throw new MasteringWorkletLoadError('unsupported', 'AudioWorklet/WebAssembly unavailable');
  }

  const run = async (): Promise<LoadedMasteringWorklet> => {
    // 1) Compile the no-modules wasm on the main thread.
    emit({ phase: 'compiling-wasm' });
    let wasmModule: WebAssembly.Module;
    try {
      let bytes: ArrayBuffer;
      try {
        const resp = await fetch(wasmUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        bytes = await resp.arrayBuffer();
      } catch (e) {
        throw new MasteringWorkletLoadError('wasm-fetch-failed', `failed to fetch ${wasmUrl}`, e);
      }
      try {
        wasmModule = await WebAssembly.compile(bytes);
      } catch (e) {
        throw new MasteringWorkletLoadError('wasm-compile-failed', 'WebAssembly.compile failed', e);
      }
      emit({ wasmCompiled: true });
    } catch (e) {
      if (e instanceof MasteringWorkletLoadError) throw e;
      throw new MasteringWorkletLoadError('wasm-compile-failed', 'wasm preparation failed', e);
    }

    // 2) Load the no-modules glue into the worklet scope.
    emit({ phase: 'loading-glue' });
    try {
      if (!glueLoadedFor.has(ctx)) {
        await ctx.audioWorklet.addModule(glueUrl);
        glueLoadedFor.add(ctx);
      }
      emit({ glueLoaded: true });
    } catch (e) {
      throw new MasteringWorkletLoadError('glue-module-failed', `addModule(${glueUrl}) failed`, e);
    }

    // 3) Register the processor.
    emit({ phase: 'loading-processor' });
    try {
      if (!processorLoadedFor.has(ctx)) {
        await ctx.audioWorklet.addModule(workletUrl);
        processorLoadedFor.add(ctx);
      }
      emit({ processorRegistered: true });
    } catch (e) {
      throw new MasteringWorkletLoadError('processor-module-failed', `addModule(${workletUrl}) failed`, e);
    }

    // 4) Construct the node — the processor's ctor inits the chain from
    //    the compiled module synchronously (no await on the audio thread).
    emit({ phase: 'constructing-node' });
    const channels = opts.channels ?? 2;
    let node: AudioWorkletNode;
    try {
      node = new AudioWorkletNode(ctx, 'loui-mastering-chain', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [channels],
        channelCount: channels,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { wasmModule, sampleRate: opts.sampleRate },
      });
      emit({ nodeConstructed: true, phase: 'ready' });
    } catch (e) {
      throw new MasteringWorkletLoadError('node-construct-failed', 'AudioWorkletNode construction failed', e);
    }

    return { node, wasmModule };
  };

  try {
    return await withTimeout(run(), timeoutMs, () => emit({ phase: 'failed', failureReason: 'timeout' }));
  } catch (e) {
    const code = e instanceof MasteringWorkletLoadError ? e.code : 'unsupported';
    const msg = e instanceof Error ? e.message : String(e);
    emit({ phase: 'failed', failureReason: code, lastError: msg });
    throw e instanceof MasteringWorkletLoadError ? e : new MasteringWorkletLoadError('unsupported', msg, e);
  }
}
