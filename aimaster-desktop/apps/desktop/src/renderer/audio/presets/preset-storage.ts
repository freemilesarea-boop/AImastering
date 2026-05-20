// Last-used preset persistence (M2-PRESET-TUNING).
//
// A tiny, dependency-free wrapper over localStorage so the preset browser
// can restore the user's last choice across sessions.  Safe in non-DOM
// environments (tests / SSR / worklet) — every access is guarded.

import { getPreset } from './loui-presets.js';

const STORAGE_KEY = 'loui.preset.lastUsed';

function store(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    // localStorage can throw in sandboxed / privacy modes.
    return null;
  }
}

/** Persist the last-used preset id.  No-op if storage is unavailable. */
export function setLastUsedPreset(id: string): void {
  const s = store();
  if (!s) return;
  try { s.setItem(STORAGE_KEY, id); } catch { /* quota / privacy — ignore */ }
}

/**
 * Read the last-used preset id, but only if it still resolves to a known
 * preset (a removed preset id returns null so callers fall back cleanly).
 */
export function getLastUsedPreset(): string | null {
  const s = store();
  if (!s) return null;
  try {
    const id = s.getItem(STORAGE_KEY);
    return id && getPreset(id) ? id : null;
  } catch {
    return null;
  }
}

/** Clear the stored preference (used by tests / "reset"). */
export function clearLastUsedPreset(): void {
  const s = store();
  if (!s) return;
  try { s.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}
