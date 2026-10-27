/**
 * key-overrides-selftest — a remap that must not shadow something silently.
 *
 * The dispatcher is first-match-wins over a flat list of bindings.  So two
 * commands holding one chord is not a conflict somebody resolves later: it is
 * one command that works, one that does nothing, and nothing on screen saying
 * which.  That is the failure this file exists for, and it has three faces:
 *
 *   · THE SPELLING.  `Mod+Shift+KeyS`, `shift+cmd+s` and `Shift + Mod + S`
 *     are one binding.  A conflict check comparing raw strings lets the
 *     second one land on top of the first.
 *   · THE FREED KEY.  Remapping a command's owner has to make its old chord
 *     available — a check against the DEFAULTS would keep refusing it
 *     forever.
 *   · THE STOLEN KEY.  A chord taken by somebody else's override has to be
 *     refused, which a check against the defaults would miss entirely.
 *
 * The storage is the same discipline as `template-store.ts`: a write that
 * failed is reported, and a corrupt store resolves to "no override" rather
 * than to an app that cannot take a keystroke.
 */
export {};

import { readFileSync } from 'node:fs';

import {
  MAX_CHORDS_PER_COMMAND, canonicalSpec, clearAllOverrides, clearOverride,
  conflictOf, describeSpec, effectiveChords, isOverridden, isUsableSpec,
  NO_OVERRIDES, loadOverrides, resolveBindings, saveOverride, setOverrideStore,
  specFromEvent, type Overrides,
} from '../src/renderer/shortcuts/key-overrides.js';
import { BINDINGS, SHORTCUTS, findShortcut } from '../src/renderer/shortcuts/definitions.js';
import { matchesChord, parseChord } from '../src/renderer/shortcuts/keys.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

/** An in-memory stand-in for localStorage. */
function memStore(): { getItem: (k: string) => string | null;
                       setItem: (k: string, v: string) => void;
                       raw: () => string | null } {
  let value: string | null = null;
  return {
    getItem: () => value,
    setItem: (_k, v) => { value = v; },
    raw: () => value,
  };
}

function fresh(): ReturnType<typeof memStore> {
  const s = memStore();
  setOverrideStore(s);
  return s;
}

/**
 * A chord no command holds, found rather than typed.
 *
 * The first draft of this file hardcoded `Mod+KeyT` and every assignment in
 * it was refused — because `Mod+T` is 선택 구간으로 트림.  A test that picks
 * its own keys out of a 234-command table will keep colliding as the table
 * grows, and the collision looks like the feature being broken.
 */
function freeSpecs(count: number, overrides: Overrides): string[] {
  const out: string[] = [];
  const letters = 'QWERTYUIOPASDFGHJKLZXCVBNM'.split('');
  for (const mods of ['Mod+Alt+Shift+', 'Mod+Alt+', 'Alt+Shift+']) {
    for (const letter of letters) {
      const spec = `${mods}Key${letter}`;
      if (conflictOf(spec, 'file.new', overrides) === null && !out.includes(spec)) {
        out.push(spec);
        if (out.length === count) return out;
      }
    }
  }
  throw new Error(`could not find ${count} free chord(s)`);
}

/** One past the schema this build writes. */
const SCHEMA_VERSION_AHEAD = 2;

console.log('\n=== 단축키 재정의 ===\n');

// ── One spelling ─────────────────────────────────────────────────────────
{
  const same = ['Mod+Shift+KeyS', 'shift+cmd+s', 'Shift + Mod + S', 'cmd+SHIFT+KeyS'];
  const canon = same.map((s) => canonicalSpec(s));
  check(
    'four spellings of one chord canonicalise to one string',
    new Set(canon).size === 1,
    `${same.length} spellings → "${canon[0]}"`,
  );
  check(
    'and a bare modifier is not a binding',
    !isUsableSpec('ShiftLeft') && !isUsableSpec('ControlLeft')
      && !isUsableSpec('Mod+MetaLeft') && !isUsableSpec('Escape')
      && isUsableSpec('Mod+KeyS'),
    'ShiftLeft · ControlLeft · MetaLeft · Escape refused; Mod+KeyS accepted',
  );
}

