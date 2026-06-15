// Account-based auth feature flag (Phase A).
//
// When ON, the app mounts the Supabase-Auth account UI (login/signup +
// session restore).  Phase A is ADDITIVE ONLY — it never changes the
// paid-feature gate (WAV export still decided by license-core), payment,
// or any existing behavior.  DEFAULT = OFF so the app behaves exactly as
// today and rollback is a single switch.
//
// Override order:
//   1. Runtime `window.__LOUI_ACCOUNT_AUTH__` (boolean).
//   2. Build env `VITE_LOUI_ACCOUNT_AUTH` ('true' / '1' → on).
//   3. Default → OFF.

declare global {
  interface Window {
    __LOUI_ACCOUNT_AUTH__?: boolean;
    __LOUI_ENTITLEMENT_GATE__?: boolean;
  }
  interface ImportMetaEnv {
    readonly VITE_LOUI_ACCOUNT_AUTH?: string;
    readonly VITE_LOUI_ENTITLEMENT_GATE?: string;
  }
}

export function isAccountAuthEnabled(): boolean {
  if (typeof window !== 'undefined' && typeof window.__LOUI_ACCOUNT_AUTH__ === 'boolean') {
    return window.__LOUI_ACCOUNT_AUTH__;
  }
  const env = (import.meta.env?.VITE_LOUI_ACCOUNT_AUTH ?? '').toString().toLowerCase();
  if (env === 'true' || env === '1') return true;
  return false; // off by default — no effect on existing license/export flow
}

// Phase C — when ON (AND account auth ON), the entitlement result is included
// in the export gate additively: paid = licensePaid || entitlementPaid.
// DEFAULT OFF → gate stays license-only.
export function isEntitlementGateEnabled(): boolean {
  if (typeof window !== 'undefined' && typeof window.__LOUI_ENTITLEMENT_GATE__ === 'boolean') {
    return window.__LOUI_ENTITLEMENT_GATE__;
  }
  const env = (import.meta.env?.VITE_LOUI_ENTITLEMENT_GATE ?? '').toString().toLowerCase();
  if (env === 'true' || env === '1') return true;
  return false;
}
