# Louver Mastering AI v3.6.0-rc.1 — 내부 RC 빌드

> **Release Candidate.** 이 빌드는 내부 QA 용 입니다. 정식 배포 전에
> `docs/QA_v3.6_RC.md` 의 체크리스트를 통과해야 합니다.  
> Repo / package version: **`3.6.0-rc.1`**

---

## 한눈에 보기

v3.5.0 이후의 안정화·보안·UX 작업을 묶은 RC 입니다. 새 DSP 는 추가하지
않았으며, 결과 화면의 **사용자 경험 안정화** 와 **프로덕션 빌드 보안** 이
이 RC 의 핵심입니다.

| 영역 | 핵심 변화 |
|---|---|
| 보안 | License HMAC 시크릿 환경변수화 + 패키징된 프로덕션 빌드 시작 시 dev fallback 거부 (하드 페일) |
| 결과 페이지 | 라이브 LUFS / TP 미터를 프리뷰 플레이어에 정식 연결 |
| Phase-E UI | section / artifact / smart-rec / export 패널 4종 — 분석 필드 누락 시 안전 폴백 (테스트 보장) |
| Phase-D 인프라 | 분석 결과 노출용 타입 (sectionAnalysis / aiArtifactCheck / vocalIntelligence / translationCheck / modeSuggestion) — UI 만 준비, Python emit 은 v3.6.x 패치에서 추가 예정 |
| 빌드 | Vite worklet 자산이 plain-JS 로 emit 되도록 정리 (TS 가 그대로 emit 되던 문제 수정) |
| Windows | NSIS 단일 타깃 (legacy portable 제거 — v3.4.4 이후) |
| 테스트 | release smoke + Phase-E UI safety + Phase-E render safety + loudness selftest 모두 `pnpm test`/`test:release-smoke` 로 묶임 |

---

## 다운로드 (CI 빌드 후 자동 첨부 예정)

| Platform | Architecture | File |
|---|---|---|
| **Windows** | x64 (NSIS) | `Louver Mastering AI-Setup-3.6.0-rc.1.exe` |
| **Linux** | x64 (AppImage) | `Louver Mastering AI-3.6.0-rc.1-linux-x86_64.AppImage` |
| macOS — Apple Silicon | arm64 | `Louver Mastering AI-3.6.0-rc.1-arm64-mac.zip` ⚠️ unsigned |
| macOS — Intel | x64 | `Louver Mastering AI-3.6.0-rc.1-x64-mac.zip` ⚠️ unsigned |

> Windows portable 타깃은 v3.4.4 이후 더 이상 빌드하지 않습니다 (NSIS 만 정식).

---

## 변경 사항 상세

### 🔒 1. 보안 하드닝 (Phase-A)

- `@aimaster/license-core` 가 새 export 두 개를 추가:
  - `isLicenseSecretProductionReady()` — 활성 HMAC 시크릿이 dev fallback /
    빈 값이 아닌지 검사 (≥ 16 char).
  - `assertLicenseSecretReady()` — 위 검사가 실패하면 명시적 메시지로 throw.
- 데스크톱 main 프로세스 (`apps/desktop/src/main/index.ts`) 가
  `app.isPackaged === true` 인 경우 **앱 시작 직전** 위 assert 를 호출.
  실패 시 모달 에러 다이얼로그를 표시하고 `app.exit(1)`.  → 누군가 시크릿
  주입을 잊고 production 빌드를 만들어도 **첫 실행에서 즉시 멈춥니다**;
  dev fallback 으로 모든 머신이 같은 키로 검증되는 사고를 차단합니다.
- dev / unpackaged 빌드는 게이트를 통과하지 않으므로 로컬 개발 흐름은
  변하지 않습니다.
- `pnpm test:release-smoke` 도 `PRODUCTION=true` 환경에서 시크릿 누락 /
  dev fallback 사용을 fail 로 표시 (빌드 시점 가드).

### 🎚 2. 라이브 LUFS / TP 미터 정식 연결

- 결과 페이지 PreviewPlayer 가 `<audio>` 엘리먼트가 metadata 를 로드한
  뒤 `LoudnessMeterPanel` 을 mount.  재생 중에만 (`active === isPlaying`)
  AudioWorklet 이 동작합니다.
