// commands.ts — what each shortcut actually does.
//
// A map from command id to a function, built from an explicit `deps` object
// rather than reaching into stores. Two reasons, and neither is style:
//
//   • the selftest drives the whole map with fake deps and asserts on what
//     was called, so "Alt+S clears solo everywhere" is a measured fact
//     rather than a line of JSX nobody ran;
//   • the DAW page owns most of this state (zoom, selection, the open
//     plugin, the panes), and passing it in keeps one owner instead of
//     mirroring it into a store so a key handler can see it.
//
// Commands marked `available: false` in `definitions.ts` never reach here.
// The dispatcher answers those with the note from the table, so an
// unsupported key explains itself instead of doing nothing.

import type { CommandId } from './definitions.js';

export type PanelId = 'inspector' | 'rack' | 'console' | 'transport' | 'editor';

export interface CommandDeps {
  notify: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  /** Leave the DAW for another page. */
  setPage: (page: 'home' | 'settings') => void;

  transport: {
    /** Play, or bake the preview first when the session is not ready. */
    playPause: () => void;
    stop: () => void;
    seek: (seconds: number) => void;
  };

  view: {
    zoomIn: () => void;
    zoomOut: () => void;
    laneTaller: () => void;
    laneShorter: () => void;
  };

  panels: {
    toggle: (panel: PanelId) => void;
    /** The lower zone is the editor and the console together. */
    toggleLowerZone: () => void;
    toggleHelp: () => void;
    openPluginPicker: () => void;
  };

  session: {
    /** Which track the inspector is on, or null. */
    selectedId: () => string | null;
    /** Track ids, in the order they appear in the arrange window. */
    trackIds: () => string[];
    select: (id: string | null) => void;
    toggleMute: (id: string) => void;
    toggleSolo: (id: string) => void;
    clearSoloMute: () => void;
    remove: (id: string) => void;
    duplicate: (id: string) => void;
    copyChannel: (id: string) => void;
    pasteChannel: (id: string) => boolean;
    clearAll: () => void;
    addFiles: () => void;
    saveSession: () => void;
    openSession: () => void;
    exportMix: () => void;
  };

  history: {
    undo: () => boolean;
    redo: () => boolean;
  };
}

export type CommandMap = Partial<Record<CommandId, () => void>>;

/** The track after (or before) the selected one, wrapping at the ends. */
function step(ids: string[], current: string | null, delta: number): string | null {
  if (ids.length === 0) return null;
  const i = current ? ids.indexOf(current) : -1;
  if (i < 0) return delta > 0 ? ids[0]! : ids[ids.length - 1]!;
  const next = (i + delta + ids.length) % ids.length;
  return ids[next]!;
}

export function buildCommands(deps: CommandDeps): CommandMap {
  const { notify, session, view, panels, transport, history } = deps;

  /** Run something that needs a selected track, or say why it did not. */
  const onSelected = (what: string, fn: (id: string) => void) => () => {
    const id = session.selectedId();
    if (!id) { notify(`${what} — 트랙을 먼저 선택하세요`, 'info'); return; }
    fn(id);
  };

  return {
    // ── 1. Project & file ────────────────────────────────────────────────
    'file.new': () => {
      if (session.trackIds().length === 0) { notify('이미 빈 세션입니다', 'info'); return; }
      session.clearAll();
      notify('새 세션 — 되돌리려면 Cmd/Ctrl+Z', 'success');
    },
    'file.open': () => session.addFiles(),
    'file.openSession': () => session.openSession(),
    'file.save': () => session.saveSession(),
    'file.saveAs': () => session.saveSession(),
    'file.export': () => session.exportMix(),
    'file.projectSetup': () => deps.setPage('settings'),

    // ── 2. Transport & navigation ────────────────────────────────────────
    'transport.playPause': () => transport.playPause(),
    'transport.returnToZero': () => transport.seek(0),
    'view.zoomInH': () => view.zoomIn(),
    'view.zoomOutH': () => view.zoomOut(),
    'view.zoomInV': () => view.laneTaller(),
    'view.zoomOutV': () => view.laneShorter(),

    // ── 4. Editing & tracks ──────────────────────────────────────────────
    'edit.undo': () => {
      if (!history.undo()) notify('되돌릴 편집이 없습니다', 'info');
    },
    'edit.redo': () => {
      if (!history.redo()) notify('다시 실행할 편집이 없습니다', 'info');
    },
    'edit.copy': onSelected('채널 설정 복사', (id) => session.copyChannel(id)),
    'edit.paste': onSelected('채널 설정 붙여넣기', (id) => {
      if (!session.pasteChannel(id)) notify('복사한 채널 설정이 없습니다', 'info');
    }),
    'edit.duplicate': onSelected('트랙 복제', (id) => session.duplicate(id)),
    'edit.repeat': () => session.exportMix(),
    'track.solo': onSelected('솔로', (id) => session.toggleSolo(id)),
    'track.mute': onSelected('뮤트', (id) => session.toggleMute(id)),
    'track.clearSoloMute': () => session.clearSoloMute(),
    'track.remove': onSelected('트랙 삭제', (id) => session.remove(id)),
    'track.prev': () => session.select(step(session.trackIds(), session.selectedId(), -1)),
    'track.next': () => session.select(step(session.trackIds(), session.selectedId(), +1)),

    // ── 5. Windows & panels ──────────────────────────────────────────────
    'window.mixConsole': () => panels.toggle('console'),
    'window.transportPanel': () => panels.toggle('transport'),
    'window.inspector': () => panels.toggle('inspector'),
    'window.rightRack': () => panels.toggle('rack'),
    'window.keyEditor': () => panels.toggle('editor'),
    'window.vstEditor': () => panels.toggle('editor'),
    'window.bottomEditor': () => panels.toggleLowerZone(),
    'window.mediaBay': () => panels.openPluginPicker(),
    'window.shortcutHelp': () => panels.toggleHelp(),
  };
}
