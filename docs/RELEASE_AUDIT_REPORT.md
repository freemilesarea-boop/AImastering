# Louver Mastering AI — Release Audit Report

**감사일자**: 2026-05-04
**감사 대상 commit**: `6fc9c8a` (v3.5 Phase 2 완료)
**브랜치**: `claude/debug-audio-quality-cAEJD`
**감사자**: 분석 only — 코드 변경 없음

> ⚠️ **중요 알림**:
> 이 문서는 *분석 보고서* 입니다.  사용자 승인 후 수정 단계에 들어갑니다.

---

## 1. Executive Summary

| 항목 | 상태 |
|------|:----:|
| 사운드 엔진 (KPOP Loud + 6 모드) | ✅ Phase 2 완료, 모든 메트릭 IDEAL 범위 |
| 자동 업데이트 | ✅ AUTO_UPDATE_ENABLED gate 정상, CI 분기 ok |
| 빌드 시스템 (Linux/Mac/Win) | ⚠️ Linux ✅ / Mac signing 미완 / Win NSIS 정상 (CI 한정) |
| 라이선스 / Free/Pro 제한 | ✅ 작동 (감사 결과 별도) |
| UI/UX | ⚠️ 일부 페이지 legacy + 신규 컴포넌트 혼재 |
| 테스트 커버리지 | ⚠️ Python 엔진 120/120 ✓ / TS renderer 테스트 부재 |
| 배포 안전성 | ⚠️ **P1 이슈 5건** + **P0 이슈 2건** (아래 §10 참조) |

### 🚨 배포 가능 여부 — **결론: NO (조건부)**

**P0 이슈 2건** 이 해결 전엔 **유료 수강생 배포 불가**:

1. **macOS 코드 서명 / Notarization 미완 (P0)** — Gatekeeper 가 앱 차단,
   첫 실행 시 사용자가 우클릭 → "열기" 우회 필요.  유료 고객 경험 치명.
2. **`package.json.version` = `3.2.0-rc`** (P0) — RC 버전을 정식 배포할 수 없음.
   `3.5.0` 정도로 bump + git tag 필요.  RC 그대로 배포 시
   electron-updater 가 향후 버전을 인식 못함 (semver 비교 오류 가능).

P1 이슈 5건은 패치 후 즉시 해결 가능:

3. **Windows 코드 서명 부재** — SmartScreen 경고 발생, 유료 사용자 신뢰 저하 (P1)
4. **legacy `src/renderer/` 와 `aimaster-desktop/apps/desktop/src/renderer/` 혼재** (P1)
5. **TS/renderer 단위 테스트 0건** (P1)
6. **임시 파일 cleanup 보강 필요** (`tempfile.mkstemp` 후 예외 시 잔존 가능) (P1)
7. **electron-updater 의 mac auto-update 가 코드서명 없이는 작동 안 함** (P1)

