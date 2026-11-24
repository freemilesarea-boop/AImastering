// 키맵 프리셋 — the keyboard a student already has in their fingers.
//
// The default map is Cubase-shaped and says so in `definitions.ts`: record on
// Numpad *, cycle on Numpad /, zoom on F and G, solo and mute on S and M.
// Somebody who learned Logic or Live types the wrong key for a week before
// their hands give up, and the remap layer below this made that fixable one
// command at a time — 241 commands at a time is not a fix.
//
// ── What these presets are, and are not ────────────────────────────────────
//
// They are NOT clones of those applications' key commands.  This file would
// have to assert a few hundred facts about software that is not in this
// repository, and a wrong assertion here teaches a student a key that does
// nothing — worse than leaving them to look it up.  So each preset carries
// only the DAILY actions where the other application's default is widely
// known, and every entry says what it is for.  Everything else stays on this
// app's own map, which is what the `?` overlay shows.
//
// The one fact this repository already stated is in `key-overrides.ts`'s own
// header: in Logic, Split is ⌘T.  That is where this started.
//
// ── Taking a key means taking it from somebody ─────────────────────────────
//
// Six of the entries below want a chord another command already holds —
// measured, not guessed: R is 녹음 무장, C is 메트로놈, ⌘T is 선택 구간으로
// 트림, ⌘D is 이벤트 연속 복사, Enter is MIDI 피아노 롤, F9 is 줌 프리셋 4.
// The dispatcher is first-match-wins, so two owners means one of them silently
// does nothing: `planPreset` therefore takes the chord OFF the old owner and
// names it, and the overlay shows that list before anything is written.  A
// command left with no key is still reachable by name in the palette (⌘P),
// which is the reason that is an acceptable outcome rather than a loss.

import type { CommandId } from './definitions.js';
import { planPreset, type Overrides } from './key-overrides.js';

export interface KeymapPreset {
  id: 'builtin' | 'logic' | 'live';
  label: string;
  /** One line, shown under the buttons. */
  note: string;
  /**
   * command → the chords it should answer to instead.
   *
   * Empty for the built-in map: applying it clears every override, which is
   * what "back to the app's own keyboard" means.
   */
  bindings: Readonly<Partial<Record<CommandId, readonly string[]>>>;
}

export const KEYMAP_PRESETS: readonly KeymapPreset[] = [
  {
    id: 'builtin',
    label: '기본 (Cubase 식)',
    note: '이 앱의 기본 키맵 — 바꾼 것을 모두 되돌립니다',
    bindings: {},
  },
  {
    id: 'logic',
    label: 'Logic 식',
    note: '자주 쓰는 동작만 Logic 기본값으로 — 나머지는 이 앱 기본값 그대로',
    bindings: {
      // Logic records on R and cycles on C; this app's defaults for both are
      // on the numeric keypad, which a laptop does not have.
      'transport.record': ['KeyR'],
      'transport.toggleLoop': ['KeyC'],
      // ⌘T — the one binding `key-overrides.ts` already named as the reason
      // the remap layer exists.
      'daw.separate': ['Mod+KeyT'],
      'daw.duplicateTrack': ['Mod+KeyD'],
      'daw.bounce': ['Mod+KeyB'],
      // Return to the start of the song, as Logic's Return does.
      'transport.returnToZero': ['Enter'],
      // These two are here to GIVE a key back rather than take one.  Record on
      // R displaces 녹음 무장 and cycle on C displaces 메트로놈 — both measured
      // — and leaving the metronome with no key at all is a daily annoyance,
      // not a trade.  K is Logic's metronome and nothing in this app holds it.
      'transport.metronome': ['KeyK'],
      // P is Logic's piano roll.  It does take P from 선택 구간에 루프 맞추기,
      // which is the rarer of the two by a long way.
      'window.keyEditor': ['KeyP'],
    },
  },
  {
    id: 'live',
    label: 'Ableton Live 식',
    note: '자주 쓰는 동작만 Live 기본값으로 — 나머지는 이 앱 기본값 그대로',
    bindings: {
      'transport.record': ['F9'],
      'transport.toggleLoop': ['Mod+KeyL'],
      'daw.duplicateTrack': ['Mod+KeyD'],
      'daw.quantize': ['Mod+KeyU'],
      'daw.consolidate': ['Mod+KeyJ'],
      // Live zooms with the two keys next to each other rather than F and G.
      'view.zoomInH': ['Equal'],
      'view.zoomOutH': ['Minus'],
    },
  },
];

export function findPreset(id: string): KeymapPreset | undefined {
  return KEYMAP_PRESETS.find((p) => p.id === id);
}

/**
 * Which preset the stored overrides ARE, or null for a hand-made keyboard.
 *
 * Worked out by comparing, not remembered.  A stored "chosen preset" would be
 * a second source of truth: remap one key afterwards and it still claims Logic
 * — the overlay would say one thing and the keyboard do another, which is the
 * drift this whole area has been getting wrong all along.
 */
export function activePresetId(overrides: Overrides): KeymapPreset['id'] | null {
  const same = (a: Overrides, b: Overrides): boolean => {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => {
      const x = a[k] ?? [];
      const y = b[k] ?? [];
      return x.length === y.length && x.every((v, i) => v === y[i]);
    });
  };
  for (const preset of KEYMAP_PRESETS) {
    const plan = planPreset(preset.bindings);
    if (plan.problem !== undefined) continue;
    if (same(overrides, plan.overrides)) return preset.id;
  }
  return null;
}
