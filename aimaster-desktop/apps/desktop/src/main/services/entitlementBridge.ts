// Entitlement bridge (Phase C/D2) — main-process cache of the renderer's
// entitlement + device gate decision.
//
// The renderer pushes ONLY a derived, non-sensitive snapshot via the
// `entitlement:set` IPC — { paid(entitlementPaid), deviceAllowed, plan,
// status } — and ONLY when both feature flags are ON.  No JWT / email / token
// ever crosses this boundary.
//
// Gate value = entitlementPaid && deviceAllowed (D2).  Defaults to false, so
// when nothing is pushed (flags OFF, signed out, fetch/register failed) the
// export gate degrades to license-only — a paying license user is never
// blocked by an entitlement or device-limit outage.

export interface EntitlementSnapshot {
  entitlementPaid: boolean;  // active pro plan
  deviceAllowed: boolean;    // current device registered within the <=2 limit
  plan: string;              // non-sensitive ('free' | 'pro_monthly' | 'pro_lifetime')
  status: string;            // non-sensitive ('free' | 'active' | ...)
}

let _state: EntitlementSnapshot = {
  entitlementPaid: false,
  deviceAllowed: false,
  plan: 'free',
  status: 'free',
};

/** Replace the cached snapshot (called from the entitlement:set IPC). */
export function setEntitlement(next: {
  paid?: unknown; deviceAllowed?: unknown; plan?: unknown; status?: unknown;
}): void {
  _state = {
    entitlementPaid: next.paid === true,
    deviceAllowed: next.deviceAllowed === true,
    plan: typeof next.plan === 'string' ? next.plan : 'free',
    status: typeof next.status === 'string' ? next.status : 'free',
  };
}

/**
 * The entitlement contribution to the export gate:
 *   entitlementPaid && deviceAllowed
 * Default false.  fileHandlers does `license || getEntitlementPaid()`, so the
 * full gate is `paid = licensePaid || (entitlementPaid && deviceAllowed)`.
 */
export function getEntitlementPaid(): boolean {
  return _state.entitlementPaid === true && _state.deviceAllowed === true;
}

/** Non-sensitive snapshot for diagnostics. */
export function getEntitlementSnapshot(): EntitlementSnapshot {
  return { ..._state };
}