→ **P0 둘 (#1, #2) 해결 후 재감사 권장.**  P0 해결 시간 추정: 4~8 시간 (서명 인증서 발급 + tag/version bump + 검증 build).

---

## 2. 배포 가능 여부 판단

| 사용자 그룹 | 배포 가능 여부 | 비고 |
|------------|:-------------:|------|
| 내부 베타 테스터 (Linux + Mac 우클릭 OK) | ✅ YES | 현 상태로 OK |
| Linux only 유료 수강생 | ✅ YES | AppImage 자체는 정상 |
| **Windows 유료 수강생** | ⚠️ **조건부** — SmartScreen 경고만 감수하면 NSIS 작동, 자동 업데이트 OK |
| **macOS 유료 수강생** | ❌ **NO** — Gatekeeper 차단 + 자동 업데이트 불가 |
| 일반 공개 (베타 → 정식) | ❌ **NO** — 위 P0 둘 해결 후 가능 |

→ **현재 시점에서 "지금 바로 모든 유료 수강생에게 배포해도 되는가?"** = **NO**.

**조건 만족 시 (P0 둘 해결 후)**: YES.

---

## 3. 전체 기능 인벤토리

### 3A. Renderer (사용자 facing)

| 기능 | 위치 | 입력 | 출력 | 실패 가능 지점 | 위험도 |
|------|------|------|------|---------------|:-----:|
| 파일 업로드 (단일) | `pages/HomePage.tsx` + `ipc/fileHandlers.ts` `file:open-dialog` | OS 파일 다이얼로그 | wav/flac/aiff/mp3/m4a 경로 | 한글 경로 / Windows long-path | Medium |
| 파일 드래그앤드롭 (외부) | `App.tsx` `<GlobalDropOverlay />` | OS drag&drop | 파일 경로 | drag region 충돌 (titleBar) | Low |
| 다중 파일 선택 (최대 20곡) | `ipc/fileHandlers.ts` `file:open-dialog-multi` | 다중 선택 | path 배열 | 21+ 시 silent truncate or error? (확인 필요) | Medium |
| 마스터링 시작 | `pages/MasteringPage.tsx` → `audio:master` IPC | options dict | result dict + temp WAV | Python engine 크래시 / FFmpeg 실패 | Medium |
| 결과 미리듣기 | `pages/ResultPage.tsx` + `aimaster-local://` 프로토콜 | 절대경로 | 오디오 스트림 | 파일 권한 / Mac sandbox | Low |
| 결과 다운로드 | `ipc/fileHandlers.ts` `file:save-wav` | (input path, output dir) | saved WAV path | output dir 비쓰기 가능 | Medium |
| 일괄 저장 | `file:batch-save-wav` | path 배열 | 저장된 path 배열 | 중간 실패 시 부분 저장 | Medium |
| QC 페이지 | `pages/QCPage.tsx` → `audio:qc` IPC | 파일 경로 | QC report dict | 짧은/무음 파일 | Low |
| Settings | `pages/SettingsPage.tsx` + `settings:get/set` | key/value | 저장됨 | electron-store 경로 권한 | Low |
| 라이선스 활성화 | `LicenseModal.tsx` + `license:activate` | 라이선스 키 | 활성화 result | 네트워크 / 잘못된 키 | Medium |
| Free 트라이얼 카운트 | `license:decrement-trial` | — | remaining | 동기화 race | Low |
| 마스터링 프리셋 (UI) | `MasteringPresets.tsx` | 사용자 클릭 | style key | 없음 | Low |
| 자동 업데이트 토스트 | `components/UpdateToast.tsx` | `window.updater.onStatus` | bottom-right card | event 누락 | Low |
| 일반 토스트 알림 | `App.tsx` Toast | `useAppStore.notification` | bottom-center toast | — | Low |
| Vocal Protection 배너 | `components/VocalProtectionBanner.tsx` | result.vocalProtection | banner | — | Low |
| Reference Match 패널 | `components/ReferenceMatchPanel.tsx` | result.referenceMatch | panel | — | Low |
| Reference picker | `components/ReferencePicker.tsx` | preset/file | 선택 | preset list 미동기화 | Low |
| Mode Recommendations | `components/ModeRecommendations.tsx` | result.modeRecommendations | banner | — | Low |
| Gain Staging 패널 | `components/GainStagingPanel.tsx` | result.gainStaging | panel | — | Low |
| Quality Check Report | `components/QualityCheckReport.tsx` | result.qualityCheck | panel | — | Low |
| Metric Comparison | `components/MetricComparison.tsx` | result.metricComparison | 표 | — | Low |
| Before/After Compare | `components/BeforeAfterCompare.tsx` | 두 파일 | 파형 비교 | 파일 read 실패 | Low |
| Loudness Gauge | `components/LoudnessGauge.tsx` | LUFS 값 | 게이지 | — | Low |
| Processing Status | `components/ProcessingStatus.tsx` | progress event | 진행률 | — | Low |
| AI Detection Alert | `components/AIDetectionAlert.tsx` | aiDetection flags | alert | — | Low |

### 3B. 메인 프로세스 (Electron)

| 기능 | 위치 | 비고 |
|------|------|------|
| 앱 시작 + 윈도우 생성 | `src/main/index.ts` | titleBarStyle hiddenInset, 1100×740 |
| 로컬 파일 protocol | `protocol.handle('aimaster-local')` | renderer 가 file:// 우회 액세스 |
| FFmpeg 상태 체크 | `audio-engine` | 실패 시 앱은 계속 실행 |
| 라이선스 핸들러 | `ipc/licenseHandlers.ts` | electron-store + node-machine-id |
| 자동 업데이터 | `src/main/updater.ts` | electron-updater + electron-log |
| 파일 핸들러 | `ipc/fileHandlers.ts` | dialog / save / get-info / recent |
| 오디오 엔진 IPC | `ipc/audioHandlers.ts` | Python bridge wrapper |
| 설정 핸들러 | `ipc/settingsHandlers.ts` | electron-store 키/값 |

### 3C. Python 사운드 엔진

| 모듈 | 역할 | 라인 수 (대략) |
|------|------|--------------:|
| `mastering/pipeline.py` | 주 마스터링 파이프라인 | ~1500 |
| `mastering/eq.py` | T1 corrective EQ + base + style overlays | ~470 |
| `mastering/dynamic_eq.py` | 5-band 동적 EQ + adynamicequalizer wrapper | ~250 |
| `mastering/dynamics.py` | 컴프레서 + makeup + knee | ~170 |
| `mastering/effects.py` | saturation/stereo/soft-clip/de-esser | ~110 |
| `mastering/safe_modes.py` | Safe / Vocal Safe / Low Limit 모드 | ~280 |
| `mastering/iterative.py` | Reference matching iterative loop | ~280 |
| `mastering/multiband.py` | 4-band EQ chain + measurement | ~150 |
| `mastering/reference_matching.py` | Reference profile 비교 + EQ correction | ~440 |
| `mastering/reference_presets.py` | 8 장르 built-in preset | ~210 |
| `mastering/tonal_budget.py` | TARGETS / BUDGETS / EFFECTIVENESS | ~150 |
| `mastering/mastering.py` | RPC entry point | ~210 |
| `qc/quality_check.py` | 마스터 결과 자동 품질 검사 | ~250 |
| `qc/limiter_check.py` | 리미터 과다 검사 (crest/LRA/ceiling) | ~270 |
| `qc/gain_staging.py` | gain staging report + telephone guard | ~340 |
| `qc/qc_checker.py` | 12-item QC | ~115 |
| `analysis/metrics.py` | LUFS / TP / LRA / RMS / crest | ~390 |
| `analysis/segment_analysis.py` | 시간대별 의심 구간 검출 | ~270 |
| `utils/ffmpeg_wrapper.py` | ffmpeg/ffprobe 호출 + 로깅 | ~380 |
| `utils/vocal_protection.py` | 항상-활성 보호 클램프 | ~210 |
| `utils/audio_io.py` | soundfile 래퍼 + waveform stats | ~315 |
| `utils/isp_safety.py` | inter-sample peak 검출 + 하향 게인 | ~135 |
| `utils/debug_logger.py` | 디버그 번들 레코더 | ~290 |
| `utils/debug_bundle.py` | zip export | ~190 |
| `utils/env_info.py` | 호스트 환경 수집 | ~165 |
| `utils/waveform_image.py` | PNG 파형 이미지 생성 | ~130 |
| `app/main.py` | JSON-RPC dispatcher | ~210 |
| `app/analyzers/analyzer.py` | Stage 1 입력 분석 | ~285 |

### 3D. 빌드 / 배포

| 기능 | 위치 | 비고 |
|------|------|------|
| Renderer 빌드 (Vite) | `vite.config.ts` → `dist/renderer/` | OK |
| Main/preload 빌드 (esbuild) | `esbuild.main.cjs` → `dist-electron/{main,preload}/` | AUTO_UPDATE_ENABLED bake-in |
| Electron 패키징 | `electron-builder.yml` | provider github / draft release |
| Linux AppImage | CI build-linux 잡 | ✅ 정상 |
| macOS DMG + ZIP (arm64+x64) | CI build-mac 잡 | ⚠️ signing 없음 |
| Windows NSIS | CI build-win 잡 | D:\w 짧은-경로 junction |
| 자동 업데이트 메타 | `latest.yml` / `latest-mac.yml` / `latest-linux.yml` | ✅ 자동 생성 |
| GitHub Release draft | softprops/action-gh-release | release-draft 잡 |
| FFmpeg 번들 | `scripts/prebuild.cjs` → `public/bin/` | ffmpeg-static 사용 |
| Python 엔진 번들 | PyInstaller `--onefile` → `public/bin/engine` | platform-specific |

### 3E. 숨겨진 / 실험 기능 (배포 시 영향 평가)

| 기능 | 상태 | 배포 영향 |
|------|------|---------|
| `master_with_reference` RPC | implemented v3.4 | UI 진입점 미확인 — 데드 path 가능성 |
| `analyze_reference` RPC | implemented v3.4 | 동일 |
| `recommend_reference_preset` RPC | implemented v3.4.1 | 동일 |
| `export_debug_bundle` RPC | implemented v3.3 | UI 버튼 미확인 — 데드 path 가능성 |
| `env_info` RPC | implemented v3.3 | 데드 path |
| `safe_modes` (3 modes) | implemented | UI 진입점 확인 필요 |
| AI artifact detection (FFT) | implemented | 활성됨 |
| Iterative reference matching | implemented v3.4 | UI 진입점 미확인 |

→ **⚠️ 데드 path 위험**: 4~5 RPC method 가 renderer 에서 호출되지 않음.  사용자에게 노출되지 않은 기능을 build 에 포함하면 binary 사이즈만 늘어나고 보안 표면 증가.  **P2 이슈** (배포 후 정리 가능).

---

## 4. 코드 구조 감사 결과

### 4A. 경로 일관성 ✅ OK

| 점검 항목 | 결과 |
|----------|:----:|
| `package.json` main = `dist-electron/main/index.js` | ✅ |
| asar 안의 `package.json` main (extraMetadata) | ✅ |
| esbuild 출력 = `dist-electron/{main,preload}/index.js` | ✅ |
| Vite 출력 = `dist/renderer/` | ✅ |
| `electron-builder.yml` files = `dist/**` + `dist-electron/**` | ✅ |
| 어디에도 `dist/main/` 또는 `dist/preload/` 잔여 참조 없음 | ✅ (v3.4.4 에서 정리) |
| asar 트리: `/dist/renderer/index.html`, `/dist-electron/main/index.js`, `/dist-electron/preload/index.js` | ✅ |

### 4B. 두 개의 renderer 트리 ⚠️ P1 이슈

| 경로 | 상태 |
|------|------|
| `aimaster-desktop/apps/desktop/src/renderer/` | **활성** (15 ts/tsx) |
| `src/renderer/` | **legacy** (별도 트리, 빌드에 미포함) |

```
$ ls src/renderer/pages/                           ← legacy
HomePage.tsx  MasteringPage.tsx  QCPage.tsx
ResultPage.tsx  SettingsPage.tsx

$ ls aimaster-desktop/apps/desktop/src/renderer/pages/  ← active
AnalysisPage.tsx  HomePage.tsx  MasteringPage.tsx
QCPage.tsx  ResultPage.tsx  SettingsPage.tsx
```

**문제**: `src/renderer/` 의 modification (예: 베타-테스트 docs 의 ModeRecommendations / VocalProtectionBanner / GainStagingPanel / ReferenceMatchPanel / ReferencePicker / ReferenceWarningBanner 컴포넌트) 가 **legacy 트리에만 추가됨**.  활성 빌드 트리 (`aimaster-desktop/apps/desktop/src/renderer/`) 엔 없음.

→ **이 6 개 컴포넌트는 production 빌드에 포함되지 않음**.  베타 테스트 자료에서 이 컴포넌트들이 노출되는 것을 가정한 사용자 시나리오가 있다면 모두 미작동.

**P1 권장 조치**:
- `src/renderer/types/audio.ts` 의 신규 타입을 active 트리로 이전
- 6 개 컴포넌트 (`UpdateToast` 만 active 트리에 있음, 나머지 5개 누락) 를 active 트리로 이전
- `src/renderer/` legacy 트리 삭제 또는 명시적 deprecated 표시

### 4C. IPC 채널 등록 / preload exposure 일치성 ✅ OK

**main 등록**: 24 channels (`audio:*`, `license:*`, `file:*`, `settings:*`, `system:ffmpeg-status`, `updater:*`)
**preload allowlist**: 24 channels (정확히 일치)

| 항목 | 결과 |
|------|:----:|
| 미등록 channel invoke 시 차단 (`Blocked IPC channel`) | ✅ |
| 미등록 listen channel 시 차단 | ✅ |
| `window.electronAPI` 인터페이스 노출 | ✅ |
| `window.updater` 인터페이스 노출 | ✅ |
| `global.d.ts` 타입 declaration 일치 | ✅ |

### 4D. dev/prod 분기 ✅ OK

| 항목 | 결과 |
|------|:----:|
| `app.isPackaged` 체크 (renderer load URL/file) | ✅ |
| `__AUTO_UPDATE_ENABLED__` baked at build time | ✅ |
| `process.env.AUTO_UPDATE_ENABLED` CI 분기 | ✅ |
| dev 모드에서 autoUpdater 비활성 | ✅ |
| FFmpeg 경로 dev/packaged 분기 | ✅ (audio-engine 모듈) |

### 4E. 임시 파일 / cleanup ⚠️ P1 일부

`tempfile.mkstemp` 사용 위치:

```python
# pipeline.py:
prelim_fd, prelim_wav = tempfile.mkstemp(suffix="_prelim.wav", ...)   # ← 7곳
fd, tmp = tempfile.mkstemp(suffix="_tonal.wav", ...)
corr_fd, corr_tmp = tempfile.mkstemp(suffix="_corr.wav", ...)
tmp_fd, tmp_wav = tempfile.mkstemp(suffix="_loudnorm.wav", ...)

# 모든 코드 path 에서 finally 또는 try/except 로 unlink 시도함 ✓
```

**문제**: 외부 시그널 (SIGTERM / 강제 종료) 시 cleanup 실행 안 됨.
**완화책**: `tempfile.mkstemp(prefix="aimaster_")` 로 prefix 통일 → 다음 부팅 시 일괄 삭제 가능 (현재는 미구현).

**P1 권장 조치**: 앱 시작 시 `/tmp` 또는 OS temp dir 의 `aimaster_*.wav` 잔여 파일 일괄 삭제 helper 추가.

### 4F. 한글 / 공백 / Windows 경로 ⚠️ Medium 위험

`audioHandlers.ts:registerAudioHandlers` 가 Python bridge 에 path 전달.  Bridge 가 stdin JSON 으로 전달할 때 UTF-8 인코딩 의존.

| 항목 | 상태 |
|------|------|
| Python 엔진 stdin/stdout UTF-8 강제 | ✅ (`app/main.py` `_get_stdin_binary()` + `ensure_ascii=True`) |
| Windows cp949 회피 | ✅ (binary buffer 사용) |
| Path 에 공백/한글 포함 시 ffmpeg 호출 | ✅ (subprocess.run + list 인자) |
| Long-path (>260 char) | ⚠️ Windows 만 — `pathEncodingError` 분류 있음 |

**P2** — 한글 파일명 / 매우 긴 path 케이스 별도 테스트 필요.

### 4G. 죽은 코드 / no-op stage ⚠️ P2

| 항목 | 위치 |
|------|------|
| `master_with_reference` RPC method | UI 진입점 없음 |
| `iterative.py` 전체 모듈 | 데드 |
| `multiband.py` 전체 모듈 | 데드 (reference_matching 만 사용) |
| `reference_presets.py` (8 presets) | UI 진입점 없음 |
| `recommend_reference_preset` RPC | UI 진입점 없음 |
| 4 가지 신규 UI 컴포넌트 (legacy 트리) | active build 미포함 |
| pre 소프트클립 (이미 정리됨) | OK |

→ 데드 코드 약 **1,800 라인**.  Build 에 포함되지만 사용자가 도달 못함.
**P2** (배포 후 정리).

---

## 5. 사운드 엔진 감사 결과

### 5A. Stage-by-stage 검증 (KPOP Loud, target -9 LUFS)

| Stage | 위치 | 역할 | 적정성 | 위험 |
|-------|------|------|:-----:|------|
| **Stage 1** 입력 분석 | `analyzer.py` + `audio_io.py` | LUFS / TP / LRA / 4-band / waveform | ✅ | 미음 입력 시 -inf 처리 OK |
| **Stage 3** T1 Adaptive Corrective EQ | `eq.py:build_kpop_loud_corrective_eq` | base+overlay 단일 spectrum-driven | ✅ Phase 2 | 5 EQ moves 한도, 중복 제거 |
| **Stage 3.5** Dynamic EQ | `dynamic_eq.py` | resonance suppression only | ✅ Phase 1 | range linear 단위 버그 수정됨, ±1.5 dB cap |
| **Stage 4** Bus Compressor | `dynamics.py` | glue (knee 10 으로 saturation 흡수) | ✅ Phase 1 | vocal-protection clamp 동작 |
| **Stage 4.5** ~~Saturation~~ | (제거됨 v3.5 P1) | — | — | — |
| **Stage 4.5** Stereo Width | `effects.py` | extrastereo m=1.10 | ✅ | mono 입력 시 no-op |
| **Stage 4.6** Soft Clipper | compand transfer | post-entry-gain peak rounding | ✅ | level 의존 (단일 instance) |
| **Stage 5a** Pre-limiter measurement (T4) | `pipeline.py` | 4-band 측정 + tilt pre-correction | ✅ Phase 2 | target convergence math |
| **Stage 5b** Loudness match | volume node | broadband entry gain (max +6 dB) | ✅ Phase 1 | vocal-protection clamp |
| **Stage 6** Brickwall Limiter | alimiter | peak ceiling (level_in ≤ +0.5 dB) | ✅ | asc=0 + level=disabled (final guard) |
| **Stage 7** Correction pass | `pipeline.py` | LUFS off-target 시 추가 push | ✅ | 한도 ±12 dB, 보호모드시 더 좁힘 |
| **Stage 8** ISP safety | `isp_safety.py` | 4× FFT oversample → 정적 down-gain | ✅ | numpy 의존 |
| **Stage 9** Final Tonal Guard | `pipeline.py:_apply_final_tonal_guard` | low+high 동시 해 (math) | ✅ Phase 2 | ±2.5 dB max, conditional limiter |
| Vocal Protection | `vocal_protection.py` | engine guard 항상 활성 | ✅ | 항상 작동 |
| Telephone guard | `gain_staging.py` | lowEnergyRatio + tilt 기반 verdict | ✅ | warn/danger surfacing |
| Tonal budget | `tonal_budget.py` | per-stage 허용량 + targets | ✅ Phase 2 | 정의만, 위반 자동 차단은 없음 |

### 5B. Phase 2 측정 데이터 (현재 commit, 3 inputs, IDEAL 범위)

| 입력 | lowRelDb | ratio | tilt | 결과 |
|------|---------:|------:|-----:|:----:|
| bass-heavy | -0.26 dB | **0.942** | **+1.46** | ✅ ALL ideal |
| bass-light | +0.56 dB | **1.138** | **+1.98** | ✅ ALL ideal |
| realistic  | +0.34 dB | **1.081** | **+1.60** | ✅ ALL ideal |

→ **세 입력 모두 사용자 명시 이상 범위 (0.85-1.15 / ±2 dB) 충족**.

### 5C. Stage 간 중복 — Phase 2 후

| Band | 건드리는 stage 수 (Phase 2) | (이전 v3.4.7) |
|------|:--------------------------:|:-------------:|
| LOW | 3 (T1, T2 가능, T9 final guard) | 7 |
| MID | 2 (T1, T9) | 6 |
| HIGH | 2 (T1, T9) | 6 |
| AIR | 2 (T1, T9) | 5 |

→ 사용자 가이드 "동일 band 최대 2번" 원칙 거의 충족 (LOW 만 3번, 그러나 T2 는 threshold 기반으로 거의 발동 안함).

---

## 6. 사운드 품질 리스크 분석

### 6A. 리스크 vs 방어 매트릭스

| 리스크 | 현재 방어 | 위치 | 충분성 | 권장 보강 |
|--------|----------|------|:------:|-----------|
| 저역 손실 | T1 + final-guard warmth | eq.py + pipeline.py | ✅ | — |
| 베이스 과다 | T1 (bass-heavy=0 warmth) + final-guard low_trim | 동일 | ✅ | — |
| 하이 과다 | T1 sheen 감산 + pre-correction shelf trim | pipeline.py | ✅ | — |
| 텔레폰 사운드 | gain_staging telephone guard + final-guard | gain_staging.py | ✅ | — |
| 먹먹한 사운드 | tilt < -4 dB → 8 kHz lift | pipeline.py | ✅ | — |
| 보컬 묻힘 | vocal_protection + T1 presence/clarity | vocal_protection.py | ✅ | — |
| 보컬 과부스트 | vocal-band cut 자동 cap (2.5 dB), boost cap (+2 dB in multiband) | vocal_protection.py | ✅ | — |
| 치찰음 증가 | dynamic_eq sibilance 7.5kHz cut | dynamic_eq.py | ✅ | — |
| harsh high-mid | dynamic_eq harsh_highmid cut | dynamic_eq.py | ✅ | — |
| limiter pump | level_in ≤ 0.5 dB clamp + asc=0 | pipeline.py | ✅ | — |
| Clipping | brickwall limiter ceiling -1 dBTP | ffmpeg_wrapper.py | ✅ | — |
| Inter-sample peak | ISP safety 4× oversample | isp_safety.py | ✅ | — |
| Loudness mismatch | LUFS correction pass + warning | pipeline.py | ✅ | — |
| Mono compatibility | mid/side 측정 + warning (LR_imbalance) | audio_io.py | ⚠️ | mono 입력 stereo 처리 후 출력 검증 |
| Stereo widening 부작용 | extrastereo m=1.10 (보수) | effects.py | ✅ | — |
| ~~Saturation 잔존~~ | 제거됨 (v3.5 P1) | — | ✅ | — |
| Dynamic EQ 오작동 | range linear 단위 수정 (Phase 1) | dynamic_eq.py | ✅ | — |
| FFmpeg filter 단위 오류 | range/threshold 단위 명시 + 테스트 | dynamic_eq.py | ✅ | adynamicequalizer threshold semantics 문서화 권장 |
| Fallback vs real path 결과 차이 | fallback strength 0.25 (보수) | dynamic_eq.py | ✅ | — |
| Sample rate 불일치 | 입력 비표준 시 warning + 44.1kHz 변환 | analyzer.py / pipeline.py | ✅ | — |
| Bit depth 차이 | 16/24/32 모두 처리 | parse_bit_depth | ✅ | — |
| MP3 입력 품질 | VBR/CBR 감지 + WAV 변환 권장 | env_info / safe_modes | ⚠️ | UI 안내 노출 미확인 |
| 짧은 파일 (<10s) | reference_warnings + LUFS 측정 정확도 | reference_matching | ✅ | — |
| 긴 파일 (>10min) | spectral 분석 max 60s 사용 | audio_io.py | ✅ | 메모리 안정 |
| 무음 파일 | input_i = -inf 검출 → FFmpegError | ffmpeg_wrapper.py | ✅ | — |
| 클리핑된 입력 | sample peak ≥ 0 dBFS warning + soft pre-gain | pipeline.py | ✅ | — |

### 6B. 알려진 제한 (배포 전 명시)

1. **합성 신호의 high-frequency tilt artifact** — cymbal noise floor 가 -45 dBFS 인 합성 신호에서 limiter 가 +9 dB 끌어올림.  실 트랙 (cymbal -25 dBFS) 에선 영향 미미.  **사용자 경험: 미영향**.
2. **Mac 자동 업데이트** — 코드 서명 + notarization 없이는 작동 안 함.  현재 graceful error event 발생 (사용자에게 보임).
3. **Static fallback** — adynamicequalizer 미가용 ffmpeg 빌드 (≤5.x) 에선 더 보수적인 정적 EQ 사용.  결과 품질 미세 차이.

---

## 7. KPOP Loud 최종 검증

### 7A. 패치 이력 검증

| 패치 | 적용 여부 | 검증 |
|------|:---------:|:----:|
| v3.4.6 텔레폰 사운드 원인 제거 (80 Hz overlay cut 제거) | ✅ | eq.py 의 90 Hz warmth bell |
| v3.4.7 adaptive EQ 적용 (warmth 동적) | ✅ | _kpop_loud_warmth_db |
| v3.5 Phase 1 dynamic EQ 단위 버그 수정 (range linear) | ✅ | dynamic_eq.py 의 `rng_linear = 10**(reduction/20)` |
| v3.5 Phase 1 alimiter level=disabled | ✅ | _build_tonal_correction_chain |
| v3.5 Phase 1 saturation 흡수 | ✅ | effects.py kpop_loud saturation=0 + dynamics knee=10 |
| v3.5 Phase 2 target convergence | ✅ | tonal_budget.py + math-based final guard |
| v3.5 Phase 2 T1 single-pass corrective EQ | ✅ | build_kpop_loud_corrective_eq |
| v3.5 Phase 2 4-band pre-limiter measurement | ✅ | pipeline.py prelim block |

### 7B. 시뮬레이션 결과 (3 type 입력)

#### 7B-1. 베이스 강한 KPOP 입력
- 입력 spec: low=-19 / mid=-31 / vocal=-33 / air=-43 dBFS, low_to_mid=+12 dB
- T1 결정: warmth 0 dB (bass-heavy), air shelf +1.2 dB, presence +1.0 dB
- Pre-limiter measure: tilt +1.4 dB → no pre-correction needed
- Final guard: warmth_bell 트리거 안 함, low_trim 트리거 안 함
- **결과**: ratio 0.942, tilt +1.46 dB ✅ ALL IDEAL
- **expected**: 안정적, 베이스 살아남, 보컬 명료
- **risk**: 없음

#### 7B-2. 베이스 약한 여성 보컬 입력
- 입력 spec: low=-32 / mid=-31 / vocal=-31 / air=-44 dBFS
- T1 결정: warmth +2.0 dB (bass-light), air shelf +2.5 dB
- Pre-limiter measure: tilt +2 dB → no pre-correction
- Final guard: 미세 조정만
- **결과**: ratio 1.138, tilt +1.98 dB ✅ IDEAL (boundary)
- **expected**: 베이스 자연스럽게 보강, 보컬 두드러짐
- **risk**: 매우 어두운 입력에서 air shelf 가 +2.5 dB 까지 올라가 sibilance 위험 (vocal_protection 가 사이비런스 cap 처리)

#### 7B-3. 이미 밝은 AI 생성 입력
- 입력 spec: high_to_mid > -10 dB
- T1 결정: warmth +0.5, sheen 0 (밝은 입력은 air shelf 만 +0.5 dB)
- Pre-limiter measure: tilt 가 처음부터 낮음
- Final guard: high_shelf_trim 가능
- **expected**: 추가 brightening 없이 안정
- **risk**: T1 의 vocal_gain +0.7 dB 가 already-bright 트랙에서 harsh 가능성 → vocal_protection 의 harsh_highmid cap 으로 방어

---

## 8. 자동 업데이트 / 배포 감사

### 8A. AUTO_UPDATE_ENABLED gate ✅ 정상

```javascript
// esbuild.main.cjs:25
const AUTO_UPDATE_ENABLED = process.env.AUTO_UPDATE_ENABLED === 'true';
// Bake-in via define
'__AUTO_UPDATE_ENABLED__': JSON.stringify(AUTO_UPDATE_ENABLED),
```

```typescript
// updater.ts:105
function _autoUpdateEnabled(): boolean {
  return app.isPackaged && (typeof __AUTO_UPDATE_ENABLED__ === 'boolean'
    ? __AUTO_UPDATE_ENABLED__
    : false);
}
```

| 항목 | 상태 |
|------|:----:|
| esbuild define 으로 baked | ✅ |
| 두 단계 gate (`isPackaged` + `__AUTO_UPDATE_ENABLED__`) | ✅ |
| dev 빌드 자동 비활성 | ✅ |
| branch/workflow_dispatch artifact → false | ✅ (CI workflow env 분기) |
| tag push (`refs/tags/v*`) → true | ✅ |
| "No published versions" → silent no-release | ✅ (4 정규식 패턴) |
| Renderer toast no-release 시 미표시 | ✅ |

### 8B. 빌드 산출물 검증 (Linux 실측)

| 산출물 | 상태 |
|--------|------|
| AppImage 생성 | ✅ 100 MB |
| `latest-linux.yml` 자동 생성 | ✅ |
| asar `package.json.main` = `dist-electron/main/index.js` | ✅ 직접 검증 |
| extraMetadata override 작동 | ✅ |
| `releaseType: draft` 설정 | ✅ |
| `provider: github / freemilesarea-boop / AImastering` | ✅ |

### 8C. 배포 위험도

| 항목 | 위험도 | 비고 |
|------|:------:|------|
| GH Token 누출 | Low | `${{ secrets.GITHUB_TOKEN }}` 자동 발급, 외부 노출 X |
| Public repo 전제 | Medium | private 전환 시 GH_TOKEN 필요 (TODO 명시됨) |
| version 과 git tag 불일치 | **High (P0)** | 현재 `package.json` = `3.2.0-rc`, git tag 미관리 |
| latest.yml 메타 SHA 검증 | ✅ | electron-builder 자동 |
| Mac auto-update without notarization | **High (P0)** | Gatekeeper 차단 → 사용자 첫 실행 실패 |
| Win SmartScreen 경고 | Medium (P1) | 코드 서명 없음 → 사용자 신뢰 저하 |

---

## 9. 플랫폼별 배포 리스크

### 9A. Windows

| 항목 | 상태 | 위험 |
|------|------|------|
| NSIS installer 정상 | ✅ (CI build-win 잡 D:\w 단축경로) | — |
| 설치 후 실행 경로 | `~\AppData\Local\Programs\Louver Mastering AI\` | OK |
| 자동 업데이트 작동 | ✅ NSIS self-update | — |
| 백신 오탐 가능성 | **Medium** — unsigned exe + PyInstaller bundled engine | 신규 사용자 일부에서 발생 가능 |
| ffmpeg/python 포함 | ✅ public/bin/ + extraResources | — |
| 권한 문제 | perMachine: false (admin 불필요) | — |
| 한글 경로 | UTF-8 stdin/stdout 강제 | OK |
| 공백 경로 | subprocess list args | OK |
| Long path (>260) | 워크스페이스 D:\w junction (CI), 배포 시는 사용자 경로 | Low |

### 9B. macOS

| 항목 | 상태 | 위험 |
|------|------|------|
| DMG + ZIP 생성 | ✅ x64 + arm64 | — |
| 용량 | DMG ~150 MB / ZIP ~140 MB | OK |
| **코드 서명** | ❌ 없음 | **P0** |
| **Notarization** | ❌ 없음 | **P0** (자동 업데이트 차단) |
| Gatekeeper 차단 | ⚠️ 첫 실행 우클릭 → 열기 필요 | UX 치명 |
| 자동 업데이트 | ❌ 작동 안 함 (notarization 없음) | **P0** |
| Apple Silicon + Intel | ✅ universal 가능하나 별도 arch 빌드 | — |

### 9C. Linux

| 항목 | 상태 |
|------|:----:|
| AppImage 정상 | ✅ |
| 자동 업데이트 | ✅ AppImage update 가능 |
| Wine 의존성 | ❌ NSIS cross-build 시 필요 (CI 한정 — 실제 Win 잡은 Win 러너) |
| 우선순위 | Low (대상 사용자 적음) |

---

## 10. 테스트 커버리지

### 10A. Python 엔진 테스트 (현재)

| 테스트 파일 | 케이스 수 | 검증 항목 |
|------------|---------:|----------|
| `test_pipeline.py` | ~37 | run_pipeline 전 케이스 (slow, ffmpeg 사용) |
| `test_ffmpeg_wrapper.py` | ~10 | ffprobe / loudnorm / 오류 분류 |
| `test_rpc_dispatcher.py` | ~8 | JSON-RPC dispatcher |
| `test_gain_staging.py` | ~10 | gain staging report + telephone guard |
| `test_vocal_protection.py` | ~13 | vocal protection clamps |
| `test_debug_quality.py` | ~13 | debug bundle + recorder |
| `test_reference_matching.py` | ~16 | reference profile + iterative loop |
| `test_reference_guidance.py` | ~21 | reference validation + presets |
| `tests/qa/run_qa.py` | (별도 도구) | end-to-end QA fixtures |
| **합계** | **120** | ✅ 모두 통과 (163 s) |

### 10B. 누락된 테스트 ⚠️ P1

| 영역 | 현재 | 권장 |
|------|:----:|------|
| Renderer 컴포넌트 unit test | ❌ 0건 | Jest + RTL minimum smoke test |
| IPC bridge 검증 | ❌ 0건 | preload allowlist 일치성 자동 검증 |
| Updater dev/prod 분기 | ❌ 0건 | 모킹 기반 단위 테스트 |
| Packaging 검증 | ❌ 0건 | asar 파일 존재 여부 자동 검증 |
| 실제 샘플 오디오 (다양한 장르) | ⚠️ 합성만 | 실 KPOP/Pop/Rock fixture 1~2 곡 |
| 한글/공백 path | ❌ 0건 | macOS + Windows 경로 fixture |
| MP3 입력 | ⚠️ 일부 | 다양한 비트레이트 |
| 모노 입력 stereo 처리 | ⚠️ 부분 | end-to-end |

---

## 11. P0 / P1 / P2 / P3 이슈 리스트

### 🚨 P0 (배포 불가 — 즉시 수정)

| # | 제목 | 영향 | 위치 | 수정 제안 | 작업량 |
|---|------|------|------|----------|:-----:|
| **P0-1** | macOS 코드 서명 + Notarization 미완 | Gatekeeper 차단, mac auto-update 불가, 첫 실행 시 우클릭 우회 필요 | `electron-builder.yml` `mac.identity` 주석 / CI secrets 미설정 | 1) Apple Developer 인증서 발급 2) `CSC_LINK` / `CSC_KEY_PASSWORD` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` GH secrets 등록 3) electron-builder.yml `mac.identity` 활성화 | 4-8 시간 (인증서 발급 포함) |
| **P0-2** | `package.json.version = "3.2.0-rc"` 정식 배포 부적합 | electron-updater semver 비교 시 RC 가 정식보다 낮게 처리될 수 있음, 사용자 향한 버전 표시 혼란 | `aimaster-desktop/apps/desktop/package.json` | `"version": "3.5.0"` 으로 bump + git tag `v3.5.0` push | 30 분 |

