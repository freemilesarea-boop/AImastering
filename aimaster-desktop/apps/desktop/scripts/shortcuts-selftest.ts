// shortcuts-selftest — the keyboard layer, measured.
//
// A keyboard map is the kind of feature that looks finished and is not: a
// chord that never matches, two commands on one key, a table row with no
// implementation behind it, or a binding that fires while the user is typing
// a track name. None of those show up by reading the file, and all of them
// are cheap to measure.
//
// So this drives the REAL table through the REAL matcher and the REAL
// command map (with recording deps), and asserts on what happened. The
// resolver used here is the same function the window listener calls — a test
// with its own copy of the dispatch rules would be testing a second
// implementation.
//
// Run:  pnpm --filter @aimaster/desktop test:shortcuts

import {
  parseChord, matchesChord, normalizeKeyToken, formatChord, keyLabel,
  type KeyEventLike, type Platform,
} from '../src/renderer/shortcuts/keys.js';
import {
  SHORTCUTS, BINDINGS, GROUP_TITLES, findShortcut, displayChords,
  type CommandId,
} from '../src/renderer/shortcuts/definitions.js';
import { buildCommands, type CommandDeps } from '../src/renderer/shortcuts/commands.js';
import { resolveEvent } from '../src/renderer/shortcuts/useDawShortcuts.js';
import {
  begin, record, undo, redo, canUndo, canRedo, LIMIT, COALESCE_MS,
  type SessionSnapshot,
} from '../src/renderer/shortcuts/session-history.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

// ── The table ────────────────────────────────────────────────────────────────

console.log('\n=== THE TABLE ===\n');
{
  check('every group is titled', Object.keys(GROUP_TITLES).length === 5, Object.values(GROUP_TITLES).join(' · '));

  const ids = SHORTCUTS.map((s) => s.id);
  const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  check('no command is listed twice', dupIds.length === 0, dupIds.join(', ') || `${ids.length}개 명령`);

  const noChord = SHORTCUTS.filter((s) => s.chords.length === 0);
  check('every row has a chord', noChord.length === 0, noChord.map((s) => s.id).join(', ') || '전부');

  const badChord = BINDINGS.filter((b) => !b.chord.code);
  check(
    'every chord parses to a real key',
    badChord.length === 0,
    badChord.map((b) => b.id).join(', ') || `${BINDINGS.length}개 조합`,
  );

  const noNote = SHORTCUTS.filter((s) => s.note.trim().length === 0);
  check('every row says what it does here', noNote.length === 0, noNote.map((s) => s.id).join(', ') || '전부');
}

console.log('\n=== NO TWO COMMANDS ON ONE KEY ===\n');
{
  // The failure this catches is silent: the second binding never fires, and
  // the only symptom is a key that "does the wrong thing".
  for (const platform of ['mac', 'win'] as Platform[]) {
    const seen = new Map<string, CommandId>();
    const clashes: string[] = [];
    for (const b of BINDINGS) {
      const key = `${b.chord.mod ? 'M' : ''}${b.chord.alt ? 'A' : ''}${b.chord.shift ? 'S' : ''}:${b.chord.code}`;
      const prev = seen.get(key);
      if (prev && prev !== b.id) clashes.push(`${key} → ${prev} vs ${b.id}`);
      else seen.set(key, b.id);
    }
    check(
      `${platform}: no chord fires two commands`,
      clashes.length === 0,
      clashes.join(', ') || `${seen.size}개 조합 전부 고유`,
    );
  }
}

