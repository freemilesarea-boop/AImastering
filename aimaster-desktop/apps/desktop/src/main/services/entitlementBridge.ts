// Entitlement bridge (Phase C) — main-process cache of the renderer's
// entitlement GATE decision.
//
// The entitlement itself is fetched in the renderer (Supabase + user JWT).
// The renderer pushes ONLY a derived, non-sensitive snapshot here via the
// `entitlement:set` IPC — { paid, plan, status } — and ONLY when both feature
// flags are ON and the plan is an active pro plan.  No JWT / email / token
// ever crosses this boundary.
//
// Default state is `paid:false`, so when nothing is pushed (flags OFF, signed
// out, fetch failed) the export gate degrades to license-only — a paying
// license user is never blocked by an entitlement outage.

export interface EntitlementSnapshot {
  paid: boolean;
  plan: string;    // non-sensitive ('free' | 'pro_monthly' | 'pro_lifetime')
  status: string;  // non-sensitive ('free' | 'active' | ...)
}

let _state: EntitlementSnapshot = { paid: false, plan: 'free', status: 'free' };

/** Replace the cached entitlement snapshot (called from the entitlement:set IPC). */
export function setEntitlement(next: Partial<EntitlementSnapshot>): void {
  _state = {
    paid: next.paid === true,
    plan: typeof next.plan === 'string' ? next.plan : 'free',
    status: typeof next.status === 'string' ? next.status : 'free',
  };
}

/** True only when the renderer pushed an active-pro entitlement. Default false. */
export function getEntitlementPaid(): boolean {
  return _state.paid === true;
}

/** Non-sensitive snapshot for diagnostics. */
export function getEntitlementSnapshot(): EntitlementSnapshot {
  return { ..._state };
}