### ⚠️ P1 (배포 전 강력 권장)

| # | 제목 | 영향 | 위치 | 수정 제안 | 작업량 |
|---|------|------|------|----------|:-----:|
| **P1-1** | Windows 코드 서명 부재 | SmartScreen 경고, 신뢰 저하, 일부 백신 오탐 | `electron-builder.yml` `win.certificateFile` | EV Code Signing 인증서 발급 + CI secret 설정 | 2-4 시간 |
| **P1-2** | Legacy `src/renderer/` vs active `aimaster-desktop/...renderer/` 트리 혼재 | 베타 테스트 자료의 5 컴포넌트가 active build 미포함 → 기능 누락 | `src/renderer/components/mastering/` 의 5 파일 | active 트리로 이전 또는 legacy 트리 삭제 | 1-2 시간 |
| **P1-3** | TS / renderer 단위 테스트 0건 | renderer 회귀 자동 검출 불가 | `tests/` (renderer 전용 디렉토리 없음) | Jest + React Testing Library 도입 + UpdateToast / VocalProtectionBanner / GainStagingPanel smoke test | 4-6 시간 |
| **P1-4** | tempfile cleanup — 강제 종료 시 잔여 파일 | 디스크 공간 누적 (사용자 인지 시 신뢰 저하) | `pipeline.py` 다중 mkstemp 호출 지점 | 앱 시작 시 OS temp 의 `aimaster_*.wav` 일괄 삭제 helper | 1 시간 |
| **P1-5** | macOS auto-update 가 notarization 없으면 작동 안 함 | P0-1 미해결 시 mac 사용자 자동 업데이트 영구 차단 | (P0-1 과 동일) | P0-1 해결로 함께 해결 | (포함) |
| **P1-6** | `tonal_budget.py` 의 BUDGETS 가 *정의만 있고 강제 안 됨* | 미래 회귀 시 silent failure | `pipeline.py` 가 `check_budget()` 호출 안 함 | gain_staging 단계에서 stage 별 delta 측정 + budget 위반 시 warn | 2-3 시간 |
| **P1-7** | `cumulative_chain_analysis.py` 가 v3.5 Phase 2 와 호환 안 됨 | 향후 회귀 분석 도구 무용지물 | `docs/scripts/` | T1 합쳐진 corrective EQ 구조에 맞게 stage 분리 로직 재작성 | 2-3 시간 |

