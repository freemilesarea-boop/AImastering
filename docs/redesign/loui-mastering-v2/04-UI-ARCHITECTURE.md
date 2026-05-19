# 04 — UI 구조도

## A. 현재 UI 구조 (As-Is)

### A.1 라우팅 / 상태 머신

```
appStore.currentPage  ←  단일 enum 으로 페이지 전환 (라우터 없음)
                                 │
   ┌─────────────┬───────────────┼───────────────┬───────────────┐
   │             │               │               │               │
HomePage    AnalysisPage    MasteringPage    ResultPage    SettingsPage / QCPage
(38.5KB)     (12KB)          (8.9KB)         (37.6KB)
[Queue]      [Analysis]      [Progress]      [Player + Metering]
```

흐름 : 파일 드롭 (Home) → 분석 (Analysis) → 진행 (Mastering) → 결과 (Result)

### A.2 ResultPage — 가장 복잡한 화면

```
┌──────────────────────────────────────────────────────────────────────┐
│  TopBar (Home / Analysis / Mastering / Result / QC / Settings)        │
├──────────────────────────────────────────────────────────────────────┤
│ ┌─ Before / After Loudness Card ────────────────────────────────┐    │
│ │  LUFS-I  -22.4  →  -14.0   (Δ +8.4 LU)                        │    │
│ │  TP       -1.2 →  -1.0     (Δ +0.2 dB)                        │    │
│ │  LRA      8.4  →  6.2     (Δ -2.2 LU)                        │    │
│ └────────────────────────────────────────────────────────────────┘    │
│ ┌─ HTML5 <audio> 미리듣기 + LoudnessMeterPanel (실시간 M/S/I + TP) ┐ │
│ │  [▶] Scrub ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ ┐ │
│ │                                                                  │ │
│ │   M -14.2 dBLUFS                                                 │ │
│ │   S -13.8                                                        │ │
│ │   I -14.0                                                        │ │
│ │   TP -1.0                                                        │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ ┌─ ABComparePanel ──────────────────────────────────────────────┐    │
│ │ [A: Original]  [B: Mastered]   (Space=toggle, P=play)          │    │
│ │ 라우드니스 매칭: -22.4 LUFS 로 동일화 (Original 그대로, Mastered: -8.4 dB trim) │ │
│ └────────────────────────────────────────────────────────────────┘    │
│ ┌─ Waveform Compare ─────────────────────────────────────────────┐   │
│ │  [Before PNG]                                                    │  │
│ │  [After  PNG]   ← 정적 이미지, 스크럽/줌 불가                    │  │
│ └──────────────────────────────────────────────────────────────────┘ │
│ ┌─ SectionAnalysisPanel ─ verse/chorus 타임라인 ───┐                  │
│ │ ▓░░▓▓▓▓░░▓▓▓▓▓▓▓░░▓▓▓░░░  (color = energy)        │                 │
│ └──────────────────────────────────────────────────┘                  │
│ ┌─ MasteringReportPanel ─ 모드/타겟/적용 게인/리미터 reduction ─┐    │
│ ┌─ SmartRecommendationPanel ─ 스텁 ─┐                                │
│ ┌─ AIArtifactWarningPanel ─ 조건부 ─┐                                │
│ ┌─ ExportReportPanel (PDF/CSV) ─┐                                    │
│ ┌─ Save buttons (WAV / MP3) ────┐                                    │
│ ┌─ YouTube Music disclosure (작은 면책) ─┐                            │
├──────────────────────────────────────────────────────────────────────┤
│ "루베르" 작은 워터마크 (좌하단)                                       │
└──────────────────────────────────────────────────────────────────────┘
```

### A.3 모듈 노출도 — **현재 = 0%**

| 백엔드 모듈 | UI 노출 |
|---|---|
| Adaptive EQ | ❌ (모드로만 간접 결정) |
| Dynamic EQ | ❌ |
| Multiband Comp | ❌ |
| Bus Compression | ❌ |
| Transient Shape | ❌ |
| Vocal Enhancer | ❌ |
| Saturation | 슬라이더 1개 (강도만) |
| Stereo Width | 슬라이더 1개 (강도만) |
| Limiter | 슬라이더 1개 (low/medium/high) |
| Reference Match | ❌ (참조 파일 업로드 UI 없음, 백엔드는 구현됨) |
| Section Analysis | 읽기 전용 표시 |

