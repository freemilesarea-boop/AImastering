// 단축키 재정의 — the layer that was missing above a hardcoded keymap.
//
// `definitions.ts` is the source of truth for both the dispatcher and the `?`
// overlay, which is why the two have never disagreed.  What it is not is
// editable: a person arriving from Logic, where Split is ⌘T, had no way to
// say so, and the first thing anybody does in a new DAW is look for the key
// commands dialog.
//
// So this file sits ABOVE the table rather than replacing it.  The defaults
// stay where they are, an override names a command and the chords it should
// answer to instead, and both readers resolve through here — so the help
// overlay still cannot drift from what the dispatcher does, which was the
// whole point of generating it.
//
// ── Why a conflict is refused instead of asked about ────────────────────────
//
// The dispatcher is first-match-wins over a flat list.  Two commands holding
// one chord is therefore not a conflict the user gets to resolve later: it is
// one command that works and one that silently does nothing, with nothing in
// the UI to say which is which.  Cubase offers "assign anyway"; here that
// would be an offer to break something quietly, so a chord that is taken is
// refused and the holder is named.  Clearing the holder first is one click
// and leaves the user knowing what they did.
//
// ── Storage discipline ──────────────────────────────────────────────────────
//
// Same as `template-store.ts` and `user-presets.ts`, because it is the same
// kind of data — written by a user, read back on another day on a possibly
// different build:
//
//   A WRITE THAT FAILED IS REPORTED.  `localStorage` throws on quota and in
//   privacy modes, and a silent failure here means a remap that comes back
//   wrong after a relaunch.
//   A CORRUPT STORE IS NOT FATAL.  Unparseable JSON, a wrong schema version
//   or an entry naming a command this build no longer has resolves to "no
//   override" rather than to an app that cannot take a keystroke.

import { BINDINGS, SHORTCUTS, type Binding, type CommandId } from './definitions.js';
import { formatChord, parseChord, type KeyChord, type Platform } from './keys.js';

const KEY = 'loui.shortcuts.overrides';
const SCHEMA_VERSION = 1;
/** Per command, matching the most any default carries plus room for one more. */
export const MAX_CHORDS_PER_COMMAND = 3;

export interface OverrideStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

let override: OverrideStore | null = null;

/** Point the store somewhere else.  Pass null to go back to `localStorage`. */
export function setOverrideStore(store: OverrideStore | null): void { override = store; }

function store(): OverrideStore | null {
  if (override) return override;
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch { return null; }
}

/** Command id → the chord specs it answers to instead of its defaults. */
export type Overrides = Readonly<Record<string, readonly string[]>>;

export const NO_OVERRIDES: Overrides = Object.freeze({});

interface Envelope { version: number; items: { id: string; chords: string[] }[] }

const KNOWN = new Set<string>(SHORTCUTS.map((s) => s.id));

/**
 * A chord spec in one form, so two spellings of one key compare equal.
 *
 * `Mod+Shift+KeyS`, `shift+cmd+s` and `Shift + Mod + S` are the same binding,
 * and a conflict check that compared the raw strings would let the second one
 * be stored on top of the first.
 */
export function canonicalSpec(spec: string): string {
  return specOf(parseChord(spec));
}

function specOf(chord: KeyChord): string {
  const parts: string[] = [];
  if (chord.mod) parts.push('Mod');
  if (chord.alt) parts.push('Alt');
  if (chord.shift) parts.push('Shift');
  parts.push(chord.code);
  return parts.join('+');
}

/** True for a spec that names an actual key rather than modifiers alone. */
export function isUsableSpec(spec: string): boolean {
  const chord = parseChord(spec);
  if (!chord.code) return false;
  // A bare modifier arrives as its own code and would bind a key nobody can
  // press on its own without also pressing it as a modifier.
  return !/^(Control|Shift|Alt|Meta)(Left|Right)$/.test(chord.code)
    && chord.code !== 'Escape';
}

export function loadOverrides(): Overrides {
  const s = store();
  if (!s) return NO_OVERRIDES;
  let raw: string | null;
  try { raw = s.getItem(KEY); } catch { return NO_OVERRIDES; }
  if (!raw) return NO_OVERRIDES;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return NO_OVERRIDES; }
  if (parsed === null || typeof parsed !== 'object') return NO_OVERRIDES;
  const env = parsed as Partial<Envelope>;
  if (env.version !== SCHEMA_VERSION || !Array.isArray(env.items)) return NO_OVERRIDES;

  const out: Record<string, readonly string[]> = {};
  for (const item of env.items) {
    if (item === null || typeof item !== 'object') continue;
    const { id, chords } = item as { id?: unknown; chords?: unknown };
    // An id this build does not have is dropped rather than carried: the
    // command it named may come back under another name, and a stored
    // override for a command that cannot run is a key that does nothing.
    if (typeof id !== 'string' || !KNOWN.has(id)) continue;
    if (!Array.isArray(chords)) continue;
    const usable = chords
      .filter((c): c is string => typeof c === 'string')
      .filter((c) => isUsableSpec(c))
      .map((c) => canonicalSpec(c))
      .slice(0, MAX_CHORDS_PER_COMMAND);
    // An override with no chords left is "unbound", which is a real choice
    // and different from having no override at all.
    out[id] = usable;
  }
  return Object.freeze(out);
}

