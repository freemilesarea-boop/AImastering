// Guided "three picks" flow flag (PROTOTYPE-PORT T1).
//
// When ON, the Home route renders the new guided flow
// (Import → Choose → Mastering → Result) instead of the legacy HomePage
// queue/batch screen.  The legacy HomePage is NEVER removed — it stays
// reachable as the "batch mode" secondary entry (T10).
//
// DEFAULT = OFF.  This guarantees a one-switch rollback: with the flag off
// the app behaves exactly as before, so each port ticket can land safely
// behind it and be flipped on only when the whole flow is verified.
//
// Override order:
//   1. Runtime `window.__LOUI_GUIDED_FLOW__` (boolean).
//   2. Build env `VITE_LOUI_GUIDED_FLOW` ('true' / '1' → force on).
//   3. Default → OFF.

declare global {
  interface Window {
    __LOUI_GUIDED_FLOW__?: boolean;
  }
  interface ImportMetaEnv {
    readonly VITE_LOUI_GUIDED_FLOW?: string;
  }
}

export function isGuidedFlowEnabled(): boolean {
  if (typeof window !== 'undefined' && typeof window.__LOUI_GUIDED_FLOW__ === 'boolean') {
    return window.__LOUI_GUIDED_FLOW__;
  }
  const env = (import.meta.env?.VITE_LOUI_GUIDED_FLOW ?? '').toString().toLowerCase();
  if (env === 'true' || env === '1') return true;
  return false; // off by default — legacy HomePage stays the default route
}