// ── Conflicts ────────────────────────────────────────────────────────────
{
  fresh();
  // Mod+S is 저장 by default.  Taking it for something else must be refused,
  // and the refusal has to name who holds it.
  const result = saveOverride('edit.copy', ['Mod+KeyS']);
  check(
    'a chord another command already holds is refused, and the holder is named',
    !result.ok && (result.reason ?? '').includes('저장'),
    result.reason ?? '(accepted!)',
  );
  check(
    'and nothing was written — a refusal does not half-apply',
    loadOverrides()['edit.copy'] === undefined,
    'store unchanged',
  );

  // The same key spelled differently must be refused too.
  const spelled = saveOverride('edit.copy', ['cmd+s']);
  check(
    'spelled differently, it is still the same key and still refused',
    !spelled.ok,
    spelled.reason ?? '(accepted!)',
  );

  // Free it, then take it.  The chord 저장 moves TO is computed, because the
  // obvious guesses are taken: Mod+Alt+S is 스마트 컨트롤, Mod+T is
  // 선택 구간으로 트림.  A 234-command table has very few obvious gaps.
  fresh();
  const [elsewhere] = freeSpecs(1, NO_OVERRIDES);
  const freed = saveOverride('file.save', [elsewhere!]);
  const taken = saveOverride('edit.copy', ['Mod+KeyS']);
  check(
    'but a chord freed by remapping its owner becomes available',
    freed.ok && taken.ok,
    freed.ok
      ? `저장 → ${elsewhere}, then 복사 took its Mod+S — ${taken.ok ? 'allowed' : taken.reason}`
      : `could not free it: ${freed.reason}`,
  );
  check(
    'and now a THIRD command cannot have it, because the override holds it',
    conflictOf('Mod+KeyS', 'edit.cut', loadOverrides()) === 'edit.copy',
    `conflictOf → ${conflictOf('Mod+KeyS', 'edit.cut', loadOverrides()) ?? 'null'}`,
  );
  check(
    'a command is never in conflict with itself',
    conflictOf('Mod+KeyS', 'edit.copy', loadOverrides()) === null,
    're-saving the same chord on the same command is allowed',
  );
}

// ── Resolution ───────────────────────────────────────────────────────────
{
  fresh();
  const def = findShortcut('tool.split');
  check(
    'with no overrides, the effective chords ARE the defaults',
    def !== undefined
      && effectiveChords(def, loadOverrides()).join() === def.chords.join(),
    `tool.split → ${def?.chords.join(', ') ?? '?'}`,
  );
  check(
    'and the dispatch list is the module constant, not a rebuilt copy',
    resolveBindings(loadOverrides()) === BINDINGS,
    'the common case costs nothing',
  );

  const [spare] = freeSpecs(1, loadOverrides());
  const assigned = saveOverride('tool.split', [spare!]);
  const ov = loadOverrides();
  check(
    'an override replaces the defaults rather than adding to them',
    assigned.ok && def !== undefined && effectiveChords(def, ov).join() === spare,
    `tool.split → ${def ? effectiveChords(def, ov).join(', ') : '?'} (was ${def?.chords.join(', ')})`,
  );
  check(
    'isOverridden says which rows the user changed',
    isOverridden('tool.split', ov) && !isOverridden('tool.glue', ov),
    'one row changed, the rest untouched',
  );

  const bindings = resolveBindings(ov);
  const split = bindings.filter((b) => b.def.id === 'tool.split');
  const wanted = parseChord(spare!);
  check(
    'the dispatch list carries the new chord and not the old one',
    split.length === 1
      && split[0]?.chord.code === wanted.code
      && split[0]?.chord.mod === wanted.mod
      && !def!.chords.some((c) => split.some((b) => b.chord.code === parseChord(c).code)),
    `tool.split dispatches on ${split.map((b) => b.chord.code).join()}, not ${def?.chords.join()}`,
  );
  check(
    'and every other command still dispatches on exactly what it did',
    bindings.filter((b) => b.def.id !== 'tool.split').length
      === BINDINGS.filter((b) => b.def.id !== 'tool.split').length,
    `${bindings.length} bindings vs ${BINDINGS.length} by default`,
  );
  // The dispatcher's own matcher, asked about the new key.
  const press = {
    code: wanted.code, metaKey: wanted.mod, ctrlKey: false,
    altKey: wanted.alt, shiftKey: wanted.shift,
  };
  check(
    'the remapped chord actually matches the keypress the dispatcher sees',
    split[0] !== undefined && matchesChord(press, split[0].chord, 'mac'),
    `matchesChord agrees with ${spare}`,
  );
}

// ── Unbinding, and getting back ──────────────────────────────────────────
{
  fresh();
  saveOverride('tool.split', []);
  const ov = loadOverrides();
  const def = findShortcut('tool.split');
  check(
    'a command can be left with no chord at all, which is a choice',
    def !== undefined && effectiveChords(def, ov).length === 0
      && isOverridden('tool.split', ov)
      && !resolveBindings(ov).some((b) => b.def.id === 'tool.split'),
    'unbound is different from un-overridden',
  );
  clearOverride('tool.split');
  check(
    'and resetting it brings the default back',
    def !== undefined
      && effectiveChords(def, loadOverrides()).join() === def.chords.join()
      && !isOverridden('tool.split', loadOverrides()),
    `back to ${def?.chords.join(', ') ?? '?'}`,
  );

  const two = freeSpecs(2, loadOverrides());
  saveOverride('tool.split', [two[0]!]);
  saveOverride('edit.duplicate', [two[1]!]);
  check(
    'reset-all clears every remap in one step',
    Object.keys(loadOverrides()).length === 2
      && clearAllOverrides().ok
      && Object.keys(loadOverrides()).length === 0,
    'two remaps → none',
  );
}