export interface SaveResult { ok: boolean; reason?: string }

function write(next: Overrides): SaveResult {
  const s = store();
  if (!s) return { ok: false, reason: '이 환경에서는 단축키를 저장할 수 없습니다' };
  const env: Envelope = {
    version: SCHEMA_VERSION,
    items: Object.entries(next).map(([id, chords]) => ({ id, chords: [...chords] })),
  };
  try {
    s.setItem(KEY, JSON.stringify(env));
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `단축키를 저장하지 못했습니다 — ${(err as Error).message}` };
  }
}

/**
 * Give a command a new set of chords.
 *
 * Every chord is checked against every OTHER command's effective chords, so
 * the stored result can never be a pair of commands racing for one key.
 */
export function saveOverride(id: CommandId, chords: readonly string[]): SaveResult {
  if (!KNOWN.has(id)) return { ok: false, reason: `알 수 없는 명령입니다 — ${id}` };
  if (chords.length > MAX_CHORDS_PER_COMMAND) {
    return { ok: false, reason: `한 명령에 최대 ${MAX_CHORDS_PER_COMMAND}개까지입니다` };
  }
  const current = loadOverrides();
  const specs: string[] = [];
  for (const raw of chords) {
    if (!isUsableSpec(raw)) return { ok: false, reason: '이 키는 단축키로 쓸 수 없습니다' };
    const spec = canonicalSpec(raw);
    if (specs.includes(spec)) continue;
    const holder = conflictOf(spec, id, current);
    if (holder) {
      const label = SHORTCUTS.find((s) => s.id === holder)?.label ?? holder;
      return { ok: false, reason: `이미 "${label}" 에 할당된 키입니다 — 그쪽을 먼저 비우세요` };
    }
    specs.push(spec);
  }
  return write({ ...current, [id]: specs });
}

/** Back to the built-in chords for this command. */
export function clearOverride(id: CommandId): SaveResult {
  const current = loadOverrides();
  if (!(id in current)) return { ok: true };
  const next: Record<string, readonly string[]> = { ...current };
  delete next[id];
  return write(next);
}

/** What a preset would do, worked out before anything is written. */
export interface PresetPlan {
  /** The override map the preset results in. */
  overrides: Overrides;
  /** Commands that lose a chord to the preset, and which one. */
  displaced: { id: CommandId; chord: string }[];
  /** Commands left with no key at all — reachable by name in the palette. */
  unbound: CommandId[];
  /** Set when the preset cannot be applied, with the reason. */
  problem?: string;
}

/**
 * Work out a preset without writing it.
 *
 * `saveOverride` refuses a chord somebody else holds, and it is right to:
 * the dispatcher is first-match-wins, so a second owner is a command that
 * silently does nothing.  But a PRESET is a whole keyboard arriving at once,
 * and half of its entries want keys the default map has already given out —
 * refusing would make every preset unusable, and applying one command at a
 * time would succeed or fail depending on the order.
 *
 * So the whole thing is computed first.  A chord the preset claims is taken
 * off whoever held it, that command is NAMED rather than quietly broken, and
 * the caller shows the list before writing.  The result is checked for two
 * owners of one chord — the invariant the per-command path protects — and a
 * preset that cannot satisfy it is refused with the clash named.
 */