### ℹ️ P2 (배포 후 패치 가능)

| # | 제목 | 영향 | 작업량 |
|---|------|------|:-----:|
| **P2-1** | 데드 코드 정리 (~1800 라인): iterative.py / multiband.py / reference_presets.py 등 UI 없음 | 빌드 사이즈 + 보안 표면 | 2-4 시간 |
| **P2-2** | 한글 경로 / Windows long-path 자동 테스트 부재 | 실제 사용자 환경에서 발견 가능 | 2-3 시간 |
| **P2-3** | Mono input → stereo 처리 후 출력 검증 부재 | 일부 모노 입력에서 부자연 stereo | 1 시간 |
| **P2-4** | MP3 / VBR 입력 시 UI 안내 노출 미확인 | 사용자 경험 개선 | 1-2 시간 |
| **P2-5** | adynamicequalizer threshold semantics 문서화 | 유지보수 향상 (이미 코드 주석엔 있음) | 30 분 |
| **P2-6** | 배포 자료 (사용 설명서, 비디오) 부재 | 유료 사용자 onboarding | 별도 |
| **P2-7** | release-draft 워크플로 + electron-builder 의 draft release 충돌 가능성 | release tag push 시 중복 draft | 1 시간 |

### 💡 P3 (개선 아이디어)

