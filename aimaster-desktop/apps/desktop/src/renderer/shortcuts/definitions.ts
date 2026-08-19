// definitions.ts — the DAW keyboard map.
//
// Source of truth for BOTH the dispatcher (useDawShortcuts) and the on-screen
// help overlay (?), so the two can never drift apart.
//
// The layout mirrors a Cubase-style DAW.  Where a DAW concept has a genuine
// counterpart in a mastering app it is mapped to that action; where it has
// none (recording, metronome, MIDI events, per-track solo on a session with a
// single stereo master) the command is still registered but marked
// `available: false` — pressing it explains itself in a toast instead of
// doing nothing silently.
//
// Two deliberate deviations from the Cubase table, both because the original
// binding collides with a more useful one in this app:
//   • 하단 에디터 패널 — Cubase uses Ctrl+Alt+E, which is already
//     "내보내기" here.  Moved to Mod+Alt+B.
//   • 세션 열기 — added on Mod+Shift+O (Cubase has no equivalent; Ctrl+O
//     opens an audio file here because that is the actual entry point).

import { parseChord, formatChord, type KeyChord, type Platform } from './keys.js';

export type ShortcutGroupId = 'file' | 'transport' | 'tools' | 'edit' | 'window' | 'daw';

export const GROUP_TITLES: Record<ShortcutGroupId, string> = {
  file:      '1. 프로젝트 및 파일',
  transport: '2. 재생 및 탐색',
  tools:     '3. 메인 툴바',
  edit:      '4. 편집 및 트랙 조작',
  window:    '5. 창 및 패널',
  daw:       '6. DAW 편집 (Edit / Mix)',
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
  | 'track.solo' | 'track.mute' | 'track.clearSoloMute' | 'loop.toSelection'
  // 5. Windows & panels
  | 'window.mixConsole' | 'window.transportPanel' | 'window.keyEditor'
  | 'window.bottomEditor' | 'window.vstEditor' | 'window.mediaBay'
  | 'window.inspector' | 'window.rightRack' | 'window.shortcutHelp'
  // 6. DAW workspace — multitrack editing, routing and rendering
  | 'daw.open' | 'daw.toggleWindow'
  | 'daw.tabNext' | 'daw.tabPrev' | 'daw.toggleTabToTransient'
  | 'daw.separate' | 'daw.heal' | 'daw.trimToSelection' | 'daw.consolidate' | 'daw.clearRange'
  | 'daw.clipGainUp' | 'daw.clipGainDown'
  | 'daw.nudgeForward' | 'daw.nudgeBack'
  | 'daw.fadeIn' | 'daw.fadeOut' | 'daw.crossfade'
  | 'daw.newTrack' | 'daw.playlistNext' | 'daw.playlistPrev' | 'daw.compSelection'
  | 'daw.freeze' | 'daw.commit' | 'daw.bounce'
  | 'daw.importAudio' | 'daw.importSession'
  | 'daw.zoomIn' | 'daw.zoomOut';

export interface ShortcutDef {
  id: CommandId;
  group: ShortcutGroupId;
  /** Feature name, as it reads in the DAW shortcut table. */
  label: string;
  /** Chord specs — the first one is the primary binding shown in the help. */
  chords: string[];
  /** What the key actually does in this app (shown in the help overlay). */
  note: string;
  /** false → the DAW concept has no counterpart here; the toast explains. */
  available: boolean;
  /** Allow the binding to fire while an <input>/<textarea> has focus. */
  allowInInput?: boolean;
}

export const SHORTCUTS: ShortcutDef[] = [
  // ── 1. 프로젝트 및 파일 ────────────────────────────────────────────────
  { id: 'file.new',          group: 'file', label: '새 프로젝트 생성',  chords: ['Mod+N'],
    note: '세션 초기화 후 홈으로 (큐 · 결과 · 리비전 삭제)', available: true },
  { id: 'file.open',         group: 'file', label: '프로젝트 열기',     chords: ['Mod+O'],
    note: '오디오 파일 열기 — 선택한 파일을 큐에 추가', available: true },
  { id: 'file.openSession',  group: 'file', label: '세션 열기',         chords: ['Mod+Shift+O'],
    note: '.louisession 불러오기 (소스 · 설정 복원)', available: true },
  { id: 'file.save',         group: 'file', label: '저장',              chords: ['Mod+S'],
    note: '현재 세션을 .louisession 으로 저장', available: true },
  { id: 'file.saveAs',       group: 'file', label: '다른 이름으로 저장', chords: ['Mod+Shift+S'],
    note: '세션 저장 (항상 저장 위치를 다시 묻습니다)', available: true },
  { id: 'file.export',       group: 'file', label: '내보내기 (Audio Export)', chords: ['Mod+Alt+E'],
    note: '마스터 WAV 내보내기 (라이선스 필요)', available: true },
  { id: 'file.projectSetup', group: 'file', label: '프로젝트 설정',     chords: ['Shift+S'],
    note: '설정 페이지 열기', available: true },

  // ── 2. 재생 및 탐색 ────────────────────────────────────────────────────
  { id: 'transport.playPause',    group: 'transport', label: '재생 / 정지', chords: ['Space'],
    note: '프리뷰 재생 / 일시정지', available: true },
  { id: 'transport.record',       group: 'transport', label: '녹음 시작',   chords: ['NumpadMultiply'],
    note: '마스터링 앱에는 녹음 트랙이 없습니다 — 대신 Mod+O 로 파일을 불러오세요', available: false },
  { id: 'transport.returnToZero', group: 'transport', label: '재생 위치 0점으로', chords: ['NumpadDecimal', 'Home'],
    note: '재생 헤드를 0초로 (루프 ON 이면 루프 시작점으로)', available: true },
  { id: 'transport.metronome',    group: 'transport', label: '메트로놈 on/off', chords: ['KeyC'],
    note: '템포/클릭 트랙이 없는 마스터링 전용 앱이라 해당 없음', available: false },
  { id: 'transport.toggleLoop',   group: 'transport', label: '루프 구간 on/off', chords: ['NumpadDivide'],
    note: '루프 재생 on/off — 구간은 파형에서 드래그(2번 툴)', available: true },
  { id: 'transport.gotoLoopStart', group: 'transport', label: '좌측 루프 포인터로', chords: ['Numpad1'],
    note: '루프 시작점으로 이동', available: true },
  { id: 'transport.gotoLoopEnd',   group: 'transport', label: '우측 루프 포인터로', chords: ['Numpad2'],
    note: '루프 끝점으로 이동', available: true },
  { id: 'view.zoomOutH', group: 'transport', label: '화면 가로 축소', chords: ['KeyG'],
    note: '파형 가로 축소 (재생 헤드 기준)', available: true },
  { id: 'view.zoomInH',  group: 'transport', label: '화면 가로 확대', chords: ['KeyH'],
    note: '파형 가로 확대 (재생 헤드 기준)', available: true },
  { id: 'view.zoomOutV', group: 'transport', label: '화면 세로 축소', chords: ['Shift+G'],
    note: '파형 진폭 축소', available: true },
  { id: 'view.zoomInV',  group: 'transport', label: '화면 세로 확대', chords: ['Shift+H'],
    note: '파형 진폭 확대 (작은 피크 확인용)', available: true },

  // ── 3. 메인 툴바 ───────────────────────────────────────────────────────
  { id: 'tool.select', group: 'tools', label: '1 · 선택 툴',      chords: ['Digit1'],
    note: '클릭 → 재생 위치 이동', available: true },
  { id: 'tool.range',  group: 'tools', label: '2 · 범위 선택 툴', chords: ['Digit2'],
    note: '드래그 → 구간 선택 (P 로 루프에 적용)', available: true },
  { id: 'tool.split',  group: 'tools', label: '3 · 자르기',       chords: ['Digit3'],
    note: '클릭 → 재생 위치에서 선택 구간 분할', available: true },
  { id: 'tool.glue',   group: 'tools', label: '4 · 붙이기',       chords: ['Digit4'],
    note: '이벤트 트랙이 없어 동작하지 않습니다 (툴만 전환)', available: false },
  { id: 'tool.erase',  group: 'tools', label: '5 · 삭제',         chords: ['Digit5'],
    note: '클릭 → 선택 구간 / 루프 구간 해제', available: true },
  { id: 'tool.zoom',   group: 'tools', label: '6 · 줌 툴',        chords: ['Digit6'],
    note: '클릭 → 확대, Alt+클릭 → 축소', available: true },
  { id: 'tool.mute',   group: 'tools', label: '7 · 뮤트',         chords: ['Digit7'],
    note: '클릭 → 프리뷰 뮤트 토글', available: true },
  { id: 'tool.draw',   group: 'tools', label: '8 · 연필 / 그리기', chords: ['Digit8'],
    note: '오토메이션 레인이 없어 동작하지 않습니다 (툴만 전환)', available: false },
  { id: 'tool.scrub',  group: 'tools', label: '9 · 스크럽',       chords: ['Digit9'],
    note: '드래그 → 재생 헤드를 따라가며 듣기', available: true },

  // ── 4. 편집 및 트랙 조작 ───────────────────────────────────────────────
  { id: 'edit.undo',   group: 'edit', label: '실행 취소 (Undo)', chords: ['Mod+Z'],
    note: '마스터링 설정 변경 되돌리기 (실시간 DSP 즉시 반영)', available: true },
  { id: 'edit.redo',   group: 'edit', label: '다시 실행 (Redo)', chords: ['Mod+Shift+Z', 'Mod+Y'],
    note: '되돌린 설정 다시 적용', available: true },
  { id: 'edit.copy',   group: 'edit', label: '복사',             chords: ['Mod+C'],
    note: '현재 마스터링 설정을 복사', available: true },
  { id: 'edit.paste',  group: 'edit', label: '붙여넣기',         chords: ['Mod+V'],
    note: '복사한 설정을 현재 세션에 적용', available: true },
  { id: 'edit.duplicate', group: 'edit', label: '이벤트 연속 복사 (Duplicate)', chords: ['Mod+D'],
    note: '현재 결과를 새 리비전으로 복제 (A/B 비교용)', available: true },
  { id: 'edit.repeat', group: 'edit', label: '반복 (Repeat)',    chords: ['Mod+K'],
    note: '현재 설정으로 다시 마스터링 실행', available: true },
  { id: 'edit.splitAtCursor', group: 'edit', label: '커서 위치에서 자르기', chords: ['Alt+X'],
    note: '재생 위치에서 선택/루프 구간을 분할', available: true },
  { id: 'edit.toggleSnap', group: 'edit', label: '스냅 on/off',  chords: ['KeyJ'],
    note: '이동 · 구간 지정을 1초(또는 섹션 경계)에 스냅', available: true },
  { id: 'track.solo',  group: 'edit', label: '솔로 (Solo)',      chords: ['KeyS'],
    note: '원본 솔로 — 마스터 체인 바이패스 토글', available: true },
  { id: 'track.mute',  group: 'edit', label: '뮤트 (Mute)',      chords: ['KeyM'],
    note: '프리뷰 출력 뮤트 토글', available: true },
  { id: 'track.clearSoloMute', group: 'edit', label: '모든 Solo/Mute 해제', chords: ['Alt+S', 'Alt+M'],
    note: '뮤트 + 마스터 바이패스 모두 해제 (트랜스포트 바에서 Alt+클릭도 동일)', available: true },
  { id: 'loop.toSelection', group: 'edit', label: '선택 구간에 루프 맞추기', chords: ['KeyP'],
    note: '선택 구간 → 루프 구간 (선택이 없으면 전체 구간)', available: true },

  // ── 5. 창 및 패널 ──────────────────────────────────────────────────────
  { id: 'window.mixConsole',     group: 'window', label: '믹스콘솔 (MixConsole)', chords: ['F3'],
    note: '하단 믹스콘솔 — 모듈별 바이패스 / 마스터 뮤트', available: true },
  { id: 'window.transportPanel', group: 'window', label: '트랜스포트 Panel', chords: ['F2'],
    note: '하단 트랜스포트 바 (파형 · 루프 · 툴) 열기/닫기', available: true },
  { id: 'window.keyEditor',      group: 'window', label: 'MIDI 피아노 롤 (Key Editor)', chords: ['Enter'],
    note: 'MIDI 이벤트가 없는 오디오 마스터링 앱이라 해당 없음', available: false },
  { id: 'window.bottomEditor',   group: 'window', label: '하단 에디터 패널', chords: ['Mod+Alt+L'],
    note: '하단 존(트랜스포트+믹스콘솔) 열기/닫기 — Cubase 의 Ctrl+Alt+E 는 내보내기와, B 는 바운스와 충돌하여 L(Lower zone)', available: true },
  { id: 'window.vstEditor',      group: 'window', label: 'VST 에디터 / 인스트루먼트 창', chords: ['F11'],
    note: '고급 파라미터(모듈 상세) 패널 열기/닫기', available: true },
  { id: 'window.mediaBay',       group: 'window', label: 'MediaBay (프리셋 브라우저)', chords: ['F5'],
    note: '스타일 · 리미터 프리셋 브라우저 열기/닫기', available: true },
  { id: 'window.inspector',      group: 'window', label: '좌측 인스펙터', chords: ['Alt+I'],
    note: '좌측 인스펙터 (소스 · 타깃 · 루프 · 툴 상태) 열기/닫기', available: true },
  { id: 'window.rightRack',      group: 'window', label: '우측 랙(Zone)', chords: ['Mod+Alt+R'],
    note: '우측 세밀 조정 패널 열기/닫기', available: true },
  { id: 'window.shortcutHelp',   group: 'window', label: '단축키 도움말', chords: ['Shift+Slash', 'F1'],
    note: '이 목록 열기/닫기', available: true },

  // ── 6. DAW 편집 (Edit / Mix) ────────────────────────────────────────────
  { id: 'daw.open', group: 'daw', label: 'DAW 워크스페이스 열기', chords: ['Mod+Alt+D'],
    note: '멀티트랙 Edit / Mix 화면으로 이동', available: true },
  { id: 'daw.toggleWindow', group: 'daw', label: 'Edit ↔ Mix 전환', chords: ['Mod+Equal'],
    note: '같은 세션의 편집 화면과 콘솔 화면 전환', available: true },
  { id: 'daw.tabNext', group: 'daw', label: '다음 편집 지점으로 (Tab)', chords: ['Tab'],
    note: '클립 경계 — Tab to Transient 가 켜져 있으면 어택까지', available: true },
  { id: 'daw.tabPrev', group: 'daw', label: '이전 편집 지점으로', chords: ['Shift+Tab'],
    note: '반대 방향. 구간이 선택돼 있으면 선택 범위를 확장', available: true },
  { id: 'daw.toggleTabToTransient', group: 'daw', label: 'Tab to Transient on/off', chords: ['Mod+Alt+Tab'],
    note: '어택 탐지 사용 여부', available: true },
  { id: 'daw.separate', group: 'daw', label: '클립 분리 (Separate)', chords: ['Mod+E'],
    note: '재생 위치에서 선택 트랙의 클립을 자름', available: true },
  { id: 'daw.heal', group: 'daw', label: '분리 복구 (Heal)', chords: ['Mod+H'],
    note: '자른 뒤 움직이지 않은 클립을 다시 합침', available: true },
  { id: 'daw.trimToSelection', group: 'daw', label: '선택 구간으로 트림', chords: ['Mod+T'],
    note: '선택 밖의 오디오를 잘라냄 (비파괴)', available: true },
  { id: 'daw.clearRange', group: 'daw', label: '선택 구간 삭제', chords: ['Delete', 'Backspace'],
    note: 'SHUFFLE 모드면 뒤 클립을 당겨 붙임', available: true },
  { id: 'daw.consolidate', group: 'daw', label: '컨솔리데이트', chords: ['Mod+Alt+C'],
    note: '선택 구간을 하나의 새 오디오 클립으로 렌더링', available: true },
  { id: 'daw.clipGainUp', group: 'daw', label: '클립 게인 +0.5 dB', chords: ['Mod+Shift+ArrowUp'],
    note: '클립 자체 게인 (페이더 이전)', available: true },
  { id: 'daw.clipGainDown', group: 'daw', label: '클립 게인 −0.5 dB', chords: ['Mod+Shift+ArrowDown'],
    note: '클립 자체 게인 (페이더 이전)', available: true },
  { id: 'daw.nudgeForward', group: 'daw', label: '넛지 →', chords: ['NumpadAdd'],
    note: '선택 클립을 넛지 값만큼 뒤로', available: true },
  { id: 'daw.nudgeBack', group: 'daw', label: '넛지 ←', chords: ['NumpadSubtract'],
    note: '선택 클립을 넛지 값만큼 앞으로', available: true },
  { id: 'daw.fadeIn', group: 'daw', label: '커서까지 페이드 인', chords: ['Alt+D'],
    note: '클립 시작 → 재생 위치', available: true },
  { id: 'daw.fadeOut', group: 'daw', label: '커서부터 페이드 아웃', chords: ['Alt+G'],
    note: '재생 위치 → 클립 끝', available: true },
  { id: 'daw.crossfade', group: 'daw', label: '크로스페이드', chords: ['Mod+F'],
    note: '맞닿은 두 클립 경계에 선택 길이만큼', available: true },
  { id: 'daw.newTrack', group: 'daw', label: '새 오디오 트랙', chords: ['Mod+Shift+N'],
    note: '세션에 오디오 트랙 추가', available: true },
  { id: 'daw.playlistPrev', group: 'daw', label: '이전 테이크', chords: ['Alt+ArrowUp'],
    note: '플레이리스트(테이크) 레인 전환', available: true },
  { id: 'daw.playlistNext', group: 'daw', label: '다음 테이크', chords: ['Alt+ArrowDown'],
    note: '플레이리스트(테이크) 레인 전환', available: true },
  { id: 'daw.compSelection', group: 'daw', label: '선택 구간 컴핑', chords: ['Mod+Alt+V'],
    note: '다른 테이크의 선택 구간을 메인 플레이리스트로', available: true },
  { id: 'daw.freeze', group: 'daw', label: '프리즈 / 해제', chords: ['Mod+Alt+F'],
    note: '인서트를 렌더링해 CPU 반환 (되돌릴 수 있음)', available: true },
  { id: 'daw.commit', group: 'daw', label: '커밋', chords: ['Mod+Alt+Shift+F'],
    note: '인서트를 오디오에 확정 렌더링 (되돌릴 수 없음)', available: true },
  { id: 'daw.bounce', group: 'daw', label: '오프라인 바운스', chords: ['Mod+Alt+B'],
    note: '세션(또는 선택 구간)을 WAV 로 렌더링 — 실시간보다 빠름', available: true },
  { id: 'daw.importAudio', group: 'daw', label: '오디오 가져오기', chords: ['Mod+Shift+I'],
    note: '파일마다 트랙 + 클립 생성', available: true },
  { id: 'daw.importSession', group: 'daw', label: '세션 데이터 가져오기', chords: ['Mod+Shift+D'],
    note: '다른 세션의 트랙 · 인서트 · 센드 · 오토메이션을 가져옴', available: true },
  { id: 'daw.zoomIn', group: 'daw', label: '가로 확대', chords: ['Mod+BracketRight'],
    note: '타임라인 확대', available: true },
  { id: 'daw.zoomOut', group: 'daw', label: '가로 축소', chords: ['Mod+BracketLeft'],
    note: '타임라인 축소', available: true },
];

/** Parsed bindings, in dispatch order (first match wins). */
export interface Binding { def: ShortcutDef; chord: KeyChord }

export const BINDINGS: Binding[] = SHORTCUTS.flatMap((def) =>
  def.chords.map((spec) => ({ def, chord: parseChord(spec) })),
);

/** Help-overlay label for a definition, e.g. 'Ctrl + Shift + S  /  Ctrl + Y'. */
export function displayChords(def: ShortcutDef, platform: Platform): string[] {
  return def.chords.map((spec) => formatChord(parseChord(spec), platform));
}

export function shortcutsByGroup(group: ShortcutGroupId): ShortcutDef[] {
  return SHORTCUTS.filter((s) => s.group === group);
}

/** The definition owning a command id (undefined for an unknown id). */
export function findShortcut(id: CommandId): ShortcutDef | undefined {
  return SHORTCUTS.find((s) => s.id === id);
}
