// Loui Mastering — realtime mastering-preview feature flag (M2-full).
//
// HARD-DISABLED: returns false unconditionally.  The realtime worklet +
// WASM mastering chain were confirmed as the source of renderer crashes;
// the worklet's onMetrics callback fired every audio block and the runaway
// setState loop killed the renderer process.  Until the worklet is
// rewritten to be mount-safe, this is a compile-time constant = false.
//
// Toggling this flag NEVER changes the export path — final export remains
// the Python/Rust offline render.

declare global {
  interface Window {
    __LOUI_REALTIME_PREVIEW__?: boolean;
  }
  interface ImportMetaEnv {
    readonly VITE_LOUI_REALTIME_PREVIEW?: string;
  }
}

/** localStorage key for the persisted dev/QA realtime toggle. */
export const REALTIME_PREVIEW_LS_KEY = 'loui.realtimePreview';

/**
 * Whether the realtime Rust mastering-preview chain is enabled.
 *
 * HARD-DISABLED in this build.  The realtime worklet + WASM mastering
 * chain attach path was the confirmed cause of renderer death when an
 * audio file was loaded into the product page; the worklet's onMetrics
 * callback fires every audio block and the runaway setState loop killed
 * the renderer process.  Until the worklet itself is rewritten to be
 * mount-safe, this returns false unconditionally.  Module edits no
 * longer change the sound in real time, but the offline export path is
 * untouched and produces the same WAV as before.
 */
export function isRealtimePreviewEnabled(): boolean {
  return false;
}

/**
 * Persist the dev/QA realtime toggle (localStorage + the runtime window
 * flag).  The hook reads the flag once per mount, so callers should reload
 * the renderer afterwards to (de)activate the graph.  NEVER changes the
 * export path — final export remains the Python/Rust offline render.
 */
export function setRealtimePreviewEnabled(on: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(REALTIME_PREVIEW_LS_KEY, on ? 'true' : 'false');
    }
  } catch { /* ignore */ }
  if (typeof window !== 'undefined') window.__LOUI_REALTIME_PREVIEW__ = on;
}

/** Diagnostic label. */
export function realtimePreviewLabel(): string {
  return isRealtimePreviewEnabled() ? 'Realtime (Rust chain)' : 'Re-render (offline)';
}
