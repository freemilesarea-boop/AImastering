// Loui Mastering — product-layout feature flag.
//
// Mirrors the WASM analyzer flag pattern in `analyzer-factory-resolver.ts`.
// The product layout (Ozone-style ProductPage) ships behind this flag
// throughout M3-P-NEXT-3.  Default = OFF, ResultPage remains the
// rendered page for the `result` slot.
//
// Decision order:
//   1. Build-time env var `VITE_LOUI_PRODUCT_LAYOUT` is `'true'` → enabled.
//   2. Runtime override on `window.__LOUI_PRODUCT_LAYOUT__` → enabled.
//   3. Default → disabled (ResultPage as before).
//
// Rollback: clear the env var / set the runtime flag to `false` — the
// app immediately falls back to ResultPage with zero behavioural drift.

declare global {
  interface Window {
    __LOUI_PRODUCT_LAYOUT__?: boolean;
  }
  interface ImportMetaEnv {
    readonly VITE_LOUI_PRODUCT_LAYOUT?: string;
  }
}

/** Whether the product-layout ProductPage has been requested. */
export function isProductLayoutEnabled(): boolean {
  const envFlag = (import.meta.env?.VITE_LOUI_PRODUCT_LAYOUT ?? '').toString().toLowerCase();
  if (envFlag === 'true' || envFlag === '1') return true;
  if (typeof window !== 'undefined' && window.__LOUI_PRODUCT_LAYOUT__ === true) return true;
  return false;
}

/** Human-readable label for diagnostic logs. */
export function productLayoutLabel(): string {
  return isProductLayoutEnabled() ? 'ProductPage (Loui v2)' : 'ResultPage (legacy)';
}