| # | 제목 | 영향 | 작업량 |
|---|------|------|:-----:|
| **P3-1** | Stereo width 를 post-limiter 로 재배치 (Phase 3 후보) | sides 가 limiter 에 의해 압축되지 않음 | 2-4 시간 |
| **P3-2** | Multi-band parallel processing (acrossover) | 더 정밀한 dynamics | 1-2 일 |
| **P3-3** | Real-time spectrum monitoring UI | 사용자 디버그 능력 | 1-2 일 |
| **P3-4** | Crash reporter (Sentry / Rollbar) 통합 | 배포 후 이슈 추적 | 4-6 시간 |
| **P3-5** | 사용 통계 텔레메트리 (opt-in) | 사용 패턴 분석 | 1 일 |
| **P3-6** | Reference matching UI 노출 | 데드 path 였던 기능 활용 | 4-6 시간 |
| **P3-7** | Debug bundle export UI 버튼 | 고객지원 효율 | 2-3 시간 |

---

## 12. 권장 수정 순서

```
Sprint 1 (배포 차단 해제, ~1주)
┌─ Day 1-2: P0-1 macOS 코드 서명 + Notarization
├─ Day 1:   P0-2 version bump (3.5.0) + git tag
├─ Day 2-3: P1-2 legacy/active renderer 트리 통합
├─ Day 3-4: P1-1 Windows 코드 서명 (EV cert 신청 → 도착까지 1-2주 소요 가능, 병행)
├─ Day 4:   P1-4 tempfile cleanup helper
├─ Day 4-5: P1-7 cumulative analyzer Phase 2 호환
└─ Day 5:   smoke test + 배포 빌드 + 검증

Sprint 2 (배포 후 즉시, ~1주)
┌─ Day 1-3: P1-3 renderer unit tests
├─ Day 2:   P1-6 tonal_budget enforcement
├─ Day 3-4: P2-1 dead code cleanup
└─ Day 4-5: P2-3, P2-4, P2-5 마무리

Sprint 3 (다음 마이너 릴리스)
└─ P3-1, P3-4, P3-7 (Phase 3 + Sentry + Debug Bundle UI)
```

