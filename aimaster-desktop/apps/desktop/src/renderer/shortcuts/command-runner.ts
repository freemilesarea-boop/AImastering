// Running a command from somewhere that is not the keyboard.
//
// `buildCommands` needs live stores, so the map is assembled inside
// `useDawShortcuts` and has only ever been reachable from the keydown
// listener.  That was fine while the keyboard was the only way in.  A context
// menu is the second way in, and it must not be a second implementation: a
// menu that re-wrote "split the clip" would be a copy of the command that
// drifts the first time either is fixed.
//
// So the hook publishes the map it already built, and anything else runs a
// command BY ID through here.  One command, two doorways.
//
// Deliberately a module-level ref rather than a store: this is not state
// anything renders from, and putting it in a store would re-render every
// menu-capable surface each time the command map is rebuilt — which is every
// time the session changes.

import type { CommandId } from './definitions.js';

export type CommandMap = Partial<Record<CommandId, () => void | Promise<void>>>;

let current: CommandMap | null = null;
let onError: ((id: CommandId, err: unknown) => void) | null = null;

/** Publish the built command map.  `null` on unmount. */
export function setCommandMap(
  map: CommandMap | null,
  errorSink?: (id: CommandId, err: unknown) => void,
): void {
  current = map;
  onError = errorSink ?? null;
}

/** True when this build has a runnable implementation for the id. */
export function hasCommand(id: CommandId): boolean {
  return typeof current?.[id] === 'function';
}

/**
 * Run a command by id.
 *
 * Returns false when there is nothing to run, so a caller can tell "did
 * nothing" from "did something" — a menu item that silently does nothing is
 * the thing this whole area of the app keeps getting wrong.
 *
 * Async rejections are routed to the same sink the keyboard dispatcher uses,
 * because a command that fails from a menu has to be reported the way it is
 * reported from a key.
 */
export function runCommand(id: CommandId): boolean {
  const run = current?.[id];
  if (typeof run !== 'function') return false;
  try {
    const result = run();
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch((err: unknown) => onError?.(id, err));
    }
  } catch (err) {
    onError?.(id, err);
  }
  return true;
}