export function planPreset(
  bindings: Readonly<Partial<Record<CommandId, readonly string[]>>>,
): PresetPlan {
  const wanted = new Map<CommandId, string[]>();
  for (const [id, chords] of Object.entries(bindings) as [CommandId, readonly string[]][]) {
    if (!KNOWN.has(id)) return { overrides: NO_OVERRIDES, displaced: [], unbound: [], problem: `알 수 없는 명령입니다 — ${id}` };
    if (chords.length > MAX_CHORDS_PER_COMMAND) {
      return { overrides: NO_OVERRIDES, displaced: [], unbound: [], problem: `한 명령에 최대 ${MAX_CHORDS_PER_COMMAND}개까지입니다 — ${id}` };
    }
    const specs: string[] = [];
    for (const raw of chords) {
      if (!isUsableSpec(raw)) {
        return { overrides: NO_OVERRIDES, displaced: [], unbound: [], problem: `이 키는 단축키로 쓸 수 없습니다 — ${raw}` };
      }
      const spec = canonicalSpec(raw);
      if (!specs.includes(spec)) specs.push(spec);
    }
    wanted.set(id, specs);
  }

  // A preset is a whole choice, so it replaces the overrides rather than
  // layering on them: starting from what is stored would carry yesterday's
  // remap into today's keyboard and nobody could say which was which.
  const next = new Map<CommandId, string[]>(wanted);
  const claimed = new Set<string>();
  for (const specs of wanted.values()) for (const spec of specs) claimed.add(spec);

  const displaced: { id: CommandId; chord: string }[] = [];
  for (const def of SHORTCUTS) {
    if (wanted.has(def.id)) continue;
    const keep = def.chords.filter((c) => !claimed.has(canonicalSpec(c)));
    if (keep.length === def.chords.length) continue;      // nothing taken
    for (const lost of def.chords.filter((c) => claimed.has(canonicalSpec(c)))) {
      displaced.push({ id: def.id, chord: canonicalSpec(lost) });
    }
    next.set(def.id, keep.map((c) => canonicalSpec(c)));
  }

  const overrides = Object.freeze(Object.fromEntries(next)) as Overrides;

  // The invariant: one chord, one command.  Checked over the RESULT, which is
  // the only place it can be checked for a bundle.
  const owner = new Map<string, CommandId>();
  for (const def of SHORTCUTS) {
    for (const spec of effectiveChords(def, overrides)) {
      const canon = canonicalSpec(spec);
      const prev = owner.get(canon);
      if (prev !== undefined) {
        const name = (x: CommandId) => SHORTCUTS.find((s) => s.id === x)?.label ?? x;
        return {
          overrides: NO_OVERRIDES, displaced: [], unbound: [],
          problem: `${formatChord(parseChord(canon), 'win')} 를 "${name(prev)}" 와 "${name(def.id)}" 가 함께 가집니다`,
        };
      }
      owner.set(canon, def.id);
    }
  }

  const unbound = [...next.entries()].filter(([, c]) => c.length === 0).map(([id]) => id);
  return { overrides, displaced, unbound };
}

/** Apply a preset, all of it or none of it. */
export function applyPreset(
  bindings: Readonly<Partial<Record<CommandId, readonly string[]>>>,
): SaveResult {
  // The built-in map is "no overrides", not "an override per command": that
  // way a later build changing a default reaches someone who chose it.
  if (Object.keys(bindings).length === 0) return clearAllOverrides();
  const plan = planPreset(bindings);
  if (plan.problem !== undefined) return { ok: false, reason: plan.problem };
  return write(plan.overrides);
}

export function clearAllOverrides(): SaveResult {
  return write(NO_OVERRIDES);
}

/** The chords this command actually answers to. */
export function effectiveChords(
  def: { id: CommandId; chords: string[] }, overrides: Overrides,
): readonly string[] {
  const own = overrides[def.id];
  return own === undefined ? def.chords : own;
}

/** Whether this command is running on something the user chose. */
export function isOverridden(id: CommandId, overrides: Overrides): boolean {
  return id in overrides;
}

/**
 * Which command already holds this chord, or null.
 *
 * Asked of the EFFECTIVE chords, not the defaults: a key freed by remapping
 * its original owner has to be available, and a key taken by someone else's
 * override has to be refused.
 */
export function conflictOf(
  spec: string, forId: CommandId, overrides: Overrides,
): CommandId | null {
  const wanted = canonicalSpec(spec);
  for (const def of SHORTCUTS) {
    if (def.id === forId) continue;
    for (const chord of effectiveChords(def, overrides)) {
      if (canonicalSpec(chord) === wanted) return def.id;
    }
  }
  return null;
}

/**
 * The dispatch list, with overrides applied.
 *
 * Returns the module-level `BINDINGS` unchanged when there are no overrides —
 * which is the common case, and keeps the default path a constant rather than
 * a rebuild on every render.
 */
export function resolveBindings(overrides: Overrides): Binding[] {
  if (Object.keys(overrides).length === 0) return BINDINGS;
  return SHORTCUTS.flatMap((def) =>
    effectiveChords(def, overrides).map((spec) => ({ def, chord: parseChord(spec) })));
}

/**
 * The chord spec for a keypress, or null when it is not bindable.
 *
 * The inverse of `parseChord` across the platform boundary: `mod` means Cmd
 * on macOS and Ctrl elsewhere, so the same physical gesture has to come back
 * as the same spec on both.
 */
export function specFromEvent(
  e: { code?: string | undefined; key?: string | undefined;
       ctrlKey?: boolean | undefined; metaKey?: boolean | undefined;
       altKey?: boolean | undefined; shiftKey?: boolean | undefined },
  platform: Platform,
): string | null {
  const code = e.code ?? e.key ?? '';
  if (!code) return null;
  const primary = platform === 'mac' ? Boolean(e.metaKey) : Boolean(e.ctrlKey);
  const spec = specOf({
    code,
    mod: primary,
    alt: Boolean(e.altKey),
    shift: Boolean(e.shiftKey),
  });
  return isUsableSpec(spec) ? spec : null;
}

/**
 * One line naming a chord, for a menu accelerator or a conflict message.
 *
 * `formatChord` and not a second formatter: the first draft of this wrote its
 * own modifier labels and lost the one case that needs handling — Shift+Slash
 * IS the `?` key, which `formatChord` already knows, and which would otherwise
 * read as "⇧/" in the help for the overlay you press `?` to open.
 */
export function describeSpec(spec: string, platform: Platform): string {
  return formatChord(parseChord(spec), platform);
}
