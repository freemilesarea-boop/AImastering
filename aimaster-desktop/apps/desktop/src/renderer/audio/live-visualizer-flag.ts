// Loui Mastering — live FFT visualizer feature flag (OZONE-MODULE-NEXT-1).
//
// Controls whether ProductPage's central analyzer area renders the new
// LouiMasteringVisualizer (live FFT spectrum + EQ-curve overlay) or the
// proven SpectrumAnalyzerPanel.  DEFAULT = ON, but the old panel remains
// the fallback (flag off, or the visualizer error-boundary trips).
//
// Decision order:
//   1. Runtime `window.__LOUI_LIVE_VISUALIZER__` (boolean) — explicit.
//   2. Build env `VITE_LOUI_LIVE_VISUALIZER` ('false'/'0' → off).
//   3. Default → ON.

declare global {
  interface Window {
    __LOUI_LIVE_VISUALIZER__?: boolean;
  }
  interface ImportMetaEnv {
    readonly VITE_LOUI_LIVE_VISUALIZER?: string;
  }
}

export function isLiveVisualizerEnabled(): boolean {
  if (typeof window !== 'undefined' && typeof window.__LOUI_LIVE_VISUALIZER__ === 'boolean') {
    return window.__LOUI_LIVE_VISUALIZER__;
  }
  const env = (import.meta.env?.VITE_LOUI_LIVE_VISUALIZER ?? '').toString().toLowerCase();
  if (env === 'false' || env === '0') return false;
  return true;
}