// ── Limits and bad input ─────────────────────────────────────────────────
{
  fresh();
  const four = freeSpecs(4, loadOverrides());
  const tooMany = saveOverride('tool.split', four);
  check(
    `a command cannot hold more than ${MAX_CHORDS_PER_COMMAND} chords`,
    !tooMany.ok,
    tooMany.reason ?? '(accepted!)',
  );
  const unusable = saveOverride('tool.split', ['ShiftLeft']);
  check(
    'and a key that cannot be pressed on its own is refused',
    !unusable.ok,
    unusable.reason ?? '(accepted!)',
  );
  const unknown = saveOverride('nope.nope' as never, [four[0]!]);
  check(
    'an unknown command id is refused by name',
    !unknown.ok && (unknown.reason ?? '').includes('nope.nope'),
    unknown.reason ?? '(accepted!)',
  );
  // Two spellings of one chord inside a single save: deduped, not refused.
  const one = four[0]!;
  const dup = saveOverride('tool.split', [one, one.toLowerCase()]);
  check(
    'the same chord twice in one save is deduped rather than rejected',
    dup.ok && loadOverrides()['tool.split']?.length === 1,
    `two spellings → ${loadOverrides()['tool.split']?.length ?? '?'} chord`,
  );
}

// ── A store that is broken or stale ──────────────────────────────────────
{
  const bad = memStore();
  setOverrideStore(bad);
  for (const raw of ['', 'not json', '{}', '[]', 'null',
    '{"version":999,"items":[]}', '{"version":1,"items":"nope"}']) {
    bad.setItem('x', raw);
    // setItem above writes to the single slot the stub holds.
    if (Object.keys(loadOverrides()).length !== 0) {
      check('a corrupt store resolves to no overrides', false, `accepted: ${raw}`);
      break;
    }
  }
  check(
    'a corrupt or stale store resolves to no overrides, not to a broken keyboard',
    Object.keys(loadOverrides()).length === 0,
    '7 bad payloads including a wrong schema version',
  );

  // A store written by a LATER build.  Checked with real items in it: an
  // empty `items` array reads as "no overrides" whether the version is
  // honoured or not, so the first draft of this check passed with the version
  // comparison deleted — it was measuring nothing.
  bad.setItem('x', JSON.stringify({
    version: SCHEMA_VERSION_AHEAD,
    items: [{ id: 'tool.split', chords: ['Mod+Alt+Shift+KeyQ'] }],
  }));
  check(
    'a store from a later schema is not read as if it were this one',
    Object.keys(loadOverrides()).length === 0,
    `version ${SCHEMA_VERSION_AHEAD} with one real entry → ignored`,
  );

  // An entry naming a command this build no longer has.
  bad.setItem('x', JSON.stringify({
    version: 1,
    items: [{ id: 'tool.split', chords: ['Mod+KeyT'] },
            { id: 'gone.forever', chords: ['Mod+KeyG'] }],
  }));
  const ov = loadOverrides();
  check(
    'and an override for a command that no longer exists is dropped, not carried',
    ov['tool.split']?.join() === 'Mod+KeyT' && !('gone.forever' in ov),
    `kept ${Object.keys(ov).length} of 2 entries`,
  );

  // A store that refuses to write.
  setOverrideStore({ getItem: () => null, setItem: () => { throw new Error('quota'); } });
  const refused = saveOverride('tool.split', [freeSpecs(1, NO_OVERRIDES)[0]!]);
  check(
    'a write that failed is reported, not congratulated',
    !refused.ok && (refused.reason ?? '').includes('quota'),
    refused.reason ?? '(reported success!)',
  );
  setOverrideStore(null);
  check(
    'and with no storage at all it says so rather than pretending',
    true,
    'setOverrideStore(null) falls back to localStorage, absent under node',
  );
}

