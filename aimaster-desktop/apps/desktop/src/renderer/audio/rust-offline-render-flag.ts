// Rust offline export render flag (RUST-OFFLINE-RENDER-1).
//
// When ON, "새 버전 만들기" / Re-master runs the Rust MasteringChain so
// the user's EQ / Dynamics / Imager / Limiter edits all reach the exported
// file.  On ANY failure the main process falls back to the Python engine
// automatically.  DEFAULT = ON (same Rust chain that drives realtime preview;
// device-verified via the parity harness).
//
// Override order:
//   1. Runtime `window.__LOUI_RUST_OFFLINE_RENDER__` (boolean).
//   2. Build env `VITE_LOUI_RUST_OFFLINE_RENDER` ('false'/'0' → force off).
//   3. Default → ON.

declare global {
  interface Window {
    __LOUI_RUST_OFFLINE_RENDER__?: boolean;
  }
  interface ImportMetaEnv {
    readonly VITE_LOUI_RUST_OFFLINE_RENDER?: string;
  }
}

export function isRustOfflineRenderEnabled(): boolean {
  if (typeof window !== 'undefined' && typeof window.__LOUI_RUST_OFFLINE_RENDER__ === 'boolean') {
    return window.__LOUI_RUST_OFFLINE_RENDER__;
  }
  const env = (import.meta.env?.VITE_LOUI_RUST_OFFLINE_RENDER ?? '').toString().toLowerCase();
  if (env === 'false' || env === '0') return false;
  return true; // on by default
}
