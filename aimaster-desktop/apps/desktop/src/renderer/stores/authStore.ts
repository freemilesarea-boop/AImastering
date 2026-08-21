// Account auth store (Phase A) — Supabase Auth session state.
//
// Scope: account creation/login + session save/restore/logout ONLY.  This
// store does NOT decide any paid-feature permission — the WAV-export gate is
// untouched (license-core).  Safe no-ops when Supabase isn't configured.
import { create } from 'zustand';
import type { Session, User } from '@supabase/supabase-js';
import { getSupabase, isSupabaseConfigured } from '../lib/supabaseClient.js';

export type AuthStatus = 'loading' | 'signed-out' | 'signed-in' | 'unconfigured';

interface AuthStore {
  status: AuthStatus;
  user: User | null;
  session: Session | null;
  busy: boolean;
  error: string | null;
  modalOpen: boolean;

  setModalOpen: (v: boolean) => void;
  /** Restore any persisted session + subscribe to auth changes. */
  init: () => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

function applySession(set: (p: Partial<AuthStore>) => void, session: Session | null): void {
  set({
    session,
    user: session?.user ?? null,
    status: session ? 'signed-in' : 'signed-out',
  });
}

export const useAuthStore = create<AuthStore>((set, _get) => ({
  status: 'loading',
  user: null,
  session: null,
  busy: false,
  error: null,
  modalOpen: false,

  setModalOpen: (v) => set({ modalOpen: v, error: null }),

  init: async () => {
    const sb = getSupabase();
    if (!sb) { set({ status: isSupabaseConfigured() ? 'signed-out' : 'unconfigured' }); return; }
    try {
      const { data } = await sb.auth.getSession();
      applySession(set, data.session ?? null);
      // Keep state in sync across refresh / token rotation / other tabs.
      sb.auth.onAuthStateChange((_event, session) => applySession(set, session));
    } catch (err) {
      set({ status: 'signed-out', error: (err as Error).message });
    }
  },

  signUp: async (email, password) => {
    const sb = getSupabase();
    if (!sb) { set({ error: '인증 서버가 설정되지 않았습니다.' }); return; }
    set({ busy: true, error: null });
    try {
      const { data, error } = await sb.auth.signUp({ email, password });
      if (error) throw error;
      applySession(set, data.session ?? null);
      // Note: when email confirmation is required, session is null until the
      // user confirms — the UI should surface that case.
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  signIn: async (email, password) => {
    const sb = getSupabase();
    if (!sb) { set({ error: '인증 서버가 설정되지 않았습니다.' }); return; }
    set({ busy: true, error: null });
    try {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      applySession(set, data.session ?? null);
      set({ modalOpen: false });
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  signInWithGoogle: async () => {
    const sb = getSupabase();
    if (!sb) { set({ error: '인증 서버가 설정되지 않았습니다.' }); return; }
    set({ busy: true, error: null });
    try {
      const redirectTo = typeof window !== 'undefined' ? window.location.origin : undefined;
      const { error } = await sb.auth.signInWithOAuth({
        provider: 'google',
        ...(redirectTo ? { options: { redirectTo } } : {}),
      });
      if (error) throw error;
      // Redirect-based flow; session is applied via onAuthStateChange on return.
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ busy: false });
    }
  },

  signOut: async () => {
    const sb = getSupabase();
    if (!sb) return;
    set({ busy: true, error: null });
    try {
      await sb.auth.signOut();
      applySession(set, null);
    } catch (err) {
      set({ error: (err as Error).message });
    } finally {
      set({ busy: false });
    }
  },
}));
