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
