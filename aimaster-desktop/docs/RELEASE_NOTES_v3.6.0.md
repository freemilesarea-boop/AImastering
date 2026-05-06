# Louver Mastering AI v3.6.0-rc.1 — 내부 RC 빌드

> **Release Candidate.** 이 빌드는 내부 QA 용 입니다. 정식 배포 전에
> `docs/QA_v3.6_RC.md` 의 체크리스트를 통과해야 합니다.  
> Repo / package version: **`3.6.0-rc.1`**

---

## 한눈에 보기

v3.5.0 이후의 안정화·보안·UX 작업을 한 번에 묶은 RC 입니다. 새 DSP 는
추가하지 않았으며, 곡 수준 분석 → UI 노출 → 사용자가 받아갈 수 있는
리포트까지의 흐름을 처음으로 끝까지 잇는 데 집중했습니다.

| 영역 | 핵심 변화 |
|---|---|
| 보안 | License HMAC 시크릿 환경변수화 / 빌드시 secret 누락 경고 (RC 빌드 한정) |
| UI 안정화 | v3.5 결과 페이지에 Phase-E 패널 4종 통합 / null-safe 렌더링 |
| 스테레오 | mono-safe stereo enhancement (1ch 입력에서도 충돌하지 않음) |
| Translation Check | 폰 / 노트북 / 클럽 환경 예측 점수 + 한국어 노트 |
| Vocal Intelligence | 보컬 존재 여부 + 명료도 + sibilance Hz 노출 |
| Section Analysis | 벌스/코러스 타임라인 + DR(LU) + 대비 점수 + 모드 힌트 |
| AI Artifact Check | 위상 / 금속성 / 서브 럼블 가능성 패턴 표시 (자동 보정 X) |
| Smart Recommendation | 모든 분석 결과를 묶어 3–5개 한국어 권장 사항 |
| Exportable Report | TXT + JSON 단일 스냅샷, 파일 경로 / 디버그 필드 누설 없음 |

---

## 다운로드 (CI 빌드 후 자동 첨부 예정)

| Platform | Architecture | File |
|---|---|---|
| **Windows** | x64 (NSIS) | `Louver Mastering AI-Setup-3.6.0-rc.1.exe` |
| **Linux** | x64 (AppImage) | `Louver Mastering AI-3.6.0-rc.1-linux-x86_64.AppImage` |
| macOS — Apple Silicon | arm64 | `Louver Mastering AI-3.6.0-rc.1-arm64-mac.zip` ⚠️ unsigned |
| macOS — Intel | x64 | `Louver Mastering AI-3.6.0-rc.1-x64-mac.zip` ⚠️ unsigned |

> Windows portable 타겟은 v3.4.4 이후 더 이상 빌드하지 않습니다 (NSIS 만 정식).

---

## 변경 사항 상세

### 🔒 1. 보안 하드닝 (Phase-A)

- `@aimaster/license-core` 의 HMAC 시크릿이 `LICENSE_HMAC_SECRET` 환경
  변수에서 읽히도록 정리되었습니다. 기본값 (`aimaster-local-secret-v1`)
  은 dev 전용이며, RC / 정식 빌드에서는 빌드 시 환경변수 설정이
  필요합니다.
- **Release smoke script (`pnpm test:release-smoke`)** 가 빌드 산출물에
  더해 `LICENSE_HMAC_SECRET` 가 정의되어 있지 않을 때 명시적으로 경고를
  띄우도록 추가되었습니다 (production-only warning).
- License record / trial record 양쪽 모두 `crypto.timingSafeEqual` 로
  HMAC 검증.

### 🎚 2. v3.5 UI wiring (안정화)

- v3.5 단계에서 정의된 `MasteringMeta` / `MetricComparisonRow` /
  `QualityCheckReport` / `DynamicEqReport` 가 결과 페이지에서 모두 렌더
  되며, 누락 필드도 안전하게 무시합니다.
- mastering 모드 7종 (Natural / Balanced / Bright / Loud / KPOP Loud /
  Warm-legacy / Punch-legacy) 의 ID·라벨이 shared-types ↔ UI 카드 ↔
  Python 엔진과 1:1 동기화되었습니다.

### 🎧 3. mono-safe stereo enhancement

- 단일 채널 / true-mono 입력에 대해서도 stereo enhancer 가 down-mix /
  energy-balance 에서 NaN 을 만들지 않도록 수정 (v3.5 audit 의 BUG-1
  regression test 가 이 케이스를 커버).

### 🛰 4. Translation Check (Phase-D 노출용 타입)

- `TranslationCheck` 타입이 `@aimaster/shared-types` 에 추가되었고,
  결과 페이지의 SmartRecommendationPanel 이 phone / laptop / club 점수가
  ≤ 0.5 일 때 한국어 경고를 표시합니다.
- 분석 결과 자체는 Python 엔진 측 emit 이 v3.6.x 패치에서 추가될
  예정입니다 (UI는 fallback-safe).

### 🗣 5. Vocal Intelligence (Phase-D 노출용 타입)

- `VocalIntelligence { vocalPresent, clarityScore, mood, sibilanceHz,
  note }` 타입을 정의.
- `clarityScore <= 0.5` 또는 `>= 0.8` 일 때 SmartRecommendationPanel 에
  보컬 보호 권장 사항 노출.

### 🎼 6. Section Analysis (Phase-D 노출용 타입 + UI)

