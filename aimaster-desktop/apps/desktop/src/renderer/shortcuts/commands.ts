// commands.ts — what each DAW shortcut actually does.
//
// Every command is a plain function over an injected `CommandDeps`, so the
// whole map can be driven from a selftest with fake IPC / fake stores and no
// DOM.  `useDawShortcuts` binds the real stores to these deps.

import type { Page } from '../stores/appStore.js';
import type { MasteringOptions } from '../stores/audioStore.js';
import type { MasteringResult } from '@aimaster/shared-types';
import type { RevisionInput } from '../audio/revisions/revision-types.js';
import type { WorkspaceState, ToolId, PanelId } from '../stores/workspaceStore.js';
import { serializeSession, deserializeSession, SESSION_VERSION, type LouiSession } from '../audio/session/session-schema.js';
import { defaultAllModulesState } from '../audio/parameters/parameter-state.js';
import { ALL_MODULE_PARAMETER_DEFS } from '../audio/parameters/module-parameter-definitions.js';
import { SHORTCUTS, type CommandId } from './definitions.js';

export type NotifyType = 'info' | 'success' | 'error' | 'warning';

export interface AudioSnapshot {
  selectedFile: string | null;
  masteringResult: MasteringResult | null;
  options: MasteringOptions;
  referenceFilePath: string | null;
}

export interface AudioActions {
  reset: () => void;
  setFile: (path: string) => void;
  addFilesToQueue: (paths: string[]) => void;
  updateOptions: (patch: Partial<MasteringOptions>) => void;
  setReferenceFile: (path: string | null) => void;
  setShowAdvanced: (v: boolean) => void;
  addRevision: (input: RevisionInput) => void;
}

export interface TransportApi {
  hasElement: () => boolean;
  toggle: () => void;
  pause: () => void;
  seek: (sec: number) => void;
  position: () => number;
  duration: () => number;
  isMuted: () => boolean;
  setMuted: (v: boolean) => void;
}

export interface CommandDeps {
  notify: (message: string, type?: NotifyType) => void;
  setPage: (page: Page) => void;
  getAudio: () => AudioSnapshot;
  audio: AudioActions;
  workspace: () => WorkspaceState;
  transport: TransportApi;
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
}

export type CommandFn = () => void | Promise<void>;
export type CommandMap = Record<CommandId, CommandFn>;

/**
 * The DAW workspace's half of the keyboard map.
 *
 * `commands` are the DAW-only verbs; `overrides` are shared keys that mean
 * something different while the DAW is on screen (Space plays the session,
 * Mod+Z undoes an edit).  `isActive` decides which meaning applies, so one
 * key never needs two bindings.
 */
export interface DawBridge {
  isActive: () => boolean;
  commands: Partial<Record<CommandId, CommandFn>>;
  overrides: Partial<Record<CommandId, CommandFn>>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOTE = new Map(SHORTCUTS.map((s) => [s.id, s.note] as const));

function fileNameOf(p: string): string {
  return p.split('/').pop()?.split('\\').pop() ?? p;
}

export function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00.0';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/** Session snapshot from the current stores. */
export function buildSession(snap: AudioSnapshot, createdAt: string): LouiSession {
  return {
    version: SESSION_VERSION,
    createdAt,
    sourceFilePath:    snap.selectedFile,
    referenceFilePath: snap.referenceFilePath,
    // The desktop result flow drives DSP from `options.rt`, not the module
    // parameter store, so the module state is written at its defaults and the
    // real tuning round-trips inside `baseOptions`.
    allModulesState:   defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS),
    presetId:          snap.options.quickPreset,
    baseOptions:       snap.options,
    freeEqEnabled:     false,
    freeEqBands:       [],
  };
}

// ── Command map ───────────────────────────────────────────────────────────────

