# 01 — 현재 구조 분석 (v3.6.0-rc.1)

## 1. 저장소 레이아웃

```
AImastering/                            ← 리포 루트 (legacy 파일 + 새 워크스페이스 혼재)
├── src/, python/                       ← legacy v3.1 이하 (freeze, python/LEGACY.md)
├── docs/                               ← 통합 설계 문서 (15개)
├── scripts/                            ← build-mac.sh / build-win.bat / setup-python.sh
└── aimaster-desktop/                   ← ★ 활성 모노레포 (Turborepo + pnpm)
    ├── apps/desktop/                   ← Electron + React + Vite (UI)
    ├── packages/
    │   ├── audio-engine/               ← TS → Python JSON-RPC 브리지 + FFmpeg 러너 (10 파일)
    │   ├── license-core/               ← Free/Pro 라이선스, electron-store + HMAC
    │   └── shared-types/               ← UI/엔진/Python 공유 타입 (800줄)
    ├── services/
    │   └── python-audio/               ← ★ 실제 DSP (35 .py, ~4,800줄)
    ├── scripts/                        ← FFmpeg 프리빌드 / 스모크 테스트
    └── docs/                           ← v3.x 릴리즈/QA 문서 (18 파일)
```

**문제점**:
- 리포 루트와 `aimaster-desktop/` 의 책임 경계가 모호. legacy 와 active 가 같은 트리에 공존.
- 향후 Loui Mastering v2 에서는 `aimaster-desktop/` 을 리포 루트로 승격하거나, `apps/` `packages/` `core/` 평면 구조로 재정렬 필요.

---

## 2. 활성 코드 통계

| 영역 | 파일 수 | 라인 수 (대략) | 언어 |
|---|---|---|---|
| `apps/desktop/src/main/` (Electron main) | 8 | ~700 | TS |
| `apps/desktop/src/preload/` | 1 | ~110 | TS |
| `apps/desktop/src/renderer/` UI | ~40 | ~6,500 | TSX + TS |
| `apps/desktop/src/renderer/audio/` ★ TS DSP | 17 | **3,641** | TS + 1 worklet JS |
| `packages/audio-engine/src/` | 10 | ~600 | TS |
| `packages/license-core/src/` | 1+ | ~400 | TS |
| `packages/shared-types/src/` | 1 | **~800** | TS |
| `services/python-audio/app/` | 35 | **~4,800** | Python |
| 테스트 (TS + Python) | ~12 | — | TS + Python |

**총 ~17,000 라인 활성 코드.**

---

## 3. 오디오 엔진 구조

### 3.1 데이터 흐름

```
Electron Main (Node.js)
    │
    │  IPC invoke('audio:analyze' | 'audio:master' | 'audio:qc')
    ▼
src/main/ipc/audioHandlers.ts
    │
    │  packages/audio-engine API 호출
    ▼
packages/audio-engine/src/
  ├── analyzers/index.ts   →  bridge.call('analyze',  {file_path})
  ├── mastering/index.ts   →  bridge.call('master',   params)
  └── qc/index.ts          →  bridge.call('qc_check', params)
    │
    │  utils/pythonBridge.ts (JSON-RPC over stdio)
    ▼
Python 서브프로세스 (services/python-audio/app/main.py)
    │
    │  HANDLERS dict 디스패치
    ▼
analyze | master | qc_check | env_info | ...
    │
    │  ★ 핵심: 각 작업 내부에서 FFmpeg 서브프로세스를 7~9회 spawn
    ▼
FFmpeg / FFprobe → 임시 .wav 생성 → 다음 단계 → ...
    │
    ▼
결과 JSON (paths + 메트릭) 을 stdout 으로 반환
```

### 3.2 두 개의 DSP 시스템 — **중요**