- BS.1770-4 K-weighting + 4× 폴리페이즈 true-peak 가 Worklet 안에서
  실행되며, Momentary / Short-term / Integrated LUFS + dBTP 가 100 ms
  주기로 갱신됩니다.
- 모드별 target LUFS 가 있으면 Integrated 막대가 ±0.5 / ±1.0 LU 허용
  범위에 따라 색이 변합니다.
- **Vite worklet emit 이슈 수정** — 이전에는 `loudnessProcessor.worklet.ts`
  를 raw TS 로 emit 해서 브라우저가 모듈 로드에 실패할 수 있었습니다.
  worklet 소스를 plain JS (`*.worklet.js`) 로 변환하고 release-smoke 가
  `.ts` 가 다시 들어오는지 자동 차단합니다.

### 🎛 3. v3.5 결과 페이지 안정화

- v3.5 단계에서 정의된 `MasteringMeta` / `MetricComparisonRow` /
  `QualityCheckReport` / `DynamicEqReport` 가 결과 페이지에서 모두 렌더
  되며, 누락 필드도 안전하게 무시합니다.
- mastering 모드 7종 (Natural / Balanced / Bright / Loud / KPOP Loud /
  Warm-legacy / Punch-legacy) 의 ID·라벨이 shared-types ↔ UI 카드 ↔
  Python 엔진과 1:1 동기화되었습니다.

### 🎧 4. Mono-safe stereo enhancement

- 단일 채널 / true-mono 입력에서 stereo enhancer 가 NaN / Infinity 를
  만들지 않도록 v3.5 audit 에서 수정 (BUG-1 regression test 가 이
  케이스를 영구히 가드).

### 🧠 5. Phase-E Intelligence UX 패널 (이번 RC 의 사용자 가시 변경)

- **`SectionAnalysisPanel`** — `sectionAnalysis` 필드가 emit 되면
  vocal/instrumental 구간 타임라인 + DR(LU) + 대비 점수 + 강·중·약
  카운트 + 모드 힌트 (현재 모드와 다를 때만) 를 표시.
- **`AIArtifactWarningPanel`** — `aiArtifactCheck` 의 phase / metallic-
  high-freq / sub-rumble finding 중 `present === true` 인 항목만 노출.
  자동 보정은 절대 수행하지 않습니다.
- **`SmartRecommendationPanel`** — 위 + vocalIntelligence / translation
  Check / modeSuggestion 까지 결합, 한국어로 최대 5개 권장 사항 (danger
  → warn → info).  분석 결과가 비어 있으면 “특별히 권장 사항이 없습니다”
  안내만 출력 (false-positive green tick 안 만듦).
- **`ExportReportPanel`** — TXT + JSON 단일 스냅샷 다운로드.  스키마 태그
  `phase-e/1`, app name + version 포함.  `outputPath` / `previewPath` /
  waveform paths / `debugSummary` / `jobId` / `artifactDir` 등 파일
  경로 / 디버그 전용 필드는 의도적으로 제외 (smoke 가 매 빌드마다 검증).

### 🧪 6. Phase-D 분석 emit — **상태: UI 인프라만, analyzer 미작동**

위 4개 Phase-E 패널은 Phase-D analyzer 의 출력을 받기 위해 만들어졌지만
**v3.6.0-rc.1 의 Python 파이프라인은 아직 다음 5개 필드를 emit 하지
않습니다**:

- `sectionAnalysis` (verse/chorus 구조 분석)
- `aiArtifactCheck` (phase / metallic / sub-rumble)
- `vocalIntelligence` (mood / clarity / sibilance)
- `translationCheck` (phone / laptop / club 예측 점수)
- `modeSuggestion`

따라서 RC 빌드에서는:
- 위 패널들이 **렌더되지 않거나** SmartRecommendation 의 “권장 사항 없음”
  카피가 보이는 것이 **정상 동작**입니다.
- 데이터를 안전하게 처리하기 위한 타입 정의 + null-safe 렌더 + 14 + 15 =
  29 개의 안전성 테스트는 모두 통과합니다.
- Python emit 은 v3.6.x 패치에서 추가될 예정이며, 그 때는 별도 UI 변경
  없이 자동으로 패널들이 활성화됩니다.

기존 시스템에서 이미 emit 되는 다음 필드는 v3.5 / v3.6 모두에서 정상
동작합니다 (Phase-D 와 별개):
- `aiDetection` (legacy harshHighmid / boomyLow / brickwall — Python
  analyzer 가 emit, QC 페이지가 사용)