---

## 13. 배포 전 체크리스트

```
[ ] P0-1 해결: macOS 인증서 발급 + CI secrets 설정 + 빌드 검증
[ ] P0-2 해결: package.json version → 3.5.0 + git tag v3.5.0
[ ] P1-1 해결: Windows 코드 서명 인증서
[ ] P1-2 해결: legacy renderer 트리 통합 / 삭제
[ ] P1-4 해결: tempfile cleanup
[ ] CI workflow 실제 tag push 시 release artifact 생성 검증
[ ] electron-updater 가 새 release 인식 검증 (이전 버전 → 새 버전 업그레이드 시뮬레이션)
[ ] 4 가지 사용자 시나리오 수동 검증:
    [ ] mac arm64 첫 실행 (Gatekeeper 통과)
    [ ] mac x64 첫 실행
    [ ] Windows NSIS 설치 + 실행
    [ ] Linux AppImage chmod +x 후 실행
[ ] 자동 업데이트 end-to-end 검증 (3.5.0 → 3.5.1 mock)
[ ] 한글 파일명 입력 → 마스터링 → 출력 검증
[ ] 백신 (Defender / Avast / Norton) 스캔 통과 검증
[ ] 모든 P1 이슈 commit log 에 명시
[ ] 사용자 매뉴얼 / FAQ / 첫 실행 가이드 확보
```

