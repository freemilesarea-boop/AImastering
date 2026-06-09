// Loui Mastering — realtime mastering-preview feature flag (M2-full).
//
// History: this flag was previously HARD-DISABLED (returned false
// unconditionally) because the realtime worklet forwarded a `metrics`
// message into React `setState` every audio block, and the runaway
// re-render loop killed the renderer process.
//
// That root cause is now fixed:
//   • `audio/realtime-metrics-sink.ts` coalesces worklet metrics and
//     notifies React at most ~10 Hz (never per-block).
//   • The ResultPage integration loads the worklet behind a 5 s timeout
//     and ALWAYS falls back to the native WebAudio DSP chain on any
//     failure, so audio is never interrupted.
//
// The gate is therefore re-opened, but stays OFF BY DEFAULT and is opt-in
// (env / localStorage / window flag).  Flipping the default to ON is the
// pre-launch step, gated on real-device validation — this headless build
// cannot exercise the audio thread.
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

function envFlag(): string | undefined {
  try {
    return (import.meta as { env?: { VITE_LOUI_REALTIME_PREVIEW?: string } })
      .env?.VITE_LOUI_REALTIME_PREVIEW;
  } catch {
    return undefined;
  }
}

function lsFlag(): string | null {
  try {
    return typeof localStorage !== 'undefined'
      ? localStorage.getItem(REALTIME_PREVIEW_LS_KEY)
      : null;
  } catch {
    return null;
  }
}

const isOn = (v: string | null | undefined): boolean => v === 'true' || v === '1' || v === 'on';
const isForcedOff = (v: string | null | undefined): boolean => v === 'force-off' || v === 'off' || v === '0';

/**
 * Whether the realtime Rust mastering-preview chain is enabled.
 *
 * Resolution order (first decisive wins):
 *   1. env `VITE_LOUI_REALTIME_PREVIEW=force-off|off|0`  → hard OFF (kill switch)
 *   2. runtime `window.__LOUI_REALTIME_PREVIEW__` boolean → that value
 *   3. localStorage `loui.realtimePreview` = on/off       → that value
 *   4. env `VITE_LOUI_REALTIME_PREVIEW=true|1|on`         → ON
 *   5. default                                            → OFF (native preview)
 *
 * Default OFF means zero behaviour change for existing users; the worklet
 * path is dormant until explicitly opted in.  The native WebAudio preview
 * remains fully audible either way.
 */
export function isRealtimePreviewEnabled(): boolean {
  const env = envFlag();
  if (isForcedOff(env)) return false;

  if (typeof window !== 'undefined' && typeof window.__LOUI_REALTIME_PREVIEW__ === 'boolean') {
    return window.__LOUI_REALTIME_PREVIEW__;
  }

  const ls = lsFlag();
  if (ls !== null) {
    if (isForcedOff(ls)) return false;
    if (isOn(ls)) return true;
  }

  return isOn(env);
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
