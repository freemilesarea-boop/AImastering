// Resolve which AnalyzerSessionFactory to use at runtime.
//
// The real WASM analyzer is the DEFAULT, and every gate below is an
// opt-OUT.  `isWasmAnalyzerEnabled()` has the decision order; this header
// used to carry a second, opposite copy of it —
//
//   "2. Build-time env var `VITE_LOUI_WASM_ANALYZER` is 'true' → WASM
//    factory. … 4. Default → SyntheticAnalyzerSessionFactory (dev-only).
//    … production builds set the env var, dev / smoke tests stick to
//    synthetic"
//
// — which was false in every clause: the env var is read only for 'false'
// and '0', a production build needs no env var at all, and a fresh boot
// with nothing set resolves to WASM.  It described the switch before the
// default was inverted, in the file that decides whether a user's meters
// are real.  `analyzer-factory-selftest` now drives each gate and pins the
// answers, because the next reader who makes the code match a comment like
// that ships fabricated meters to everyone.

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
  // Safe-boot kill switch — `safe-boot-flags.DEFAULT_ENABLED` ships
  // `{ wasmAnalyzer: true }`, so this gate is open unless somebody closes it
  // from DevTools (`window.__SAFE_BOOT__.disableWasmAnalyzer()`).  It used to
  // say the flag "defaults to OFF … until the user explicitly toggles it on",
  // which was true while the dlmalloc panic was being cornered and stopped
  // being true when that was fixed at the source.  Had it still been OFF,
  // every boot would have resolved to synthetic — so this is the one comment
  // in the file whose being stale was indistinguishable from the bug.
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