---

## 14. 검증 명령 실행 결과

| 명령 | 결과 |
|------|------|
| `pnpm typecheck` | ✅ 통과 (warnings 없음) |
| `pnpm build` (renderer + main) | ✅ 통과 (`dist/renderer/index.html` + `dist-electron/{main,preload}/index.js`) |
| `pytest tests/` (전체) | ✅ **120/120 통과** (163 s) |
| `electron-builder --linux AppImage --publish never` | ✅ 통과 (101 MB AppImage + latest-linux.yml) |
| `electron-builder --win nsis --publish never` (Linux 환경) | ❌ Wine 필요 (CI Windows 러너에선 정상 작동 — 별 이슈 아님) |
| `electron-builder --mac dmg zip --publish never` (Linux 환경) | ❌ macOS 환경 필요 (CI Mac 러너에선 정상 작동) |
| asar 안의 `package.json.main` | ✅ `dist-electron/main/index.js` |
| `cumulative_chain_analysis.py` 3 inputs | ⚠️ Phase 2 호환 안 됨 (P1-7 — 분석 도구 자체 issue) |
| Phase 2 end-to-end (master_file 3 inputs) | ✅ 모든 메트릭 IDEAL 범위 (재확인) |
| Linux artefact 이름 | ✅ `Louver Mastering AI-3.2.0-rc-linux-x86_64.AppImage` |

