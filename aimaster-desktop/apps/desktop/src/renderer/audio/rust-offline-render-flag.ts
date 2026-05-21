// Rust offline export render — experimental feature flag
// (RUST-OFFLINE-RENDER-1).
//
// When ON, "new version" / Re-master tries the Rust MasteringChain offline
// render (audio:master-rust-experimental) so the user's EQ/Dynamics/Limiter
// edits reach the exported file.  On ANY failure the main process falls
// back to the Python engine.  DEFAULT = OFF (experimental, output quality
// must be device-verified before defaulting on).
//
// Decision order:
//   1. Runtime `window.__LOUI_RUST_OFFLINE_RENDER__` (boolean).
//   2. Build env `VITE_LOUI_RUST_OFFLINE_RENDER` ('true'/'1' → on).
//   3. Default → OFF.

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
  return env === 'true' || env === '1';
}
