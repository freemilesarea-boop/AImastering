// Finding a command by typing part of it.
//
// The "?" overlay has searched the table by label, note and key since it was
// built.  The palette needs the same search, and a second copy of it is how
// two surfaces start disagreeing about whether a remapped key is findable —
// the exact failure this codebase has now been bitten by in the session save,
// the WAV export and the MIDI import.  So the search is one function and both
// surfaces call it.
//
// Key matching goes through `describeSpec`, which is what the person actually
// SEES on screen (⌘⌥F on a Mac, Ctrl+Alt+F on Windows), so typing what is
// printed on the chip finds the row.  And it goes through `effectiveChords`,
// so a student who remapped 프리즈 finds it by THEIR key, not the factory one.

import { SHORTCUTS, type ShortcutDef } from './definitions.js';
import { describeSpec, effectiveChords, type Overrides } from './key-overrides.js';
import type { Platform } from './keys.js';

/** Does this command answer to `needle`?  `needle` must already be lowercase. */
export function commandMatches(
  def: ShortcutDef,
  needle: string,
  overrides: Overrides,
  platform: Platform,
): boolean {
  if (needle === '') return true;
  if (def.label.toLowerCase().includes(needle)) return true;
  if (def.note.toLowerCase().includes(needle)) return true;
  return effectiveChords(def, overrides)
    .some((spec) => describeSpec(spec, platform).toLowerCase().includes(needle));
}

/**
 * The commands that answer to `query`, in table order.
 *
 * Table order rather than a relevance score on purpose: the table is grouped
 * the way the app is, so a short query lands you in the right neighbourhood
 * and the next character narrows it.  A score would reshuffle the list under
 * the cursor between keystrokes, which is how a palette makes you run the
 * wrong thing.
 */
export function searchCommands(
  query: string,
  overrides: Overrides,
  platform: Platform,
  limit?: number,
): ShortcutDef[] {
  const needle = query.trim().toLowerCase();
  const found = SHORTCUTS.filter((def) => commandMatches(def, needle, overrides, platform));
  return limit === undefined ? found : found.slice(0, limit);
}
