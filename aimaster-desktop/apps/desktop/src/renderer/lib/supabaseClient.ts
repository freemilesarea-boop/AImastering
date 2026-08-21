// Supabase client for account auth (Phase A).
//
// Created from build-injected env (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).
// Renderer-side only; supabase-js persists the session in localStorage
// (persistSession + autoRefreshToken) so save/restore is automatic — no main
// process / IPC needed in Phase A.  Returns null when not configured (or the
// account-auth flag is off), so callers degrade gracefully and nothing in the
// existing license/export path is touched.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

declare global {
  interface ImportMetaEnv {
    readonly VITE_SUPABASE_URL?: string;
    readonly VITE_SUPABASE_ANON_KEY?: string;
  }
}

const URL = (import.meta.env?.VITE_SUPABASE_URL ?? '').toString();
const ANON = (import.meta.env?.VITE_SUPABASE_ANON_KEY ?? '').toString();

let _client: SupabaseClient | null = null;

/** Returns the configured Supabase client, or null when env is missing. */
export function getSupabase(): SupabaseClient | null {
  if (_client) return _client;
  if (!URL || !ANON) return null;
  _client = createClient(URL, ANON, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'loui-auth',
    },
  });
  return _client;
}

/** True when Supabase auth env is present (so the UI can show a useful state). */
export function isSupabaseConfigured(): boolean {
  return Boolean(URL && ANON);
}
