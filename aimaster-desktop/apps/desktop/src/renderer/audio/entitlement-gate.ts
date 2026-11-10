// The entitlement half of the export gate, as a decision instead of an effect.
//
// WHY IT IS A FUNCTION.  This rule decides who may export a WAV, and it lived
// inline in an `App.tsx` `useEffect` — so nothing could test it without
// mounting React, and nothing did.  The repo already settled the pattern for
// a rule with consequences: `pythonFallbackMayStandIn` is "a pure predicate
// rather than a condition inlined in the IPC handler, so the rule can be
// tested without an Electron main process".  Same reason, higher stakes.
//
// This is a MOVE, not a change.  Every branch below is the one `App.tsx` ran,
// including the parts worth arguing about, because the thing a commercial
// rule most needs is to stop changing by accident.
//
// ── The expiry asymmetry, recorded rather than fixed ─────────────────────
//
// `notExpired` is `!expiresAt || new Date(expiresAt).getTime() > now`.  Run
// against the values the field's own type (`string | null`) permits:
//
//   null            → lifetime      PAID
//   undefined       → lifetime      PAID
//   ''              → lifetime      PAID        ← present, but read as absent
//   0               → lifetime      PAID        ← same
//   '   '           → NaN > now     not paid
//   'next tuesday'  → NaN > now     not paid
//   past ISO        → false         not paid
//   future ISO      → true          PAID
//
// So an empty expiry means "never expires" and an unparseable one means
// "expired already", and no reading of the field justifies both.  Whether it
// MATTERS depends on something this repository cannot answer: if the server's
// `status` is the authority (an ended subscription comes back `expired` /
// `canceled`) then the expiry check is belt-and-braces and `''` costs
// nothing; if `expiresAt` is load-bearing, a `pro_monthly` row carrying `''`
// is paid forever.  The entitlement row is built by a Supabase function that
// is not in this tree.
//
// How much it matters TODAY: nothing.  `entitlementBridge.ts` does not
// re-check expiry — it takes `paid === true` off the IPC and stores it — but
// it also has no consumer: the export gate that would have called
// `getEntitlementPaid()` was deleted, and two selftests
// (`export-gate-selftest`, `license-free-selftest`) currently FORBID one
// reappearing.  This build ships free, so the value computed here goes
// nowhere and an empty expiry costs nobody anything.
//
// It matters the moment that changes.  The bridge's own header lists the
// three steps to turn the entitlement half back on, and step 2 is adding
// that gate.  On the day it lands, this expression becomes the only expiry
// check in the app, with no second line of defence — so the asymmetry is
// recorded now, while it is free to be wrong, rather than found later by a
// customer.
//
// (An earlier version of this paragraph said the stakes were live, which
// overstated it by leaving out the missing consumer.)
//
// Tightening it would be a one-line change and a guess about billing — and
// guessing wrong revokes paying users, which is worse than the hole it
// closes.  So the behaviour is pinned as it is, the asymmetry is named here
// and in `entitlement-gate-selftest`, and the question goes to whoever owns
// the server contract: does an ended `pro_monthly` come back with `status`
// flipped, or only with `expiresAt` in the past?

/** The entitlement row as the store holds it (plan/status deliberately loose —
 *  they are server strings, and a value nobody listed must not read as pro). */
export interface EntitlementRow {
  plan: string;
  status: string;
  expiresAt: string | null;
}

/** Everything the decision reads.  No stores, no window, no clock. */
export interface EntitlementGateInput {
  /** `isAccountAuthEnabled()` — Phase A. */
  accountAuth: boolean;
  /** `isEntitlementGateEnabled()` — Phase C. */
  gateOn: boolean;
  /** `authStore.status` */
  authStatus: string;
  /** `entitlementStore.status` */
  entStatus: string;
  entitlement: EntitlementRow | null;
  /** Injected so an expiry boundary is a test, not a race. */
  now: number;
}

export interface EntitlementGateDecision {
  /**
   * Whether the main process is told anything at all.
   *
   * With account auth OFF the effect returns before touching the bridge, so
   * main keeps its default `false` and the export gate is exactly
   * license-only.  That is a different outcome from "we pushed paid: false",
   * and collapsing the two would make the flag look like it had been
   * evaluated when it never was.
   */
  push: boolean;
  paid: boolean;
  plan: string;
  status: string;
}

/** The plans that count as paid.  A plan id nobody listed is free — adding
 *  one here is the deliberate act of making it sell. */
export const PAID_PLANS: readonly string[] = ['pro_monthly', 'pro_lifetime'];

/** The one `status` that counts. */
export const ACTIVE_STATUS = 'active';

/** `App.tsx`'s expression, unchanged.  See the asymmetry note in the header. */
export function notExpired(expiresAt: EntitlementRow['expiresAt'], now: number): boolean {
  return !expiresAt || new Date(expiresAt).getTime() > now;
}

export function entitlementGateDecision(i: EntitlementGateInput): EntitlementGateDecision {
  if (!i.accountAuth) return { push: false, paid: false, plan: 'free', status: 'free' };

  let paid = false;
  let plan = 'free';
  let status = 'free';
  if (i.gateOn && i.authStatus === 'signed-in' && i.entStatus === 'loaded' && i.entitlement) {
    plan = i.entitlement.plan;
    status = i.entitlement.status;
    paid = status === ACTIVE_STATUS
      && PAID_PLANS.includes(plan)
      && notExpired(i.entitlement.expiresAt, i.now);
  }
  return { push: true, paid, plan, status };
}
