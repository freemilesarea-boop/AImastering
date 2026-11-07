/**
 * shortcuts-selftest.ts — DAW keyboard layer (DAW-SHORTCUTS-1).
 *
 * Covers the three pure layers of the feature:
 *   • chord parsing / matching (keys.ts)
 *   • the shortcut table itself (definitions.ts) — no collisions, no orphans
 *   • the command map (commands.ts) driven with fake deps + the real
 *     workspace store, plus the options undo history and lane geometry.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:shortcuts
 */

import {
  parseChord, matchesChord, normalizeKeyToken, formatChord, keyLabel,
  type KeyEventLike, type Platform,
} from '../src/renderer/shortcuts/keys.js';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { SHORTCUTS, BINDINGS, findShortcut, type CommandId } from '../src/renderer/shortcuts/definitions.js';
import { buildCommands, buildSession, type CommandDeps, type AudioSnapshot } from '../src/renderer/shortcuts/commands.js';
import type { SaveDepth, SaveDither } from '../src/renderer/audio/save-format.js';
import { searchCommands } from '../src/renderer/shortcuts/command-search.js';
import { LESSONS, stageOf } from '../src/renderer/shortcuts/lesson-plan.js';
import { buildCheatSheet } from '../src/renderer/shortcuts/cheat-sheet.js';
import {
  resetHints, takeHintTurn, MAX_HINTS_PER_COMMAND,
} from '../src/renderer/shortcuts/chord-hints.js';
import {
  describeSpec, effectiveChords, NO_OVERRIDES, type Overrides,
} from '../src/renderer/shortcuts/key-overrides.js';
import {
  useWorkspaceStore, snapTime, registerTransportElement, panelsSharingSlot,
} from '../src/renderer/stores/workspaceStore.js';
import {
  initHistory, record, undo, redo, canUndo, canRedo, HISTORY_LIMIT,
} from '../src/renderer/audio/options-history.js';
import { visibleWindow, ratioInWindow, timeAtRatio } from '../src/renderer/components/daw/transport-view.js';
import type { MasteringOptions } from '../src/renderer/stores/audioStore.js';
import type { MasteringResult } from '@aimaster/shared-types';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
/**
 * Run one check.
 *
 * It used to take `() => void` and call it bare.  Three checks in this file
 * are `async`, so `fn()` handed back a promise, the result was recorded as a
 * PASS before the body had run, and every assertion inside became an
 * unhandled rejection that never reached the tally.  Found by changing the
 * channel `file.export` calls and watching 38/38 pass anyway — the check that
 * named that channel was one of the three.
 *
 * So a promise is awaited, through the same list the summary waits on.
 */
const pending: Promise<void>[] = [];