- `segmentAnalysis` / `suspectSegments` (per-window RMS 분석)
- `vocalProtection` (engine guard 리포트, mood/clarity 가 아님)
- `referenceMatch` / `referenceProfile` (Ozone-style reference matching)

### 📤 7. Exportable Mastering Report

- 한 번의 클릭으로 TXT 또는 JSON 다운로드.
- 포함: app name + version / before-after loudness / true peak / LRA /
  selected mode / applied corrections / Phase-D 필드 (있을 때만) /
  pipelineWarnings.
- 누락 필드는 단순히 섹션을 생략 — TXT 가 거짓 정보를 표시하지 않습니다.

---

## 빌드 / 테스트 명령

```bash
# 의존성 설치
cd aimaster-desktop && pnpm install

# 1. 타입 체크 (4 packages)
pnpm typecheck

# 2. 데스크톱 빌드 (renderer + main + preload)
pnpm --filter @aimaster/desktop build

# 3. UI / 분석 안전성 테스트 (60 cases)
pnpm --filter @aimaster/desktop test
#   → test:phase-e-ui (14)  + test:phase-e-render (15) + test:loudness (30+)

# 4. 릴리스 산출물 smoke check (production gate 검증 포함)
pnpm --filter @aimaster/desktop test:release-smoke
#   PRODUCTION=true 환경에서 LICENSE_HMAC_SECRET 미설정 시 exit 1

# 5. Python audio 엔진 테스트
cd services/python-audio && pytest -q
```

CI 는 `tag push refs/tags/v*` 일 때만 `AUTO_UPDATE_ENABLED=true` 로
빌드되어 자동 업데이트 채널에 들어갑니다. RC 태그를 만들 때는
`v3.6.0-rc.1` 처럼 prerelease 식별자가 포함된 태그를 사용하세요.

---

## ⚠️ 알려진 한계 (Known Limitations)

1. **macOS 코드 서명 / Notarization 미적용** — v3.5 와 동일.  Gatekeeper
   첫 실행 차단, electron-updater self-replace 작동 안 함.  v3.6.x
   패치에서 인증서 도입 예정.
2. **Phase-D analyzer Python emit 미구현** — 위 §6 참조.  UI 패널은
   필드 부재 시 무해하게 폴백.
3. **Reference matching UI 진입점 부재** — RPC method 는 v3.4 부터
   존재하지만 결과 페이지 외 진입 버튼이 없습니다 (v3.6.x 예정).
4. **임시 파일 잔존 가능성** — 강제 종료 시 `aimaster_*.wav` 가
   OS temp dir 에 남을 수 있음 (v3.5 와 동일).
5. **`LICENSE_HMAC_SECRET` 환경변수 필수** — production 빌드 (`app.is
   Packaged === true`) 시 시작 시점에 dev fallback 을 거부합니다.
   배포 인프라가 강한 시크릿을 주입해야 정식 빌드가 시작됩니다.

---

## 마이그레이션 메모 (3.5.x → 3.6.0-rc.1)

- `@aimaster/shared-types` 가 `0.1.0` → `0.2.0` 으로 올랐습니다 (Phase-D
  타입 추가는 모두 옵셔널이므로 호환 깨짐 없음).
- `MasteringResult` 에 다음 옵셔널 필드가 추가됨:
  `sectionAnalysis`, `aiArtifactCheck`, `vocalIntelligence`,
  `translationCheck`, `modeSuggestion`.  분석 엔진이 emit 하지 않으면
  UI 는 변하지 않습니다.
- `AIArtifactCheck` 의 `phaseAnomaly` / `metallicHighFreq` /
  `subRumble` 는 모두 옵셔널 (`AIArtifactFinding | undefined`) 로 변경.
- `@aimaster/license-core` 가 `assertLicenseSecretReady()` /
  `isLicenseSecretProductionReady()` / `DEV_FALLBACK_HMAC_SECRET` 를
  추가 export.  embedder 는 production 시작 시 assert 를 반드시
  호출해야 합니다.

---

## QA 진행 가이드

전체 체크리스트는 `aimaster-desktop/docs/QA_v3.6_RC.md` 를 참고하세요.
QA 통과 후 production tag (`v3.6.0`) 로 다시 빌드해 정식 릴리스를
승격합니다.
