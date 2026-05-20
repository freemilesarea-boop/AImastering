// Loui Mastering — product-layout feature flag.
//
// The product layout (Ozone-style ProductPage) is the DEFAULT result
// screen as of M3-P-NEXT-6.  The legacy ResultPage is retained as a
// fallback and can be restored at runtime or build time.
//
// Decision order (first match wins):
//   1. Runtime override `window.__LOUI_PRODUCT_LAYOUT__` (true OR false)
//      — explicit, overrides everything.  Set `false` to force the
//        classic ResultPage.
//   2. Build-time env var `VITE_LOUI_PRODUCT_LAYOUT`:
//        'false' / '0' → disabled (classic ResultPage)
//        'true' / '1'  → enabled
//   3. Default → ENABLED (ProductPage).
//
// Rollback (any one of):
//   • Runtime: `window.__LOUI_PRODUCT_LAYOUT__ = false` + reload
//   • Build:   `VITE_LOUI_PRODUCT_LAYOUT=false`
//   • Error boundary auto-falls-back to ResultPage on a render crash.

declare global {
  interface Window {
    __LOUI_PRODUCT_LAYOUT__?: boolean;
  }
  interface ImportMetaEnv {
    readonly VITE_LOUI_PRODUCT_LAYOUT?: string;
  }
}

/** Whether the product-layout ProductPage should render (default: true). */
export function isProductLayoutEnabled(): boolean {
  // 1. Runtime override — explicit true OR false wins over everything.
  if (typeof window !== 'undefined' && typeof window.__LOUI_PRODUCT_LAYOUT__ === 'boolean') {
    return window.__LOUI_PRODUCT_LAYOUT__;
  }
  // 2. Build-time env — explicit opt-out / opt-in.
  const envFlag = (import.meta.env?.VITE_LOUI_PRODUCT_LAYOUT ?? '').toString().toLowerCase();
  if (envFlag === 'false' || envFlag === '0') return false;
  if (envFlag === 'true'  || envFlag === '1') return true;
  // 3. Default — ProductPage is the default result screen.
  return true;
}

/** Human-readable label for diagnostic logs. */
export function productLayoutLabel(): string {
  return isProductLayoutEnabled() ? 'ProductPage (Loui v2)' : 'ResultPage (legacy)';
}
