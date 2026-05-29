// Loui Mastering — realtime mastering-preview feature flag (M2-full).
//
// When ON, the AudioWorklet preview tap routes audio through the Rust
// MasteringChain (WASM) so parameter changes are heard with low latency:
//   source → mastering chain → analyzer tap → destination.
// When OFF, the chain node is never spliced in (source → tap → destination)
// so EQ/Dynamics/Imager edits produce NO audible change — they only stage
// for the offline re-render.
//
// DEFAULT = ON.  Real-time audition of module edits is a core product
// feature: turning a knob must change the sound.  The chain is wrapped in
// hard safety layers (per-block passthrough on any error in the worklet,
// finite/peak guards in the Rust chain) and gated by an environment
// readiness probe, so the worst case is a transparent passthrough — never
// broken or silenced audio.  Synthetic/offline stays an explicit opt-OUT.
//
// Toggling this flag NEVER changes the export path — final export remains
// the Python/Rust offline render.
//
// Decision order (explicit OFF wins; otherwise ON):
//   1. Runtime `window.__LOUI_REALTIME_PREVIEW__` (boolean) — explicit.
//   2. Persisted QA toggle `localStorage['loui.realtimePreview']`.
//   3. Build env `VITE_LOUI_REALTIME_PREVIEW` ('false'/'0' → off).
//   4. Default → ON.

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

/** Whether the realtime Rust mastering-preview chain is enabled (ON by default). */
export function isRealtimePreviewEnabled(): boolean {
  // SAFE_BOOT override (highest priority): if the user disabled the
  // realtime worklet via the safe-boot flag, force it off regardless of
  // the runtime / persisted / env settings.  Without this gate the hook
  // would still build a shared-graph session from any media element and
  // attempt to load the worklet — defeating the safe-boot guard.
  try {
    const sb = sessionStorage.getItem('__loui_safe_boot__v2');
    if (sb) {
      const parsed = JSON.parse(sb) as { realtimeMasteringGraph?: boolean };
      if (parsed.realtimeMasteringGraph === false) return false;
    }
  } catch { /* ignore */ }
  if (typeof window !== 'undefined' && typeof window.__LOUI_REALTIME_PREVIEW__ === 'boolean') {
    return window.__LOUI_REALTIME_PREVIEW__;
  }
  const persisted = readPersistedFlag();
  if (persisted !== null) return persisted;
  const envFlag = (import.meta.env?.VITE_LOUI_REALTIME_PREVIEW ?? '').toString().toLowerCase();
  if (envFlag === 'false' || envFlag === '0') return false;
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