→ Ozone 스타일 모듈 UI 와의 격차가 크다.

### A.4 컴포넌트 인벤토리

```
apps/desktop/src/renderer/components/
├─ TopBar.tsx                        (1.5KB)  ← nav
├─ MasteringModeSelector.tsx         (2.6KB)  ← 5+2 모드 그리드
├─ LoudnessMeterPanel.tsx            (7.2KB)  ★ AudioWorklet 기반
├─ PreviewPanel.tsx                  (6.5KB)  ★ 5s 슬라이스 핫스왑
├─ ABComparePanel.tsx                (9.9KB)  ★ 샘플 정합 AB
├─ SectionAnalysisPanel.tsx          (6.7KB)  ← 정적 표시
├─ SmartRecommendationPanel.tsx      (2.9KB)  ← 스텁
├─ AIArtifactWarningPanel.tsx        (4.9KB)  ← 조건부
├─ MasteringReportPanel.tsx          (4.6KB)
├─ ExportReportPanel.tsx             (4.4KB)
├─ LicenseModal.tsx                  (9.9KB)  ← dead
├─ UpdateToast.tsx                   (8.1KB)
└─ ... (qc/, common/, upload/, license/, mastering/ 서브폴더 — legacy src 트리 기준)
```

### A.5 상태 (Zustand)

```
appStore:
  ├─ currentPage: 'home' | 'analysis' | 'mastering' | 'result' | 'qc' | 'settings'
  └─ notification

audioStore:
  ├─ queue: QueueItem[]                  // 최대 20곡 배치
  ├─ selectedFile / analysis / masteringResult / qcResult
  ├─ isAnalyzing / isMastering / progress / progressStage / error
  ├─ options: MasteringOptions
  │   ├─ style, targetLufs, targetTp
  │   ├─ sampleRate, bitDepth
  │   ├─ applyAiCorrections
  │   ├─ limiterStrength, saturationAmount, stereoWidth, outputGainDb
  │   └─ quickPreset
  ├─ showAdvanced
  └─ setFile / setAnalysis / updateOptions / reset

licenseStore: (사문)
```

### A.6 시각화 — 보유 / 부재

| 시각화 | 상태 | 메모 |
|---|---|---|
| LUFS M/S/I 미터 | ✅ | AudioWorklet, 100ms |
| TP 미터 | ✅ | 위 동일 |
| FFT 스펙트럼 | ❌ | AnalyserNode 사용처 전혀 없음 |
| 스펙트로그램 | ❌ | — |
| 파형 | ⚠️ 정적 PNG | 줌/스크럽 불가 |
| GR 미터 | ❌ | — |
| EQ 곡선 | ❌ | — |
| 벡터스코프 / Correlation | ❌ | — |
| 위상 스코프 | ❌ | — |

---

## B. 목표 UI 구조 (To-Be — Loui Mastering v2)

### B.1 레이아웃 철학

Ozone 9/10 스타일을 참고하되, Loui 만의 차별점:
- **AI 추천 + 수동 제어 하이브리드** — 추천 결과가 모듈 파라미터에 "고스트 값"으로 표시되고, 사용자가 이를 그대로 적용/수정/거부 가능.
- **모듈 그래프 시각화** — 직선 체인이 아니라 노드 그래프 (선택적 펼침).
- **단일 화면 워크플로** — 페이지 전환 최소화. 좌측 모듈 리스트, 중앙 시각화, 우측 메터.

