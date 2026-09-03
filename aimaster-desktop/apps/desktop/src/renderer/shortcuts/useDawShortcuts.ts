// useDawShortcuts — the one keydown listener the DAW installs.
//
// # Why a single listener
//
// Per-component handlers mean the binding depends on what has focus, which
// is exactly what a DAW keyboard must not do: Space is the transport whether
// the pointer is over the arrange window, a fader or nothing at all. So one
// listener on the window, one table, one place where a chord becomes an
// action.
//
// # Where it deliberately stays out of the way
//
// Typing surfaces come first. While an `<input>`, `<textarea>`, `<select>`
// or a contenteditable has focus, the DAW layer does not fire — otherwise
// naming a track would mute it on the "m" and delete it on Backspace. The
// only exception is Escape, which closes what is open.
//
// A focused `<button>` keeps Space and Enter as well: those are the button's
// own activation keys, and stealing them would break every keyboard user's
// ability to press the thing they just tabbed to.
//
// # Unsupported keys answer for themselves
//
// A chord in the table with `available: false` is still matched, and still
// swallowed, and produces the note explaining why this app has no such
// thing. A key that silently does nothing is indistinguishable from a bug.

import { useEffect, useRef } from 'react';
import { BINDINGS, findShortcut, type CommandId } from './definitions.js';
import { matchesChord, detectPlatform, type Platform } from './keys.js';
import type { CommandMap } from './commands.js';

/**
 * The shape these guards actually need off an element.
 *
 * Duck-typed rather than `instanceof HTMLElement` for two reasons: an
 * element from another document (an iframe, a portal) fails `instanceof`
 * against this window's constructor and would silently lose its typing
 * protection, and the selftest has no DOM at all.
 */
interface ElementLike {
  tagName?: unknown;
  isContentEditable?: unknown;
  getAttribute?: unknown;
}

function tagOf(target: EventTarget | null): string {
  const el = target as ElementLike | null;
  return typeof el?.tagName === 'string' ? el.tagName.toUpperCase() : '';
}

/** Typing surfaces where the shortcut layer must not fire. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const tag = tagOf(target);
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return (target as ElementLike | null)?.isContentEditable === true;
}

/** Space and Enter belong to a focused button, not to the transport. */
export function isButtonTarget(target: EventTarget | null): boolean {
  if (tagOf(target) === 'BUTTON') return true;
  const get = (target as ElementLike | null)?.getAttribute;
  if (typeof get !== 'function') return false;
  return (get as (n: string) => string | null).call(target, 'role') === 'button';
}

const BUTTON_KEYS = new Set(['Space', 'Enter']);

export interface ShortcutResolution {
  id: CommandId;
  /** false → the table says this app has no counterpart. */
  available: boolean;
  note: string;
  label: string;
}

/**
 * Which command a key event fires, if any.
 *
 * Pure and exported so the selftest can ask "what does Alt+X do" without a
 * DOM: the answer has to come from the same code the window listener uses,
 * or the test is describing a second implementation.
 */
export function resolveEvent(
  e: { code?: string | undefined; key?: string | undefined;
       ctrlKey?: boolean | undefined; metaKey?: boolean | undefined;
       altKey?: boolean | undefined; shiftKey?: boolean | undefined },
  platform: Platform,
  target: EventTarget | null = null,
): ShortcutResolution | null {
  if (isTypingTarget(target)) return null;

  for (const b of BINDINGS) {
    if (!matchesChord(e, b.chord, platform)) continue;
    if (isButtonTarget(target) && BUTTON_KEYS.has(b.chord.code) && !b.chord.mod && !b.chord.alt) {
      // The focused button gets its own activation key.
      return null;
    }
    const def = findShortcut(b.id);
    if (!def) return null;
    return { id: b.id, available: def.available, note: def.note, label: def.label };
  }
  return null;
}

export interface UseDawShortcutsOptions {
  /** Commands for the ids this page implements. */
  commands: CommandMap;
  /** Shown when a key is bound but the app has no such feature. */
  notify: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  /** Escape closes whatever is open; returns true when it consumed the key. */
  onEscape?: () => boolean;
  /** Off while another screen owns the keyboard. */
  enabled?: boolean;
}

export function useDawShortcuts(options: UseDawShortcutsOptions): void {
  // The handler is installed once; everything it needs is read through a ref
  // so a re-render does not detach and re-attach the listener. That churn is
  // what turned an earlier realtime integration into an audio-rate loop.
  const ref = useRef(options);
  ref.current = options;

  useEffect(() => {
    const platform = detectPlatform();

    const onKeyDown = (e: KeyboardEvent): void => {
      const { commands, notify, onEscape, enabled = true } = ref.current;
      if (!enabled) return;

      if (e.key === 'Escape' && onEscape) {
        if (onEscape()) { e.preventDefault(); }
        return;
      }

      const hit = resolveEvent(e, platform, e.target);
      if (!hit) return;

      // Swallowed either way: a bound key must never also scroll the page,
      // trigger the browser's own Ctrl+S, or type into anything.
      e.preventDefault();
      e.stopPropagation();

      if (!hit.available) {
        notify(`${hit.label} — ${hit.note}`, 'info');
        return;
      }
      const run = commands[hit.id];
      if (!run) {
        notify(`${hit.label} — 아직 연결되지 않았습니다`, 'warning');
        return;
      }
      run();
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