function check(name: string, fn: () => void | Promise<void>): void {
  const record = (e?: unknown): void => {
    results.push(e === undefined
      ? { name, pass: true, detail: '' }
      : { name, pass: false, detail: e instanceof Error ? e.message : String(e) });
  };
  try {
    const out = fn();
    if (out !== undefined && typeof (out as Promise<void>).then === 'function') {
      pending.push((out as Promise<void>).then(() => { record(); }, (e: unknown) => { record(e); }));
      return;
    }
    record();
  } catch (e) { record(e); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function eq<T>(a: T, b: T, m: string): void {
  if (a !== b) throw new Error(`${m} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

const ev = (over: Partial<KeyEventLike>): KeyEventLike => ({
  code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...over,
});

// ── keys.ts ──────────────────────────────────────────────────────────────────

check('normalizeKeyToken maps letters / digits / names to codes', () => {
  eq(normalizeKeyToken('s'), 'KeyS', 'letter');
  eq(normalizeKeyToken('1'), 'Digit1', 'digit');
  eq(normalizeKeyToken('Space'), 'Space', 'space');
  eq(normalizeKeyToken('numpaddivide'), 'NumpadDivide', 'numpad');
  eq(normalizeKeyToken('f3'), 'F3', 'fkey');
  eq(normalizeKeyToken('Home'), 'Home', 'home');
});

check('parseChord reads modifiers', () => {
  const c = parseChord('Mod+Shift+S');
  eq(c.code, 'KeyS', 'code'); eq(c.mod, true, 'mod'); eq(c.shift, true, 'shift'); eq(c.alt, false, 'alt');
  const d = parseChord('Alt+X');
  eq(d.alt, true, 'alt'); eq(d.mod, false, 'no mod'); eq(d.code, 'KeyX', 'code');
});

check('Mod is Cmd on mac and Ctrl on win', () => {
  const save = parseChord('Mod+S');
  assert(matchesChord(ev({ code: 'KeyS', metaKey: true }), save, 'mac'), 'cmd+s on mac');
  assert(!matchesChord(ev({ code: 'KeyS', ctrlKey: true }), save, 'mac'), 'ctrl+s must NOT fire on mac');
  assert(matchesChord(ev({ code: 'KeyS', ctrlKey: true }), save, 'win'), 'ctrl+s on win');
  assert(!matchesChord(ev({ code: 'KeyS', metaKey: true }), save, 'win'), 'win key must not fire');
});

check('modifier matching is exact — Shift+S never fires the S binding', () => {
  const solo = parseChord('KeyS');
  const setup = parseChord('Shift+S');
  assert(matchesChord(ev({ code: 'KeyS' }), solo, 'win'), 'plain S');
  assert(!matchesChord(ev({ code: 'KeyS', shiftKey: true }), solo, 'win'), 'shift+S ≠ S');
  assert(matchesChord(ev({ code: 'KeyS', shiftKey: true }), setup, 'win'), 'shift+S');
  assert(!matchesChord(ev({ code: 'KeyS', ctrlKey: true, shiftKey: true }), setup, 'win'), 'ctrl+shift+S ≠ shift+S');
});

check('numpad bindings are distinct from the number row', () => {
  const loop = parseChord('NumpadDivide');
  assert(matchesChord(ev({ code: 'NumpadDivide' }), loop, 'win'), 'numpad /');
  assert(!matchesChord(ev({ code: 'Slash' }), loop, 'win'), 'row / must not fire');
  const tool1 = parseChord('Digit1');
  assert(!matchesChord(ev({ code: 'Numpad1' }), tool1, 'win'), 'numpad 1 ≠ tool 1');
});

check('Option+X matches by physical code (mac composes ≈ in e.key)', () => {
  const split = parseChord('Alt+X');
  assert(matchesChord(ev({ code: 'KeyX', key: '≈', altKey: true }), split, 'mac'), 'alt+x on mac');
});

check('formatChord renders per platform, ? for Shift+Slash', () => {
  eq(formatChord(parseChord('Mod+Shift+S'), 'mac'), '⌘ + Shift + S', 'mac');
  eq(formatChord(parseChord('Mod+Shift+S'), 'win'), 'Ctrl + Shift + S', 'win');
  eq(formatChord(parseChord('Shift+Slash'), 'win'), '?', 'help');
  eq(keyLabel('NumpadDecimal'), 'Numpad .', 'numpad label');
});

// ── definitions.ts ───────────────────────────────────────────────────────────

check('every shortcut has a label, note and at least one chord', () => {
  for (const s of SHORTCUTS) {
    assert(s.label.length > 0, `${s.id} label`);
    assert(s.note.length > 0, `${s.id} note`);
    assert(s.chords.length > 0, `${s.id} chords`);
    for (const spec of s.chords) assert(parseChord(spec).code !== '', `${s.id} chord "${spec}" has no key`);
  }
});

check('no two commands claim the same chord', () => {
  const seen = new Map<string, CommandId>();
  for (const { def, chord } of BINDINGS) {
    const key = `${chord.mod ? 'M' : ''}${chord.alt ? 'A' : ''}${chord.shift ? 'S' : ''}|${chord.code}`;
    const prev = seen.get(key);
    assert(prev === undefined, `${key} bound to both ${prev} and ${def.id}`);
    seen.set(key, def.id);
  }
});

check('all five Cubase groups are covered', () => {
  for (const g of ['file', 'transport', 'tools', 'edit', 'window'] as const) {
    assert(SHORTCUTS.some((s) => s.group === g), `group ${g} empty`);
  }
  eq(SHORTCUTS.filter((s) => s.group === 'tools').length, 9, '9 toolbar tools');
});

check('nothing that ships is still marked "not applicable"', () => {
  // `available: false` draws the row STRUCK THROUGH in the DAW's shortcut
  // help, over the words "해당 없음".  Saying that about a key that works is
  // worse than saying nothing: the user stops pressing it.
  //
  // This used to assert the off-list verbatim — `tool.draw,tool.glue,
  // transport.record` — with a comment saying the point was that a shipped
  // feature left marked "not applicable" would fail here.  It could not: a
  // frozen list only moves when somebody edits it, which is exactly what a
  // stale flag means nobody did.  Two of the three had shipped in the DAW and
  // the list never budged.  Record even contradicted itself in one sentence:
  // struck through, note reading "DAW 워크스페이스에서는 이 키가 녹음을 시작합니다".
  //
  // So the flag is checked against the evidence instead — the DAW's own
  // command map for verbs, and the surfaces that branch on a tool id for
  // tools.  A feature landing now flips the flag or fails here.
  const dawCommands = readFileSync('src/renderer/shortcuts/daw-commands.ts', 'utf8');
  const dawUi = execSync(
    String.raw`grep -rho "tool === '[a-z]*'" src/renderer/components/daw || true`,
    { encoding: 'utf8', shell: '/bin/bash' });

  const shipped = (id: CommandId): string | null => {
    if (new RegExp(`'${id}':`).test(dawCommands)) return 'the DAW command map implements it';
    const tool = /^tool\.([a-z]+)$/.exec(id)?.[1];
    if (tool !== undefined && dawUi.includes(`tool === '${tool}'`)) {
      return `a DAW surface branches on tool === '${tool}'`;
    }
    return null;
  };

  const wrong = SHORTCUTS.filter((s) => !s.available)
    .map((s) => ({ id: s.id, why: shipped(s.id) }))
    .filter((x) => x.why !== null);
  assert(wrong.length === 0,
    'marked unavailable, but shipped:\n    '
    + wrong.map((x) => `${x.id} — ${x.why!}`).join('\n    '));

  // And the converse, so the flag cannot simply be set true everywhere: the
  // one genuinely-off key must stay off while nothing acts on it.
  const glue = SHORTCUTS.find((s) => s.id === 'tool.glue');
  assert(glue !== undefined && !glue.available && shipped('tool.glue') === null,
    'tool.glue is still unimplemented and must stay marked so');
});

// ── options history ──────────────────────────────────────────────────────────

const opts = (over: Partial<MasteringOptions> = {}): MasteringOptions => ({
  style: 'balanced', targetLufs: -14, targetTp: -1, sampleRate: 44100, bitDepth: 24,
  applyAiCorrections: true, limiterStrength: 'medium', ...over,
});

check('history records, undoes and redoes', () => {
  let h = initHistory(opts());
  assert(!canUndo(h), 'fresh has no undo');
  h = record(h, opts({ targetLufs: -10 }));
  h = record(h, opts({ targetLufs: -8 }));
  eq(h.present.targetLufs, -8, 'present');
  h = undo(h);
  eq(h.present.targetLufs, -10, 'undo 1');
  h = undo(h);
  eq(h.present.targetLufs, -14, 'undo 2');
  assert(!canUndo(h), 'exhausted');
  assert(canRedo(h), 'redo available');
  h = redo(h);
  eq(h.present.targetLufs, -10, 'redo');
});

check('history ignores no-op records and drops the redo branch on a new edit', () => {
  let h = initHistory(opts());
  const before = h;
  h = record(h, opts());
  assert(h === before, 'identical snapshot is a no-op');
  h = record(h, opts({ targetLufs: -9 }));
  h = undo(h);
  assert(canRedo(h), 'redo armed');
  h = record(h, opts({ targetLufs: -7 }));
  assert(!canRedo(h), 'redo branch dropped');
});

check('history is capped', () => {
  let h = initHistory(opts());
  for (let i = 0; i < HISTORY_LIMIT + 20; i++) h = record(h, opts({ targetLufs: -20 + i * 0.1 }));
  assert(h.past.length <= HISTORY_LIMIT, `past=${h.past.length} > ${HISTORY_LIMIT}`);
});

// ── lane geometry ────────────────────────────────────────────────────────────

check('visibleWindow centres on the play head and clamps to the file', () => {
  eq(visibleWindow(0, 0, 4).endSec, 0, 'no duration');
  const full = visibleWindow(100, 50, 1);
  eq(full.startSec, 0, 'zoom 1 start'); eq(full.endSec, 100, 'zoom 1 end');
  const mid = visibleWindow(100, 50, 4);
  eq(mid.startSec, 37.5, 'centred start'); eq(mid.endSec, 62.5, 'centred end');
  const head = visibleWindow(100, 0, 4);
  eq(head.startSec, 0, 'clamped left');
  const tail = visibleWindow(100, 100, 4);
  eq(tail.endSec, 100, 'clamped right');
});

check('ratioInWindow / timeAtRatio round-trip', () => {
  const view = visibleWindow(100, 50, 4);
  eq(ratioInWindow(50, view), 0.5, 'centre ratio');
  eq(timeAtRatio(0.5, view), 50, 'centre time');
  eq(timeAtRatio(-1, view), view.startSec, 'clamped low');
  eq(timeAtRatio(9, view), view.endSec, 'clamped high');
});

// ── snap ─────────────────────────────────────────────────────────────────────

check('snapTime is identity while snap is off, grid/marker aware when on', () => {
  const ws = useWorkspaceStore.getState();
  ws.setSnapMarkers([12.4]);
  eq(snapTime(3.7), 3.7, 'snap off');
  ws.toggleSnap();
  eq(snapTime(3.7), 4, 'grid snap');
  eq(snapTime(12.3), 12.4, 'marker wins inside a grid step');
  ws.toggleSnap();
  ws.setSnapMarkers([]);
});

// ── command map ──────────────────────────────────────────────────────────────

interface Harness {
  deps: CommandDeps;
  notes: Array<{ message: string; type: string | undefined }>;
  pages: string[];
  invocations: Array<{ channel: string; args: unknown[] }>;
  options: MasteringOptions;
  updates: Array<Partial<MasteringOptions>>;
  revisions: number;
  audioSnapshot: AudioSnapshot;
  muted: boolean;
  positionSec: number;
  durationSec: number;
  hasElement: boolean;
  toggles: number;
  /** What the result screen is set to write — read by file.export. */
  saveFormat: { depth: SaveDepth; dither: SaveDither };
}

function harness(over: Partial<AudioSnapshot> = {}, invokeResult: unknown = null): Harness {
  const h: Harness = {
    deps: null as unknown as CommandDeps,
    notes: [], pages: [], invocations: [], updates: [], revisions: 0,
    options: opts(),
    audioSnapshot: {
      selectedFile: null, masteringResult: null, options: opts(), referenceFilePath: null, ...over,
    },
    muted: false, positionSec: 0, durationSec: 120, hasElement: true, toggles: 0,
    saveFormat: { depth: '24', dither: 'tpdf' },
  };
  h.options = h.audioSnapshot.options;
  h.deps = {
    notify: (message, type) => { h.notes.push({ message, type }); },
    setPage: (p) => { h.pages.push(p); },
    getAudio: () => ({ ...h.audioSnapshot, options: h.options }),
    saveFormat: () => h.saveFormat,
    audio: {
      reset: () => { h.audioSnapshot.selectedFile = null; },
      setFile: (p) => { h.audioSnapshot.selectedFile = p; },
      addFilesToQueue: () => { /* counted via invocations */ },
      updateOptions: (patch) => { h.updates.push(patch); h.options = { ...h.options, ...patch }; },
      setReferenceFile: (p) => { h.audioSnapshot.referenceFilePath = p; },
      setShowAdvanced: () => { /* noop */ },
      addRevision: () => { h.revisions += 1; },
    },
    workspace: () => useWorkspaceStore.getState(),
    transport: {
      hasElement: () => h.hasElement,
      toggle: () => { h.toggles += 1; },
      pause: () => { /* noop */ },
      seek: (sec) => { h.positionSec = sec; },
      position: () => h.positionSec,
      duration: () => h.durationSec,
      isMuted: () => h.muted,
      setMuted: (v) => { h.muted = v; },
    },
    invoke: (channel, ...args) => {
      h.invocations.push({ channel, args });
      return Promise.resolve(invokeResult);
    },
  };
  return h;
}

function freshWorkspace(): void {
  const ws = useWorkspaceStore.getState();
  ws.setTool('select');
  ws.setLoop({ startSec: 0, endSec: 0 });
  ws.setLoopEnabled(false);
  ws.setSelection(null);
  ws.resetZoom();
  ws.setMuted(false);
  ws.setClipboard(null);
  ws.resetOptionsHistory(opts());
  ws.setPanel('mixConsole', false);
  if (ws.snapEnabled) ws.toggleSnap();
}

check('every CommandId in the table has an implementation', () => {
  const cmds = buildCommands(harness().deps);
  for (const s of SHORTCUTS) {
    assert(typeof cmds[s.id] === 'function', `${s.id} has no command`);
  }
  const implemented = Object.keys(cmds).sort();
  const declared = SHORTCUTS.map((s) => s.id).sort();
  eq(implemented.join(','), declared.join(','), 'command map matches the table exactly');
});

check('unavailable commands explain themselves instead of doing nothing', () => {
  const h = harness();
  const cmds = buildCommands(h.deps);
  cmds['transport.record']();
  cmds['transport.metronome']();
  cmds['window.keyEditor']();
  eq(h.notes.length, 3, 'one toast each');
  for (const n of h.notes) eq(n.type, 'warning', 'warning level');
  assert(h.notes[0]!.message === findShortcut('transport.record')!.note, 'note reused verbatim');
});

check('Space warns when nothing is loaded and toggles when it is', () => {
  const h = harness();
  h.hasElement = false;
  const cmds = buildCommands(h.deps);
  cmds['transport.playPause']();
  eq(h.toggles, 0, 'no toggle');
  eq(h.notes[0]!.type, 'warning', 'warned');
  h.hasElement = true;
  cmds['transport.playPause']();
  eq(h.toggles, 1, 'toggled');
});

check('loop toggle arms the whole file, locators seek to it', () => {
  freshWorkspace();
  const h = harness();
  const cmds = buildCommands(h.deps);
  cmds['transport.toggleLoop']();
  const ws = useWorkspaceStore.getState();
  eq(ws.loopEnabled, true, 'loop on');
  eq(ws.loop.endSec, 120, 'armed to duration');
  cmds['transport.gotoLoopEnd']();
  eq(h.positionSec, 120, 'seek to right locator');
  cmds['transport.gotoLoopStart']();
  eq(h.positionSec, 0, 'seek to left locator');
  cmds['transport.toggleLoop']();
  eq(useWorkspaceStore.getState().loopEnabled, false, 'loop off');
});

check('P maps the selection onto the loop', () => {
  freshWorkspace();
  const h = harness();
  const cmds = buildCommands(h.deps);
  useWorkspaceStore.getState().setSelection({ startSec: 30, endSec: 45 });
  cmds['loop.toSelection']();
  const ws = useWorkspaceStore.getState();
  eq(ws.loop.startSec, 30, 'start'); eq(ws.loop.endSec, 45, 'end'); eq(ws.loopEnabled, true, 'enabled');
});

check('Alt+X splits the range at the play head', () => {
  freshWorkspace();
  const h = harness();
  const cmds = buildCommands(h.deps);
  useWorkspaceStore.getState().setSelection({ startSec: 10, endSec: 50 });
  h.positionSec = 30;
  cmds['edit.splitAtCursor']();
  eq(useWorkspaceStore.getState().selection!.endSec, 30, 'head kept');
  h.positionSec = 90;                       // outside the range now
  cmds['edit.splitAtCursor']();
  eq(h.notes[h.notes.length - 1]!.type, 'warning', 'refuses outside the range');
});

check('number keys switch the active tool', () => {
  freshWorkspace();
  const cmds = buildCommands(harness().deps);
  cmds['tool.range']();
  eq(useWorkspaceStore.getState().tool, 'range', 'range');
  cmds['tool.scrub']();
  eq(useWorkspaceStore.getState().tool, 'scrub', 'scrub');
});

check('undo / redo push snapshots back into the options', () => {
  freshWorkspace();
  const h = harness();
  const cmds = buildCommands(h.deps);
  const ws = useWorkspaceStore.getState();
  ws.recordOptions(opts({ targetLufs: -10 }));
  ws.recordOptions(opts({ targetLufs: -8 }));
  cmds['edit.undo']();
  eq(h.options.targetLufs, -10, 'undo applied');
  eq(useWorkspaceStore.getState().applyingHistory, false, 'flag cleared');
  cmds['edit.redo']();
  eq(h.options.targetLufs, -8, 'redo applied');
  cmds['edit.undo'](); cmds['edit.undo'](); cmds['edit.undo']();
  eq(h.notes[h.notes.length - 1]!.message, '되돌릴 변경이 없습니다', 'bottom of the stack');
});

check('copy / paste move the settings through the workspace clipboard', () => {
  freshWorkspace();
  const h = harness();
  const cmds = buildCommands(h.deps);
  cmds['edit.paste']();
  eq(h.notes[0]!.type, 'warning', 'nothing to paste yet');
  h.options = opts({ targetLufs: -9, style: 'punch' });
  cmds['edit.copy']();
  h.options = opts();
  cmds['edit.paste']();
  eq(h.options.targetLufs, -9, 'lufs pasted');
  eq(h.options.style, 'punch', 'style pasted');
});

check('S bypasses the master chain, M mutes, Alt+S clears both', () => {
  freshWorkspace();
  const h = harness();
  const cmds = buildCommands(h.deps);
  cmds['track.solo']();
  eq(h.options.rt?.masterBypass, true, 'bypass on');
  cmds['track.mute']();
  eq(h.muted, true, 'muted');
  cmds['track.clearSoloMute']();
  eq(h.muted, false, 'unmuted');
  eq(h.options.rt?.masterBypass, false, 'bypass off');
});

check('zoom commands step the workspace zoom', () => {
  freshWorkspace();
  const cmds = buildCommands(harness().deps);
  cmds['view.zoomInH'](); cmds['view.zoomInH']();
  eq(useWorkspaceStore.getState().zoomH, 4, 'H zoom in');
  cmds['view.zoomOutH']();
  eq(useWorkspaceStore.getState().zoomH, 2, 'H zoom out');
  for (let i = 0; i < 12; i++) cmds['view.zoomInH']();
  eq(useWorkspaceStore.getState().zoomH, 64, 'clamped at max');
});

check('panel commands toggle their panel', () => {
  freshWorkspace();
  const h = harness();
  const cmds = buildCommands(h.deps);
  cmds['window.mixConsole']();
  eq(useWorkspaceStore.getState().panels.mixConsole, true, 'opened');
  cmds['window.mixConsole']();
  eq(useWorkspaceStore.getState().panels.mixConsole, false, 'closed');
  cmds['window.shortcutHelp']();
  eq(useWorkspaceStore.getState().panels.help, true, 'help opened');
  cmds['window.shortcutHelp']();
});

check('export refuses without a master, and carries the chosen depth and dither', async () => {
  const h = harness();
  const cmds = buildCommands(h.deps);
  await cmds['file.export']();
  eq(h.invocations.length, 0, 'no IPC without a result');
  eq(h.notes[0]!.type, 'warning', 'warned');

  // The result screen's own choice has to reach the file.  This command used
  // to call `file:save-wav`, which is a plain copy: 16-bit with TPDF dither,
  // picked on that very screen, was written as the 24-bit render with no
  // dither and nothing said a word.  The 저장 button beside it was right.
  const h2 = harness({ masteringResult: { outputPath: '/tmp/master.wav' } as MasteringResult },
    { savedPath: '/out/master.wav' });
  h2.saveFormat = { depth: '16', dither: 'tpdf' };
  await buildCommands(h2.deps)['file.export']();
  eq(h2.invocations[0]!.channel, 'file:save-audio', 'channel');
  const req = h2.invocations[0]!.args[0] as { sourcePath: string; bitDepth: number; dither: string };
  eq(req.sourcePath, '/tmp/master.wav', 'source path');
  eq(req.bitDepth, 16, 'the chosen depth');
  eq(req.dither, 'tpdf', 'and the dither that goes with it');
  eq(h2.notes[0]!.type, 'success', 'success toast');

  // At the render's own depth there is nothing to dither, so the payload must
  // say none rather than name a shape the file will not get.
  const h3 = harness({ masteringResult: { outputPath: '/tmp/m.wav' } as MasteringResult },
    { savedPath: '/out/m.wav' });
  h3.saveFormat = { depth: '24', dither: 'shaped' };
  await buildCommands(h3.deps)['file.export']();
  eq((h3.invocations[0]!.args[0] as { dither: string }).dither, 'none', '24-bit carries no dither');

  // A cancelled dialog answers with no path and must not claim a success.
  const h4 = harness({ masteringResult: { outputPath: '/tmp/m.wav' } as MasteringResult },
    { savedPath: null });
  await buildCommands(h4.deps)['file.export']();
  eq(h4.notes.length, 0, 'a cancelled export says nothing');
});

check('save serialises a loadable session', async () => {
  const h = harness({ selectedFile: '/songs/take1.wav' }, '/sessions/a.louisession');
  const cmds = buildCommands(h.deps);
  await cmds['file.save']();
  eq(h.invocations[0]!.channel, 'session:save', 'channel');
  const raw = h.invocations[0]!.args[0] as string;
  const parsed = JSON.parse(raw) as { sourceFilePath: string; baseOptions: MasteringOptions; version: number };
  eq(parsed.sourceFilePath, '/songs/take1.wav', 'source in session');
  eq(parsed.baseOptions.targetLufs, -14, 'options in session');
  eq(parsed.version, 1, 'version');
});

check('open session restores the source file and options', async () => {
  const session = buildSession(
    { selectedFile: '/songs/b.wav', masteringResult: null, referenceFilePath: null, options: opts({ targetLufs: -9 }) },
    '2026-01-01T00:00:00.000Z',
  );
  const h = harness({}, { path: '/sessions/b.louisession', data: JSON.stringify(session) });
  const cmds = buildCommands(h.deps);
  await cmds['file.openSession']();
  eq(h.audioSnapshot.selectedFile, '/songs/b.wav', 'source restored');
  eq(h.options.targetLufs, -9, 'options restored');
});

check('new project resets the workspace ranges and goes home', () => {
  const h = harness({ selectedFile: '/songs/c.wav' });
  const cmds = buildCommands(h.deps);
  useWorkspaceStore.getState().setLoop({ startSec: 5, endSec: 9 });
  useWorkspaceStore.getState().setLoopEnabled(true);
  cmds['file.new']();
  const ws = useWorkspaceStore.getState();
  eq(ws.loopEnabled, false, 'loop cleared');
  eq(ws.loop.endSec, 0, 'range cleared');
  eq(h.pages[0], 'home', 'navigated home');
  eq(h.audioSnapshot.selectedFile, null, 'session reset');
});

check('duplicate needs a rendered master', () => {
  const h = harness({ selectedFile: '/songs/d.wav' });
  const cmds = buildCommands(h.deps);
  cmds['edit.duplicate']();
  eq(h.revisions, 0, 'no revision without a result');
  const h2 = harness({
    selectedFile: '/songs/d.wav',
    masteringResult: {
      outputPath: '/tmp/d.wav', previewPath: '/tmp/d.mp3',
      loudnessAfter: { integratedLufs: -13.9, truePeakDbtp: -1.1, lra: 6 },
    } as MasteringResult,
  });
  const cmds2 = buildCommands(h2.deps);
  cmds2['edit.duplicate']();
  eq(h2.revisions, 1, 'revision added');
});

// Transport registry must not leak between runs.
registerTransportElement(null);

// ── Zoom says which way it went ────────────────────────────────────────────
//
// Reported as "zoom in is G and zoom out is F, and they feel swapped".  They
// were not swapped.  F is bound to zoomInH and G to zoomOutH, the store
// multiplies on one and divides on the other, and the DAW override does the
// same to pxPerSec — the keys did exactly what they say.
//
// What was wrong was the sentence.  BOTH directions announced themselves as
// 확대: press the zoom-out key, watch the view shrink, and read "가로 확대".
// A pair of keys that behave correctly and describe themselves wrongly is
// indistinguishable, from the far side of the screen, from a pair that is
// bound backwards.
check('zooming out does not announce itself as zooming in', () => {
  const src = readFileSync('src/renderer/shortcuts/commands.ts', 'utf8');
  const line = (id: string): string =>
    src.split('\n').find((l) => l.includes(`'${id}':`)) ?? '';
  const outH = line('view.zoomOutH');
  const outV = line('view.zoomOutV');
  assert(outH.length > 0 && outV.length > 0, 'the zoom-out commands are gone');
  assert(!outH.includes('가로 확대'), `zoomOutH still says 확대: ${outH.trim()}`);
  assert(outH.includes('축소'), `zoomOutH does not say 축소: ${outH.trim()}`);
  assert(!outV.includes('세로 확대'), `zoomOutV still says 확대: ${outV.trim()}`);
  assert(outV.includes('축소'), `zoomOutV does not say 축소: ${outV.trim()}`);
});

check('and zooming in still says so', () => {
  const src = readFileSync('src/renderer/shortcuts/commands.ts', 'utf8');
  const line = (id: string): string =>
    src.split('\n').find((l) => l.includes(`'${id}':`)) ?? '';
  assert(line('view.zoomInH').includes('가로 확대'), 'zoomInH lost its label');
  assert(line('view.zoomInV').includes('세로 확대'), 'zoomInV lost its label');
});

// The half that was never broken, pinned so a "fix" cannot swap the bindings
// to chase a symptom that lived in the text.
check('F still zooms in and G still zooms out', () => {
  const defs = readFileSync('src/renderer/shortcuts/definitions.ts', 'utf8');
  const inH = defs.split('\n').find((l) => l.includes("id: 'view.zoomInH'")) ?? '';
  const outH = defs.split('\n').find((l) => l.includes("id: 'view.zoomOutH'")) ?? '';
  assert(inH.includes("'KeyF'"), `zoomInH is not on F: ${inH.trim()}`);
  assert(outH.includes("'KeyG'"), `zoomOutH is not on G: ${outH.trim()}`);
});

check('and the DAW override still zooms the way it is named', () => {
  const dc = readFileSync('src/renderer/shortcuts/daw-commands.ts', 'utf8');
  assert(/'view\.zoomInH':\s*\(\)\s*=>\s*\{[^}]*pxPerSec\s*\*/.test(dc),
    'zoomInH no longer multiplies pxPerSec');
  assert(/'view\.zoomOutH':\s*\(\)\s*=>\s*\{[^}]*pxPerSec\s*\//.test(dc),
    'zoomOutH no longer divides pxPerSec');
});

// ── Teaching the keyboard ────────────────────────────────────────────────────

check('the palette and the "?" overlay search the same way', () => {
  // One function, two surfaces.  A second copy is how the two would start
  // disagreeing about whether a remapped key is findable — the duplication
  // that bit the session save, the WAV export and the MIDI import.
  const help = readFileSync('src/renderer/components/daw/DawShortcutHelp.tsx', 'utf8');
  const palette = readFileSync('src/renderer/components/daw/DawCommandPalette.tsx', 'utf8');
  for (const [name, src] of [['help', help], ['palette', palette]] as const) {
    assert(/searchCommands\(/.test(src), `${name} calls searchCommands`);
    assert(!/\.note\.toLowerCase\(\)\.includes/.test(src),
      `${name} does not carry its own copy of the matcher`);
  }
});

check('a command is found by its name, its note and the key as printed', () => {
  const platform: Platform = 'win';
  const freeze = findShortcut('daw.freeze')!;
  const byName = searchCommands('프리즈', NO_OVERRIDES, platform);
  assert(byName.some((d) => d.id === 'daw.freeze'), 'by name');

  const printed = describeSpec(freeze.chords[0]!, platform);
  const byKey = searchCommands(printed, NO_OVERRIDES, platform);
  assert(byKey.some((d) => d.id === 'daw.freeze'), `by the key as printed (${printed})`);

  // The note is the sentence under the row, and it is what somebody who does
  // not know the app's word for a thing will type.
  const byNote = searchCommands('인서트를', NO_OVERRIDES, platform);
  assert(byNote.length > 0, 'by words from the note');

  eq(searchCommands('', NO_OVERRIDES, platform).length, SHORTCUTS.length, 'an empty query is everything');
  eq(searchCommands('프리즈', NO_OVERRIDES, platform, 1).length, 1, 'the limit is honoured');
});

check('a remapped command is found by the key it has now, not the one it had', () => {
  const platform: Platform = 'win';
  const freeze = findShortcut('daw.freeze')!;
  const was = describeSpec(freeze.chords[0]!, platform);
  const overrides: Overrides = Object.freeze({ 'daw.freeze': ['Mod+Alt+Shift+KeyV'] });
  const now = describeSpec('Mod+Alt+Shift+KeyV', platform);

  assert(searchCommands(now, overrides, platform).some((d) => d.id === 'daw.freeze'),
    `found by the new key (${now})`);
  assert(!searchCommands(was, overrides, platform).some((d) => d.id === 'daw.freeze'),
    `no longer found by the old one (${was})`);
});

check('every command id the toolbar names is a real one', () => {
  // A typo here is a button that does nothing AND has no tooltip, which is
  // two silent failures for the price of one.
  const page = readFileSync('src/renderer/pages/DawPage.tsx', 'utf8');
  const ids = [...page.matchAll(/<ToolbarButton cmd="([^"]+)"/g)].map((m) => m[1]!);
  assert(ids.length >= 15, `the toolbar names ${ids.length} commands`);
  for (const id of ids) {
    assert(findShortcut(id as CommandId) !== undefined, `${id} is in the table`);
  }
});

check('no tooltip spells a chord out by hand', () => {
  // Twenty-two of them did.  Two ways wrong: "(Mod+Alt+D)" shows the person
  // the word "Mod", which is a token from this codebase and not a key on
  // anybody's keyboard; and all of them were frozen text, so the moment a
  // student remapped the command the tooltip told them the wrong key with
  // complete confidence — worse than saying nothing.
  //
  // One of them named a key bound to NOTHING: 가로 확대 is KeyF, the way 가로
  // 축소 next to it is KeyG, and both its tooltip and its face said H.  A
  // student pressing H got silence.
  //
  // So tooltips ask the keymap (`commandTitle`), and this check keeps it that
  // way.  A mouse gesture is still allowed to be written out — "Alt+클릭" is
  // not a chord and the keymap has nothing to say about it.
  const files = execSync('grep -rl \'title="\' src/renderer --include=*.tsx', { encoding: 'utf8' })
    .trim().split('\n');
  const chordish = [
    /(?:Mod|Cmd|Ctrl)\+/,          // the modifier spelled as a token
    /⌘|⌥/,                         // or as a glyph
    /Alt\+(?![가-힣])/,             // Alt+KEY, but not Alt+클릭
    /\((?:Home|End|Space|Tab|Enter|Esc|Escape|Del|Delete|Numpad[^)]*|F\d+|[A-Z])\)/,
  ];
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    // Three forms, because the one this check first missed was the third:
    // a conditional inside title={...} with the chord in both branches.  The
    // app itself gave it away — four "×" buttons still saying (Mod+Backspace)
    // while this check reported none.
    const texts = [
      ...[...src.matchAll(/title="([^"]*)"/g)].map((m) => m[1]!),
      ...[...src.matchAll(/title=\{'([^']*)'\}/g)].map((m) => m[1]!),
      ...[...src.matchAll(/title=\{(?:(?!\}\s*$)[\s\S]){0,400}?\}/g)].map((m) => m[0]),
    ];
    for (const text of texts) {
      // `commandTitle(...)` naming a command id is the right answer, not an
      // offender: ids like 'daw.open' contain no chord, and the chord it
      // renders comes from the keymap at run time.
      const bare = text.replace(/commandTitle\([^)]*\)/g, '');
      if (chordish.some((re) => re.test(bare))) {
        offenders.push(`${f.replace('src/renderer/', '')}: "${bare.slice(0, 56).trim()}"`);
      }
    }
  }
  assert(offenders.length === 0,
    `${offenders.length} tooltip(s) write a key out instead of asking the keymap:\n    `
    + offenders.join('\n    '));
});

