// Resolve which AnalyzerSessionFactory to use at runtime.
//
// Decision order:
//   1. The caller passed an explicit factory → use it.
//   2. Build-time env var `VITE_LOUI_WASM_ANALYZER` is `'true'` → WASM factory.
//   3. Runtime override on `window.__LOUI_WASM_ANALYZER__` → WASM factory.
//   4. Default → SyntheticAnalyzerSessionFactory (dev-only).
//
// This single switch is the production-safety net: production builds set
// the env var, dev / smoke tests stick to synthetic, and a power-user
// can force one or the other via the window override.

import type { AnalyzerSessionFactory } from '@aimaster/shared-types/streaming';

import { SyntheticAnalyzerSessionFactory } from './analyzer-session-synthetic.js';
import { WasmAnalyzerSessionFactory } from './wasm-analyzer-session.js';
import { isRealtimePreviewEnabled } from './realtime-preview-flag.js';

declare global {
  interface Window {
    __LOUI_WASM_ANALYZER__?: boolean;
  }
  interface ImportMetaEnv {
    readonly VITE_LOUI_WASM_ANALYZER?: string;
  }
}

/** localStorage key for the persisted WASM-analyzer toggle. */
export const WASM_ANALYZER_LS_KEY = 'loui.wasmAnalyzer';

// Both factories are constructed eagerly so Vite's tree-shaker keeps the
// WasmAnalyzerSessionFactory + analyzer-tap.worklet.js asset reference
// in the bundle even when the build-time env var is unset.  The runtime
// switch is purely an instance handoff — no construction cost beyond
// what an idle factory holds (zero — both factories are stateless until
// `create()`).
const wasmFactory: WasmAnalyzerSessionFactory = new WasmAnalyzerSessionFactory();
const syntheticFactory: SyntheticAnalyzerSessionFactory = new SyntheticAnalyzerSessionFactory();

/**
 * Whether the WASM analyzer session is active.
 *
 * Decision order:
 *   1. env `VITE_LOUI_WASM_ANALYZER`
 *   2. runtime `window.__LOUI_WASM_ANALYZER__`
 *   3. persisted `localStorage['loui.wasmAnalyzer']`
 *   4. **realtime-preview dependency** — the realtime mastering graph
 *      rides on this session (via `setInsertNode`), so enabling realtime
 *      preview implies the analyzer session must run.
 *   5. default → OFF.
 */
export function isWasmAnalyzerEnabled(): boolean {
  const envFlag = (import.meta.env?.VITE_LOUI_WASM_ANALYZER ?? '').toString().toLowerCase();
  if (envFlag === 'true' || envFlag === '1') return true;
  if (typeof window !== 'undefined' && window.__LOUI_WASM_ANALYZER__ === true) return true;
  try {
    if (typeof localStorage !== 'undefined') {
      const v = localStorage.getItem(WASM_ANALYZER_LS_KEY);
      if (v === 'true' || v === '1') return true;
      if (v === 'false' || v === '0') return false;
    }
  } catch { /* ignore */ }
  // Realtime preview requires the WASM analyzer session it splices into.
  if (isRealtimePreviewEnabled()) return true;
  return false;
}

/** Return the active factory. */
export function resolveAnalyzerFactory(): AnalyzerSessionFactory {
  return isWasmAnalyzerEnabled() ? wasmFactory : syntheticFactory;
}

/**
 * Diagnostic — returns a human-readable label for the active factory.
 * Used by the dev panel header so testers can confirm at a glance which
 * path their UI is consuming.
 */
export function analyzerFactoryLabel(): string {
  return isWasmAnalyzerEnabled() ? 'WASM (loui-dsp)' : 'Synthetic (dev only)';
}