| | Python 엔진 (오프라인) | TypeScript DSP (런타임) |
|---|---|---|
| 위치 | `services/python-audio/app/mastering/` | `apps/desktop/src/renderer/audio/` |
| 라인 수 | ~3,200 | **3,641** |
| 용도 | 최종 마스터 렌더 (WAV/MP3 출력) | 5초 미리듣기 슬라이스, AB 비교, 실시간 LUFS 미터 |
| 처리 단위 | 파일 전체, 디스크 I/O | AudioBuffer 메모리, Web Audio API |
| 모듈 | pipeline / eq / dynamics / dynamic_eq / multiband / iterative / safe_modes / effects / tonal_budget | gainStaging / transientProtection / vocalEnhancer / limiterChain / peakLimiter / softClip / kWeighting / biquad / truePeak |
| LUFS 분석 | FFmpeg `loudnorm` filter | loudnessCore.ts + AudioWorklet |
| **둘이 같은 결과를 내는지?** | **검증된 적 없음** (테스트 부재) | — |

이 이중성은 v3 의 가장 큰 구조적 부채다. 사용자가 미리듣기에서 들은 소리와 최종 렌더가 다를 수 있다.

### 3.3 IPC 채널 (preload 화이트리스트)

`apps/desktop/src/preload/index.ts`:

**invoke (요청):**
- `audio:analyze`, `audio:master`, `audio:qc`
- `file:select-input`, `file:select-output-dir`, `file:open-folder`
- `settings:get`, `settings:set`
- `system:ffmpeg-status`, `system:env-info`
- `support:export-debug-bundle`
- `updater:check`, `updater:download`, `updater:install`

**listen (이벤트):**
- `audio:progress` (jobId, percent, stage)
- `updater:status`

라이선스 채널은 v3.6 RC 에서 제거됨 (게이트 비활성화).

---

## 4. DSP 처리 흐름 (Python pipeline.py 기준)

`services/python-audio/app/mastering/pipeline.py` (1,762줄) 의 실제 단계:

```
┌─ Stage 0: 입력 검증 (ffprobe)
│   - 코덱 / 샘플레이트 / 채널 / 길이 확인
│
├─ Stage 1: Pre-Analysis
│   - FFmpeg loudnorm pass1 → LUFS / TP / LRA 측정
│   - soundfile 로드 → DC offset / RMS / clipping / silence
│   - FFT 기반 AI 아티팩트 탐지 (3~5kHz, 60~200Hz 에너지비)
│
├─ Stage 2: Preprocessing Warnings
│   - mono / 비표준 SR / DC offset / 사전 clipping 경고만 생성 (수정 안 함)
│
├─ Stage 3: Adaptive EQ
│   - 모드별 EQ 커브 (balanced/warm/bright/punch/loud/kpop_loud)
│   - Low-shelf 60Hz, Mid-shelf, Air 12kHz
│   - 동적 EQ (adynamicequalizer) 옵션
│   - FFmpeg filter chain 으로 적용 → 임시 .wav
│
├─ Stage 4: Bus Compression (Glue Comp)
│   - 모드별 threshold/ratio/attack/release (dynamics.py)
│   - vocal_protection.py 가 ratio<=2.0, attack>=25ms 로 클램프
│   - FFmpeg filter chain → 임시 .wav
│
├─ Stage 5: Loudness Normalization
│   - 모드별 분기:
│     · linear 모드: loudnorm 2-pass (FFmpeg) — 정확하지만 느림
│     · loud / kpop_loud: static volume + alimiter — 빠르지만 측정 정확도 ↓
│   - 타겟: -14 LUFS / -1.0 dBTP (기본) / 모드별 오버라이드
│
├─ Stage 6: Brickwall True-Peak Limiter
│   - ceiling -1.0 dBTP, input_gain 은 limiter_strength 에 따라
│   - FFmpeg alimiter
│
├─ Stage 7: ISP Safety Pass
│   - utils/isp_safety.py — Inter-Sample Peak 재검사 후 추가 감쇠
│
├─ Stage 8: Optional Iterative Reference Match
│   - reference_matching.py → 5-band 비교 → 차이>임계치면 Stage 3 보정 재실행
│   - 최대 3 iteration / 90% 일치 시 종료
│
├─ Stage 9: Auto QC
│   - quality_check.py (TP / 단기 변동 / amp drop / clipping / over-comp)
│   - limiter_check.py (excessive reduction)
│   - gain_staging.py (per-stage dB)
│
└─ Stage 10: Preview MP3 + 결과 JSON
    - FFmpeg → 320 kbps MP3
    - paths + metrics + reports → JSON 반환
```

