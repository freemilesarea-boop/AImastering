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
//   2. Persisted QA toggle `localStorage['loui.realtimePreview']`.
//   3. Build env `VITE_LOUI_REALTIME_PREVIEW` ('true'/'1' → on).
//   4. Default → OFF.

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

function readPersistedFlag(): boolean | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const v = localStorage.getItem(REALTIME_PREVIEW_LS_KEY);
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0') return false;
  } catch { /* ignore (private mode / unavailable) */ }
  return null;
}

/** Whether the realtime Rust mastering-preview chain is enabled. */
export function isRealtimePreviewEnabled(): boolean {
  if (typeof window !== 'undefined' && typeof window.__LOUI_REALTIME_PREVIEW__ === 'boolean') {
    return window.__LOUI_REALTIME_PREVIEW__;
  }
  const persisted = readPersistedFlag();
  if (persisted !== null) return persisted;
  const envFlag = (import.meta.env?.VITE_LOUI_REALTIME_PREVIEW ?? '').toString().toLowerCase();
  if (envFlag === 'true' || envFlag === '1') return true;
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