console.log('\n=== THE USER\'S TABLE IS COVERED ===\n');
{
  // The Cubase bindings the request actually listed, checked one by one
  // against what the resolver does. Written out rather than derived, because
  // deriving them from `definitions.ts` would just be comparing the table to
  // itself.
  const WANTED: Array<[string, CommandId]> = [
    ['Mod+N', 'file.new'],
    ['Mod+O', 'file.open'],
    ['Mod+S', 'file.save'],
    ['Mod+Shift+S', 'file.saveAs'],
    ['Mod+Alt+E', 'file.export'],
    ['Shift+S', 'file.projectSetup'],
    ['Space', 'transport.playPause'],
    ['NumpadMultiply', 'transport.record'],
    ['Home', 'transport.returnToZero'],
    ['NumpadDecimal', 'transport.returnToZero'],
    ['KeyC', 'transport.metronome'],
    ['NumpadDivide', 'transport.toggleLoop'],
    ['Numpad1', 'transport.gotoLoopStart'],
    ['Numpad2', 'transport.gotoLoopEnd'],
    ['KeyG', 'view.zoomOutH'],
    ['KeyH', 'view.zoomInH'],
    ['Shift+G', 'view.zoomOutV'],
    ['Shift+H', 'view.zoomInV'],
    ['Digit1', 'tool.select'],
    ['Digit2', 'tool.range'],
    ['Digit3', 'tool.split'],
    ['Digit4', 'tool.glue'],
    ['Digit5', 'tool.erase'],
    ['Digit6', 'tool.zoom'],
    ['Digit7', 'tool.mute'],
    ['Digit8', 'tool.draw'],
    ['Digit9', 'tool.scrub'],
    ['Mod+Z', 'edit.undo'],
    ['Mod+Shift+Z', 'edit.redo'],
    ['Mod+C', 'edit.copy'],
    ['Mod+V', 'edit.paste'],
    ['Mod+D', 'edit.duplicate'],
    ['Mod+K', 'edit.repeat'],
    ['Alt+X', 'edit.splitAtCursor'],
    ['KeyJ', 'edit.toggleSnap'],
    ['KeyS', 'track.solo'],
    ['KeyM', 'track.mute'],
    ['KeyP', 'loop.toSelection'],
    ['F3', 'window.mixConsole'],
    ['F2', 'window.transportPanel'],
    ['Enter', 'window.keyEditor'],
    ['F11', 'window.vstEditor'],
    ['F5', 'window.mediaBay'],
    ['Alt+I', 'window.inspector'],
    ['Mod+Alt+R', 'window.rightRack'],
  ];

  const misses: string[] = [];
  for (const [spec, expected] of WANTED) {
    const chord = parseChord(spec);
    for (const platform of ['mac', 'win'] as Platform[]) {
      const e: KeyEventLike = {
        code: chord.code,
        metaKey: platform === 'mac' ? chord.mod : false,
        ctrlKey: platform === 'mac' ? false : chord.mod,
        altKey: chord.alt,
        shiftKey: chord.shift,
      };
      const hit = resolveEvent(e, platform);
      if (!hit || hit.id !== expected) {
        misses.push(`${spec} (${platform}) → ${hit ? hit.id : 'nothing'}, expected ${expected}`);
      }
    }
  }
  check(
    `all ${WANTED.length} bindings from the request resolve, on both platforms`,
    misses.length === 0,
    misses.slice(0, 5).join(' | ') || `${WANTED.length * 2}회 확인`,
  );

  // And the ones that have no counterpart say so rather than doing nothing.
  const unavailable = SHORTCUTS.filter((s) => !s.available);
  check(
    'the unsupported keys are still bound, with a reason',
    unavailable.length > 0 && unavailable.every((s) => s.note.length > 8),
    `${unavailable.length}개: ${unavailable.slice(0, 3).map((s) => s.label).join(', ')}…`,
  );
}

console.log('\n=== THE MATCHER ===\n');
{
  const mac: Platform = 'mac';
  const win: Platform = 'win';
  const modS = parseChord('Mod+S');

  check(
    'Cmd+S fires on macOS, Ctrl+S does not',
    matchesChord({ code: 'KeyS', metaKey: true }, modS, mac)
      && !matchesChord({ code: 'KeyS', ctrlKey: true }, modS, mac),
    '두 번째 수식키가 눌린 상태는 다른 조합이다',
  );
  check(
    'Ctrl+S fires on Windows, Cmd+S does not',
    matchesChord({ code: 'KeyS', ctrlKey: true }, modS, win)
      && !matchesChord({ code: 'KeyS', metaKey: true }, modS, win),
    '',
  );
  check(
    'Shift+S never fires the plain-S binding',
    !matchesChord({ code: 'KeyS', shiftKey: true }, parseChord('KeyS'), win),
    '수식키는 정확히 일치해야 한다 — 솔로와 프로젝트 설정이 같은 키를 쓴다',
  );
  check(
    'and plain S never fires Shift+S',
    !matchesChord({ code: 'KeyS' }, parseChord('Shift+S'), win),
    '',
  );
  check(
    'the numpad is told apart from the number row',
    matchesChord({ code: 'Numpad1' }, parseChord('Numpad1'), win)
      && !matchesChord({ code: 'Digit1' }, parseChord('Numpad1'), win),
    'event.code 를 쓰는 이유 — event.key 로는 둘 다 "1" 이다',
  );
  check(
    'Option+X on macOS matches by code, not by the character it types',
    matchesChord({ code: 'KeyX', key: '≈', altKey: true }, parseChord('Alt+X'), mac),
    'macOS 는 Option+X 를 "≈" 로 보냅니다',
  );
  check('normalizeKeyToken accepts human spellings', normalizeKeyToken('s') === 'KeyS'
    && normalizeKeyToken('/') === 'Slash' && normalizeKeyToken('space') === 'Space',
    'KeyS · Slash · Space');
  check('formatChord reads like a menu', formatChord(parseChord('Mod+Shift+S'), mac) === '⌘ + Shift + S'
    && formatChord(parseChord('Mod+Shift+S'), win) === 'Ctrl + Shift + S',
    `${formatChord(parseChord('Mod+Shift+S'), mac)} / ${formatChord(parseChord('Mod+Shift+S'), win)}`);
  check('and ? is shown as ?', formatChord(parseChord('Shift+Slash'), win) === '?', '?');
  check('keyLabel names the numpad keys', keyLabel('NumpadDivide') === 'Numpad /', keyLabel('NumpadDivide'));
}

