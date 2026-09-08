// Loui Mastering — realtime mastering-preview feature flag.
//
// History matters here.  This flag was hard-disabled after the realtime
// worklet was confirmed as the source of renderer crashes: its metrics
// callback fired every audio block, the host turned each message into a
// `setState`, and the resulting re-render re-attached the worklet — a
// feedback loop at audio rate.
//
// It is re-enabled because that loop has been removed at the source, not
// papered over:
//
//   • the worklet rate-limits metrics on a wall clock (≤ 10 Hz), so no host
//     can be driven faster than that whatever it does with the messages;
//   • `realtime-preview-store` takes messages into a plain object and
//     notifies React on a fixed timer, so message arrival cannot render;
//   • `useRealtimePreview` attaches on stable primitives only, and pushes
//     config through a ref-held node — a parameter change can no longer
//     re-attach anything.
//
// The kill switch is kept, because a crash source earns one: set
// `VITE_LOUI_REALTIME_PREVIEW=false` at build time, `localStorage`
// `loui.realtimePreview = 'false'`, or `window.__LOUI_REALTIME_PREVIEW__ =
// false` at runtime.  Any of them turns it off without a rebuild.
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
 * Resolution order — the most explicit wins, so a user or a QA build can
 * always switch it off without touching code:
 *   1. `window.__LOUI_REALTIME_PREVIEW__` (runtime override)
 *   2. `localStorage['loui.realtimePreview']`
 *   3. `VITE_LOUI_REALTIME_PREVIEW` ('false' / '0' → off)
 *   4. default → on
 */
export function isRealtimePreviewEnabled(): boolean {
  if (typeof window !== 'undefined' && typeof window.__LOUI_REALTIME_PREVIEW__ === 'boolean') {
    return window.__LOUI_REALTIME_PREVIEW__;
  }
  try {
    if (typeof localStorage !== 'undefined') {
      const v = localStorage.getItem(REALTIME_PREVIEW_LS_KEY);
      if (v === 'true' || v === '1') return true;
      if (v === 'false' || v === '0') return false;
    }
  } catch { /* private mode / disabled storage — fall through */ }
  const env = (import.meta.env?.VITE_LOUI_REALTIME_PREVIEW ?? '').toString().toLowerCase();
  if (env === 'false' || env === '0') return false;
  return true;
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