### B.2 메인 화면 (Mastering Studio)

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  Loui Mastering                                          ⚙ Settings  |  ? Help    │
│  [project.wav]                                            (i) Pro  Logged in       │
├──────────┬──────────────────────────────────────────────────────────┬─────────────┤
│          │                                                          │             │
│ MODULES  │   ┌─ Spectrum / Spectrogram (실시간 FFT) ─────────────┐  │  METERS     │
│          │   │                                                   │  │             │
│ ☑ Gain    │  │   ▁▂▄▆█▇▆▄▃▂▁  (animated)                        │  │ LUFS-M -14.0│
│ ☑ EQ      │  │   [Now / Avg / Max]  [Linear / Log]              │  │ LUFS-S -13.8│
│ ☑ Dyn EQ  │  │                                                   │  │ LUFS-I -14.0│
│ ☑ MBComp  │  │   ※ 모듈 클릭 시 해당 모듈 시각화로 전환:        │  │ TP    -1.0 │
│ ☑ BusComp │  │      EQ → 곡선 에디터 + 입력 스펙트럼 오버레이   │  │ LRA    6.2 │
│ ☐ TransSh │  │      Comp → GR 미터 + 입출력 라인                │  │             │
│ ☑ Imager  │  │      Limiter → GR + ISP + 4× oversample 보기     │  │ ─── Spectra ─│
│ ☐ Satur   │  │                                                   │  │ ▓▓▓▓▓▓▓     │
│ ☐ De-Ess  │  │                                                   │  │             │
│ ☐ Vocal   │  └───────────────────────────────────────────────────┘  │ ─── Stereo ─│
│ ☑ RefMtch │                                                          │  ◯ correl    │
│ ☑ Limiter │   ┌─ Module Parameters (선택 모듈의 파라미터) ─────┐    │             │
│ ☑ Loud    │  │                                                   │  │             │
│ ☑ Dither  │  │  EQ                                               │  │             │
│          │   │  Band 1  Bell    80Hz   Q=1.2   +2.0 dB           │  │             │
│ + Add     │  │  Band 2  Bell    250Hz  Q=2.0   -1.5 dB           │  │             │
│           │  │  Band 3  Shelf   12kHz  Q=0.7   +1.2 dB           │  │             │
│           │  │  [+ Band]   [Reset]   [Match Reference]           │  │             │
│           │  │                                                   │  │             │
│           │  │  ◎ AI 추천:  Band 2 -2.0 dB  Band 4 +0.8 dB        │  │             │
│           │  │  [Accept all]  [Compare A/B]                      │  │             │
│           │  └───────────────────────────────────────────────────┘  │             │
│           │                                                          │             │
│  PRESETS  │   ┌─ Timeline (Section + Waveform) ──────────────────┐   │             │
│  ▸ Pop    │  │  Intro │ Verse │ Chorus │ Verse │ Chorus │ Bridge │  │             │
│  ▸ Hip-Hop │  │  ▒▒▒▒▒▒▒▒▓▓▓▓▓▓▓▓▒▒▒▒▒▓▓▓▓▓▓▓▓▓▓▓▒▒▒▒▒          │  │             │
│  ▸ K-Pop  │  │  ◀━━━━━━━━━━ scrub ━━━━━━━━━━━━▶  loop A-B        │  │             │
│  ▸ Custom │  │                                                   │  │             │
│           │  └───────────────────────────────────────────────────┘  │             │
│           │                                                          │             │
├──────────┴──────────────────────────────────────────────────────────┴─────────────┤
│  ▶ Play   ⏸  ↻  Loop  |  A/B Compare  |  Target: -14 LUFS / -1 dBTP  |  Export    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### B.3 핵심 UI 컴포넌트 (v2)

| 컴포넌트 | 역할 | 의존 |
|---|---|---|
| `<ModuleList>` | 좌측 — 모듈 그래프 활성/순서/추가/제거 | dnd-kit |
| `<ModuleInspector>` | 중앙 하단 — 선택 모듈의 파라미터 | per-module Form |
| `<SpectrumView>` | 중앙 상단 — 실시간 FFT (canvas) | AnalyserNode + Worker |
| `<EQCurveEditor>` | EQ 모듈 선택 시 SpectrumView 위에 오버레이 | canvas + biquad calc |
| `<GRMeter>` | Comp/Limiter 모듈 시각화 | per-module |
| `<MeterStack>` | 우측 — LUFS / TP / LRA / Correl / Phase | 통합 메터 워클릿 |
| `<Timeline>` | 하단 — section + waveform + scrub + loop | Peaks data |
| `<TransportBar>` | 최하단 — 재생/AB/타겟 | — |
| `<PresetBrowser>` | 좌측 하단 — 프리셋 트리 | preset store |
| `<AIRecommendBadge>` | 모듈 파라미터 옆 — 추천값 고스트 | recommendation engine |

