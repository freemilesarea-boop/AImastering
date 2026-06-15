// Entitlement store (Phase B) — reads the account's entitlement.
//
// SCOPE: query + cache only.  This is NOT wired to the WAV-export gate
// (that stays license-core, Phase C).  Therefore an entitlement outage can
// never block a paying license user's export.  Safe no-ops when Supabase
// isn't configured / user isn't signed in.
import { create } from 'zustand';
import { getSupabase } from '../lib/supabaseClient.js';

export interface Entitlement {
  plan: string;            // 'free' | 'pro_monthly' | 'pro_lifetime'
  status: string;          // 'free' | 'active' | 'past_due' | 'canceled' | 'expired' | 'refunded'
  expiresAt: string | null;
  provider: string;        // 'paddle' | 'app_store' | 'play_billing' | 'revenuecat' | 'manual'
  isPro: boolean;          // server-computed (display only in Phase B)
}

const CACHE_KEY = 'loui-entitlement';

function readCache(): Entitlement | null {
  try { const r = localStorage.getItem(CACHE_KEY); return r ? (JSON.parse(r) as Entitlement) : null; }
  catch { return null; }
}
function writeCache(e: Entitlement | null): void {
  try { if (e) localStorage.setItem(CACHE_KEY, JSON.stringify(e)); else localStorage.removeItem(CACHE_KEY); }
  catch { /* ignore */ }
}

interface EntitlementStore {
  entitlement: Entitlement | null;
  status: 'idle' | 'loading' | 'loaded' | 'error';
  error: string | null;
  /** Load last-known entitlement from cache (offline-friendly display). */
  loadCache: () => void;
  /** Fetch the current user's entitlement from aimaster-entitlement edge fn. */
  refresh: () => Promise<void>;
  /** Clear on sign-out. */
  clear: () => void;
  /** Claim an existing license key into the signed-in account (D1). */
  claim: (key: string) => Promise<{ ok: boolean; code?: string }>;
}

export const useEntitlementStore = create<EntitlementStore>((set) => ({
  entitlement: null,
  status: 'idle',
  error: null,

  loadCache: () => {
    const c = readCache();
    if (c) set({ entitlement: c, status: 'loaded' });
  },

  refresh: async () => {
    const sb = getSupabase();
    if (!sb) { set({ status: 'idle' }); return; }
    const { data: sess } = await sb.auth.getSession();
    if (!sess?.session) { set({ entitlement: null, status: 'idle' }); writeCache(null); return; }

    set({ status: 'loading', error: null });
    try {
      // functions.invoke automatically attaches the user's JWT.
      const { data, error } = await sb.functions.invoke('aimaster-entitlement');
      if (error) throw error;
      const e = data as Entitlement;
      set({ entitlement: e, status: 'loaded', error: null });
      writeCache(e);
    } catch (err) {
      // Offline / server error: keep the cached value for DISPLAY only.
      const cached = readCache();
      set({ entitlement: cached, status: 'error', error: (err as Error).message });
    }
  },

  clear: () => { set({ entitlement: null, status: 'idle', error: null }); writeCache(null); },

  claim: async (key: string) => {
    const sb = getSupabase();
    if (!sb) return { ok: false, code: 'unconfigured' };
    try {
      // User-facing failures (not_found / already_claimed / expired /
      // invalid_status) return HTTP 200 → arrive as `data`; server/auth errors
      // arrive as `error`.
      const { data, error } = await sb.functions.invoke('aimaster-claim-license', {
        body: { key: key.trim().toUpperCase() },
      });
      if (error) return { ok: false, code: 'server_error' };
      const res = (data ?? {}) as { ok?: boolean; code?: string };
      if (res.ok) {
        await useEntitlementStore.getState().refresh();
        return { ok: true };
      }
      return { ok: false, code: res.code ?? 'server_error' };
    } catch {
      return { ok: false, code: 'server_error' };
    }
  },
}));
