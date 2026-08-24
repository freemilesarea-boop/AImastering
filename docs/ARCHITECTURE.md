# 아키텍처 설계 문서

> **이 문서는 초기 설계본입니다.** 여기 그려진 폴더 구조(`src/main`, `src/renderer`,
> `AudioEngine.ts`, 루트 `vite.config.ts` …)는 앱이 `aimaster-desktop/` 으로 옮겨가기
> 전의 것이고, 그 트리는 이제 저장소에 없습니다. 지금 돌아가는 구조는
> [`aimaster-desktop/docs/ARCHITECTURE.md`](../aimaster-desktop/docs/ARCHITECTURE.md)
> 를 보세요. 아래 내용은 초기 의도를 읽는 용도로 남겨둡니다.

## 폴더 구조

```
AImastering/
├── docs/                          # 설계 문서
│   ├── SPEC.md
│   ├── ARCHITECTURE.md
│   └── API.md
│
├── src/
│   ├── main/                      # Electron 메인 프로세스 (Node.js)
│   │   ├── index.ts               # 앱 진입점, BrowserWindow 생성
│   │   ├── ipc/                   # IPC 핸들러 모음
│   │   │   ├── fileHandlers.ts    # 파일 I/O IPC
│   │   │   ├── audioHandlers.ts   # 오디오 처리 IPC
│   │   │   ├── licenseHandlers.ts # 라이센스 IPC
│   │   │   └── settingsHandlers.ts
│   │   ├── services/              # 백엔드 서비스
│   │   │   ├── AudioEngine.ts     # Python 파이프라인 오케스트레이터
│   │   │   ├── LicenseService.ts  # 라이센스 검증 서비스
│   │   │   ├── SettingsService.ts # 앱 설정 관리
│   │   │   └── UpdateService.ts   # 자동 업데이트
│   │   └── utils/
│   │       ├── logger.ts          # 로깅 유틸리티
│   │       ├── pathUtils.ts       # 경로 유틸리티
│   │       └── pythonBridge.ts    # Python 프로세스 관리
│   │
│   ├── preload/                   # Electron Preload 스크립트
│   │   └── index.ts               # contextBridge API 노출
│   │
│   └── renderer/                  # React 렌더러 프로세스
│       ├── App.tsx                 # 앱 루트 컴포넌트
│       ├── main.tsx               # React 진입점
│       ├── components/
│       │   ├── common/            # 공통 UI 컴포넌트
│       │   │   ├── Button.tsx
│       │   │   ├── Modal.tsx
│       │   │   ├── ProgressBar.tsx
│       │   │   ├── Tooltip.tsx
│       │   │   └── StatusBadge.tsx
│       │   ├── upload/            # 파일 업로드 관련
│       │   │   ├── DropZone.tsx
│       │   │   └── FileList.tsx
│       │   ├── mastering/         # 마스터링 관련
│       │   │   ├── MasteringPanel.tsx
│       │   │   ├── PresetSelector.tsx
│       │   │   ├── LoudnessGauge.tsx
│       │   │   └── ProcessingStatus.tsx
│       │   ├── qc/                # QC 검사 관련
│       │   │   ├── QCReport.tsx
│       │   │   └── PlatformChecklist.tsx
│       │   ├── settings/          # 설정 관련
│       │   │   └── SettingsForm.tsx
│       │   └── license/           # 라이센스 관련
│       │       └── LicenseModal.tsx
│       ├── pages/                 # 페이지 단위 뷰
│       │   ├── HomePage.tsx       # 메인 화면 (드롭존)
│       │   ├── MasteringPage.tsx  # 마스터링 진행 화면
│       │   ├── ResultPage.tsx     # 결과/다운로드 화면
│       │   ├── QCPage.tsx         # QC 검사 화면
│       │   └── SettingsPage.tsx   # 설정 화면
│       ├── hooks/                 # 커스텀 훅
│       │   ├── useAudioEngine.ts  # 오디오 엔진 통신
│       │   ├── useLicense.ts      # 라이센스 상태
│       │   └── useSettings.ts     # 앱 설정
│       ├── store/                 # Zustand 스토어
│       │   ├── appStore.ts        # 앱 전역 상태
│       │   ├── audioStore.ts      # 오디오 처리 상태
│       │   └── licenseStore.ts    # 라이센스 상태
│       ├── types/                 # TypeScript 타입 정의
│       │   ├── audio.ts
│       │   ├── license.ts
│       │   └── ipc.ts
│       └── utils/                 # 렌더러 유틸리티
│           ├── formatters.ts      # 숫자/단위 포매터
│           └── validators.ts      # 입력 검증
│
├── python/                        # Python 오디오 처리 엔진
│   ├── main.py                    # Python 진입점 (stdin/stdout JSON RPC)
│   ├── pipeline/
│   │   ├── __init__.py
│   │   ├── analyzer.py            # 오디오 분석 모듈
│   │   ├── mastering.py           # 마스터링 파이프라인
│   │   ├── loudness.py            # LUFS/TP 측정 및 보정
│   │   ├── eq.py                  # EQ 처리
│   │   ├── compressor.py          # 컴프레션 처리
│   │   └── limiter.py             # 리미터/클리퍼
│   ├── analysis/
│   │   ├── __init__.py
│   │   ├── spectral.py            # 스펙트럼 분석
│   │   └── qc_checker.py          # QC 검사 로직
│   └── utils/
│       ├── __init__.py
│       ├── audio_io.py            # 오디오 파일 I/O
│       ├── ffmpeg_wrapper.py      # FFmpeg 래퍼
│       └── logger.py              # Python 로거
│
├── scripts/
│   ├── setup-python.sh            # Python 환경 설정
│   ├── build.sh                   # 빌드 스크립트
│   └── notarize.js                # macOS 공증 스크립트
│
├── assets/
│   └── icons/                     # 앱 아이콘
│
├── tests/
│   ├── unit/
│   └── integration/
│
├── package.json
├── tsconfig.json
├── tailwind.config.js
├── vite.config.ts                 # Vite (렌더러 번들러)
├── electron-builder.yml
├── requirements.txt               # Python 의존성
└── README.md
```

