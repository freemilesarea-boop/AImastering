/**
 * context-menu-selftest — the second doorway, checked against the first.
 *
 * Before this, five files in the renderer had an `onContextMenu` and three of
 * them only called `preventDefault()`.  So three hundred commands were
 * reachable by a key you had to already know or a panel you had to already
 * have found, and right-click — which Logic's own manual describes as a
 * primary path — did nothing on a clip, a track header, a mixer strip or an
 * insert slot.
 *
 * The thing that can go wrong once menus exist is not that they look wrong.
 * It is that a menu entry becomes a SECOND implementation of the command it
 * is named after, drifting the first time either is fixed. So every item that
 * has a command carries only its id: the label comes from the same table the
 * dispatcher reads, the accelerator from the same resolver the help overlay
 * reads, and the click runs the same function the keystroke runs.
 *
 * This file holds that: every id in every menu must exist in the keymap, and
 * the menus must not be carrying their own labels for commands that have one.
 */
export {};

import { readFileSync } from 'node:fs';

import {
  clipMenu, insertMenu, mixerMenu, trackMenu,
} from '../src/renderer/components/daw/surface-menus.js';
import { SHORTCUTS, type CommandId } from '../src/renderer/shortcuts/definitions.js';
import { hasCommand, runCommand, setCommandMap } from '../src/renderer/shortcuts/command-runner.js';
import { LAYER } from '../src/renderer/theme/layers.js';
import type { MenuItem } from '../src/renderer/stores/contextMenuStore.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

const noop = (): void => {};

const MENUS: { surface: string; items: MenuItem[] }[] = [
  { surface: 'clip (audio)', items: clipMenu({ kind: 'audio', onOpenEditor: noop, onDelete: noop }) },
  { surface: 'clip (midi)', items: clipMenu({ kind: 'midi', onOpenEditor: noop, onDelete: noop }) },
  { surface: 'track', items: trackMenu({ onDelete: noop, onInserts: noop, inStack: false }) },
  { surface: 'track (master)', items: trackMenu({ onDelete: null, onInserts: noop, inStack: false }) },
  { surface: 'track (in stack)', items: trackMenu({ onDelete: noop, onInserts: noop, inStack: true }) },
  { surface: 'mixer', items: mixerMenu({ onInserts: noop, isMaster: false }) },
  { surface: 'mixer (master)', items: mixerMenu({ onInserts: noop, isMaster: true }) },
  { surface: 'insert (filled)', items: insertMenu({
    pluginName: 'Compressor', bypassed: false,
    onOpen: noop, onToggleBypass: noop, onRemove: noop, onInserts: noop }) },
  { surface: 'insert (empty)', items: insertMenu({
    pluginName: null, bypassed: false,
    onOpen: noop, onToggleBypass: noop, onRemove: noop, onInserts: noop }) },
];

const KNOWN = new Set<string>(SHORTCUTS.map((s) => s.id));
const commandIds = (items: MenuItem[]): CommandId[] =>
  items.filter((i): i is { kind: 'command'; id: CommandId; label?: string } => i.kind === 'command')
    .map((i) => i.id);

console.log('\n=== 우클릭 메뉴 ===\n');

// ── Every id is real ─────────────────────────────────────────────────────
{
  const unknown: string[] = [];
  let total = 0;
  for (const { surface, items } of MENUS) {
    for (const id of commandIds(items)) {
      total++;
      if (!KNOWN.has(id)) unknown.push(`${surface}: ${id}`);
    }
  }
  check(
    'every command a menu offers exists in the keymap',
    unknown.length === 0,
    unknown.length === 0 ? `${total} command entries across ${MENUS.length} menus`
      : unknown.join(' | '),
  );
}

// ── No second labels ─────────────────────────────────────────────────────
{
  const relabelled: string[] = [];
  for (const { surface, items } of MENUS) {
    for (const item of items) {
      if (item.kind !== 'command') continue;
      if (item.label !== undefined) relabelled.push(`${surface}: ${item.id}`);
    }
  }
  check(
    'and no menu writes its own label for a command that already has one',
    relabelled.length === 0,
    relabelled.length === 0 ? 'every command entry is an id and nothing else'
      : relabelled.join(' | '),
  );
}