check('the cheat sheet prints what the keyboard actually is', () => {
  const platform: Platform = 'win';
  const ids: CommandId[] = ['file.save', 'transport.playPause', 'daw.freeze'];
  const html = buildCheatSheet({
    title: '시험', commands: ids, overrides: NO_OVERRIDES, platform,
    printedAt: new Date('2026-01-02T03:04:05Z'),
  });
  for (const id of ids) {
    const def = findShortcut(id)!;
    assert(html.includes(def.label), `${id}: the label is on the page`);
    const chord = describeSpec(def.chords[0]!, platform);
    assert(html.includes(chord), `${id}: its key (${chord}) is on the page`);
  }
  assert(html.includes('2026-01-02 03:04'), 'and when it was printed');
});

check('a remapped key prints as the remapped key, and is marked', () => {
  const platform: Platform = 'win';
  const overrides: Overrides = Object.freeze({ 'daw.freeze': ['Mod+Alt+Shift+KeyV'] });
  const html = buildCheatSheet({
    title: '시험', commands: ['daw.freeze'], overrides, platform, printedAt: new Date(),
  });
  // A sheet of factory defaults is wrong for anybody who changed a key, which
  // is the whole reason this is generated rather than shipped as a picture.
  assert(html.includes(describeSpec('Mod+Alt+Shift+KeyV', platform)), 'the new key');
  assert(!html.includes(describeSpec(findShortcut('daw.freeze')!.chords[0]!, platform)),
    'and not the one it replaced');
  assert(/class="row changed"/.test(html), 'and the row says it was changed');
});