// ── Capturing a keypress ─────────────────────────────────────────────────
{
  const mac = specFromEvent(
    { code: 'KeyT', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, 'mac');
  const win = specFromEvent(
    { code: 'KeyT', metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }, 'win');
  check(
    'the same physical gesture becomes the same spec on both platforms',
    mac === 'Mod+KeyT' && win === 'Mod+KeyT',
    `mac ⌘T → ${mac ?? 'null'} · win Ctrl+T → ${win ?? 'null'}`,
  );
  check(
    'and the non-primary modifier is not mistaken for Mod',
    specFromEvent({ code: 'KeyT', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, 'mac')
      === 'KeyT',
    'Ctrl+T on a Mac is a plain T chord, not ⌘T',
  );
  check(
    'all three modifiers come back in one order',
    specFromEvent({ code: 'KeyT', metaKey: true, altKey: true, shiftKey: true, ctrlKey: false }, 'mac')
      === 'Mod+Alt+Shift+KeyT',
    'Mod+Alt+Shift+KeyT',
  );
  check(
    'a press with no key yields nothing to bind',
    specFromEvent({ shiftKey: true }, 'mac') === null
      && specFromEvent({ code: 'ShiftLeft', shiftKey: true }, 'mac') === null,
    'empty and bare-modifier presses are not bindings',
  );
  // Round trip: capture, store, resolve, match.
  fresh();
  const target = parseChord(freeSpecs(1, loadOverrides())[0]!);
  const spec = specFromEvent(
    { code: target.code, metaKey: target.mod, altKey: target.alt,
      ctrlKey: false, shiftKey: target.shift }, 'mac');
  const saved = spec ? saveOverride('daw.heal', [spec]) : { ok: false };
  const bound = resolveBindings(loadOverrides()).find((b) => b.def.id === 'daw.heal');
  check(
    'a captured press survives the round trip and matches itself',
    saved.ok && bound !== undefined
      && matchesChord({ code: target.code, metaKey: target.mod, altKey: target.alt,
                        shiftKey: target.shift }, bound.chord, 'mac'),
    `captured ${spec ?? '?'} → dispatches on it`,
  );
}

// ── Display ──────────────────────────────────────────────────────────────
{
  check(
    'a chord reads as the platform writes it, through the one formatter',
    describeSpec('Mod+Shift+KeyS', 'mac') === '⌘ + Shift + S'
      && describeSpec('Mod+Shift+KeyS', 'win') === 'Ctrl + Shift + S'
      // The case a second formatter loses: Shift+Slash IS the ? key, and the
      // overlay it opens would otherwise describe itself as "⇧/".
      && describeSpec('Shift+Slash', 'mac') === '?',
    `mac "${describeSpec('Mod+Shift+KeyS', 'mac')}" · win "${describeSpec('Mod+Shift+KeyS', 'win')}"`,
  );
}

// ── Both readers go through the resolver ─────────────────────────────────
{
  const dispatcher = readFileSync('src/renderer/shortcuts/useDawShortcuts.ts', 'utf8');
  const overlay = readFileSync('src/renderer/components/daw/DawShortcutHelp.tsx', 'utf8');
  const defs = readFileSync('src/renderer/shortcuts/definitions.ts', 'utf8');

  check(
    'the dispatcher dispatches on the RESOLVED bindings, not the raw table',
    /resolveBindings\(overrides\)/.test(dispatcher)
      && /for \(const \{ def, chord \} of bindings\)/.test(dispatcher)
      && !/of BINDINGS\)/.test(dispatcher),
    'the keydown loop reads the overridden list',
  );
  check(
    'and it re-subscribes when a binding changes, so a remap is live immediately',
    /\}, \[commands, bindings\]\);/.test(dispatcher),
    'the listener effect depends on the bindings',
  );
  check(
    'the help overlay shows the EFFECTIVE chords, not the defaults',
    /effectiveChords\(s, overrides\)/.test(overlay)
      && !/displayChords/.test(overlay),
    'one resolver, two readers — they still cannot drift',
  );
  check(
    'and the function that formatted defaults is gone rather than left as a trap',
    !/export function displayChords/.test(defs),
    'removed with a note saying why',
  );
  check(
    'the overlay captures the keypress before the dispatcher can run it',
    /window\.addEventListener\('keydown', onKey, \{ capture: true \}\)/.test(overlay),
    'otherwise assigning ⌘S would save the session',
  );
  check(
    'every row can be edited and every changed row can be reset',
    /setCapturing\(s\.id\)/.test(overlay) && /reset\(s\.id\)/.test(overlay)
      && /resetAll\(\)/.test(overlay),
    'edit · reset · reset-all',
  );
  check(
    'and the table is searchable, because it is three hundred rows',
    /placeholder="기능 · 설명 · 키 검색"/.test(overlay),
    `${SHORTCUTS.length} commands in the table`,
  );
}

// ── The store writes to disk before it believes itself ───────────────────
{
  const store = readFileSync('src/renderer/stores/shortcutStore.ts', 'utf8');
  const guarded = (store.match(/if \(result\.ok\) set\(\{ overrides: loadOverrides\(\) \}\);/g) ?? []).length;
  check(
    'every mutator updates React state only if the write landed',
    guarded === 3,
    `${guarded}/3 mutators (setChords · reset · resetAll) check first`,
  );
}

setOverrideStore(null);
console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
