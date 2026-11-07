// Where the key-binding overrides live for React.
//
// A separate store rather than a field on the workspace, because this is the
// one piece of UI state that the DISPATCHER reads: the keydown listener is
// rebuilt when it changes, and burying that dependency in a store that also
// changes on every zoom and every panel toggle would rebuild the global key
// listener dozens of times a minute.
//
// The persistence lives in `shortcuts/key-overrides.ts`; this is the part
// React subscribes to.  Every mutator goes to disk FIRST and only updates the
// store if the write landed — a remap that is live until the next launch and
// then gone is worse than one that refused out loud.

import { create } from 'zustand';
import {
  applyPreset, clearAllOverrides, clearOverride, loadOverrides, planPreset, saveOverride,
  type Overrides, type PresetPlan, type SaveResult,
} from '../shortcuts/key-overrides.js';
import { findPreset } from '../shortcuts/keymap-presets.js';
import type { CommandId } from '../shortcuts/definitions.js';

export interface ShortcutState {
  overrides: Overrides;
  /** Re-read from storage — for a test, or after an import. */
  reload: () => void;
  setChords: (id: CommandId, chords: readonly string[]) => SaveResult;
  reset: (id: CommandId) => SaveResult;
  resetAll: () => SaveResult;
  /**
   * Switch the whole keyboard to a preset.
   *
   * Returns the plan as well as the result, because applying one takes keys
   * off other commands and the caller has to be able to say which — see
   * `planPreset`.
   */
  usePreset: (id: string) => SaveResult & { plan?: PresetPlan };
}

export const useShortcutStore = create<ShortcutState>((set) => ({
  overrides: loadOverrides(),
  reload: () => set({ overrides: loadOverrides() }),
  setChords: (id, chords) => {
    const result = saveOverride(id, chords);
    if (result.ok) set({ overrides: loadOverrides() });
    return result;
  },
  reset: (id) => {
    const result = clearOverride(id);
    if (result.ok) set({ overrides: loadOverrides() });
    return result;
  },
  usePreset: (id) => {
    const preset = findPreset(id);
    if (!preset) return { ok: false, reason: `알 수 없는 프리셋입니다 — ${id}` };
    const plan = planPreset(preset.bindings);
    if (plan.problem !== undefined) return { ok: false, reason: plan.problem };
    const result = applyPreset(preset.bindings);
    if (result.ok) set({ overrides: loadOverrides() });
    return { ...result, plan };
  },

  resetAll: () => {
    const result = clearAllOverrides();
    if (result.ok) set({ overrides: loadOverrides() });
    return result;
  },
}));
