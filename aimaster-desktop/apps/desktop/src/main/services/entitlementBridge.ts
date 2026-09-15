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
//
// ── Dormant, and this says so out loud ──────────────────────────────────────
//
// NOTHING READS THIS TODAY.  `getEntitlementPaid` has no callers: the export
// gate it was written for was removed when the build went free, and
// `license-free-selftest` now asserts that `fileHandlers.ts` does not consult
// licence or entitlement state at all.  The renderer still pushes a snapshot
// on every auth change, main still caches it, and the value goes nowhere.
//
// That is deliberate — `license-free-selftest` also holds that the licensing
// machinery stays put so that selling later is one word rather than a rebuild
// — but it is worth being exact about which word.  Turning the LICENCE half
// back on is `LICENSE_ENFORCED`, and `canProcess` is waiting for it.  Turning
// the ENTITLEMENT half back on takes three things, because its consumer was
// deleted rather than switched off:
//
//   1. `VITE_LOUI_ENTITLEMENT_GATE=true` (and account auth on), so the
//      renderer computes a real snapshot instead of the all-false default;
//   2. a gate in `fileHandlers.ts` that actually calls `getEntitlementPaid()`
//      — `paid = licensePaid || getEntitlementPaid()` was the shape;
//   3. the two selftests that currently forbid exactly that, updated in the
//      same commit: `export-gate-selftest` ("save handlers do not consult
//      licence or entitlement state") and `license-free-selftest` ("no export
//      path stops anyone — there is no gate left to read").
//
// An earlier version of this comment claimed step 2 was already done.  It was
// not, and a reader trusting it would have shipped a paywall with one half
// silently open.

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
 *
 * Default false.  No caller today — see the dormancy note at the top of this
 * file for what re-wiring it takes.  Kept, and named in `dead-exports`'
 * ALLOWED list, because deleting the only reader would leave `setEntitlement`
 * writing into nothing, which is a worse shape than an unread reader.
 */
export function getEntitlementPaid(): boolean {
  return _state.entitlementPaid === true && _state.deviceAllowed === true;
}
