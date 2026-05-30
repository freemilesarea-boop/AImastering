// Realtime-preview readiness detector (M2-full device test).
//
// Feature-detects whether the browser/Electron environment can run the
// Rust mastering chain inside an AudioWorklet.  If anything is missing,
// the realtime path stays disabled and the app uses the re-render
// preview — never a crash, never a silent failure.

export interface RealtimeReadiness {
  /** Overall verdict — true only if every requirement is met. */
  ready: boolean;
  /** AudioWorklet is available (not ScriptProcessor — required). */
  audioWorklet: boolean;
  /** WebAssembly is available. */
  webAssembly: boolean;
  /** AudioContext is constructable. */
  audioContext: boolean;
  /** Human-readable reasons the path is unavailable (empty if ready). */
  reasons: string[];
}

/**
 * Probe the environment for realtime-preview capability.  Pure feature
 * detection — no AudioContext is created, no audio thread is touched.
 */
export function detectRealtimeReadiness(): RealtimeReadiness {
  const reasons: string[] = [];

  const hasAudioContext =
    typeof globalThis !== 'undefined' &&
    (typeof (globalThis as { AudioContext?: unknown }).AudioContext === 'function' ||
     typeof (globalThis as { webkitAudioContext?: unknown }).webkitAudioContext === 'function');
  if (!hasAudioContext) reasons.push('AudioContext unavailable');

  // AudioWorklet lives on AudioContext.prototype.audioWorklet.  We check
  // the constructor's prototype to avoid instantiating a context.
  let hasAudioWorklet = false;
  try {
    const Ctor = (globalThis as { AudioContext?: new () => unknown }).AudioContext;
    hasAudioWorklet =
      typeof Ctor === 'function' &&
      'audioWorklet' in (Ctor.prototype as object) &&
      typeof (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode === 'function';
  } catch {
    hasAudioWorklet = false;
  }
  if (!hasAudioWorklet) reasons.push('AudioWorklet unavailable (ScriptProcessor is not used)');

  const hasWasm = typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
  if (!hasWasm) reasons.push('WebAssembly unavailable');

  const ready = hasAudioContext && hasAudioWorklet && hasWasm;
  return { ready, audioWorklet: hasAudioWorklet, webAssembly: hasWasm, audioContext: hasAudioContext, reasons };
}

/** Single-line summary for logs / the debug panel. */
export function describeReadiness(r: RealtimeReadiness): string {
  if (r.ready) return 'realtime-ready';
  return `realtime-unavailable: ${r.reasons.join('; ')}`;
}

// ── Worklet-WASM asset readiness (M2-full-NEXT) ───────────────────────
//
// Feature detection (above) tells us the ENVIRONMENT can host the path.
// This second probe tells us the BUILD shipped the no-modules WASM assets
// the worklet needs — without instantiating an AudioContext or touching
// the audio thread.  Both must pass before the realtime flag can be
// flipped on.

import {
  MASTERING_WASM_GLUE_URL,
  MASTERING_WASM_BINARY_URL,
  MASTERING_WORKLET_URL,
} from './mastering-worklet-loader.js';

/** Coded reasons the worklet WASM assets are not loadable. */
export type WorkletAssetReason =
  | 'glue-missing'
  | 'wasm-missing'
  | 'processor-missing'
  | 'fetch-error'
  | 'timeout';

export interface WorkletAssetReadiness {
  /** True only if all three worklet assets are fetchable. */
  ready: boolean;
  glue: boolean;
  wasm: boolean;
  processor: boolean;
  reasons: WorkletAssetReason[];
}

async function probeUrl(url: string, timeoutMs: number): Promise<boolean> {
  if (typeof fetch !== 'function') return false;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    // GET (not HEAD) — Vite's dev server / file:// don't always answer HEAD.
    const resp = await fetch(url, ctrl ? { signal: ctrl.signal } : {});
    return resp.ok;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Probe whether the no-modules worklet WASM assets shipped with the
 * build.  Network/file IO only — no AudioContext, no audio thread.
 * Times out per asset so a hung dev server can't block readiness.
 */
export async function detectWorkletAssetReadiness(timeoutMs = 3000): Promise<WorkletAssetReadiness> {
  const [glue, wasm, processor] = await Promise.all([
    probeUrl(MASTERING_WASM_GLUE_URL, timeoutMs),
    probeUrl(MASTERING_WASM_BINARY_URL, timeoutMs),
    probeUrl(MASTERING_WORKLET_URL, timeoutMs),
  ]);
  const reasons: WorkletAssetReason[] = [];
  if (!glue) reasons.push('glue-missing');
  if (!wasm) reasons.push('wasm-missing');
  if (!processor) reasons.push('processor-missing');
  return { ready: glue && wasm && processor, glue, wasm, processor, reasons };
}

/** Single-line summary of asset readiness for logs / the debug panel. */
export function describeWorkletAssetReadiness(r: WorkletAssetReadiness): string {
  if (r.ready) return 'worklet-assets-ready';
  return `worklet-assets-missing: ${r.reasons.join('; ')}`;
}