**FFmpeg 호출 횟수 (한 곡):**
- loudnorm pass1, EQ chain, comp chain, loudnorm pass2 (linear 모드), limiter, ISP, preview MP3, before/after waveform PNG 2회
- **총 7~9 spawn / 곡**

---

## 5. CPU 사용량 분석

### 5.1 측정 데이터 (코드 분석 기반 추정)

3분 / 44.1kHz / 24bit 스테레오 WAV 입력 기준:

| Stage | 시간 | 병목 |
|---|---|---|
| ffprobe | ~50ms | spawn overhead |
| loudnorm pass1 | **~2-4s** | FFmpeg 전체 스캔 |
| Pre-Analysis (soundfile + FFT) | ~0.5-1s | numpy FFT, 풀버퍼 메모리 로드 |
| EQ filter chain | ~1-2s | FFmpeg DSP |
| Comp filter chain | ~1-2s | FFmpeg DSP |
| loudnorm pass2 (linear) | **~2-4s** | FFmpeg 전체 스캔 (2회차) |
| alimiter | ~1s | FFmpeg DSP |
| ISP safety | ~0.5s | numpy scan |
| Iterative match (옵션, 1 iter) | +**5-8s** | Stage 3~7 재실행 |
| Preview MP3 | ~1s | libmp3lame |
| Waveform PNG ×2 | ~1s | FFmpeg showwavespic |
| **합계 (기본)** | **~10-16s** | — |
| **합계 (reference match)** | **~25-40s** | — |

### 5.2 병목 분석

1. **FFmpeg spawn 오버헤드 — 가장 큰 단일 비용.**
   - 각 spawn 당 인터프리터 startup + 파일 I/O + 인코딩/디코딩.
   - 1곡 7~9회 = startup 비용만 누적 ~3-5초.
   - **해결**: 단일 DSP 그래프로 통합 (Stage 3~7 을 한 번의 처리로). v2 의 네이티브 코어로 해결.

2. **loudnorm 2-pass 가 본질적으로 2배 스캔.**
   - LUFS 측정과 동시에 정규화하는 단일 패스 알고리즘 필요 (LUFS K-weighted real-time).
   - TS DSP `loudnessCore.ts` 가 이미 가능하지만 Python 과 정확도 불일치 위험.

3. **soundfile 풀버퍼 로드.**
   - 10분 트랙: 44.1k × 60 × 10 × 2ch × 8byte (float64) = 약 423MB RAM.
   - 스트리밍 처리로 전환 필요.

4. **Iterative reference matching 이 가장 비싼 옵션.**
   - 전체 파이프라인 최대 3회 반복.
   - 사용자 미리듣기 단계에서는 불가능.

### 5.3 메모리

- Python 측: 풀버퍼 float64 × 임시 파일 다수. 10분 곡 1GB 도달 가능.
- TS DSP 측: AudioBuffer (float32) × 슬라이스 5초 → ~2MB. 효율적.

---

## 6. UI 구조 (renderer)

### 6.1 페이지 라우팅

`apps/desktop/src/renderer/pages/`:

| 페이지 | 라인 | 역할 |
|---|---|---|
| HomePage.tsx | 38.5KB | 배치 큐 허브 (드래그&드롭, 최대 20곡, 단일 스타일) |
| AnalysisPage.tsx | 12KB | 분석 결과 + 스타일 선택 |
| MasteringPage.tsx | 8.9KB | 5-stage 진행 상태 표시 |
| ResultPage.tsx | **37.6KB** | 완료 후 미리듣기 / 메터 / AB / 저장 |
| QCPage.tsx | 9.8KB | QC 상세 리포트 |
| SettingsPage.tsx | 8.3KB | 출력 경로 / 설정 |