console.log('\n=== TYPING WINS ===\n');
{
  // The bug this prevents: renaming a track to "Mute Gtr" muting it on the
  // m, and Backspace deleting the track instead of a character.
  // Plain objects: the guards are duck-typed on purpose, so an element from
  // another document keeps its typing protection — and so this test can run
  // without a DOM.
  const input = { tagName: 'INPUT', isContentEditable: false } as unknown as EventTarget;
  const button = {
    tagName: 'BUTTON', isContentEditable: false, getAttribute: () => null,
  } as unknown as EventTarget;

  check(
    'no binding fires while an input has focus',
    resolveEvent({ code: 'KeyM' }, 'win', input) === null
      && resolveEvent({ code: 'Backspace' }, 'win', input) === null,
    '이름을 고치다 트랙이 사라지지 않는다',
  );
  check(
    'but the same keys fire outside one',
    resolveEvent({ code: 'KeyM' }, 'win', null)?.id === 'track.mute',
    'track.mute',
  );
  check(
    'Space belongs to a focused button, not the transport',
    resolveEvent({ code: 'Space' }, 'win', button) === null,
    '탭으로 옮겨간 버튼을 누를 수 있어야 한다',
  );
  check(
    'while Cmd+S still works from a focused button',
    resolveEvent({ code: 'KeyS', ctrlKey: true }, 'win', button)?.id === 'file.save',
    '수식키가 붙은 조합은 버튼의 키가 아니다',
  );
}

// ── The commands ─────────────────────────────────────────────────────────────

interface Log { calls: string[] }

function fakeDeps(log: Log, over: Partial<CommandDeps> = {}): CommandDeps {
  const note = (s: string) => { log.calls.push(s); };
  let selected: string | null = 't2';
  const ids = ['t1', 't2', 't3'];
  return {
    notify: (m) => note(`notify:${m}`),
    setPage: (p) => note(`page:${p}`),
    transport: {
      playPause: () => note('playPause'),
      stop: () => note('stop'),
      seek: (s) => note(`seek:${s}`),
    },
    view: {
      zoomIn: () => note('zoomIn'),
      zoomOut: () => note('zoomOut'),
      laneTaller: () => note('laneTaller'),
      laneShorter: () => note('laneShorter'),
    },
    panels: {
      toggle: (p) => note(`panel:${p}`),
      toggleLowerZone: () => note('lowerZone'),
      toggleHelp: () => note('help'),
      openPluginPicker: () => note('picker'),
    },
    session: {
      selectedId: () => selected,
      trackIds: () => ids,
      select: (id) => { selected = id; note(`select:${id}`); },
      toggleMute: (id) => note(`mute:${id}`),
      toggleSolo: (id) => note(`solo:${id}`),
      clearSoloMute: () => note('clearSoloMute'),
      remove: (id) => note(`remove:${id}`),
      duplicate: (id) => note(`duplicate:${id}`),
      copyChannel: (id) => note(`copy:${id}`),
      pasteChannel: (id) => { note(`paste:${id}`); return true; },
      clearAll: () => note('clearAll'),
      addFiles: () => note('addFiles'),
      saveSession: () => note('saveSession'),
      openSession: () => note('openSession'),
      exportMix: () => note('exportMix'),
    },
    history: {
      undo: () => { note('undo'); return true; },
      redo: () => { note('redo'); return true; },
    },
    ...over,
  };
}