export function buildCommands(deps: CommandDeps, daw?: DawBridge): CommandMap {
  const { notify, setPage, getAudio, audio, workspace, transport, invoke } = deps;

  /** Registered-but-not-applicable command: say why instead of doing nothing. */
  const unavailable = (id: CommandId): CommandFn => () => {
    notify(NOTE.get(id) ?? '이 앱에서는 지원하지 않는 기능입니다.', 'warning');
  };

  const setTool = (tool: ToolId, id: CommandId): CommandFn => () => {
    workspace().setTool(tool);
    const def = SHORTCUTS.find((s) => s.id === id);
    notify(`${def?.label ?? tool} — ${def?.note ?? ''}`, def?.available === false ? 'warning' : 'info');
  };

  const togglePanelCmd = (panel: PanelId, label: string): CommandFn => () => {
    workspace().togglePanel(panel);
    notify(`${label} ${workspace().panels[panel] ? '열림' : '닫힘'}`);
  };

  const saveSession = async (): Promise<void> => {
    const snap = getAudio();
    if (!snap.selectedFile) { notify('저장할 세션이 없습니다 — 먼저 음원을 불러오세요', 'warning'); return; }
    const json = serializeSession(buildSession(snap, new Date().toISOString()));
    try {
      const dest = await invoke('session:save', json) as string | null;
      if (dest) notify(`세션 저장 완료 — ${fileNameOf(dest)}`, 'success');
    } catch {
      notify('세션 저장 실패', 'error');
    }
  };

  // The DAW verbs are added right below; the literal covers everything else.
  const base = {
    // ── 1. 프로젝트 및 파일 ─────────────────────────────────────────────
    'file.new': () => {
      audio.reset();
      const ws = workspace();
      ws.setSelection(null);
      ws.setLoop({ startSec: 0, endSec: 0 });
      ws.setLoopEnabled(false);
      ws.resetZoom();
      ws.setSnapMarkers([]);
      setPage('home');
      notify('새 프로젝트 — 세션을 초기화했습니다', 'success');
    },

    'file.open': async () => {
      const paths = await invoke('file:open-dialog-multi') as string[] | null;
      if (!paths?.length) return;
      audio.addFilesToQueue(paths);
      const first = paths[0];
      if (first && !getAudio().selectedFile) audio.setFile(first);
      setPage('home');
      notify(`${paths.length}개 파일을 불러왔습니다`, 'success');
    },

    'file.openSession': async () => {
      let loaded: { path: string; data: string } | null;
      try {
        loaded = await invoke('session:load') as { path: string; data: string } | null;
      } catch {
        notify('세션 파일을 읽을 수 없습니다', 'error');
        return;
      }
      if (!loaded) return;
      const parsed = deserializeSession(loaded.data);
      if (!parsed.ok) { notify(parsed.error, 'error'); return; }
      const { session } = parsed;
      if (session.sourceFilePath) audio.setFile(session.sourceFilePath);
      audio.setReferenceFile(session.referenceFilePath);
      audio.updateOptions(session.baseOptions);
      workspace().resetOptionsHistory(session.baseOptions);
      notify(`세션 불러오기 완료 — ${fileNameOf(loaded.path)}`, 'success');
    },

    'file.save':   saveSession,
    'file.saveAs': saveSession,

    'file.export': async () => {
      const out = getAudio().masteringResult?.outputPath;
      if (!out) { notify('내보낼 마스터가 없습니다 — 먼저 마스터링을 완료하세요', 'warning'); return; }
      try {
        const dest = await invoke('file:save-wav', out) as string | null;
        if (dest) notify(`내보내기 완료 — ${fileNameOf(dest)}`, 'success');
      } catch {
        notify('내보내기 실패 (라이선스가 필요할 수 있습니다)', 'error');
      }
    },

    'file.projectSetup': () => { setPage('settings'); },

    // ── 2. 재생 및 탐색 ─────────────────────────────────────────────────
    'transport.playPause': () => {
      if (!transport.hasElement()) { notify('재생할 프리뷰가 없습니다', 'warning'); return; }
      transport.toggle();
    },

    'transport.record':    unavailable('transport.record'),
    // The click belongs to the session's tempo map, so the DAW override owns
    // it.  Outside the DAW there is no tempo to click to.
    'transport.metronome': () => {
      notify('메트로놈은 DAW 워크스페이스에서 씁니다', 'warning');
    },

    'transport.returnToZero': () => {
      const ws = workspace();
      transport.seek(ws.loopEnabled ? ws.loop.startSec : 0);
    },

    'transport.toggleLoop': () => {
      const ws = workspace();
      const next = !ws.loopEnabled;
      if (next && ws.loop.endSec <= ws.loop.startSec) {
        // No range yet — arm the whole file (or the current selection).
        const sel = ws.selection;
        const dur = transport.duration();
        ws.setLoop(sel ?? { startSec: 0, endSec: dur > 0 ? dur : 0 });
      }
      ws.setLoopEnabled(next);
      notify(next ? `루프 ON — ${fmtTime(workspace().loop.startSec)} ~ ${fmtTime(workspace().loop.endSec)}` : '루프 OFF');
    },

    'transport.gotoLoopStart': () => { transport.seek(workspace().loop.startSec); },
    'transport.gotoLoopEnd':   () => { transport.seek(workspace().loop.endSec); },

    'view.zoomOutH': () => { workspace().zoomOutH(); notify(`가로 확대 ×${workspace().zoomH}`); },
    'view.zoomInH':  () => { workspace().zoomInH();  notify(`가로 확대 ×${workspace().zoomH}`); },
    'view.zoomOutV': () => { workspace().zoomOutV(); notify(`세로 확대 ×${workspace().zoomV.toFixed(1)}`); },
    'view.zoomInV':  () => { workspace().zoomInV();  notify(`세로 확대 ×${workspace().zoomV.toFixed(1)}`); },

    // ── 3. 메인 툴바 ────────────────────────────────────────────────────
    'tool.select': setTool('select', 'tool.select'),
    'tool.range':  setTool('range',  'tool.range'),
    'tool.split':  setTool('split',  'tool.split'),
    'tool.glue':   setTool('glue',   'tool.glue'),
    'tool.erase':  setTool('erase',  'tool.erase'),
    'tool.zoom':   setTool('zoom',   'tool.zoom'),
    'tool.mute':   setTool('mute',   'tool.mute'),
    'tool.draw':   setTool('draw',   'tool.draw'),
    'tool.scrub':  setTool('scrub',  'tool.scrub'),

    // ── 4. 편집 및 트랙 조작 ────────────────────────────────────────────
    'edit.undo': () => {
      const ws = workspace();
      const prev = ws.undoOptions();
      if (!prev) { notify('되돌릴 변경이 없습니다'); return; }
      audio.updateOptions(prev);
      ws.endApplyHistory();
      notify('실행 취소');
    },

    'edit.redo': () => {
      const ws = workspace();
      const next = ws.redoOptions();
      if (!next) { notify('다시 실행할 변경이 없습니다'); return; }
      audio.updateOptions(next);
      ws.endApplyHistory();
      notify('다시 실행');
    },

    // Cmd+C / Cmd+X / Cmd+V mean the timeline while the DAW is on screen —
    // see `DawBridge.overrides`, which is the mechanism for a key that means
    // two things.  These are the meanings everywhere else.
    'edit.copy': () => {
      workspace().setClipboard(getAudio().options);
      notify('현재 마스터링 설정을 복사했습니다', 'success');
    },

    /** Cut has no meaning for a settings object; it exists for the DAW. */
    'edit.cut': () => {
      notify('잘라내기는 DAW 워크스페이스에서 쓸 수 있습니다', 'warning');
    },

    'edit.paste': () => {
      const clip = workspace().clipboard;
      if (!clip) { notify('복사된 설정이 없습니다', 'warning'); return; }
      audio.updateOptions(clip);
      notify('복사한 설정을 적용했습니다', 'success');
    },

    'edit.duplicate': () => {
      const snap = getAudio();
      const r = snap.masteringResult;
      if (!r?.outputPath || !snap.selectedFile) {
        notify('복제할 마스터 결과가 없습니다', 'warning');
        return;
      }
      audio.addRevision({
        sourceFilePath: snap.selectedFile,
        sourceFileName: fileNameOf(snap.selectedFile),
        optionsSnapshot: snap.options,
        outputPath:  r.outputPath,
        previewPath: r.previewPath,
        metrics: {
          integratedLufs: r.loudnessAfter.integratedLufs,
          truePeakDbtp:   r.loudnessAfter.truePeakDbtp,
        },
      });
      notify('현재 결과를 새 리비전으로 복제했습니다', 'success');
    },

    'edit.repeat': () => {
      if (!getAudio().selectedFile) { notify('반복할 대상이 없습니다', 'warning'); return; }
      transport.pause();
      setPage('mastering');
      notify('현재 설정으로 다시 마스터링합니다');
    },

    'edit.splitAtCursor': () => {
      const ws = workspace();
      const pos = transport.position();
      const range = ws.selection ?? (ws.loop.endSec > ws.loop.startSec ? ws.loop : null);
      if (!range || pos <= range.startSec || pos >= range.endSec) {
        notify('재생 위치가 구간 안에 없습니다', 'warning');
        return;
      }
      const head = { startSec: range.startSec, endSec: pos };
      ws.setSelection(head);
      if (ws.loopEnabled) ws.setLoop(head);
      notify(`구간 분할 — ${fmtTime(head.startSec)} ~ ${fmtTime(head.endSec)}`);
    },

    'edit.toggleSnap': () => {
      workspace().toggleSnap();
      notify(`스냅 ${workspace().snapEnabled ? 'ON' : 'OFF'}`);
    },

    'track.solo': () => {
      const opts = getAudio().options;
      const rt = opts.rt ?? {};
      const next = !(rt.masterBypass ?? false);
      audio.updateOptions({ rt: { ...rt, masterBypass: next } });
      notify(next ? '원본 솔로 ON — 마스터 체인 바이패스' : '원본 솔로 OFF — 마스터 체인 복귀');
    },

    'track.mute': () => {
      const next = !transport.isMuted();
      transport.setMuted(next);
      workspace().setMuted(next);
      notify(next ? '뮤트 ON' : '뮤트 OFF');
    },

    'track.clearSoloMute': () => {
      transport.setMuted(false);
      workspace().setMuted(false);
      const rt = getAudio().options.rt ?? {};
      audio.updateOptions({ rt: { ...rt, masterBypass: false } });
      notify('모든 Solo / Mute 해제');
    },

    'loop.toSelection': () => {
      const ws = workspace();
      const dur = transport.duration();
      const range = ws.selection ?? { startSec: 0, endSec: dur };
      if (range.endSec <= range.startSec) { notify('루프로 지정할 구간이 없습니다', 'warning'); return; }
      ws.setLoop(range);
      ws.setLoopEnabled(true);
      notify(`루프 구간 = ${fmtTime(range.startSec)} ~ ${fmtTime(range.endSec)}`);
    },

    // ── 5. 창 및 패널 ───────────────────────────────────────────────────
    'window.mixConsole':     togglePanelCmd('mixConsole', '믹스콘솔'),
    'window.transportPanel': togglePanelCmd('transport',  '트랜스포트'),
    'window.keyEditor':      unavailable('window.keyEditor'),
    'window.bottomEditor':   togglePanelCmd('bottomZone', '하단 존'),
    'window.mediaBay':       togglePanelCmd('mediaBay',   'MediaBay'),
    'window.inspector':      togglePanelCmd('inspector',  '인스펙터'),
    'window.rightRack':      togglePanelCmd('rightRack',  '우측 랙'),

    'window.vstEditor': () => {
      workspace().togglePanel('vstEditor');
      const open = workspace().panels.vstEditor;
      audio.setShowAdvanced(open);
      if (open) workspace().setPanel('rightRack', true);
      notify(`고급 파라미터 ${open ? '열림' : '닫힘'}`);
    },

    'window.shortcutHelp': () => { workspace().togglePanel('help'); },
    'window.controlSurface': () => { workspace().togglePanel('surface'); },
  } as CommandMap;

  // DAW-only verbs — registered even without the workspace so the key says
  // what it needs instead of doing nothing.
  for (const def of SHORTCUTS) {
    if (def.group !== 'daw') continue;
    const impl = daw?.commands[def.id];
    base[def.id] = impl ?? (() => {
      notify('DAW 워크스페이스(Mod+Alt+D)에서 사용할 수 있습니다', 'warning');
    });
  }

  if (!daw) return base;

  // Shared keys: pick the meaning that matches the visible workspace.
  const bridge = daw;
  for (const [id, override] of Object.entries(bridge.overrides) as Array<[CommandId, CommandFn]>) {
    const fallback = base[id];
    base[id] = () => (bridge.isActive() ? override() : fallback());
  }
  return base;
}

