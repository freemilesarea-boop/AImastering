// The tooltip for a control that is also a command.
//
// Eleven tooltips used to write the chord out by hand — "(Mod+Alt+D)",
// "(Mod+Alt+Shift+K)" — and that is wrong twice over.  It shows the person the
// word "Mod", which is a token from this codebase and not a key on anyone's
// keyboard.  And it is frozen text: the moment a student remaps the command,
// the tooltip is confidently telling them the wrong key, which is worse than
// telling them nothing.
//
// So a tooltip asks the keymap.  `effectiveChords` means it follows a remap,
// and `describeSpec` renders what the platform actually shows (⌘⌥D on a Mac,
// Ctrl + Alt + D on Windows).  The right-click menus have worked this way
// since they were built; this is the same thing for buttons.

import { findShortcut, type CommandId } from './definitions.js';
import { describeSpec, effectiveChords, type Overrides } from './key-overrides.js';
import type { Platform } from './keys.js';

/**
 * The command's key as the person sees it, or null when it has none.
 *
 * EVERY key, not the first: six commands carry two (the transport's 0점 is
 * Home and Numpad ., and a tooltip that named only one of them would be the
 * reason somebody thinks the other does not work).
 */
export function chordOf(
  id: CommandId,
  overrides: Overrides,
  platform: Platform,
): string | null {
  const def = findShortcut(id);
  if (!def) return null;
  const all = effectiveChords(def, overrides).map((spec) => describeSpec(spec, platform));
  return all.length === 0 ? null : all.join(' / ');
}

/**
 * A tooltip: what the control does, and the key that does the same thing.
 *
 * `extra` is for the sentence a control already had — a tooltip that only
 * named a chord would be a step backwards for the ones that explained
 * themselves, and the explanation is the half a beginner needs first.
 */
export function commandTitle(
  id: CommandId,
  overrides: Overrides,
  platform: Platform,
  extra?: string,
): string {
  const def = findShortcut(id);
  const name = extra ?? def?.label ?? id;
  const chord = chordOf(id, overrides, platform);
  return chord === null ? name : `${name} — ${chord}`;
}
