// definitions.ts — the DAW keyboard map.
//
// One table, read by BOTH the dispatcher (`useDawShortcuts`) and the on-screen
// help (`DawShortcutHelp`), so what the app does and what it claims to do
// cannot drift apart.
//
// The layout follows the Cubase table an engineer already has in their hands.
// Where a Cubase concept has a real counterpart here it is bound to it; where
// it does not — recording, the metronome, MIDI parts, glue and pencil on a
// session whose stems are already aligned at zero — the key is STILL
// registered, with `available: false`. Pressing it says what it would do and
// why it does not, which is the difference between "this app has no such
// thing" and "my keyboard is broken".
//
// Three deliberate deviations from the Cubase table, each because the original
// binding collides with something more useful here:
//
//   • 하단 에디터 패널 — Cubase puts it on Ctrl+Alt+E, which is 내보내기 in
//     this app. Moved to Mod+Alt+L (Lower zone).
//   • 녹음 — Cubase lists both Numpad * and C; C is the metronome in the same
//     table. Only Numpad * is bound here, so C stays unambiguous.
//   • 세션 열기 — no Cubase equivalent. Mod+O opens AUDIO files here because
//     that is how a session actually starts, so loading a saved session gets
//     Mod+Shift+O.

import { parseChord, formatChord, type KeyChord, type Platform } from './keys.js';

export type ShortcutGroupId = 'file' | 'transport' | 'tools' | 'edit' | 'window';

export const GROUP_TITLES: Record<ShortcutGroupId, string> = {
  file:      '1. 프로젝트 및 파일',
  transport: '2. 재생 및 탐색',
  tools:     '3. 메인 툴바',
  edit:      '4. 편집 및 트랙 조작',
  window:    '5. 창 및 패널',
};

export type CommandId =
  // 1. Project & file
  | 'file.new' | 'file.open' | 'file.openSession' | 'file.save' | 'file.saveAs'
  | 'file.export' | 'file.projectSetup'
  // 2. Transport & navigation
  | 'transport.playPause' | 'transport.record' | 'transport.returnToZero'
  | 'transport.metronome' | 'transport.toggleLoop'
  | 'transport.gotoLoopStart' | 'transport.gotoLoopEnd'
  | 'view.zoomOutH' | 'view.zoomInH' | 'view.zoomOutV' | 'view.zoomInV'
  // 3. Toolbar
  | 'tool.select' | 'tool.range' | 'tool.split' | 'tool.glue' | 'tool.erase'
  | 'tool.zoom' | 'tool.mute' | 'tool.draw' | 'tool.scrub'
  // 4. Editing & tracks
  | 'edit.undo' | 'edit.redo' | 'edit.copy' | 'edit.paste' | 'edit.duplicate'
  | 'edit.repeat' | 'edit.splitAtCursor' | 'edit.toggleSnap'
  | 'track.solo' | 'track.mute' | 'track.clearSoloMute' | 'track.remove'
  | 'track.next' | 'track.prev' | 'loop.toSelection'
  // 5. Windows & panels
  | 'window.mixConsole' | 'window.transportPanel' | 'window.keyEditor'
  | 'window.bottomEditor' | 'window.vstEditor' | 'window.mediaBay'
  | 'window.inspector' | 'window.rightRack' | 'window.shortcutHelp';

export interface ShortcutDef {
  id: CommandId;
  group: ShortcutGroupId;
  /** Feature name, as it reads in the Cubase table. */
  label: string;
  /** Chord specs. The first is the primary binding shown in the help. */
  chords: string[];
  /** What the key actually does HERE — shown in the help overlay. */
  note: string;
  /** false → no counterpart in this app; the toast explains rather than nothing happening. */
  available: boolean;
}