console.log('\n=== THE COMMANDS RUN ===\n');
{
  const log: Log = { calls: [] };
  const cmds = buildCommands(fakeDeps(log));

  const expectations: Array<[CommandId, string]> = [
    ['transport.playPause', 'playPause'],
    ['transport.returnToZero', 'seek:0'],
    ['view.zoomInH', 'zoomIn'],
    ['view.zoomOutH', 'zoomOut'],
    ['view.zoomInV', 'laneTaller'],
    ['view.zoomOutV', 'laneShorter'],
    ['file.open', 'addFiles'],
    ['file.save', 'saveSession'],
    ['file.saveAs', 'saveSession'],
    ['file.openSession', 'openSession'],
    ['file.export', 'exportMix'],
    ['file.projectSetup', 'page:settings'],
    ['edit.repeat', 'exportMix'],
    ['edit.undo', 'undo'],
    ['edit.redo', 'redo'],
    ['edit.copy', 'copy:t2'],
    ['edit.paste', 'paste:t2'],
    ['edit.duplicate', 'duplicate:t2'],
    ['track.solo', 'solo:t2'],
    ['track.mute', 'mute:t2'],
    ['track.remove', 'remove:t2'],
    ['track.clearSoloMute', 'clearSoloMute'],
    ['window.mixConsole', 'panel:console'],
    ['window.transportPanel', 'panel:transport'],
    ['window.inspector', 'panel:inspector'],
    ['window.rightRack', 'panel:rack'],
    ['window.keyEditor', 'panel:editor'],
    ['window.vstEditor', 'panel:editor'],
    ['window.bottomEditor', 'lowerZone'],
    ['window.mediaBay', 'picker'],
    ['window.shortcutHelp', 'help'],
  ];

  const wrong: string[] = [];
  for (const [id, expect] of expectations) {
    log.calls.length = 0;
    const run = cmds[id];
    if (!run) { wrong.push(`${id}: 구현 없음`); continue; }
    run();
    if (!log.calls.includes(expect)) wrong.push(`${id}: ${log.calls.join(',') || '아무것도'} (기대 ${expect})`);
  }
  check(
    `all ${expectations.length} available commands do what the table says`,
    wrong.length === 0,
    wrong.slice(0, 4).join(' | ') || '전부 일치',
  );

  // Every command the table calls available must exist, and no command may
  // exist for a row the table calls unavailable.
  const missing = SHORTCUTS.filter((s) => s.available && !cmds[s.id]).map((s) => s.id);
  check('nothing is advertised without an implementation', missing.length === 0, missing.join(', ') || '전부 구현됨');
  const phantom = SHORTCUTS.filter((s) => !s.available && cmds[s.id]).map((s) => s.id);
  check('and nothing unsupported is secretly wired', phantom.length === 0, phantom.join(', ') || '없음');
}

console.log('\n=== COMMANDS THAT NEED A TRACK ===\n');
{
  const log: Log = { calls: [] };
  const deps = fakeDeps(log);
  deps.session.selectedId = () => null;
  const cmds = buildCommands(deps);

  log.calls.length = 0;
  cmds['track.solo']!();
  check(
    'solo with nothing selected explains instead of throwing',
    log.calls.some((c) => c.startsWith('notify:')) && !log.calls.some((c) => c.startsWith('solo:')),
    log.calls.join(', '),
  );

  // Selection stepping wraps, so holding ↓ walks the session round.
  const log2: Log = { calls: [] };
  const cmds2 = buildCommands(fakeDeps(log2));
  cmds2['track.next']!();
  cmds2['track.next']!();
  check(
    'the arrows step and wrap through the tracks',
    log2.calls.includes('select:t3') && log2.calls.includes('select:t1'),
    log2.calls.join(' → '),
  );

  const log3: Log = { calls: [] };
  const deps3 = fakeDeps(log3);
  deps3.session.trackIds = () => [];
  const cmds3 = buildCommands(deps3);
  log3.calls.length = 0;
  cmds3['track.next']!();
  check('and do nothing sensible on an empty session', log3.calls.includes('select:null'), log3.calls.join(','));

  // A paste with nothing on the clipboard has to say so.
  const log4: Log = { calls: [] };
  const deps4 = fakeDeps(log4);
  deps4.session.pasteChannel = () => false;
  const cmds4 = buildCommands(deps4);
  log4.calls.length = 0;
  cmds4['edit.paste']!();
  check(
    'pasting an empty clipboard says so',
    log4.calls.some((c) => c.includes('복사한 채널 설정이 없습니다')),
    log4.calls.join(', '),
  );

  // New project on an empty session must not claim to have done something.
  const log5: Log = { calls: [] };
  const deps5 = fakeDeps(log5);
  deps5.session.trackIds = () => [];
  const cmds5 = buildCommands(deps5);
  log5.calls.length = 0;
  cmds5['file.new']!();
  check(
    'a new project on an empty session does not wipe anything',
    !log5.calls.includes('clearAll'),
    log5.calls.join(', '),
  );
}

// ── Undo ─────────────────────────────────────────────────────────────────────