라우팅은 단순 state 머신 (`appStore.currentPage`) — 진짜 라우터 없음.

### 6.2 컴포넌트 (~30개)

핵심 그룹:
- **메터링**: `LoudnessMeterPanel` (BS.1770-4 LUFS M/S/I + TP, AudioWorklet 기반, 100ms 주기)
- **재생**: `PreviewPanel` (5초 슬라이스 핫스왑), `ABComparePanel` (샘플 정합 AB + 라우드니스 매칭)
- **분석**: `SectionAnalysisPanel` (verse/chorus 타임라인), `AIArtifactWarningPanel`, `SmartRecommendationPanel`
- **리포트**: `MasteringReportPanel`, `ExportReportPanel`
- **공통**: `TopBar`, `MasteringModeSelector`, `UpdateToast`, `LicenseModal` (사문화)

### 6.3 상태 관리 (Zustand)

- **`appStore`** — 페이지 / 알림
- **`audioStore`** — 큐 / 단일 파일 상태 / `MasteringOptions` (style, targetLufs, targetTp, sampleRate, bitDepth, limiterStrength, saturation, stereoWidth, outputGainDb, quickPreset)
- **`licenseStore`** — 사문 (게이트 OFF)

### 6.4 시각화 상태

- 실시간 **LUFS/TP 미터**: ✅ AudioWorklet 으로 구현됨
- 실시간 **FFT 스펙트럼**: ❌ 없음 (`AnalyserNode` 사용처 전혀 없음)
- **EQ 곡선 에디터**: ❌ 없음
- **GR (gain reduction) 표시**: ❌ 없음
- **파형**: 정적 PNG (Python 측 FFmpeg `showwavespic` 생성) — 줌/스크럽 불가
- **AB 비교**: ✅ 샘플-정합 + 라우드니스 매칭 구현

---

## 7. 비동작/스텁 기능 (현황)

| 항목 | 위치 | 상태 |
|---|---|---|
| 라이선스 게이트 | `src/main/index.ts:11`, `licenseHandlers.ts` | **비활성화** (`v3.6 RC field test`) |
| LicenseModal | `components/LicenseModal.tsx` | 렌더 안 됨 / dead code |
| SmartRecommendationPanel | `components/SmartRecommendationPanel.tsx` | 스텁 로직 (2.9KB) |
| AIArtifactWarningPanel | `components/AIArtifactWarningPanel.tsx` | 조건부 렌더, 콘텐츠 빈약 |
| tonal_budget.py | `app/mastering/tonal_budget.py` | 148줄, 파이프라인 호출 경로 미확인 |
| voice_clarity.py | (검색 안 잡힘 — 삭제됨 또는 미구현) | — |
| Phase-D 필드 (Section / AI artifact / Vocal intelligence / Translation / Mode suggestion) | `shared-types/index.ts` 정의 있음, `MasteringResult` 의 optional 필드 | 일부만 채워짐 (구현/소비 둘 다 부분적) |
| dither | (검색 안 잡힘) | **미구현** — 16비트 출력 시 품질 손실 위험 |
| oversampling | (검색 안 잡힘) | **미구현** — TP 정확도 한계 |
| macOS 노타라이즈 | `electron-builder.yml` | TODO v3.5 — CSC_LINK 미주입 |
| RemoteValidator | `license-core` | 인터페이스만 — 서버 미구현 |
| PyInstaller 번들링 | — | **없음** — 시스템 Python 의존 |

상세 → `02-PROBLEM-INVENTORY.md`

---

## 8. 브랜딩 현황 (Loui Mastering 리브랜드 대상)

| 위치 | 텍스트 | 비고 |
|---|---|---|
| `apps/desktop/src/renderer/main.tsx:8,45` | `[AIMASTER]`, `AIMASTER` | console / ErrorBoundary |
| `apps/desktop/src/renderer/App.tsx:52` | `AIMASTER` | NoApiUI fallback |
| `apps/desktop/src/renderer/App.tsx:231` | **`루베르`** | **현재 유일하게 사용자에 보이는 브랜드** (좌하단 워터마크) |
| `components/LicenseModal.tsx:16,36` | `AIMASTER-` prefix / regex | 라이선스 키 포맷 (재발급 필요) |
| `src/main/ipc/audioHandlers.ts:33` | `AIMASTER_FFMPEG` env var | env 키 |
| `apps/desktop/package.json`, `electron-builder.yml` | productName / appId | 패키지 메타 |
| 도큐먼트 18+15 파일 | 다수 | 일괄 치환 필요 |

