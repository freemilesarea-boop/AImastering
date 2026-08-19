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
  type KeyEventLike,
} from '../src/renderer/shortcuts/keys.js';
import { SHORTCUTS, BINDINGS, findShortcut, type CommandId } from '../src/renderer/shortcuts/definitions.js';
import { buildCommands, buildSession, type CommandDeps, type AudioSnapshot } from '../src/renderer/shortcuts/commands.js';
import {
  useWorkspaceStore, snapTime, registerTransportElement,
} from '../src/renderer/stores/workspaceStore.js';
import {
  initHistory, record, undo, redo, canUndo, canRedo, HISTORY_LIMIT,
} from '../src/renderer/audio/options-history.js';
import { visibleWindow, ratioInWindow, timeAtRatio } from '../src/renderer/components/daw/transport-view.js';
import type { MasteringOptions } from '../src/renderer/stores/audioStore.js';
import type { MasteringResult } from '@aimaster/shared-types';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
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

check('unavailable commands are the documented five', () => {
  const off = SHORTCUTS.filter((s) => !s.available).map((s) => s.id).sort();
  eq(off.join(','), 'tool.draw,tool.glue,transport.metronome,transport.record,window.keyEditor', 'unavailable set');
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
  };
  h.options = h.audioSnapshot.options;
  h.deps = {
    notify: (message, type) => { h.notes.push({ message, type }); },
    setPage: (p) => { h.pages.push(p); },
    getAudio: () => ({ ...h.audioSnapshot, options: h.options }),
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

check('export refuses without a master and calls file:save-wav with one', async () => {
  const h = harness();
  const cmds = buildCommands(h.deps);
  await cmds['file.export']();
  eq(h.invocations.length, 0, 'no IPC without a result');
  eq(h.notes[0]!.type, 'warning', 'warned');

  const h2 = harness({ masteringResult: { outputPath: '/tmp/master.wav' } as MasteringResult }, '/out/master.wav');
  const cmds2 = buildCommands(h2.deps);
  await cmds2['file.export']();
  eq(h2.invocations[0]!.channel, 'file:save-wav', 'channel');
  eq(h2.invocations[0]!.args[0], '/tmp/master.wav', 'source path');
  eq(h2.notes[0]!.type, 'success', 'success toast');
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

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== DAW keyboard layer ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
