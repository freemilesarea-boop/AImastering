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
| 라이선스 | **이번 RC 부터 라이선스 게이트 비활성화** — 키 입력 / 검증 / 차단 / 시크릿 환경변수 모두 사용하지 않습니다.  마스터링은 항상 실행 가능. |
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

### 🔓 1. 라이선스 게이트 비활성화 (v3.6.0-rc.1+1)

이번 RC 부터 라이선스 키 / HMAC 시크릿 시스템 전체가 **앱 실행 경로에서
빠졌습니다**.  필드 테스트에서 `LICENSE_HMAC_SECRET` 누락으로 앱이 첫
실행에서 `app.exit(1)` 되어 테스터들이 막힌 문제를 해결하기 위함입니다.

제거된 것:
- 메인 프로세스 시작 시 호출되던 `assertLicenseSecretReady()` 게이트
- `app.exit(1)` + "AIMaster — startup blocked" 다이얼로그
- License IPC 핸들러 등록 (`license:status` / `license:activate` /
  `license:deactivate` / `license:can-process` / `license:decrement-trial` /
  `license:get-remaining`) — preload allowlist 에서도 함께 제거
- TopBar 의 LicenseBadge, App.tsx 의 `<LicenseModal />`, SettingsPage 의
  LicenseSection
- `release-smoke` 의 `LICENSE_HMAC_SECRET` 강제 검증 (PRODUCTION 환경에서도
  더 이상 fail 하지 않음)

영향:
- **마스터링은 라이선스 키 없이 항상 실행 가능합니다.**
- 트라이얼 카운트 / "Pro" 표시 / 키 입력 화면이 모두 사라집니다.
- DSP 알고리즘, Python 엔진, support 진단 / preview / A/B / loudness
  meter / 리포트 export 는 영향 없음.

남아있는 것 (dead code, 활성 코드 경로 미사용):
- `packages/license-core/` 패키지 자체
- `apps/desktop/src/main/ipc/licenseHandlers.ts`
- `apps/desktop/src/renderer/components/LicenseModal.tsx`
- `apps/desktop/src/renderer/stores/licenseStore.ts`

향후 라이선스 시스템을 다시 켤 때는 이 dead-code 를 다시 import 하고
preload allowlist + main 등록 + TopBar / SettingsPage 마운트 4 곳을
복구하면 됩니다.

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

# 4. 릴리스 산출물 smoke check
pnpm --filter @aimaster/desktop test:release-smoke
#   라이선스 게이트 비활성화로 LICENSE_HMAC_SECRET 환경변수는 더 이상 필요 없음.

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
5. **라이선스 / 트라이얼 카운트 없음** — 이번 RC 부터 라이선스 게이트
   비활성화 (위 §1).  모든 기능이 항상 사용 가능합니다.  유료 / 무료
   구분 / 트라이얼 카운트는 다시 켜질 때까지 표시되지 않습니다.

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
- `@aimaster/license-core` 는 패키지 자체는 워크스페이스에 남아 있지만
  메인 프로세스의 active 코드 경로에서 import 되지 않습니다.  embedder
  는 어떤 시크릿 / 환경변수 / assert 호출도 필요하지 않습니다.

---

## QA 진행 가이드

전체 체크리스트는 `aimaster-desktop/docs/QA_v3.6_RC.md` 를 참고하세요.
QA 통과 후 production tag (`v3.6.0`) 로 다시 빌드해 정식 릴리스를
승격합니다.

### 필드 테스트 (5 명 내부)

- 빌드 산출 절차: `aimaster-desktop/docs/RC_BUILD_RUNBOOK_v3.6.md`
- 테스터 가이드 (한국어): `aimaster-desktop/docs/TESTER_GUIDE_v3.6_RC.md`
- 테스터 트래킹 시트: `aimaster-desktop/docs/FIELD_TEST_LOG_v3.6_RC.md`
- 진단 리포트 집계: `pnpm --filter @aimaster/desktop aggregate-bundles -- <dir>`
- 테스터용 진단 export 버튼이 TopBar 우측에 노출됩니다 (지원 진단).