---

## 데이터 흐름

```
[User]
  │
  ▼
[React UI] ─── IPC (invoke) ──► [Electron Main]
                                      │
                                      ▼
                              [AudioEngine.ts]
                                      │
                                      ▼ spawn/stdin
                              [Python main.py]
                                      │
                          ┌───────────┼───────────┐
                          ▼           ▼           ▼
                    [analyzer]  [mastering]  [qc_checker]
                          │           │           │
                          └───────────┼───────────┘
                                      │ JSON result
                                      ▼
                              [Electron Main]
                                      │
                               IPC (send/event)
                                      │
                                      ▼
                              [React UI Update]
```

## IPC 채널 목록

| 채널명 | 방향 | 설명 |
|--------|------|------|
| `audio:analyze` | invoke | 오디오 파일 분석 요청 |
| `audio:master` | invoke | 마스터링 실행 요청 |
| `audio:progress` | main→renderer | 처리 진행률 push |
| `audio:qc` | invoke | QC 검사 요청 |
| `file:open-dialog` | invoke | 파일 선택 대화상자 |
| `file:save-dialog` | invoke | 저장 대화상자 |
| `license:validate` | invoke | 라이센스 키 검증 |
| `license:status` | invoke | 현재 라이센스 상태 조회 |
| `settings:get` | invoke | 설정 조회 |
| `settings:set` | invoke | 설정 저장 |

---

## 라이센스 흐름

```
[앱 시작]
    │
    ▼
[로컬 라이센스 파일 확인]
    │
    ├─ 없음 ──► [무료 체험 모드] ──► 3회 처리 후 업그레이드 유도
    │
    ├─ 있음 ──► [로컬 검증 (HMAC)]
    │               │
    │               ├─ 유효 + 온라인 ──► [서버 검증] ──► OK/만료 처리
    │               │
    │               ├─ 유효 + 오프라인 ──► [오프라인 허용 기간 확인]
    │               │                       ├─ 7일 이내 ──► [허용]
    │               │                       └─ 초과 ──► [재연결 요구]
    │               │
    │               └─ 무효 ──► [라이센스 입력 화면]
    │
    └─ 만료 ──► [갱신 유도]
```

---

## 오디오 처리 파이프라인

```
[Input WAV]
    │
    ▼
[1. Pre-Analysis]
    ├─ LUFS 측정 (ffmpeg loudnorm -pass 1)
    ├─ True Peak 측정
    ├─ Dynamic Range 측정
    └─ 스펙트럼 분석

    │
    ▼
[2. Preprocessing]
    ├─ DC Offset 제거
    ├─ 무음 구간 정리
    └─ 포맷 정규화 (32bit float 내부 처리)

    │
    ▼
[3. EQ Stage]
    ├─ 저역 정리 (High-pass @ 30Hz)
    ├─ 중역 투명도
    └─ 고역 공기감 (Air EQ @ 12kHz+)

    │
    ▼
[4. Compression Stage]
    ├─ 멀티밴드 컴프레서
    └─ 글루 컴프레서 (버스 컴프레션)

    │
    ▼
[5. Loudness Normalization]
    ├─ FFmpeg loudnorm 2-pass
    ├─ 타깃: Integrated -14 LUFS
    └─ True Peak 한계: -1.0 dBTP

    │
    ▼
[6. Limiting Stage]
    ├─ True Peak Limiter
    └─ 클리핑 방지

    │
    ▼
[7. Post-Analysis / QC]
    ├─ 출력 LUFS 재측정
    ├─ True Peak 재측정
    └─ QC 합격/불합격 판정

    │
    ▼
[Output WAV/FLAC/MP3]
```

---

## UI 화면 목록

| 화면 | 설명 |
|------|------|
| HomePage | 드롭존 + 최근 파일 목록 |
| MasteringPage | 프리셋 선택 + 처리 진행 상태 |
| ResultPage | 전/후 비교 + 다운로드 |
| QCPage | QC 리포트 + 플랫폼 체크리스트 |
| SettingsPage | 앱 설정 + 출력 폴더 |
| LicenseModal | 라이센스 키 입력/상태 |