check('the page escapes the text it is given', () => {
  // Real data, not a synthetic case: one note in the table carries double
  // quotes, so this check has something to prove.
  const html = buildCheatSheet({
    title: '시험', commands: ['daw.tuneToGuide'], overrides: NO_OVERRIDES,
    platform: 'win', printedAt: new Date(),
  });
  assert(html.includes('&quot;의도한 음&quot;'), 'the quotes came through escaped');
  assert(!html.includes('"의도한 음"'), 'and not raw');
});

check('the page is self-contained, because a classroom machine has no network', () => {
  const html = buildCheatSheet({
    title: '전체', commands: SHORTCUTS.map((s) => s.id), overrides: NO_OVERRIDES,
    platform: 'mac', printedAt: new Date(),
  });
  for (const bad of ['http://', 'https://', '<script', '@import', 'url(']) {
    assert(!html.includes(bad), `nothing to fetch: found ${bad}`);
  }
  assert(/@page/.test(html) && /columns: 2/.test(html), 'and it is laid out for paper');
});

check('a stage prints as that stage, not as the whole table', () => {
  const first = LESSONS.find((l) => l.stage === 1)!;
  const html = buildCheatSheet({
    title: first.title, commands: first.commands, overrides: NO_OVERRIDES,
    platform: 'win', printedAt: new Date(),
  });
  assert(html.includes(first.title), 'the stage names itself');
  eq((html.match(/class="row/g) ?? []).length, first.commands.length, 'one row per command');
  // Rendered and looked at: every row carried an identical "1단계" chip while
  // the title above already said it.  A badge that is the same on every row
  // says nothing, so a stage's sheet drops it — and the whole table, where
  // the stages differ, keeps it as the map of the course.
  assert(!/class="stage"/.test(html), 'a stage sheet does not repeat the stage on every row');
  const whole = buildCheatSheet({
    title: '전체', commands: SHORTCUTS.map((x) => x.id), overrides: NO_OVERRIDES,
    platform: 'win', printedAt: new Date(),
  });
  assert(/class="stage"/.test(whole), 'but the whole table marks which rows a stage teaches');
});

check('the lesson plan teaches real commands, each in one place', () => {
  // The curriculum is data in its own file so a course can change without
  // touching the table the dispatcher reads.  Data rots: an id that no longer
  // exists is a stage with a hole in it, and a command in two stages means a
  // student is taught it twice and the counts on the chips are wrong.
  const seen = new Map<string, number>();
  for (const lesson of LESSONS) {
    assert(lesson.commands.length > 0, `${lesson.title} is empty`);
    for (const id of lesson.commands) {
      assert(findShortcut(id) !== undefined, `${lesson.title}: ${id} is not in the table`);
      const prev = seen.get(id);
      assert(prev === undefined, `${id} is taught in stage ${prev} and stage ${lesson.stage}`);
      seen.set(id, lesson.stage);
    }
  }
  // Stage 1 is "a dozen", which is the whole point — a stage that grows into
  // a reference manual is the thing this replaced.
  const first = LESSONS.find((l) => l.stage === 1)!;
  assert(first.commands.length <= 15, `stage 1 has ${first.commands.length} commands`);
  eq(LESSONS.map((l) => l.stage).join(), '1,2,3', 'three stages, in order');
});

check('stage 1 is a whole first lesson, and names the way out', () => {
  // Not a style check: these five are the loop of a first session — get a
  // sound in, hear it, cut it, undo, save — and the palette is how the other
  // 229 commands are reachable by somebody who knows none of their keys.
  const first = LESSONS.find((l) => l.stage === 1)!;
  for (const id of ['daw.importAudio', 'transport.playPause', 'edit.undo',
                    'file.save', 'daw.palette'] as CommandId[]) {
    assert(first.commands.includes(id), `stage 1 is missing ${id}`);
  }
  // And every command it teaches has a key to teach.
  for (const id of first.commands) {
    assert(effectiveChords(findShortcut(id)!, NO_OVERRIDES).length > 0,
      `${id} has no key, so there is nothing to teach`);
  }
});

check('stageOf answers for a taught command and says nothing for the rest', () => {
  eq(stageOf('file.save'), 1, 'save is stage 1');
  eq(stageOf('daw.exportStems'), 3, 'stems is stage 3');
  eq(stageOf('daw.memStore.7'), null, 'a memory slot is taught by nobody');
});

check('the overlay offers the stages and renders one row renderer', () => {
  const overlay = readFileSync('src/renderer/components/daw/DawShortcutHelp.tsx', 'utf8');
  assert(/LESSONS\.map/.test(overlay), 'the chips come from the lesson plan');
  assert(/stageRows\.map\(renderRow\)/.test(overlay) && /rows\.map\(renderRow\)/.test(overlay),
    'both views use the same row renderer');
  // A stage in Cubase grouping would lose the teaching order, which is the
  // only thing a stage has that the search box does not.
  assert(/lesson\?\.commands/.test(overlay) || /lesson\.commands/.test(overlay),
    'a stage is mapped from the lesson, not filtered out of the table');
});

check('no message spells a chord out by hand either', () => {
  // The tooltip check below found 22 of these; the MESSAGE surface had twelve
  // more — "먼저 Mod+Alt+Shift+C", which shows the person a token out of this
  // codebase and goes wrong the moment a key moves.  Keymap presets move six
  // keys at once, so the day presets shipped this stopped being theoretical:
  // switching to Logic took R off 녹음 무장, and a message was still telling
  // students to press R to arm — which now starts recording instead.
  const files = execSync("grep -rl 'notify(' src/renderer --include=*.ts --include=*.tsx",
    { encoding: 'utf8' }).trim().split('\n');
  const chordish = [
    /(?:Mod|Cmd|Ctrl)\+/, /⌘|⌥/, /Alt\+(?![가-힣])/,
    /\((?:Home|End|Space|Tab|Enter|Esc|Del|Numpad[^)]*|F\d+|[A-Z])\)/,
  ];
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/notify\(\s*(`[^`]*`|'[^']*')/g)) {
      // An interpolation that asks the keymap is the right answer, so it comes
      // out before the text is judged.
      const text = m[1]!.replace(/\$\{[^}]*\}/g, '');
      if (chordish.some((re) => re.test(text))) {
        offenders.push(`${f.replace('src/renderer/', '')}: ${text.slice(0, 52)}`);
      }
    }
  }
  assert(offenders.length === 0,
    `${offenders.length} message(s) write a key out instead of asking the keymap:\n    `
    + offenders.join('\n    '));
});

check('a key hint stops after three showings and remembers that it did', () => {
  // The count lives in localStorage so the fourth session does not start the
  // three over again; Node has no such thing, so give it one.
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => { mem.clear(); },
    key: () => null,
    length: 0,
  };
  resetHints();
  for (let i = 1; i <= MAX_HINTS_PER_COMMAND; i++) {
    assert(takeHintTurn('daw.freeze'), `showing ${i} is allowed`);
  }
  assert(!takeHintTurn('daw.freeze'), 'and the fourth is not');
  assert(!takeHintTurn('daw.freeze'), 'nor the fifth — the refusal did not count itself');
  // One command reaching its limit must not silence another.
  assert(takeHintTurn('daw.commit'), 'a different command still gets its turn');
  // And the overlay's "키 힌트 다시 보기" really brings them back.
  resetHints();
  assert(takeHintTurn('daw.freeze'), 'after a reset the hints come back');
});

check('the palette and the shortcut list cannot be open at once', () => {
  // Two full-screen overlays at the same z-index are one overlay with
  // clickable buttons hidden under it — the slot mechanism exists for this.
  eq(panelsSharingSlot('palette').join(), 'help', 'opening the palette closes the list');
  eq(panelsSharingSlot('help').join(), 'palette', 'and the other way round');

  const ws = useWorkspaceStore.getState();
  ws.setPanel('help', true);
  ws.setPanel('palette', true);
  assert(useWorkspaceStore.getState().panels.palette, 'the palette is open');
  assert(!useWorkspaceStore.getState().panels.help, 'and the list closed itself');
  useWorkspaceStore.getState().setPanel('palette', false);
});

// Nothing is counted until every async body has finished — the summary used to
// print while three of them were still running, which is exactly how their
// failures went missing.  In an IIFE because this file compiles to cjs, where
// a top-level await is a build error.
void (async (): Promise<void> => {
  await Promise.all(pending);

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n=== DAW keyboard layer ===');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  if (failed > 0) process.exit(1);
})();