- `SectionAnalysis { sections[], dynamicRangeLu, alternationScore,
  sectionCounts, modeSuggestion }`.
- 새 패널 `SectionAnalysisPanel` 이 verse/chorus 타임라인 (high/mid/low
  에너지별 색), DR(LU), 대비 점수, 강·중·약 카운트, 그리고 사용자가
  현재 선택한 모드와 다른 추천 모드가 있을 때만 힌트를 표시합니다.

### ⚠️ 7. AI Artifact Check

- `AIArtifactCheck { phaseAnomaly?, metallicHighFreq?, subRumble?,
  analyzerVersion? }` (각 finding 은 `AIArtifactFinding`).
- 새 패널 `AIArtifactWarningPanel` — `present === true` 인 finding 만
  렌더, 자동 보정은 절대 수행하지 않습니다.
- 한국어 카피는 모두 보수적 (`가능성`, `감지된 패턴`, `확인 필요`).

### 🧠 8. Smart Recommendation UI

- 새 패널 `SmartRecommendationPanel` + 순수 헬퍼 `smartRecommendations.ts`.
- sectionAnalysis / modeSuggestion / aiArtifactCheck / vocalIntelligence
  / translationCheck 5종을 결합해 최대 5개의 권장 사항을 표시.
- 우선순위: danger → warn → info.
- 빈 입력 → "특별히 권장 사항이 없습니다" fallback (false-positive
  green-tick 은 절대 만들지 않음).

### 📤 9. Exportable Mastering Report (TXT + JSON)

- 새 패널 `ExportReportPanel` + 순수 헬퍼 `masteringReportExport.ts`.
- 스키마 태그 `phase-e/1`, app name + version 이 payload 에 포함.
- before/after loudness, true peak, LRA, selected mode, applied
  corrections, sectionAnalysis, modeSuggestion, aiArtifactCheck,
  vocalIntelligence, translationCheck, pipelineWarnings 모두 한 번에
  스냅샷.
- **누설 방지** — outputPath / previewPath / waveformPath / debugSummary
  / artifactDir / jobId 등 파일 시스템 경로와 디버그 전용 필드는
  payload 에서 의도적으로 제외 (smoke test 가 매 빌드마다 검증).

---

## 빌드 / 테스트 명령

```bash
# 의존성 설치
cd aimaster-desktop && pnpm install

# 1. 타입 체크 (4 packages)
pnpm typecheck

# 2. 데스크톱 빌드 (renderer + main)
pnpm --filter @aimaster/desktop build

# 3. UI / 분석 안전성 테스트 (60 cases)
pnpm --filter @aimaster/desktop test
#   → test:phase-e-ui (14)  + test:phase-e-render (15) + test:loudness (30+)

# 4. 릴리스 산출물 smoke check (이번 RC 신규 추가)
pnpm --filter @aimaster/desktop test:release-smoke

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
2. **LoudnessMeterPanel (live meter) 페이지 미연결** — 컴포넌트와
   AudioWorklet 코드는 빌드되지만 어떤 페이지에서도 import 하지 않아
   사용자 시나리오에서 노출되지 않습니다.  QA 체크리스트의 "live
   loudness meter" 항목은 이번 RC 에서 N/A.
3. **Phase-D Python 엔진 emit 아직 부분 구현** — sectionAnalysis /
   aiArtifactCheck / vocalIntelligence / translationCheck /
   modeSuggestion 5종은 UI 가 받을 준비는 끝났지만, Python 측 emit 은
   v3.6.x 패치에서 마무리됩니다.  필드가 비어 있어도 패널은 모두
   안전하게 비워서 렌더 (Phase-E safety test 가 보장).
4. **Reference matching UI 진입점 부재** — RPC method 는 v3.4 부터
   존재하지만 결과 페이지 외 진입 버튼이 없습니다 (v3.6.x 예정).
5. **임시 파일 잔존 가능성** — 강제 종료 시 `aimaster_*.wav` 가
   OS temp dir 에 남을 수 있음 (v3.5 와 동일).
6. **`LICENSE_HMAC_SECRET` 환경변수 미설정 시** — license-core 가
   `aimaster-local-secret-v1` 기본값으로 폴백.  RC 외 정식 빌드에는
   배포 인프라에서 강한 시크릿 주입이 필요합니다.

---

## 마이그레이션 메모 (3.5.x → 3.6.0-rc.1)

- `@aimaster/shared-types` 가 `0.1.0` → `0.2.0` 으로 올랐습니다 (Phase-D
  타입 추가는 모두 옵셔널이므로 호환 깨짐 없음).
- `MasteringResult` 에 다음 옵셔널 필드가 추가됨:
  `sectionAnalysis`, `aiArtifactCheck`, `vocalIntelligence`,
  `translationCheck`, `modeSuggestion`.  분석 엔진 출력 일부가
  null/undefined 여도 UI 는 변하지 않습니다.
- `AIArtifactCheck` 의 `phaseAnomaly` / `metallicHighFreq` /
  `subRumble` 는 모두 옵셔널 (`AIArtifactFinding | undefined`) 로 변경
  되었습니다 — 기존에 항상 emit 했던 코드는 그대로 작동합니다.

---

## QA 진행 가이드

전체 체크리스트는 `aimaster-desktop/docs/QA_v3.6_RC.md` 를 참고하세요.
QA 통과 후 production tag (`v3.6.0`) 로 다시 빌드해 정식 릴리스를
승격합니다.