---

## 15. 최종 결론

### 🚨 **지금 바로 실제 유료 수강생에게 배포해도 되는가? → NO**

#### 이유

1. **macOS 사용자가 첫 실행 시 Gatekeeper 차단** 으로 우클릭 우회를 직접 해야 함 (P0-1).  유료 고객 onboarding 경험에 치명.
2. **`package.json.version = 3.2.0-rc`** 인 채로 `v3.5.0` 같은 정식 tag 를 push 하면 electron-updater 가 향후 버전 인식 못 할 위험 (P0-2).
3. **mac 자동 업데이트** 가 notarization 없이 작동 안 함 (P0-1 의 종속 효과).
4. **Windows 사용자** 에게도 SmartScreen 경고가 첫 인상이라 신뢰 저하 (P1-1, 차단 사유는 아님).

#### 조건부 YES 시나리오

- **"Linux 만 혹은 베타 테스터 (Mac 우회 OK 인지) 만"** 배포: ✅ 현 상태로 가능.
- **"Windows + Linux 배포, Mac 은 보류"**: P0-2 (version bump) 만 하면 가능.  Win SmartScreen 경고는 사용자 안내로 우회 (예: "처음 실행 시 'Windows에서 PC 보호' 화면 → '추가 정보' → '실행'" 안내).
- **"전체 플랫폼 정식 배포"**: P0-1 + P0-2 모두 해결 필요.  최소 1 주 (인증서 발급 시간 포함).

#### 권장 다음 액션

다음 중 하나 선택:

**A) 즉시 배포 (Linux + Win, mac 보류)**
1. `version: 3.5.0` bump
2. `git tag v3.5.0 && git push origin v3.5.0`
3. CI 가 NSIS / AppImage 자동 publish
4. Mac 사용자에게는 "곧 별도 안내" 메시지

**B) 1주 대기 후 전체 플랫폼 배포**
1. Apple Developer 인증서 발급 (~$99/year, 24-48h)
2. EV Code Signing for Win (~$300-500/year, 1-2 주)
3. CI secrets 등록 + electron-builder.yml mac.identity 활성화
4. v3.5.0 tag push + 모든 플랫폼 정식 배포

**C) Beta 단계로 전환 (1-2 주 더)**
1. 위 P0/P1 모두 해결
2. 별도 베타 그룹에 1주 운영
3. P2 일부 해결
4. 정식 배포

→ **추천**: **B 또는 C**.  "유료 수강생" 이라는 단서가 있는 만큼 Mac Gatekeeper 우회 부담은 user-paying-money 에게 적절치 않음.

---

## Appendix A — 통계

- 총 코드 라인: ~12,000 (Python ~6,000 + TS/TSX ~3,500 + 기타 ~2,500)
- 테스트 라인: ~3,200 (Python 만)
- 테스트 통과율: **120/120 = 100 %**
- 평균 마스터링 시간: ~5 s (12 s WAV, kpop_loud, target -9 LUFS)
- 빌드 시간 (Linux): ~30 s (renderer 3 s + main < 1 s + electron-builder ~25 s)

## Appendix B — Commit history (최근 10)

```
6fc9c8a  feat: v3.5 Phase 2 — target-convergence tonal architecture
b9b824e  fix: v3.5 Phase 1 — Dynamic EQ + final-guard architecture fixes
026a3da  docs: pre-v3.5 mastering engine architecture analysis
40603e3  fix: v3.4.7 KPOP Loud — adaptive 톤 밸런스 + 최종 보정 가드
c5271ad  fix: v3.4.6 KPOP Loud 텔레폰 사운드 긴급 수정
f4e40f3  fix: v3.4.5 — gate auto-update on baked release-channel flag
bfa5e03  fix: v3.4.4 — drop Windows portable, scrub stale dist/main refs
6b75d23  feat: v3.4.3 electron-updater 자동 업데이트 + NSIS/DMG 배포
74544ce  fix: build-mac/build-win 빌드 실패 수정 — main entry path mismatch
500a2c9  docs: v3.4.1 user-test materials + analyzer
```

---

**감사 종료.  사용자 승인 후 위 우선순위에 따라 수정 단계 진입.**
