/**
 * entitlement-gate-selftest — who may export, and the four switches around it.
 *
 * Five feature gates decide what the app is; one of them decides what the app
 * SELLS.  None of the five had a test.  The analyzer one has since been
 * pinned (`analyzer-factory-selftest`), and what was left was:
 *
 *   isRealtimePreviewEnabled   default ON   — whether the user HEARS the chain
 *   isGuidedFlowEnabled        default OFF  — which Home route renders
 *   isAccountAuthEnabled       default OFF  — whether the account UI mounts
 *   isEntitlementGateEnabled   default OFF  — whether entitlement counts
 *                                             toward the paid export gate
 *
 * The entitlement decision itself was written out inside an `App.tsx`
 * `useEffect`, so testing it meant mounting React and nobody did.  It is now
 * `entitlement-gate.ts` — the same branches, as a function — and this file
 * holds them, including the expiry asymmetry that is pinned rather than
 * fixed.  See that file's header for why a one-line tightening would be a
 * guess about billing.
 *
 * None of it gates anything today: this build ships free, and the export gate
 * that would read the entitlement snapshot was deleted (two other suites
 * forbid one reappearing without them).  That is the reason to pin the rule
 * now — it is the only moment when getting it wrong is free.
 *
 * Run:  pnpm --filter @aimaster/desktop test:entitlement-gate
 */

import {
  entitlementGateDecision, notExpired, PAID_PLANS, ACTIVE_STATUS,
  type EntitlementRow, type EntitlementGateInput,
} from '../src/renderer/audio/entitlement-gate.js';
import { isAccountAuthEnabled, isEntitlementGateEnabled } from '../src/renderer/audio/account-auth-flag.js';
import { isGuidedFlowEnabled } from '../src/renderer/audio/guided-flow-flag.js';
import { isRealtimePreviewEnabled, REALTIME_PREVIEW_LS_KEY } from '../src/renderer/audio/realtime-preview-flag.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(cond: unknown, detail: string): void { if (!cond) throw new Error(detail); }

const NOW = Date.UTC(2026, 0, 15);
const FUTURE = new Date(NOW + 86_400_000).toISOString();
const PAST = new Date(NOW - 86_400_000).toISOString();

function row(over: Partial<EntitlementRow> = {}): EntitlementRow {
  return { plan: 'pro_monthly', status: ACTIVE_STATUS, expiresAt: FUTURE, ...over };
}
/** Everything on, a signed-in user with a loaded pro row — the paying case. */
function input(over: Partial<EntitlementGateInput> = {}): EntitlementGateInput {
  return {
    accountAuth: true, gateOn: true, authStatus: 'signed-in', entStatus: 'loaded',
    entitlement: row(), now: NOW, ...over,
  };
}

// ── The decision ─────────────────────────────────────────────────────────

check('a signed-in active pro subscription may export', () => {
  const d = entitlementGateDecision(input());
  assert(d.push && d.paid, `push=${d.push} paid=${d.paid}`);
  assert(d.plan === 'pro_monthly' && d.status === ACTIVE_STATUS, `${d.plan}/${d.status}`);
});

check('with account auth OFF the bridge is never touched', () => {
  // The distinction that matters: main keeps its default and the export gate
  // is exactly license-only.  A `paid: false` PUSH would instead be this
  // code asserting an answer it never computed.
  const d = entitlementGateDecision(input({ accountAuth: false }));
  assert(d.push === false, 'the decision would have pushed with account auth off');
  assert(d.paid === false && d.plan === 'free' && d.status === 'free',
    `it reported ${d.plan}/${d.status} paid=${d.paid} for a flag that was never evaluated`);
});

check('each remaining precondition alone is enough to withhold paid', () => {
  // Every one of these is a way the real app arrives without an answer, and
  // each must land on "not paid" on its own — a gate that needs two failures
  // to deny is a gate that pays out on one.
  const alone: Array<[string, Partial<EntitlementGateInput>]> = [
    ['the entitlement gate flag is off', { gateOn: false }],
    ['the user is signed out',           { authStatus: 'signed-out' }],
    ['auth is still resolving',          { authStatus: 'idle' }],
    ['the entitlement never loaded',     { entStatus: 'idle' }],
    ['the entitlement fetch failed',     { entStatus: 'error' }],
    ['there is no entitlement row',      { entitlement: null }],
  ];
  for (const [label, over] of alone) {
    const d = entitlementGateDecision(input(over));
    assert(d.push === true, `${label}: should still push (account auth is on)`);
    assert(d.paid === false, `${label}: paid anyway`);
  }
  // `entStatus: 'error'` is the one worth naming: the store keeps the CACHED
  // row on a failed refresh, so this is the offline case.  Pro is withheld
  // until a refresh succeeds — conservative, and deliberate.
  const offline = entitlementGateDecision(input({ entStatus: 'error' }));
  assert(offline.paid === false, 'a cached row after a failed refresh paid out');
});

check('only the listed plans sell, and only the active status', () => {
  for (const plan of PAID_PLANS) {
    assert(entitlementGateDecision(input({ entitlement: row({ plan }) })).paid === true, `${plan} did not pay`);
  }
  for (const plan of ['free', 'pro_yearly', 'PRO_MONTHLY', 'trial', '']) {
    assert(entitlementGateDecision(input({ entitlement: row({ plan }) })).paid === false,
      `plan "${plan}" paid out — a plan id nobody listed must read as free`);
  }
  for (const status of ['free', 'past_due', 'canceled', 'expired', 'refunded', 'Active', '']) {
    assert(entitlementGateDecision(input({ entitlement: row({ status }) })).paid === false,
      `status "${status}" paid out`);
  }
});