// ── Shape ────────────────────────────────────────────────────────────────
{
  const problems: string[] = [];
  for (const { surface, items } of MENUS) {
    if (items.length === 0) { problems.push(`${surface}: empty`); continue; }
    if (items[0]?.kind === 'separator') problems.push(`${surface}: starts with a separator`);
    if (items[items.length - 1]?.kind === 'separator') problems.push(`${surface}: ends with a separator`);
    for (let i = 1; i < items.length; i++) {
      if (items[i]?.kind === 'separator' && items[i - 1]?.kind === 'separator') {
        problems.push(`${surface}: two separators in a row at ${i}`);
      }
      if (items[i]?.kind === 'separator' && items[i - 1]?.kind === 'header') {
        problems.push(`${surface}: a header with nothing under it at ${i}`);
      }
    }
    const last = items[items.length - 1];
    if (last?.kind === 'header') problems.push(`${surface}: ends with a header`);
  }
  check(
    'no menu is empty, starts or ends with a rule, or doubles one up',
    problems.length === 0,
    problems.length === 0 ? `${MENUS.length} menus, ${MENUS.reduce((n, m) => n + m.items.length, 0)} entries`
      : problems.join(' | '),
  );
}

// ── Destructive items say so ─────────────────────────────────────────────
{
  const unmarked: string[] = [];
  for (const { surface, items } of MENUS) {
    for (const item of items) {
      if (item.kind !== 'action') continue;
      const destructive = /삭제|비우기/.test(item.label);
      if (destructive && item.danger !== true && item.disabled !== true) {
        unmarked.push(`${surface}: ${item.label}`);
      }
    }
  }
  check(
    'anything that deletes is marked as such, not sitting next to a nudge',
    unmarked.length === 0,
    unmarked.length === 0 ? 'every 삭제 / 비우기 entry carries danger or is disabled'
      : unmarked.join(' | '),
  );
  // The master cannot be deleted and says so instead of offering a dead row.
  const master = MENUS.find((m) => m.surface === 'track (master)')!.items;
  const deadDelete = master.find((i) => i.kind === 'action' && i.label.includes('마스터'));
  check(
    'and the master offers no delete, with the reason on the row',
    deadDelete !== undefined && deadDelete.kind === 'action' && deadDelete.disabled === true,
    deadDelete?.kind === 'action' ? deadDelete.label : '(missing)',
  );
}

// ── The surfaces differ where they should ────────────────────────────────
{
  const audio = commandIds(MENUS.find((m) => m.surface === 'clip (audio)')!.items);
  const midi = commandIds(MENUS.find((m) => m.surface === 'clip (midi)')!.items);
  check(
    'an audio clip is offered audio work and a MIDI part is not',
    audio.includes('daw.normalizeClip') && audio.includes('daw.showWarp')
      && !midi.includes('daw.normalizeClip') && !midi.includes('daw.showWarp'),
    `audio ${audio.length} entries · midi ${midi.length} — normalize and warp are audio-only`,
  );
  const plain = commandIds(MENUS.find((m) => m.surface === 'track')!.items);
  const stacked = commandIds(MENUS.find((m) => m.surface === 'track (in stack)')!.items);
  check(
    'a track in a stack is offered unpack, and one outside it offers create',
    plain.includes('daw.createStack') && !plain.includes('daw.unpackStack')
      && stacked.includes('daw.unpackStack') && !stacked.includes('daw.createStack'),
    'one entry, two meanings — never both at once',
  );
  const strip = commandIds(MENUS.find((m) => m.surface === 'mixer')!.items);
  const masterStrip = commandIds(MENUS.find((m) => m.surface === 'mixer (master)')!.items);
  check(
    'and the master strip is not offered a track delay',
    strip.includes('daw.trackDelayEarlier') && !masterStrip.includes('daw.trackDelayEarlier'),
    'the output has nothing to be early or late against',
  );
  const filled = MENUS.find((m) => m.surface === 'insert (filled)')!.items;
  const empty = MENUS.find((m) => m.surface === 'insert (empty)')!.items;
  check(
    'an empty insert slot offers one thing, not a menu of dead items',
    empty.length === 1 && filled.length > 3,
    `empty ${empty.length} entry · filled ${filled.length}`,
  );
  check(
    'and a filled slot names the plugin it is about',
    filled.some((i) => i.kind === 'action' && i.label.includes('Compressor')),
    'the first row says which device',
  );
}

// ── The runner ───────────────────────────────────────────────────────────
{
  setCommandMap(null);
  check(
    'with no command map published, running a command reports that it did not',
    !hasCommand('daw.separate') && runCommand('daw.separate') === false,
    'a menu over a torn-down workspace does nothing and says so',
  );

  let ran: string[] = [];
  setCommandMap({ 'daw.separate': () => { ran.push('separate'); } });
  check(
    'with a map, the command runs and the caller is told it ran',
    runCommand('daw.separate') === true && ran.join() === 'separate'
      && hasCommand('daw.separate'),
    'one command, two doorways',
  );
  check(
    'an id the map does not carry is still a clean false',
    runCommand('daw.heal') === false,
    'not every command exists on every screen',
  );

  // A throwing command must reach the same sink the keyboard uses.
  const seen: string[] = [];
  setCommandMap(
    { 'daw.separate': () => { throw new Error('boom'); } },
    (id, err) => seen.push(`${id}:${(err as Error).message}`),
  );
  check(
    'a command that throws is reported, not swallowed',
    runCommand('daw.separate') === true && seen.join() === 'daw.separate:boom',
    seen.join() || '(nothing reported)',
  );

  // And an async rejection.
  const async: string[] = [];
  setCommandMap(
    { 'daw.separate': () => Promise.reject(new Error('later')) },
    (id, err) => async.push(`${id}:${(err as Error).message}`),
  );
  runCommand('daw.separate');
  setTimeout(() => {
    check(
      'and so is one that rejects a tick later',
      async.join() === 'daw.separate:later',
      async.join() || '(nothing reported)',
    );
    finish();
  }, 10);
  ran = [];
}

