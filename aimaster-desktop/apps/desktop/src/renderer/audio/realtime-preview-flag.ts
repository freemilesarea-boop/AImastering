// Loui Mastering — realtime mastering-preview feature flag (M2-full).
//
// When ON, the AudioWorklet preview tap routes audio through the Rust
// MasteringChain (WASM) so parameter changes are heard with low latency.
// When OFF (default), the existing re-render preview workflow is used
// unchanged.
//
// DEFAULT = OFF.  The realtime chain is opt-in until it has been
// device-tested for CPU + glitch behaviour (see m2-full benchmark +
// fallback docs).  Toggling this flag NEVER changes the export path —
// final export remains the Python/Rust offline render.
//
// Decision order:
//   1. Runtime `window.__LOUI_REALTIME_PREVIEW__` (boolean) — explicit.
//   2. Build env `VITE_LOUI_REALTIME_PREVIEW` ('true'/'1' → on).
//   3. Default → OFF.

declare global {
  interface Window {
    __LOUI_REALTIME_PREVIEW__?: boolean;
  }
  interface ImportMetaEnv {
    readonly VITE_LOUI_REALTIME_PREVIEW?: string;
  }
}

/** Whether the realtime Rust mastering-preview chain is enabled. */
export function isRealtimePreviewEnabled(): boolean {
  if (typeof window !== 'undefined' && typeof window.__LOUI_REALTIME_PREVIEW__ === 'boolean') {
    return window.__LOUI_REALTIME_PREVIEW__;
  }
  const envFlag = (import.meta.env?.VITE_LOUI_REALTIME_PREVIEW ?? '').toString().toLowerCase();
  if (envFlag === 'true' || envFlag === '1') return true;
  return false;
}

/** Diagnostic label. */
export function realtimePreviewLabel(): string {
  return isRealtimePreviewEnabled() ? 'Realtime (Rust chain)' : 'Re-render (offline)';
}