브랜드 상수가 한 곳에 없음 — 하드코드. v2 에서는 `@loui/brand` 등 단일 토큰 소스 필요.

---

## 9. 빌드 / 패키징 / 배포

- **번들러**: Vite (renderer), esbuild (main+preload)
- **모노레포**: Turborepo + pnpm workspaces
- **패키저**: electron-builder 24.13.3
- **플랫폼**: macOS DMG arm64/x64, Windows NSIS x64, Linux AppImage x64
- **자동 업데이트**: electron-updater, GitHub Releases (draft → 수동 publish)
- **FFmpeg 번들**: 프리빌드 바이너리 → `public/bin/` → `extraResources`
- **Python 번들**: ❌ 없음 — 사용자 시스템 Python 의존 (`setup-python.sh` 가이드)
- **코드 사이닝**: macOS hardenedRuntime 만 enable, CSC 환경변수 미주입

---

## 10. 테스트 인프라

| 영역 | 위치 | 갯수 | 상태 |
|---|---|---|---|
| Python pytest | `services/python-audio/tests/` | ~120 (79 passed / 41 skipped) | 부분 동작 |
| TS UI 스모크 | `apps/desktop/scripts/phase-e-*.ts` | ~81 | 동작 |
| Loudness selftest | `apps/desktop/scripts/loudness-selftest.ts` | 1 calibration | 동작 |
| Release smoke | `release-smoke.ts` | 3 장르 샘플 | 수동 실행 |
| QA fixtures | `tests/qa/` (legacy) | — | 수동 |
| **E2E (Playwright/Spectron)** | — | **0** | **없음** |
| **DSP regression (참조 출력 매칭)** | — | **0** | **없음** |
| **Python ↔ TS DSP 동일성 테스트** | — | **0** | **없음 — 결정적** |

---

## 11. 최근 3개월 흐름 (git log)

- **Phase-E (v3.6 RC)**: UI intelligence layer — section / AI artifact / smart rec / export
- **Phase-D**: song-level intelligence (shared-types 만 확장됨)
- **v3.4**: Ozone 스타일 reference matching, 3-stage limiter
- **v3.3**: vocal-protection 가드, gain-staging report, safe modes
- **최근**: `b44a24f` — license gate disabled for RC field test, `daec0d2` — RC hardening

**경향**: 사용자에게 "스마트한 결정 표시" (Phase-D/E) 에 집중. 사용자가 **수동으로 조작할 모듈은 추가되지 않음**. Ozone 스타일 모듈 UI 와의 갭이 누적되어 옴.

---

## 12. 정리

**현재 코드베이스는 잘 작성된 "AI 자동 마스터링 CLI 의 GUI 래퍼" 다.**
- DSP 품질 자체는 합리적 (BS.1770-4 LUFS, ISP, vocal protection 등).
- 그러나 모든 결정이 백엔드에 숨겨져 있고, UI 는 결과 표시 위주.
- 상업용 출시 (Loui Mastering) 등급의 **모듈형 / 수동 제어 / 실시간 시각화** 와는 거리가 큼.

**구조적 부채 우선순위:**
1. 이중 DSP 시스템 통합 (Python 오프라인 ↔ TS 런타임)
2. FFmpeg 서브프로세스 의존 → 네이티브 단일 DSP 그래프
3. 블랙박스 → 모듈형 UI (이미 백엔드에 구현된 모듈 노출)
4. 정적 시각화 → 실시간 (FFT, GR, EQ 곡선, 동적 미터)
5. 라이선스/노타라이즈/번들링 등 상업 출시 사전 조건