function snap(n: number, selected: string | null = null): SessionSnapshot {
  return {
    tracks: [{ id: `t${n}`, gainDb: n }],
    masterPresetId: null,
    masterTargetLufs: null,
    selectedId: selected,
  };
}

console.log('\n=== UNDO ===\n');
{
  let h = begin(snap(0));
  check('a fresh session has nothing to undo', !canUndo(h) && !canRedo(h), '시작 상태');

  h = record(h, snap(1), 'gain:t1', 1000);
  h = record(h, snap(2), 'remove:t2', 5000);
  check('two edits are two steps', canUndo(h), `past ${h.past.length}`);

  const back = undo(h)!;
  h = back.history;
  check(
    'undo restores the state before the last edit',
    (back.snapshot.tracks[0] as { gainDb: number }).gainDb === 1,
    `gainDb ${(back.snapshot.tracks[0] as { gainDb: number }).gainDb}`,
  );
  check('and redo becomes possible', canRedo(h), `future ${h.future.length}`);

  const forward = redo(h)!;
  h = forward.history;
  check(
    'redo puts it back',
    (forward.snapshot.tracks[0] as { gainDb: number }).gainDb === 2,
    `gainDb ${(forward.snapshot.tracks[0] as { gainDb: number }).gainDb}`,
  );

  // A new edit after undoing abandons the redo branch — the standard rule,
  // and the one users rely on to escape a wrong redo.
  h = undo(h)!.history;
  h = record(h, snap(9), 'gain:t9', 20000);
  check('a fresh edit clears the redo branch', !canRedo(h), `future ${h.future.length}`);
}

console.log('\n=== A DRAG IS ONE UNDO STEP ===\n');
{
  let h = begin(snap(0));
  // Sixty pointer moves on one fader, the way a real drag arrives.
  for (let i = 1; i <= 60; i++) h = record(h, snap(i), 'gain:t1', 1000 + i * 5);
  check(
    'sixty moves on one fader collapse to one step',
    h.past.length === 1,
    `past ${h.past.length} — 하나씩 쌓였다면 Ctrl+Z 를 60번 눌러야 한다`,
  );

  // …but a different track, or the same one later, is a new step.
  h = record(h, snap(61), 'gain:t2', 1400);
  check('another track is its own step', h.past.length === 2, `past ${h.past.length}`);
  h = record(h, snap(62), 'gain:t2', 1400 + COALESCE_MS + 50);
  check(
    'and the same fader after a pause is a new step',
    h.past.length === 3,
    `past ${h.past.length} — 손을 뗐다 다시 잡으면 다른 편집이다`,
  );
}

console.log('\n=== THE STACK IS BOUNDED ===\n');
{
  let h = begin(snap(0));
  for (let i = 1; i <= LIMIT + 40; i++) h = record(h, snap(i), `edit:${i}`, i * 10_000);
  check(
    'the history stops growing at the limit',
    h.past.length === LIMIT,
    `past ${h.past.length} / 한도 ${LIMIT} — 세션 스냅샷이 무한히 쌓이지 않는다`,
  );
  check(
    'and it is the oldest step that is dropped',
    (h.past[0]!.snapshot.tracks[0] as { gainDb: number }).gainDb > 1,
    `가장 오래된 항목 gainDb ${(h.past[0]!.snapshot.tracks[0] as { gainDb: number }).gainDb}`,
  );
}

console.log('\n=== SNAPSHOTS DO NOT ALIAS ===\n');
{
  // The bug: recording the live array and then mutating it means undo
  // restores the state you were trying to leave.
  const live = snap(1);
  const h = record(begin(snap(0)), live, 'edit', 1000);
  (live.tracks[0] as { gainDb: number }).gainDb = 999;
  check(
    'a snapshot is a copy, not a window onto live state',
    (h.present!.snapshot.tracks[0] as { gainDb: number }).gainDb === 1,
    `기록된 값 ${(h.present!.snapshot.tracks[0] as { gainDb: number }).gainDb}, 이후 변경 999`,
  );
}

console.log('\n=== THE HELP SHOWS THE SAME TABLE ===\n');
{
  const rows = SHORTCUTS.map((s) => displayChords(s, 'mac'));
  check(
    'every row renders a chord label',
    rows.every((r) => r.length > 0 && r.every((c) => c.length > 0)),
    `${rows.length}행`,
  );
  const def = findShortcut('window.shortcutHelp');
  check(
    'the help lists the key that opens it',
    def !== undefined && displayChords(def, 'win').includes('?'),
    def ? displayChords(def, 'win').join(' / ') : '없음',
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