export const SHORTCUTS: ShortcutDef[] = [
  // ── 1. 프로젝트 및 파일 ──────────────────────────────────────────────────
  { id: 'file.new', group: 'file', label: '새 프로젝트 생성', chords: ['Mod+N'],
    note: '세션의 모든 트랙을 비웁니다 (되돌리기 가능)', available: true },
  { id: 'file.open', group: 'file', label: '프로젝트 열기', chords: ['Mod+O'],
    note: '스템 파일 열기 — 고른 파일이 트랙으로 추가됩니다', available: true },
  { id: 'file.openSession', group: 'file', label: '세션 열기', chords: ['Mod+Shift+O'],
    note: '저장한 .louvsession 불러오기 (트랙 · 페이더 · 플러그인 복원)', available: true },
  { id: 'file.save', group: 'file', label: '저장', chords: ['Mod+S'],
    note: '세션을 .louvsession 으로 저장', available: true },
  { id: 'file.saveAs', group: 'file', label: '다른 이름으로 저장', chords: ['Mod+Shift+S'],
    note: '저장 위치를 다시 물어봅니다', available: true },
  { id: 'file.export', group: 'file', label: '내보내기 (Audio Export)', chords: ['Mod+Alt+E'],
    note: '믹스다운 — 세션 전체를 마스터 WAV 하나로', available: true },
  { id: 'file.projectSetup', group: 'file', label: '프로젝트 설정', chords: ['Shift+S'],
    note: '설정 페이지 열기', available: true },

  // ── 2. 재생 및 탐색 ──────────────────────────────────────────────────────
  { id: 'transport.playPause', group: 'transport', label: '재생 / 정지', chords: ['Space'],
    note: '재생 · 일시정지 (준비 전이면 미리듣기부터 굽습니다)', available: true },
  { id: 'transport.returnToZero', group: 'transport', label: '재생 위치 0점으로',
    chords: ['NumpadDecimal', 'Home'],
    note: '재생 헤드를 0초로', available: true },
  { id: 'transport.record', group: 'transport', label: '녹음 시작', chords: ['NumpadMultiply'],
    note: '녹음 트랙이 없습니다 — 이 앱은 이미 녹음된 스템을 믹스·마스터링합니다',
    available: false },
  { id: 'transport.metronome', group: 'transport', label: '메트로놈 on/off', chords: ['KeyC'],
    note: '템포 맵이 없습니다 — 스템은 이미 정렬돼 들어옵니다', available: false },
  { id: 'transport.toggleLoop', group: 'transport', label: '루프 구간 on/off', chords: ['NumpadDivide'],
    note: '구간 루프가 없습니다 — 전체 재생만 있습니다', available: false },
  { id: 'transport.gotoLoopStart', group: 'transport', label: '좌측 루프 포인터로', chords: ['Numpad1'],
    note: '루프 포인터가 없습니다 (0점 이동은 Home)', available: false },
  { id: 'transport.gotoLoopEnd', group: 'transport', label: '우측 루프 포인터로', chords: ['Numpad2'],
    note: '루프 포인터가 없습니다', available: false },
  { id: 'view.zoomOutH', group: 'transport', label: '화면 가로 축소', chords: ['KeyG'],
    note: '어레인지 가로 축소', available: true },
  { id: 'view.zoomInH', group: 'transport', label: '화면 가로 확대', chords: ['KeyH'],
    note: '어레인지 가로 확대', available: true },
  { id: 'view.zoomOutV', group: 'transport', label: '화면 세로 축소', chords: ['Shift+G'],
    note: '트랙 레인 높이 낮추기 — 한 화면에 더 많은 트랙', available: true },
  { id: 'view.zoomInV', group: 'transport', label: '화면 세로 확대', chords: ['Shift+H'],
    note: '트랙 레인 높이 키우기 — 파형을 크게', available: true },

  // ── 3. 메인 툴바 ─────────────────────────────────────────────────────────
  //
  // The stems in a session are already aligned at zero and are never cut,
  // moved or drawn on — that is the whole premise of the arrange window here.
  // So the tool keys have nothing to switch between, and say so once rather
  // than pretending to switch a tool that changes nothing.
  { id: 'tool.select', group: 'tools', label: '1 · 선택 툴', chords: ['Digit1'],
    note: '클릭이 곧 선택입니다 — 툴을 고를 필요가 없습니다', available: false },
  { id: 'tool.range', group: 'tools', label: '2 · 범위 선택 툴', chords: ['Digit2'],
    note: '구간 편집이 없습니다 — 스템은 통째로 다룹니다', available: false },
  { id: 'tool.split', group: 'tools', label: '3 · 자르기', chords: ['Digit3'],
    note: '스템은 0점 정렬로 들어오므로 자르지 않습니다', available: false },
  { id: 'tool.glue', group: 'tools', label: '4 · 붙이기', chords: ['Digit4'],
    note: '이벤트가 없어 붙일 것이 없습니다', available: false },
  { id: 'tool.erase', group: 'tools', label: '5 · 삭제', chords: ['Digit5'],
    note: '트랙 삭제는 Delete (선택한 트랙)', available: false },
  { id: 'tool.zoom', group: 'tools', label: '6 · 줌 툴', chords: ['Digit6'],
    note: '줌은 G / H 로 바로 씁니다', available: false },
  { id: 'tool.mute', group: 'tools', label: '7 · 뮤트', chords: ['Digit7'],
    note: '뮤트는 M (선택한 트랙)', available: false },
  { id: 'tool.draw', group: 'tools', label: '8 · 연필 / 그리기', chords: ['Digit8'],
    note: '오토메이션 레인이 없습니다', available: false },
  { id: 'tool.scrub', group: 'tools', label: '9 · 스크럽', chords: ['Digit9'],
    note: '눈금자를 클릭하면 그 위치로 이동합니다', available: false },

  // ── 4. 편집 및 트랙 조작 ─────────────────────────────────────────────────
  { id: 'edit.undo', group: 'edit', label: '실행 취소 (Undo)', chords: ['Mod+Z'],
    note: '트랙 추가 · 삭제 · 페이더 · 팬 · 악기 · 플러그인 되돌리기', available: true },
  { id: 'edit.redo', group: 'edit', label: '다시 실행 (Redo)', chords: ['Mod+Shift+Z', 'Mod+Y'],
    note: '되돌린 편집 다시 적용', available: true },
  { id: 'edit.copy', group: 'edit', label: '복사', chords: ['Mod+C'],
    note: '선택한 트랙의 채널 설정(페이더 · 팬 · 인서트)을 복사', available: true },
  { id: 'edit.paste', group: 'edit', label: '붙여넣기', chords: ['Mod+V'],
    note: '복사한 채널 설정을 선택한 트랙에 적용', available: true },
  { id: 'edit.duplicate', group: 'edit', label: '연속 복사 (Duplicate)', chords: ['Mod+D'],
    note: '선택한 트랙을 같은 설정으로 하나 더 (A/B 비교용)', available: true },
  { id: 'edit.repeat', group: 'edit', label: '반복 (Repeat)', chords: ['Mod+K'],
    note: '같은 설정으로 믹스다운 다시 실행', available: true },
  { id: 'edit.splitAtCursor', group: 'edit', label: '커서 위치에서 자르기', chords: ['Alt+X'],
    note: '스템은 자르지 않습니다 — 0점 정렬이 전제입니다', available: false },
  { id: 'edit.toggleSnap', group: 'edit', label: '스냅 on/off', chords: ['KeyJ'],
    note: '옮길 것이 없어 스냅이 없습니다', available: false },
  { id: 'track.solo', group: 'edit', label: '솔로 (Solo)', chords: ['KeyS'],
    note: '선택한 트랙 솔로', available: true },
  { id: 'track.mute', group: 'edit', label: '뮤트 (Mute)', chords: ['KeyM'],
    note: '선택한 트랙 뮤트', available: true },
  { id: 'track.clearSoloMute', group: 'edit', label: '모든 Solo/Mute 해제',
    chords: ['Alt+S', 'Alt+M'],
    note: '전 트랙의 솔로 · 뮤트 해제 (M/S 버튼 Alt+클릭도 같음)', available: true },
  { id: 'track.remove', group: 'edit', label: '선택 트랙 삭제', chords: ['Delete', 'Backspace'],
    note: '선택한 트랙을 세션에서 제거 (Mod+Z 로 복구)', available: true },
  { id: 'track.prev', group: 'edit', label: '이전 트랙 선택', chords: ['ArrowUp'],
    note: '위 트랙으로 — 인스펙터도 같이 따라갑니다', available: true },
  { id: 'track.next', group: 'edit', label: '다음 트랙 선택', chords: ['ArrowDown'],
    note: '아래 트랙으로', available: true },
  { id: 'loop.toSelection', group: 'edit', label: '선택 구간에 루프 맞추기', chords: ['KeyP'],
    note: '구간 루프가 없습니다', available: false },

  // ── 5. 창 및 패널 ────────────────────────────────────────────────────────
  { id: 'window.mixConsole', group: 'window', label: '믹스콘솔 (MixConsole)', chords: ['F3'],
    note: '하단 믹스콘솔 열기/닫기', available: true },
  { id: 'window.transportPanel', group: 'window', label: '트랜스포트 Panel', chords: ['F2'],
    note: '상단 트랜스포트 바 열기/닫기', available: true },
  { id: 'window.keyEditor', group: 'window', label: 'MIDI 피아노 롤 (Key Editor)', chords: ['Enter'],
    note: '선택한 트랙의 플러그인 편집기 열기/닫기 (MIDI 파트는 없습니다)', available: true },
  { id: 'window.bottomEditor', group: 'window', label: '하단 에디터 패널', chords: ['Mod+Alt+L'],
    note: '하단 존(플러그인 편집기 + 믹스콘솔) 열기/닫기 — Cubase 의 Ctrl+Alt+E 는 여기서 내보내기라 L(Lower zone)',
    available: true },
  { id: 'window.vstEditor', group: 'window', label: 'VST 에디터 / 인스트루먼트 창', chords: ['F11'],
    note: '선택한 트랙의 플러그인 편집기 열기/닫기', available: true },
  { id: 'window.mediaBay', group: 'window', label: 'MediaBay (프리셋 브라우저)', chords: ['F5'],
    note: '플러그인 추가 목록 열기', available: true },
  { id: 'window.inspector', group: 'window', label: '좌측 인스펙터', chords: ['Alt+I'],
    note: '좌측 인스펙터 접기/펼치기', available: true },
  { id: 'window.rightRack', group: 'window', label: '우측 랙(Zone)', chords: ['Mod+Alt+R'],
    note: '우측 마스터 버스 랙 접기/펼치기', available: true },
  { id: 'window.shortcutHelp', group: 'window', label: '단축키 도움말', chords: ['Shift+Slash', 'F1'],
    note: '이 목록 열기/닫기', available: true },
];

/** Every chord, paired with the command it fires. Built once. */
export interface Binding {
  chord: KeyChord;
  id: CommandId;
}

export const BINDINGS: Binding[] = SHORTCUTS.flatMap((s) =>
  s.chords.map((spec) => ({ chord: parseChord(spec), id: s.id })));

export function findShortcut(id: CommandId): ShortcutDef | undefined {
  return SHORTCUTS.find((s) => s.id === id);
}

/** Chords of one command, formatted for the current platform. */
export function displayChords(def: ShortcutDef, platform: Platform): string[] {
  return def.chords.map((spec) => formatChord(parseChord(spec), platform));
}