check('an expiry in the past withholds it, one in the future does not', () => {
  assert(entitlementGateDecision(input({ entitlement: row({ expiresAt: PAST }) })).paid === false, 'an expired row paid out');
  assert(entitlementGateDecision(input({ entitlement: row({ expiresAt: FUTURE }) })).paid === true, 'a live row did not pay');
  // The boundary, both sides of the same millisecond.
  assert(notExpired(new Date(NOW + 1).toISOString(), NOW) === true, 'one ms in the future read as expired');
  assert(notExpired(new Date(NOW).toISOString(), NOW) === false, 'the exact instant read as live');
});

check('and the expiry asymmetry is what it is — pinned, not fixed', () => {
  // Recorded so a change to it is a decision somebody made.  `null` means
  // lifetime; so do `''` and anything else falsy, while an unparseable date
  // means expired.  No reading of the field justifies both — see the
  // header of entitlement-gate.ts.  Whether it matters depends on whether
  // the server's `status` is the authority, which this repo cannot answer.
  assert(notExpired(null, NOW) === true, 'null stopped meaning lifetime');
  assert(notExpired('' as unknown as string, NOW) === true,
    'empty expiry no longer reads as lifetime — if that was deliberate, say so here');
  assert(notExpired('next tuesday', NOW) === false, 'an unparseable expiry stopped reading as expired');
  assert(notExpired('   ', NOW) === false, 'a whitespace expiry stopped reading as expired');
  // The pair that shows the asymmetry in one line.
  assert(notExpired('', NOW) !== notExpired('   ', NOW),
    'the two empty-ish expiries now agree — the asymmetry was fixed, so fix this check and the header too');
});

// ── The four switches ────────────────────────────────────────────────────
//
// Each case rebuilds the environment: sharing one store leaks the previous
// override into the next, and a leak reads as a pass.
const g = globalThis as unknown as Record<string, unknown>;
function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => { m.clear(); },
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  } as unknown as Storage;
}
function fresh(): { win: Record<string, unknown>; ls: Storage } {
  const win: Record<string, unknown> = {};
  const ls = memStorage();
  g['window'] = win;
  g['localStorage'] = ls;
  return { win, ls };
}

check('the commercial flags ship OFF, so a build sells nothing by accident', () => {
  fresh();
  assert(isAccountAuthEnabled() === false, 'account auth defaults ON — the account UI would mount for everyone');
  assert(isEntitlementGateEnabled() === false,
    'the entitlement gate defaults ON — entitlement would count toward the paid export gate unasked');
});

check('and the guided flow ships OFF, so the Home route does not move', () => {
  fresh();
  assert(isGuidedFlowEnabled() === false, 'the guided flow defaults ON — Home would render the new route');
});

check('the realtime preview ships ON, because the preview is the product', () => {
  // It was hard-disabled once, as a confirmed renderer-crash source.  The
  // loop was removed at the source and the flag turned back on; if it ever
  // reads OFF by default again, the user hears nothing and this says so.
  fresh();
  assert(isRealtimePreviewEnabled() === true, 'the realtime preview defaults OFF — the user would hear no chain');
});

check('each flag honours its own runtime override, and only its own', () => {
  const cases: Array<[string, string, () => boolean]> = [
    ['__LOUI_ACCOUNT_AUTH__', 'account auth', isAccountAuthEnabled],
    ['__LOUI_ENTITLEMENT_GATE__', 'entitlement gate', isEntitlementGateEnabled],
    ['__LOUI_GUIDED_FLOW__', 'guided flow', isGuidedFlowEnabled],
  ];
  for (const [key, label, fn] of cases) {
    const { win } = fresh();
    win[key] = true;
    assert(fn() === true, `${label}: window.${key} = true did not turn it on`);
    // And it must not move any of the others.
    for (const [, otherLabel, otherFn] of cases.filter(([k]) => k !== key)) {
      assert(otherFn() === false, `${label}'s override also turned on ${otherLabel}`);
    }
    win[key] = false;
    assert(fn() === false, `${label}: window.${key} = false did not turn it off`);
  }
  // The realtime one is the opt-OUT shape, so `false` is what it reads.
  const { win } = fresh();
  win['__LOUI_REALTIME_PREVIEW__'] = false;
  assert(isRealtimePreviewEnabled() === false, 'the realtime preview override did not turn it off');
});

check('the realtime preview also reads its localStorage key, both ways', () => {
  for (const v of ['false', '0']) {
    const { ls } = fresh();
    ls.setItem(REALTIME_PREVIEW_LS_KEY, v);
    assert(isRealtimePreviewEnabled() === false, `'${v}' did not turn it off`);
  }
  for (const v of ['true', '1']) {
    const { ls } = fresh();
    ls.setItem(REALTIME_PREVIEW_LS_KEY, v);
    assert(isRealtimePreviewEnabled() === true, `'${v}' did not turn it on`);
  }
  // Anything else is not an instruction, and must leave the default alone.
  for (const v of ['off', 'no', 'yes', '']) {
    const { ls } = fresh();
    ls.setItem(REALTIME_PREVIEW_LS_KEY, v);
    assert(isRealtimePreviewEnabled() === true, `'${v}' was read as an instruction`);
  }
});

check('a runtime override outranks the stored one, as the docblock says', () => {
  // `window` first, then `localStorage` — so a QA session can force the
  // opposite of whatever a previous session persisted.
  const { win, ls } = fresh();
  ls.setItem(REALTIME_PREVIEW_LS_KEY, 'false');
  win['__LOUI_REALTIME_PREVIEW__'] = true;
  assert(isRealtimePreviewEnabled() === true, 'the stored value outranked the runtime override');
});

delete g['window'];
delete g['localStorage'];
console.log('');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