### B.4 페이지 / 모달 구조 (v2)

```
Loui Mastering Studio (single-page application)
├─ /studio          ★ 위 메인 화면 (단일 트랙)
├─ /batch           배치 처리 — 큐 + 단일 프리셋 적용
├─ /library         프리셋 + 참조 트랙 관리
├─ /history         최근 마스터 결과 히스토리
└─ /settings        출력 / 라이선스 / 업데이트 / 텔레메트리

Modals:
- Preset Save / Manage
- Reference Track Import
- Account / License
- About
```

### B.5 상태 (Zustand or Redux Toolkit)

```
projectStore:
  ├─ sourcePath, sourceBuffer (decoded)
  ├─ graph: ModuleGraph   ← 모듈 노드 + 연결 + 파라미터
  ├─ playback: { isPlaying, position, loopAB, mode }
  └─ meters: live snapshot

graphStore:
  ├─ modules: Module[]
  ├─ activeModuleId
  ├─ history: Snapshot[]  ← Undo/Redo (커맨드 패턴)
  └─ ai: { recommendations, applied }

presetStore:
  ├─ presets: Preset[]    ← 빌트인 + 사용자
  ├─ activePresetId
  └─ source: 'builtin' | 'user' | 'marketplace'

uiStore:
  ├─ panels: { left, right, bottom collapsed }
  ├─ theme: 'dark' | 'light'
  ├─ locale: 'ko' | 'en' | 'ja'
  └─ shortcuts: KeyMap

licenseStore:
  ├─ tier: 'trial' | 'pro' | 'studio'
  ├─ trialUsesLeft
  └─ activatedAt

telemetryStore (opt-in):
  └─ ...
```

### B.6 단축키 (필수)

| 키 | 동작 |
|---|---|
| Space | Play / Pause |
| A | A/B 토글 |
| L | Loop on/off |
| Ctrl/Cmd+Z / Y | Undo / Redo |
| 1..9 | 모듈 활성 토글 |
| M | Module Inspector 포커스 |
| F | Spectrum freeze |
| E | Export |

### B.7 스타일 / 토큰

```
@loui/design-tokens
├─ colors.dark / colors.light
├─ semantic.success / warning / danger / info
├─ semantic.gr (gain reduction) — amber-to-red
├─ semantic.lufs (target ±0.5 / ±2 LU 경계 색)
├─ typography (Inter + JetBrains Mono)
├─ space, radius, shadow scales
└─ motion (단단한 100ms / 부드러운 200ms / 메터 100ms)
```

브랜드 토큰을 단일 패키지로 분리 (`@loui/brand`):
- `productName`: "Loui Mastering"
- `appId`: "studio.loui.mastering"
- `support`: { email, docs, status }
- 로고 SVG / 다크/라이트 변형

### B.8 i18n

- 한국어/영어/일본어 1차 (한국어 fallback 금지 — 시작부터 i18n).
- 라이브러리: `i18next` + 컴파일타임 키 점검.

### B.9 접근성

- WCAG 2.1 AA 명도 대비
- 키보드 전용 탐색 (Tab/Shift+Tab)
- 모든 노브에 숫자 입력 가능
- 모든 메터에 텍스트 라벨 (스크린 리더)

---

## C. 마이그레이션 차이 요약

| 영역 | 현재 | v2 |
|---|---|---|
| 페이지 | 6 페이지 (전환식) | 1 메인 + 4 보조 |
| 라우팅 | currentPage state | React Router |
| 모듈 노출 | 0% (5개 프리셋) | 100% (15+ 모듈) |
| 시각화 | LUFS 메터만 실시간 | FFT/스펙트로그램/GR/EQ/벡터스코프/페이즈 |
| 파형 | 정적 PNG | 인터랙티브 (peaks data, 줌, AB 마커) |
| 상태 | Zustand 2 store | Zustand 5+ store (도메인 분리) |
| 단축키 | A/B/Space 만 | 풀 키맵 + 사용자 커스텀 |
| 테마 | 다크만 | 다크 + 라이트 |
| i18n | 한국어 하드코드 | ko/en/ja |
| a11y | 미검증 | WCAG 2.1 AA |
| 브랜드 | 하드코드 8+ 위치 | `@loui/brand` 단일 소스 |
