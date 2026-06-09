// Rust offline export render flag (RUST-OFFLINE-RENDER-1).
//
// When ON, "새 버전 만들기" / Re-master routes export through the Rust
// MasteringChain (audio:master-rust-experimental) so the user's EQ /
// Dynamics / Imager / Limiter edits all reach the exported file.  On ANY
// failure the renderer (and the main process) fall back to the Python engine
// automatically.
//
// DEFAULT = OFF.  Now that the renderer actually routes on this flag
// (engine unification C-2b), default-on would send every user to the Rust
// export before on-device A/B QA.  Per the export-support promotion plan,
// the default flips ON only after sign-off; until then it is opt-in.
//
// Override order:
//   1. Runtime `window.__LOUI_RUST_OFFLINE_RENDER__` (boolean).
//   2. Build env `VITE_LOUI_RUST_OFFLINE_RENDER` ('true'/'1'/'on' → ON).
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
  return env === 'true' || env === '1' || env === 'on'; // off by default
}
