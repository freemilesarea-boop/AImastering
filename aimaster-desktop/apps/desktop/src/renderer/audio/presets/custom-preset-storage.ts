// User-saved presets (Phase 2 UX).
//
// Stores user-created snapshots of the central parameter state in
// localStorage under `loui.presets.user`.  A custom preset captures the
// full all-modules state (every numeric / boolean / enum / bypass) so
// loading it is a single state replacement — undoable via Cmd/Ctrl+Z.
//
// Schema:
//   {
//     version: 1,
//     items: [
//       { id, name, createdAt, state }     // state = AllModulesParameterState
//     ]
//   }
//
// Safe in non-DOM environments (every storage call is guarded).  Keys are
// short v4-ish ids so multiple presets with the same display name coexist.

import type { AllModulesParameterState } from '../parameters/parameter-state.js';

const STORAGE_KEY = 'loui.presets.user';
const SCHEMA_VERSION = 1;
const MAX_PRESETS = 100;
const MAX_NAME_LEN = 60;

export interface CustomPreset {
  id: string;
  name: string;
  /** Epoch ms when the preset was saved. */
  createdAt: number;
  state: AllModulesParameterState;
}

interface StoredEnvelope {
  version: number;
  items: CustomPreset[];
}

function store(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch { return null; }
}

function readEnvelope(): StoredEnvelope {
  const s = store();
  if (!s) return { version: SCHEMA_VERSION, items: [] };
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return { version: SCHEMA_VERSION, items: [] };
    const parsed = JSON.parse(raw) as StoredEnvelope | null;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
      return { version: SCHEMA_VERSION, items: [] };
    }
    // Defensive: drop items that look malformed (no name / no state).
    const items = parsed.items.filter((it): it is CustomPreset =>
      !!it && typeof it.id === 'string' && typeof it.name === 'string'
      && typeof it.createdAt === 'number' && !!it.state && typeof it.state === 'object',
    );
    return { version: SCHEMA_VERSION, items };
  } catch {
    return { version: SCHEMA_VERSION, items: [] };
  }
}

function writeEnvelope(env: StoredEnvelope): void {
  const s = store();
  if (!s) return;
  try { s.setItem(STORAGE_KEY, JSON.stringify(env)); } catch { /* quota / privacy — ignore */ }
}

function newId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `user-${Date.now().toString(36)}-${rand}`;
}

/** Sanitise a user-typed name: trim, collapse whitespace, cap length. */
export function sanitisePresetName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
}

/** List all custom presets (newest first). */
export function listCustomPresets(): CustomPreset[] {
  const env = readEnvelope();
  return env.items.slice().sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Save a new custom preset.  Returns the stored entry (with its generated
 * id + timestamp).  Returns `null` if the name is empty after sanitisation.
 */
export function saveCustomPreset(name: string, state: AllModulesParameterState): CustomPreset | null {
  const clean = sanitisePresetName(name);
  if (!clean) return null;
  const env = readEnvelope();
  const entry: CustomPreset = {
    id: newId(),
    name: clean,
    createdAt: Date.now(),
    // Deep clone via JSON to detach from React state references.
    state: JSON.parse(JSON.stringify(state)) as AllModulesParameterState,
  };
  env.items.push(entry);
  // Enforce cap: drop the oldest entry if over limit.
  if (env.items.length > MAX_PRESETS) {
    env.items.sort((a, b) => a.createdAt - b.createdAt);
    env.items = env.items.slice(env.items.length - MAX_PRESETS);
  }
  writeEnvelope(env);
  return entry;
}

/** Remove a custom preset by id.  Returns true if something was removed. */
export function deleteCustomPreset(id: string): boolean {
  const env = readEnvelope();
  const before = env.items.length;
  env.items = env.items.filter((p) => p.id !== id);
  if (env.items.length === before) return false;
  writeEnvelope(env);
  return true;
}

/** Rename a custom preset.  Returns the updated entry, or null if not found / invalid name. */
export function renameCustomPreset(id: string, nextName: string): CustomPreset | null {
  const clean = sanitisePresetName(nextName);
  if (!clean) return null;
  const env = readEnvelope();
  const idx = env.items.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  env.items[idx] = { ...env.items[idx]!, name: clean };
  writeEnvelope(env);
  return env.items[idx]!;
}