function finish(): void {
  // ── Wiring, read from the source ───────────────────────────────────────
  const edit = readFileSync('src/renderer/components/daw/edit/EditWindow.tsx', 'utf8');
  const mix = readFileSync('src/renderer/components/daw/mix/MixWindow.tsx', 'utf8');
  const menu = readFileSync('src/renderer/components/daw/ContextMenu.tsx', 'utf8');
  const chrome = readFileSync('src/renderer/components/daw/DawWorkspaceChrome.tsx', 'utf8');
  const hook = readFileSync('src/renderer/shortcuts/useDawShortcuts.ts', 'utf8');
  const store = readFileSync('src/renderer/stores/contextMenuStore.ts', 'utf8');

  check(
    'all four surfaces open a menu',
    /onContextMenu=\{\(e\) => onLaneContext\(e, row\.track\)\}/.test(edit)
      && /onContextMenu=\{onContextMenu\}/.test(edit)
      && /openContextMenu\(e, track\.name, mixerMenu\(/.test(mix)
      && /insertMenu\(\{/.test(mix),
    'clip lane · track header · mixer strip · insert slot',
  );
  check(
    'a right-click selects what it is about before offering the menu',
    /setFocusedTrack\(track\.id\);/.test(edit)
      && /setSelection\(\{\s*\n\s*startSec: clip\.startSec, endSec: clipEnd\(clip\)/.test(edit),
    'which is why the entries can be command ids — the commands act on the selection',
  );
  check(
    'and the clip menu opens the editor through the same path the double-click uses',
    /openClipEditor\(row\.track\.id, clip\)/.test(edit)
      && /onOpenEditor: \(\) => openClipEditor\(track\.id, clip\)/.test(edit),
    'one function, not a second answer to "which editor"',
  );
  check(
    'the menu is mounted once, not per surface',
    (chrome.match(/<ContextMenu \/>/g) ?? []).length === 1,
    'one portal, one set of dismissal rules',
  );
  check(
    'the hook publishes the command map it already built',
    /setCommandMap\(commands,/.test(hook) && /return \(\) => setCommandMap\(null\);/.test(hook),
    'cleared on unmount, so stale closures are never called',
  );
  check(
    'every caller suppresses the browser menu through one helper',
    /e\.preventDefault\(\);\s*\n\s*e\.stopPropagation\(\);/.test(store)
      && !/preventDefault/.test(edit.slice(edit.indexOf('onLaneContext'), edit.indexOf('onLaneContext') + 1400)),
    'openContextMenu does it — three of the five old handlers did only this and a fourth forgot',
  );
  check(
    'the menu shows the EFFECTIVE accelerator, so a remap is reflected here too',
    /effectiveChords\(def, overrides\)/.test(menu) && /describeSpec\(first, platform\)/.test(menu),
    'the only place the app teaches a shortcut at the moment you want the action',
  );
  check(
    'an item whose command this build cannot run is shown disabled, not hidden',
    /const runnable = def\?\.available !== false && hasCommand\(item\.id\)/.test(menu)
      && /disabled=\{!runnable\}/.test(menu),
    'hiding it would hide the bug in whoever built the menu',
  );
  check(
    'Escape and a press elsewhere both dismiss it',
    /e\.code !== 'Escape'/.test(menu)
      && /addEventListener\('mousedown', onDown\)/.test(menu)
      && /addEventListener\('keydown', onKey, \{ capture: true \}\)/.test(menu),
    'captured Escape, so it closes the menu rather than the panel behind it',
  );
  check(
    'and it flips rather than clips at the edge of the window',
    /x \+ w \+ pad > vw \? Math\.max\(pad, x - w\) : x/.test(menu),
    'measured after mount, hidden until placed',
  );
  check(
    'it sits above the popovers it can be raised from, and below a full scrim',
    LAYER.contextMenu > LAYER.popover && LAYER.contextMenu < LAYER.scrim
      && /zIndex: LAYER\.contextMenu/.test(menu),
    `popover ${LAYER.popover} < contextMenu ${LAYER.contextMenu} < scrim ${LAYER.scrim}`,
  );

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed === 0 ? 0 : 1);
}
