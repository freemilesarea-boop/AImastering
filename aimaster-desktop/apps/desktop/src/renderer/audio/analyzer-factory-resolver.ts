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
import { isEnabled as isSafeBootEnabled } from './safe-boot-flags.js';

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
 * The real WASM meter engine is the DEFAULT — the Spectrum / Loudness /
 * Stereo panels are core product features and must show real analysis of
 * the playing audio (never mock data).  The synthetic factory is a
 * dev-only opt-OUT, requested explicitly.
 *
 * Decision order:
 *   1. explicit OFF — env `VITE_LOUI_WASM_ANALYZER=false` /
 *      `window.__LOUI_WASM_ANALYZER__ === false` /
 *      `localStorage['loui.wasmAnalyzer'] = 'false'`  → synthetic (dev).
 *   2. safe-boot crash-hunt gate: `safe-boot-flags.wasmAnalyzer === false`
 *      (sessionStorage-backed kill switch reachable from DevTools as
 *      `window.__SAFE_BOOT__.enableWasmAnalyzer()` / disable equivalents)
 *      → synthetic.  This collapses two previously-independent gates into
 *      one, so a single safe-boot toggle disables BOTH the panel-stack
 *      provider and the AnalyzerSession factory.
 *   3. otherwise → ON (real WASM analyzer).
 */
export function isWasmAnalyzerEnabled(): boolean {
  const envFlag = (import.meta.env?.VITE_LOUI_WASM_ANALYZER ?? '').toString().toLowerCase();
  if (envFlag === 'false' || envFlag === '0') return false;
  if (typeof window !== 'undefined' && window.__LOUI_WASM_ANALYZER__ === false) return false;
  try {
    if (typeof localStorage !== 'undefined') {
      const v = localStorage.getItem(WASM_ANALYZER_LS_KEY);
      if (v === 'false' || v === '0') return false;
    }
  } catch { /* ignore */ }
  // Safe-boot kill switch — defaults to OFF for the wasmAnalyzer flag in
  // safe-boot-flags.DEFAULT_ENABLED, so this is the active gate during
  // crash-hunt sessions until the user explicitly toggles it on.
  try {
    if (!isSafeBootEnabled('wasmAnalyzer')) return false;
  } catch { /* sessionStorage not available — fall through to ON */ }
  return true;
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
