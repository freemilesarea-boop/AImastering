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
  | 'edit.undo' | 'edit.redo' | 'edit.copy' | 'edit.cut' | 'edit.paste' | 'edit.duplicate'
  | 'edit.repeat' | 'edit.splitAtCursor' | 'edit.toggleSnap'
  | 'track.solo' | 'track.mute' | 'track.clearSoloMute' | 'loop.toSelection'
  // 5. Windows & panels
  | 'window.mixConsole' | 'window.transportPanel' | 'window.keyEditor'
  | 'window.bottomEditor' | 'window.vstEditor' | 'window.mediaBay'
  | 'window.inspector' | 'window.rightRack' | 'window.shortcutHelp'
  | 'window.controlSurface'
  // 6. DAW workspace — multitrack editing, routing and rendering
  | 'daw.open' | 'daw.toggleWindow'
  | 'daw.tabNext' | 'daw.tabPrev' | 'daw.toggleTabToTransient'
  | 'daw.separate' | 'daw.heal' | 'daw.trimToSelection' | 'daw.consolidate'
  | 'daw.bounceSelection' | 'daw.clearRange'
  | 'daw.clipGainUp' | 'daw.clipGainDown'
  | 'daw.clipPitchUp' | 'daw.clipPitchDown' | 'daw.clipPitchReset'
  | 'daw.createEditGroup' | 'daw.dissolveEditGroup' | 'daw.toggleGroupsEnabled'
  | 'daw.quantizeAudio'
  | 'daw.zoomToSelection' | 'daw.toggleFollowPlayhead' | 'daw.playFromSelection'
  | 'daw.duplicateTrack' | 'daw.cycleRulerFormat'
  | 'daw.nudgeForward' | 'daw.nudgeBack'
  | 'daw.fadeIn' | 'daw.fadeOut' | 'daw.crossfade'
  | 'daw.newTrack' | 'daw.playlistNext' | 'daw.playlistPrev' | 'daw.compSelection'
  | 'daw.freeze' | 'daw.commit' | 'daw.bounce' | 'daw.sendToMastering' | 'daw.exportStems'
  | 'daw.importAudio' | 'daw.importSession'
  | 'daw.zoomIn' | 'daw.zoomOut'
  // Key Editor
  | 'daw.quantize' | 'daw.humanize' | 'daw.selectAllNotes' | 'daw.legatoNotes'
  | 'daw.transposeUp' | 'daw.transposeDown'
  | 'daw.octaveUp' | 'daw.octaveDown'
  | 'daw.velocityUp' | 'daw.velocityDown'
  | 'daw.detectChords' | 'daw.reharmonize' | 'daw.addChord'
  | 'daw.analyzeVocal' | 'daw.tuneVocal' | 'daw.openVocalEditor'
  | 'daw.togglePicture' | 'daw.nudgeFrameBack' | 'daw.nudgeFrameForward'
  | 'daw.cutRipple' | 'daw.pasteInsert' | 'daw.insertSilence'
  | 'daw.stripSilence' | 'daw.alignToGuide' | 'daw.snapZeroCross'
  | 'daw.normalizeClip' | 'daw.reverseClip' | 'daw.renameClip'
  | 'daw.renameTrack' | 'daw.trackHeightUp' | 'daw.trackHeightDown'
  | 'daw.smartControls' | 'daw.createStack' | 'daw.unpackStack' | 'daw.toggleStack'
  | 'daw.toggleAutomation' | 'daw.automationMode'
  | 'daw.tempoChange' | 'daw.tempoRamp'
  | 'daw.showChain' | 'daw.showSession' | 'daw.launchScene' | 'daw.stopAllClips'
  | 'daw.showSpectral' | 'daw.showReference' | 'daw.analyzeMix'
  | 'daw.showWarp' | 'daw.autoWarp' | 'daw.toggleWarp'
  | 'daw.detectTempo' | 'daw.extractGroove' | 'daw.applyGroove'
  | 'daw.trackDelayEarlier' | 'daw.trackDelayLater' | 'daw.trackDelayClear'
  | 'daw.pictureBack' | 'daw.pictureForward' | 'daw.pictureToPlayhead'
  | 'daw.spotClip'
  | 'daw.showRestore' | 'daw.declick'
  | 'daw.toggleArm' | 'daw.record' | 'daw.punchFromSelection'
  | 'daw.showSteps' | 'daw.arpeggiate' | 'daw.strum' | 'daw.slide' | 'daw.capturePattern'
  | 'daw.showIntel' | 'daw.analyzeMixAi' | 'daw.aiCommand'
  | 'daw.sectionNext' | 'daw.sectionPrev' | 'daw.sectionSelect' | 'daw.sectionAdd'
  | 'daw.sectionMoveBack' | 'daw.sectionMoveForward'
  | 'daw.tuneToGuide' | 'daw.riff';

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
    note: '마스터링 앱에는 녹음 트랙이 없습니다 — DAW 워크스페이스에서는 이 키가 녹음을 시작합니다', available: false },
  { id: 'transport.returnToZero', group: 'transport', label: '재생 위치 0점으로', chords: ['NumpadDecimal', 'Home'],
    note: '재생 헤드를 0초로 (루프 ON 이면 루프 시작점으로)', available: true },
  { id: 'transport.metronome',    group: 'transport', label: '메트로놈 on/off', chords: ['KeyC'],
    note: '템포 맵을 따라갑니다 — 리타르단도에서도 음악과 같이 느려집니다', available: true },
  { id: 'transport.toggleLoop',   group: 'transport', label: '루프 구간 on/off', chords: ['NumpadDivide'],
    note: '루프 재생 on/off — 구간은 파형에서 드래그(2번 툴)', available: true },
  { id: 'transport.gotoLoopStart', group: 'transport', label: '좌측 루프 포인터로', chords: ['Numpad1'],
    note: '루프 시작점으로 이동', available: true },
  { id: 'transport.gotoLoopEnd',   group: 'transport', label: '우측 루프 포인터로', chords: ['Numpad2'],
    note: '루프 끝점으로 이동', available: true },
  { id: 'view.zoomInH',  group: 'transport', label: '화면 가로 확대', chords: ['KeyF'],
    note: '파형 가로 확대 (재생 헤드 기준)', available: true },
  { id: 'view.zoomOutH', group: 'transport', label: '화면 가로 축소', chords: ['KeyG'],
    note: '파형 가로 축소 (재생 헤드 기준)', available: true },
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
    note: 'DAW 에서 구간을 선택했으면 그 구간 · 아니면 마스터링 설정', available: true },
  { id: 'edit.cut',    group: 'edit', label: '잘라내기',         chords: ['Mod+X'],
    note: 'DAW 전용 — 구간을 클립보드로 옮기고 구멍을 남깁니다', available: true },
  { id: 'edit.paste',  group: 'edit', label: '붙여넣기',         chords: ['Mod+V'],
    note: 'DAW 에서는 재생헤드에 · 아니면 복사한 마스터링 설정', available: true },
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
    note: '선택한 MIDI 파트를 Key Editor 로 열기 (DAW 워크스페이스)', available: true },
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
  { id: 'window.controlSurface', group: 'window', label: '컨트롤 서피스', chords: ['Alt+K'],
    note: 'MIDI 컨트롤러 매핑 패널 열기/닫기 — 학습 · 픽업 · 내보내기', available: true },

  // ── 6. DAW 편집 (Edit / Mix) ────────────────────────────────────────────
  { id: 'daw.open', group: 'daw', label: 'DAW 워크스페이스 열기', chords: ['Mod+Alt+D'],
    note: '멀티트랙 Edit / Mix 화면으로 이동', available: true },
  { id: 'daw.toggleWindow', group: 'daw', label: 'Edit ↔ Mix 전환', chords: ['Mod+Equal'],
    note: '같은 세션의 편집 화면과 콘솔 화면 전환', available: true },
  { id: 'daw.sectionAdd',    group: 'daw', label: '구간 경계 추가', chords: ['Alt+Shift+G'],
    note: '재생헤드에 어레인지 구간 경계를 만듭니다', available: true },
  { id: 'daw.sectionNext',   group: 'daw', label: '다음 구간으로', chords: ['Alt+Period'],
    note: '다음 구간 시작으로 이동', available: true },
  { id: 'daw.sectionPrev',   group: 'daw', label: '이전 구간으로', chords: ['Alt+Comma'],
    note: '이전 구간 시작으로 이동', available: true },
  { id: 'daw.sectionSelect', group: 'daw', label: '현재 구간 선택', chords: ['Alt+BracketRight'],
    note: '재생헤드가 있는 구간을 모든 트랙에서 선택합니다', available: true },
  { id: 'daw.sectionMoveBack', group: 'daw', label: '구간을 앞으로 옮기기',
    chords: ['Alt+Shift+BracketLeft'],
    note: '재생헤드의 구간을 앞 구간과 맞바꿉니다 — 클립·오토메이션·템포째로', available: true },
  { id: 'daw.sectionMoveForward', group: 'daw', label: '구간을 뒤로 옮기기',
    chords: ['Alt+Shift+BracketRight'],
    note: '재생헤드의 구간을 뒤 구간과 맞바꿉니다 — 클립·오토메이션·템포째로', available: true },
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
  { id: 'daw.consolidate', group: 'daw', label: '컨솔리데이트 (구간)', chords: ['Mod+Alt+C'],
    note: '선택 구간을 그 길이 그대로 하나의 새 오디오 클립으로 렌더링', available: true },
  { id: 'daw.bounceSelection', group: 'daw', label: '바운스 (Bounce Selection)', chords: ['KeyV'],
    note: '선택한 클립들을 트랙별로 하나의 파일로 합침 — 사이의 빈 구간은 디지털 무음', available: true },
  { id: 'daw.clipGainUp', group: 'daw', label: '클립 게인 +0.5 dB', chords: ['Mod+Shift+ArrowUp'],
    note: '클립 자체 게인 (페이더 이전)', available: true },
  { id: 'daw.clipGainDown', group: 'daw', label: '클립 게인 −0.5 dB', chords: ['Mod+Shift+ArrowDown'],
    note: '클립 자체 게인 (페이더 이전)', available: true },
  { id: 'daw.clipPitchUp', group: 'daw', label: '클립 피치 +1 반음', chords: ['Mod+Alt+ArrowUp'],
    note: '오디오 클립을 길이 그대로 반음 올립니다 — 클립 게인이 Mod+Shift+화살표, 피치는 Mod+Alt+화살표', available: true },
  { id: 'daw.clipPitchDown', group: 'daw', label: '클립 피치 −1 반음', chords: ['Mod+Alt+ArrowDown'],
    note: '오디오 클립을 길이 그대로 반음 내립니다', available: true },
  { id: 'daw.clipPitchReset', group: 'daw', label: '클립 피치 원음', chords: ['Alt+Digit0'],
    note: '피치를 0 으로 — 파일 그대로 재생됩니다', available: true },
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
  { id: 'daw.sendToMastering', group: 'daw', label: '마스터링으로 보내기', chords: ['Mod+Shift+M'],
    note: '믹스를 렌더링해서 홈 마스터링 대기열에 넣습니다 — 저장 창도 없고 내보내기로 치지도 않습니다',
    available: true },
  { id: 'daw.exportStems', group: 'daw', label: '스템 내보내기', chords: ['Mod+Alt+Shift+B'],
    note: '트랙마다 WAV 하나 — 합치면 믹스가 됩니다 (마스터 체인 제외)', available: true },
  { id: 'daw.importAudio', group: 'daw', label: '오디오 가져오기', chords: ['Mod+Shift+I'],
    note: '파일마다 트랙 + 클립 생성', available: true },
  { id: 'daw.importSession', group: 'daw', label: '세션 데이터 가져오기', chords: ['Mod+Shift+D'],
    note: '다른 세션의 트랙 · 인서트 · 센드 · 오토메이션을 가져옴', available: true },
  { id: 'daw.zoomIn', group: 'daw', label: '가로 확대', chords: ['Mod+BracketRight'],
    note: '타임라인 확대', available: true },
  { id: 'daw.zoomOut', group: 'daw', label: '가로 축소', chords: ['Mod+BracketLeft'],
    note: '타임라인 축소', available: true },

  // ── Key Editor ─────────────────────────────────────────────────────────
  { id: 'daw.quantize', group: 'daw', label: '퀀타이즈', chords: ['Mod+Q'],
    note: '인스펙터의 강도 · 스윙 · 캐치 설정으로 선택 노트를 퀀타이즈', available: true },
  { id: 'daw.humanize', group: 'daw', label: '휴머나이즈', chords: ['Mod+Shift+Q'],
    note: '시드 고정 랜덤 — 바운스에서 같은 결과가 재현됨', available: true },
  { id: 'daw.selectAllNotes', group: 'daw', label: '노트 전체 선택', chords: ['Mod+A'],
    note: '열린 파트의 모든 노트 선택', available: true },
  { id: 'daw.legatoNotes', group: 'daw', label: '레가토', chords: ['Alt+L'],
    note: '각 노트를 다음 노트까지 늘림', available: true },
  { id: 'daw.transposeUp', group: 'daw', label: '반음 위로', chords: ['Shift+ArrowUp'],
    note: '선택 노트 +1 반음 (스케일 보정 옵션 반영)', available: true },
  { id: 'daw.transposeDown', group: 'daw', label: '반음 아래로', chords: ['Shift+ArrowDown'],
    note: '선택 노트 −1 반음', available: true },
  { id: 'daw.octaveUp', group: 'daw', label: '옥타브 위로', chords: ['Shift+Alt+ArrowUp'],
    note: '선택 노트 +12 반음', available: true },
  { id: 'daw.octaveDown', group: 'daw', label: '옥타브 아래로', chords: ['Shift+Alt+ArrowDown'],
    note: '선택 노트 −12 반음', available: true },
  { id: 'daw.velocityUp', group: 'daw', label: '벨로시티 +', chords: ['Mod+ArrowUp'],
    note: '선택 노트 벨로시티 +5', available: true },
  { id: 'daw.velocityDown', group: 'daw', label: '벨로시티 −', chords: ['Mod+ArrowDown'],
    note: '선택 노트 벨로시티 −5', available: true },

  // ── Chord Track ────────────────────────────────────────────────────────
  { id: 'daw.detectChords', group: 'daw', label: '코드 감지 → 코드 트랙', chords: ['Mod+Shift+C'],
    note: '열린 MIDI 파트의 화성을 읽어 코드 트랙을 채움', available: true },
  { id: 'daw.reharmonize', group: 'daw', label: '리하모나이즈 (재즈)', chords: ['Mod+Alt+J'],
    note: '3화음 → 7화음, 도미넌트 앞에 ii 삽입', available: true },
  { id: 'daw.addChord', group: 'daw', label: '재생 위치에 코드', chords: ['Alt+H'],
    note: '코드 레인에 C 를 놓습니다 — 블록을 더블클릭해 Cmaj7 처럼 고쳐 씁니다', available: true },

  // ── 보컬 피치 편집 (VariAudio 계열) ────────────────────────────────────
  { id: 'daw.analyzeVocal', group: 'daw', label: '보컬 피치 분석', chords: ['Mod+Alt+P'],
    note: '재생 위치의 오디오 클립을 음정 구간으로 분석 (피치 · 비브라토 · 드리프트)', available: true },
  { id: 'daw.tuneVocal', group: 'daw', label: '스케일로 피치 보정', chords: ['Mod+Alt+U'],
    note: '분석된 구간을 에디터 스케일에 맞추고 PSOLA 로 렌더 (원본은 보존)', available: true },
  { id: 'daw.openVocalEditor', group: 'daw', label: 'VOCAL 에디터에서 열기', chords: ['Shift+Alt+V'],
    note: '재생 위치의 오디오 클립을 블롭 에디터로 — 노트 하나씩 끌어 고칩니다', available: true },

  // ── 클립보드 · 오디오 편집 ─────────────────────────────────────────────
  // Mod+C / Mod+X / Mod+V 는 edit.* 쪽에 있습니다 — DAW 에 있으면 타임라인,
  // 아니면 마스터링 설정으로 갈라집니다.  아래는 DAW 에만 있는 변형입니다.
  { id: 'daw.cutRipple', group: 'daw', label: '잘라내고 뒤를 당기기', chords: ['Mod+Shift+X'],
    note: '구멍을 남기지 않습니다 — 이걸로 잘라 붙이면 복사가 아니라 이동입니다', available: true },
  { id: 'daw.pasteInsert', group: 'daw', label: '끼워 넣기 (뒤를 밀기)', chords: ['Mod+Shift+V'],
    note: '덮어쓰지 않고 자리를 만들어 넣습니다 — 아무것도 사라지지 않습니다', available: true },
  { id: 'daw.insertSilence', group: 'daw', label: '무음 삽입', chords: ['Mod+Shift+E'],
    note: '선택한 길이만큼 재생헤드에 빈 자리를 만듭니다 (리플 삭제의 반대)', available: true },
  { id: 'daw.stripSilence', group: 'daw', label: '무음 제거 (Detect Silence)', chords: ['Shift+Alt+S'],
    note: '선택한 클립에서 소리 나는 부분만 남깁니다 — 자르기 전에 얼마나 없어지는지 보여줍니다. 이어서 V(바운스)', available: true },
  { id: 'daw.alignToGuide', group: 'daw', label: '가이드에 정렬 (Audio Align)', chords: ['Shift+Alt+A'],
    note: '선택한 트랙 중 맨 위를 가이드로, 나머지 더블링·코러스의 박자를 맞춥니다 (DTW)', available: true },
  { id: 'daw.snapZeroCross', group: 'daw', label: '영교차로 스냅', chords: ['Shift+Alt+Z'],
    note: '선택 구간의 양 끝을 파형이 0을 지나는 곳으로 — 자른 자리의 딱 소리를 없앱니다', available: true },

  // ── 트랙 헤더 ──────────────────────────────────────────────────────────
  { id: 'daw.quantizeAudio', group: 'daw', label: '오디오 퀀타이즈', chords: ['Mod+Shift+T'],
    note: '트랜지언트를 그리드로 — 강도·스윙·허용 오차를 정하고, 적용 전에 몇 개가 움직이는지 봅니다', available: true },
  { id: 'daw.createEditGroup', group: 'daw', label: '편집 그룹 만들기', chords: ['Mod+G'],
    note: '선택한 트랙들이 한 덩어리처럼 선택·편집됩니다 (페이더·뮤트도 함께)', available: true },
  { id: 'daw.dissolveEditGroup', group: 'daw', label: '편집 그룹 해제', chords: ['Mod+Shift+H'],
    note: '선택한 트랙이 속한 그룹을 없앱니다', available: true },
  { id: 'daw.toggleGroupsEnabled', group: 'daw', label: '그룹 일시 정지 / 재개', chords: ['Mod+Shift+B'],
    note: '그룹을 지우지 않고 잠깐 꺼서 한 트랙만 편집 — 다시 누르면 복구', available: true },
  { id: 'daw.zoomToSelection', group: 'daw', label: '선택 구간에 맞춰 확대', chords: ['Shift+F'],
    note: '선택이 없으면 세션 전체 — 양쪽에 여유를 두고 맞춥니다', available: true },
  { id: 'daw.toggleFollowPlayhead', group: 'daw', label: '재생헤드 따라가기 on/off', chords: ['KeyL'],
    note: '재생 중 화면이 페이지 단위로 넘어갑니다 (큐베이스는 F 이지만 그 키는 가로 확대가 씁니다)', available: true },
  { id: 'daw.playFromSelection', group: 'daw', label: '선택 지점부터 재생', chords: ['Shift+Space'],
    note: 'Space 는 그대로 재생헤드에서 — 이건 선택 시작으로 가서 재생', available: true },
  { id: 'daw.cycleRulerFormat', group: 'daw', label: '눈금자 단위 바꾸기', chords: ['Shift+R'],
    note: '마디 → 분:초 → 샘플 → 타임코드 순으로 돕니다', available: true },
  { id: 'daw.duplicateTrack', group: 'daw', label: '트랙 복제', chords: ['Mod+Alt+Shift+D'],
    note: '클립·인서트·센드·오토메이션까지 복사해 바로 아래에 — 프리즈와 녹음 무장은 빼고', available: true },
  { id: 'daw.renameTrack', group: 'daw', label: '트랙 이름 바꾸기', chords: ['Shift+Alt+K'],
    note: '헤더의 이름을 더블클릭해도 됩니다 · 색은 왼쪽 색 조각을 클릭', available: true },
  { id: 'daw.trackHeightUp', group: 'daw', label: '트랙 높이 키우기', chords: ['Shift+Alt+Equal'],
    note: '아주 작게 → 작게 → 보통 → 크게 → 아주 크게', available: true },
  { id: 'daw.trackHeightDown', group: 'daw', label: '트랙 높이 줄이기', chords: ['Shift+Alt+Minus'],
    note: '헤더 아래 모서리를 끌어도 됩니다', available: true },

  // ── 클립 처리 ──────────────────────────────────────────────────────────
  { id: 'daw.normalizeClip', group: 'daw', label: '클립 노멀라이즈', chords: ['Shift+Alt+N'],
    note: '−1 dBTP 로 — 렌더가 아니라 클립 게인이라 두 번 눌러도 같습니다', available: true },
  { id: 'daw.reverseClip', group: 'daw', label: '클립 뒤집기', chords: ['Shift+Alt+R'],
    note: '새 파일로 렌더하고 페이드도 반대쪽으로 옮깁니다 (원본은 그대로)', available: true },
  { id: 'daw.renameClip', group: 'daw', label: '클립 이름 바꾸기', chords: ['Shift+Alt+M'],
    note: '구간을 잡고 누르면 선택한 클립 전부에 번호를 붙여 이름을 답니다', available: true },

  // ── 픽처 (비디오) ──────────────────────────────────────────────────────
  { id: 'daw.togglePicture', group: 'daw', label: '픽처 창 켜기 / 끄기', chords: ['Shift+Alt+P'],
    note: '어느 창에 있든 영상이 위에 떠 있습니다 — 스코어링은 보면서 하는 일입니다', available: true },
  { id: 'daw.nudgeFrameBack', group: 'daw', label: '한 프레임 뒤로', chords: ['Shift+Alt+Comma'],
    note: '초가 아니라 프레임 단위 — 23.976 에서는 41.7 ms 입니다', available: true },
  { id: 'daw.nudgeFrameForward', group: 'daw', label: '한 프레임 앞으로', chords: ['Shift+Alt+Period'],
    note: '히트 포인트는 프레임 위에 있습니다', available: true },

  // ── 스마트 컨트롤 · 트랙 스택 ──────────────────────────────────────────
  { id: 'daw.tempoChange', group: 'daw', label: '재생 위치에 템포 변화', chords: ['Alt+T'],
    note: '지금 걸려 있는 템포 그대로 이벤트를 놓습니다 — 음악은 안 움직이고 손잡이만 생깁니다', available: true },
  { id: 'daw.tempoRamp', group: 'daw', label: '템포 이벤트 Jump ↔ Ramp', chords: ['Shift+Alt+T'],
    note: '재생 위치 직전 이벤트를 리타르단도 / 아첼레란도로', available: true },
  { id: 'daw.toggleAutomation', group: 'daw', label: '오토메이션 레인 열기 / 접기', chords: ['Alt+A'],
    note: '볼륨 레인부터 — 접어도 브레이크포인트는 그대로 남고 계속 재생됩니다', available: true },
  { id: 'daw.automationMode', group: 'daw', label: '오토메이션 모드 순환', chords: ['Mod+Alt+Shift+A'],
    note: 'read → touch → latch → write → trim. 재생 중에 페이더를 잡으면 기록됩니다', available: true },
  { id: 'daw.smartControls', group: 'daw', label: '스마트 컨트롤', chords: ['Mod+Alt+S'],
    note: '매크로 7개(WARMTH·CLARITY·PUNCH·AIR·WIDTH·DEPTH·LOUDNESS) — Advanced 로 실제 파라미터', available: true },
  { id: 'daw.createStack', group: 'daw', label: '트랙 스택 만들기', chords: ['Mod+Shift+G'],
    note: '선택 트랙을 합산 스택으로 묶음 (버스 생성 + 라우팅)', available: true },
  { id: 'daw.unpackStack', group: 'daw', label: '스택 해제', chords: ['Mod+Shift+U'],
    note: '멤버는 남기고 폴더와 버스를 제거', available: true },
  { id: 'daw.toggleStack', group: 'daw', label: '스택 접기/펼치기', chords: ['Mod+Shift+F'],
    note: '큰 세션에서 화면을 정리', available: true },

  // ── Device Chain · Session View ────────────────────────────────────────
  { id: 'daw.showChain', group: 'daw', label: 'Device Chain', chords: ['Mod+Alt+H'],
    note: '신호 흐름을 그래프로 — 병렬 브랜치 · 센드 · 랙', available: true },
  { id: 'daw.showSession', group: 'daw', label: 'Session View', chords: ['Mod+Alt+Y'],
    note: '클립 그리드 · 씬 실행 · Arrangement 변환', available: true },
  { id: 'daw.showWarp', group: 'daw', label: 'Warp 에디터', chords: ['Mod+Alt+W'],
    note: '클립을 세션 템포에 맞춤 — 마커를 그리드로 끌어당기기', available: true },
  { id: 'daw.autoWarp', group: 'daw', label: 'Auto-Warp', chords: ['Mod+Shift+W'],
    note: '트랜지언트마다 마커를 찍고 그리드에 스냅', available: true },
  { id: 'daw.toggleWarp', group: 'daw', label: 'Warp 켜기 / 끄기', chords: ['Alt+W'],
    note: '선택한 클립의 워프 on/off', available: true },

  { id: 'daw.spotClip', group: 'daw', label: 'Spot — 클립을 정확한 위치로', chords: ['Mod+Alt+Shift+S'],
    note: '재생헤드 아래 클립의 위치를 타임코드 · 마디 · 분초 · 샘플로 입력합니다', available: true },

  // ── 픽처 ───────────────────────────────────────────────────────────────
  { id: 'daw.pictureBack', group: 'daw', label: '픽처 한 프레임 앞으로', chords: ['Mod+Shift+BracketLeft'],
    note: '픽처만 옮깁니다 — 재생헤드는 그대로', available: true },
  { id: 'daw.pictureForward', group: 'daw', label: '픽처 한 프레임 뒤로', chords: ['Mod+Shift+BracketRight'],
    note: '픽처만 옮깁니다 — 재생헤드는 그대로', available: true },
  { id: 'daw.pictureToPlayhead', group: 'daw', label: '픽처를 재생헤드로', chords: ['Mod+Alt+Shift+KeyP'],
    note: '픽처의 첫 프레임이 재생헤드에 오도록 옮깁니다', available: true },

  // ── 트랙 딜레이 ────────────────────────────────────────────────────────
  { id: 'daw.trackDelayEarlier', group: 'daw', label: '트랙 딜레이 −1 ms', chords: ['Mod+Alt+Shift+Comma'],
    note: '커서가 있는 트랙을 1 ms 먼저 재생 — 오토메이션은 따라가지 않습니다', available: true },
  { id: 'daw.trackDelayLater', group: 'daw', label: '트랙 딜레이 +1 ms', chords: ['Mod+Alt+Shift+Period'],
    note: '커서가 있는 트랙을 1 ms 늦게 재생', available: true },
  { id: 'daw.trackDelayClear', group: 'daw', label: '트랙 딜레이 0', chords: ['Mod+Alt+Shift+Digit0'],
    note: '트랙 딜레이를 없앱니다', available: true },

  // ── 템포 검출 · 그루브 ──────────────────────────────────────────────────
  { id: 'daw.detectTempo', group: 'daw', label: '클립에서 템포 검출', chords: ['Mod+Alt+Shift+T'],
    note: '박의 위치까지 함께 찾아 세션 템포를 맞추고 클립을 그리드에 붙입니다', available: true },
  { id: 'daw.extractGroove', group: 'daw', label: '그루브 추출', chords: ['Mod+Alt+Shift+G'],
    note: '연주의 밀고 당김을 템플릿으로 떠냅니다 — 오디오 클립 또는 열린 MIDI 파트', available: true },
  { id: 'daw.applyGroove', group: 'daw', label: '그루브 적용', chords: ['Mod+Alt+Shift+H'],
    note: '떠낸 그루브를 선택한 노트에 입힙니다 — 모르는 자리는 건드리지 않습니다', available: true },
  { id: 'daw.toggleArm', group: 'daw', label: '녹음 무장 / 해제', chords: ['KeyR'],
    note: '커서가 있는 트랙을 무장하고 입력을 엽니다', available: true },
  { id: 'daw.record', group: 'daw', label: '녹음 시작 / 정지', chords: ['Mod+KeyR'],
    note: '카운트인 · 프리롤 · 펀치를 계획대로 실행 (DAW 에서는 Numpad * 도 같은 동작)', available: true },
  { id: 'daw.punchFromSelection', group: 'daw', label: '선택 구간을 펀치로', chords: ['Mod+Shift+P'],
    note: '선택한 구간을 펀치 인/아웃으로 설정', available: true },
  { id: 'daw.tuneToGuide', group: 'daw', label: '가이드 멜로디로 피치 보정', chords: ['Mod+Alt+T'],
    note: 'Key Editor 에 연 MIDI 파트를 타깃으로 보컬을 튜닝 — 스케일이 아니라 "의도한 음"', available: true },
  { id: 'daw.riff', group: 'daw', label: 'Riff Machine', chords: ['Mod+Shift+R'],
    note: '코드 트랙과 스케일에서 프레이즈를 생성 — 열려 있는 MIDI 파트에 씁니다', available: true },
  { id: 'daw.showIntel', group: 'daw', label: 'Intelligence (AI)', chords: ['Mod+Alt+I'],
    note: '분석 · AI 믹스 · AI 마스터 · 레퍼런스 매칭 · 오토메이션 · 자연어', available: true },
  { id: 'daw.analyzeMixAi', group: 'daw', label: 'AI 분석 실행', chords: ['Mod+Shift+A'],
    note: '믹스와 모든 트랙을 재고 문제를 찾습니다', available: true },
  { id: 'daw.aiCommand', group: 'daw', label: '말로 지시하기', chords: ['Mod+Slash'],
    note: '자연어 커맨드 입력으로 이동', available: true },
  { id: 'daw.showSteps', group: 'daw', label: 'Channel Rack (스텝 시퀀서)', chords: ['Mod+Alt+Q'],
    note: '스텝 그리드 · 패턴 라이브러리', available: true },
  { id: 'daw.arpeggiate', group: 'daw', label: '아르페지오', chords: ['Mod+Alt+A'],
    note: '선택한 코드를 그리드 속도로 펼칩니다', available: true },
  { id: 'daw.strum', group: 'daw', label: '스트럼', chords: ['Mod+Alt+X'],
    note: '블록 코드를 손으로 친 것처럼 — 끝은 함께 끝납니다', available: true },
  { id: 'daw.slide', group: 'daw', label: '슬라이드 (포르타멘토)', chords: ['Mod+Alt+Z'],
    note: '앞 노트에서 벤드해 들어옵니다 — 실제 피치벤드 데이터', available: true },
  { id: 'daw.capturePattern', group: 'daw', label: '클립을 패턴으로', chords: ['Mod+Alt+O'],
    note: '노트를 라이브러리로 옮기고 클립을 링크로 만듭니다', available: true },
  { id: 'daw.showRestore', group: 'daw', label: 'Restoration (노이즈 · 클릭)', chords: ['Mod+Alt+N'],
    note: '노이즈 프로파일 학습 후 감산 · 클릭 스캔 후 AR 복원', available: true },
  { id: 'daw.declick', group: 'daw', label: '클립 디클릭', chords: ['Mod+Shift+K'],
    note: '커서 아래 클립의 클릭을 찾아 전부 복원', available: true },
  { id: 'daw.showSpectral', group: 'daw', label: 'Spectral Repair', chords: ['Mod+Alt+G'],
    note: '스펙트로그램에서 주파수 영역만 골라 Repair / Attenuate / Replace', available: true },
  { id: 'daw.showReference', group: 'daw', label: 'Mastering Reference', chords: ['Mod+Alt+M'],
    note: 'REFERENCE vs YOUR MIX — LUFS · TP · DR · WIDTH · 대역 밸런스', available: true },
  { id: 'daw.analyzeMix', group: 'daw', label: '현재 믹스 분석', chords: ['Mod+Alt+K'],
    note: '세션을 렌더링해 레퍼런스와 비교', available: true },
  { id: 'daw.launchScene', group: 'daw', label: '다음 씬 실행', chords: ['Mod+Alt+Enter'],
    note: 'Session View 의 다음 씬을 다음 마디에 실행', available: true },
  { id: 'daw.stopAllClips', group: 'daw', label: '모든 클립 정지', chords: ['Mod+Alt+Period'],
    note: 'Session View 재생 중지', available: true },
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
