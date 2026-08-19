// keys.ts — chord parsing / matching for the DAW keyboard layer.
//
// Everything here is pure and DOM-free (it only reads fields off a
// KeyboardEvent-shaped object), so the selftest can drive it with plain
// object literals.
//
// Why `event.code` and not `event.key`:
//   • Numpad keys are only distinguishable via `code` (NumpadDivide vs
//     Slash, Numpad1 vs Digit1) — Cubase-style transport bindings live on
//     the numpad, so this matters.
//   • On macOS, Option+letter emits a composed character in `event.key`
//     (Option+X → "≈"), which would break every Alt binding.
//   • Layout-independent: G/H stay on the same physical keys.
// `event.key` is used only as a fallback when `code` is empty (some IMEs
// and synthetic events).

export type Platform = 'mac' | 'win';

/** A single key combination. `mod` = Cmd on macOS, Ctrl elsewhere. */
export interface KeyChord {
  /** KeyboardEvent.code token — 'KeyS', 'Digit1', 'Numpad1', 'Space', 'F3', … */
  code: string;
  mod: boolean;
  alt: boolean;
  shift: boolean;
}

/** Minimal shape we need off a KeyboardEvent (keeps the matcher testable). */
export interface KeyEventLike {
  code?: string | undefined;
  key?: string | undefined;
  ctrlKey?: boolean | undefined;
  metaKey?: boolean | undefined;
  altKey?: boolean | undefined;
  shiftKey?: boolean | undefined;
}

const FKEY = /^F([1-9]|1[0-2])$/i;

/**
 * Normalise a human-written key token into a KeyboardEvent.code token.
 * Already-canonical tokens ('Numpad1', 'KeyS', 'F3') pass through.
 */
export function normalizeKeyToken(token: string): string {
  const t = token.trim();
  if (!t) return '';

  // Canonical code prefixes pass straight through (case-normalised).
  if (/^numpad/i.test(t)) return 'Numpad' + t.slice(6, 7).toUpperCase() + t.slice(7);
  if (/^key[a-z]$/i.test(t)) return 'Key' + t.slice(3).toUpperCase();
  if (/^digit[0-9]$/i.test(t)) return 'Digit' + t.slice(5);
  if (FKEY.test(t)) return t.toUpperCase();

  if (/^[a-z]$/i.test(t)) return 'Key' + t.toUpperCase();
  if (/^[0-9]$/.test(t)) return 'Digit' + t;

  switch (t.toLowerCase()) {
    case 'space':     case 'spacebar': return 'Space';
    case 'enter':     case 'return':   return 'Enter';
    case 'esc':       case 'escape':   return 'Escape';
    case 'home':                       return 'Home';
    case 'end':                        return 'End';
    case 'tab':                        return 'Tab';
    case 'backspace':                  return 'Backspace';
    case 'delete':    case 'del':      return 'Delete';
    case 'up':                         return 'ArrowUp';
    case 'down':                       return 'ArrowDown';
    case 'left':                       return 'ArrowLeft';
    case 'right':                      return 'ArrowRight';
    case 'slash':     case '/':        return 'Slash';
    case 'backslash': case '\\':       return 'Backslash';
    case 'comma':     case ',':        return 'Comma';
    case 'period':    case '.':        return 'Period';
    case 'minus':     case '-':        return 'Minus';
    case 'equal':     case '=':        return 'Equal';
    default:                           return t;
  }
}

/**
 * Parse a chord spec such as 'Mod+Shift+S', 'Alt+X', 'NumpadDivide', 'Space'.
 * Modifier tokens: Mod (Cmd/Ctrl), Alt (Option), Shift.
 */
export function parseChord(spec: string): KeyChord {
  const parts = spec.split('+').map((p) => p.trim()).filter(Boolean);
  const chord: KeyChord = { code: '', mod: false, alt: false, shift: false };
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case 'mod': case 'cmd': case 'ctrl': case 'control': case 'command':
        chord.mod = true; break;
      case 'alt': case 'option': case 'opt':
        chord.alt = true; break;
      case 'shift':
        chord.shift = true; break;
      default:
        chord.code = normalizeKeyToken(part);
    }
  }
  return chord;
}

/** The KeyboardEvent.code for an event, falling back to `key` when absent. */
export function eventCode(e: KeyEventLike): string {
  if (e.code) return e.code;
  if (e.key) return normalizeKeyToken(e.key);
  return '';
}

/**
 * True when the event is exactly this chord on this platform.
 *
 * Modifier matching is exact — Shift+G never fires the plain-G binding, and
 * a chord without `mod` never fires while Cmd/Ctrl is held.  The non-primary
 * modifier (Ctrl on macOS, Cmd on Windows) must always be up, so Ctrl+S on a
 * Mac does not trigger the Cmd+S binding.
 */
export function matchesChord(e: KeyEventLike, chord: KeyChord, platform: Platform): boolean {
  const primary   = platform === 'mac' ? Boolean(e.metaKey) : Boolean(e.ctrlKey);
  const secondary = platform === 'mac' ? Boolean(e.ctrlKey) : Boolean(e.metaKey);
  if (secondary) return false;
  if (chord.mod !== primary) return false;
  if (chord.alt !== Boolean(e.altKey)) return false;
  if (chord.shift !== Boolean(e.shiftKey)) return false;
  return eventCode(e) === chord.code;
}

// ── Display ───────────────────────────────────────────────────────────────────

/** Human label for a bare key code — 'KeyS' → 'S', 'Numpad1' → 'Numpad 1'. */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) {
    const rest = code.slice(6);
    const named: Record<string, string> = {
      Divide: '/', Multiply: '*', Subtract: '-', Add: '+',
      Decimal: '.', Enter: 'Enter',
    };
    return `Numpad ${named[rest] ?? rest}`;
  }
  switch (code) {
    case 'Slash':     return '/';
    case 'Backslash': return '\\';
    case 'Comma':     return ',';
    case 'Period':    return '.';
    case 'Minus':     return '-';
    case 'Equal':     return '=';
    default:          return code;
  }
}

/** 'Mod+Shift+S' + mac → '⌘ + Shift + S'; + win → 'Ctrl + Shift + S'. */
export function formatChord(chord: KeyChord, platform: Platform): string {
  const parts: string[] = [];
  if (chord.mod)   parts.push(platform === 'mac' ? '⌘' : 'Ctrl');
  if (chord.alt)   parts.push(platform === 'mac' ? 'Option' : 'Alt');
  if (chord.shift) parts.push('Shift');
  // Shift+Slash is the "?" key — show it as such.
  if (chord.shift && chord.code === 'Slash' && !chord.mod && !chord.alt) return '?';
  parts.push(keyLabel(chord.code));
  return parts.join(' + ');
}

/** Runtime platform — Electron exposes process.platform through the preload. */
export function detectPlatform(): Platform {
  if (typeof window === 'undefined') return 'win';
  const p = window.electronAPI?.platform;
  if (p === 'darwin') return 'mac';
  if (!p && typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')) {
    return 'mac';
  }
  return 'win';
}
