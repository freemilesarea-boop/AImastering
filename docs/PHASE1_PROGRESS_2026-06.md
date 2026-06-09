# Phase 1 진행 보고 (결제/서명 제외)

**작성일**: 2026-06-09
**브랜치**: `claude/dazzling-darwin-eav8na`
**범위 결정**: Phase 1에서 **결제(유료 인증서 구매가 필요한 macOS 공증·Windows EV 서명) 제외**, 정식 출시(서명/결제)는 Phase 4 이후.
**바인딩 대상 결정**: **ResultPage(canonical) 강화** — 은퇴한 리치 모듈 UI는 보존만.
**worklet 게이트 결정**: **코드/셀프테스트 기준 해제** + native 폴백 유지. 실기기 검증은 출시 전 단계.

> 이 컨테이너는 **헤드리스**(GUI/오디오 하드웨어/실기기 테스트 불가)다. 따라서 검증은 typecheck + tsx 셀프테스트 + cargo/pytest로만 가능하고, "들어보는 QA"가 필요한 단계는 출시 전 게이트로 남긴다(사용자 합의됨).

---

## A. 완료 + 검증됨 (커밋)

### A-1. 실시간 worklet 프리뷰 게이트 안전 재개방 ✅
**커밋**: `feat(realtime): re-open worklet preview gate safely (Phase 1)`

문제였던 hard-disable의 **근본 원인**(worklet이 오디오 블록마다 metrics를 React `setState`로 흘려보내 runaway 리렌더 → 렌더러 프로세스 사망)을 해결:

- **신규 `audio/realtime-metrics-sink.ts`** — 블록당 metrics를 coalesce하여 **≤10Hz**로만 통지(블록당 setState 금지). 결정적 throttle(클록 주입 가능)이라 헤드리스 단위테스트 가능.
- **`audio/realtime-preview-flag.ts` 재작성** — 무조건 `false` 제거 → env/localStorage/window 게이트. **기본 OFF·opt-in·kill-switch**. export 경로 불변.
- **ResultPage(canonical) 라이브 와이어링** — 플래그 ON일 때 WASM 마스터링 worklet을 active insert로 splice, 동일 `RealtimeChainConfig` 주입. **어떤 실패든 native DSP 체인으로 자동 폴백** → 오디오 끊김 없음. metrics는 싱크로만 수신(리렌더 루프 없음).
- **셀프테스트** `realtime-preview-gate-selftest.ts` 추가 + `test` 스크립트 등록.

**검증**: `typecheck` 0, 신규 게이트 셀프테스트 12/12, 기존 `native-dsp`/`realtime-config`/`loudness` 셀프테스트 회귀 없음.
**잔여(출시 전)**: 기본값 ON 전환은 **실기기 오디오 검증** 후. 현재 기본 OFF라 사용자 동작 무변경(무회귀).

### A-2. 엔진 일원화 C-2(a) — Rust 렌더 출력에 QC/분석 래핑 ✅
**커밋**: `feat(engine-unify): wrap Rust offline render with QC/analysis → MasteringResult parity (C-2a)`

엔진 일원화의 **핵심 차단(결과 형태 불일치)** 해소:
- **신규 `main/offline/assemble-rust-result.ts`** (순수 함수) — Rust 렌더 + Python `analyze`(source/output) + `qc_check`(output)를 합쳐 **MasteringResult 호환 객체** 생성. `analysisReport`(eq/dyn/limiter/loudnorm)는 체인 config에서 합성, 12-item `QCResult`→`QualityCheckReport` 매핑, before/after `metricComparison`·`appliedCorrections` 도출. 파생 불가 optional(gainStaging/suspectSegments 등)은 미정의(UI 안전).
- **`audio:master-rust-experimental` 핸들러** — Rust 경로는 조립된 MasteringResult 반환, Python 폴백도 전체 masterFile 결과 반환. 슬림 형태 제거.
- **헤드리스 셀프테스트** `rust-result-assembly-selftest.ts`(22 checks) + `test` 등록.

**검증**: typecheck 0, 전체 셀프테스트 스위트 그린.
**잔여**: 렌더러 export 라우팅 스위치(C-2b) + 실기기 A/B QA. 프로덕션 `audio:master`는 불변(무회귀).

---

## B. 점검 중 정정된 사실 (기존 보고서 갱신)

이전 `docs/SYSTEM_AUDIT_AND_ROADMAP_2026-06.md`는 옛 redesign 문서에 일부 의존했는데, 실제 코드는 더 진척돼 있었다:

1. **Rust 오프라인 렌더에 라우드니스 정규화가 이미 존재** — `test:rust-loudness` 9/9 통과("quiet sine moves toward target ±2 LU", "ceiling never exceeded after normalize", 2-pass solver). 즉 승격 플랜의 **게이트 #1(loudness-norm)은 충족됨**. (옛 파리티 리포트의 "Rust엔 loudnorm 없음"은 `rust-offline-render-2`에서 해소).
2. **Rust 오프라인 렌더 안전 파리티** — `test:rust-offline` 7/7(무음/사인/노이즈/스테레오/실링/바이패스/메트릭).
3. **리치 모듈 UI는 "은퇴"** — `ProductPage`/`ModuleParameterStateProvider`/파라미터 패널/드래그 EQ는 라우팅에서 빠지고 ResultPage가 canonical. 휴면 코드(Storybook)로 보존 중.
4. **Rust export는 별도 실험 채널** — `audio:master-rust-experimental`. 프로덕션 `audio:master`는 여전히 Python. 렌더러는 실험 채널을 **호출하지 않음**(rust 플래그는 정의됐으나 라우팅 미사용).

---

## C. 미완 Phase-1 항목 + 정확한 차단 사유

### C-1. ResultPage 파라메트릭 EQ 노출 → 완료 ✅
**커밋**: `feat(eq): live parametric EQ control on ResultPage + model selftest (C-1)`
- **`ParametricEqPanel`** (밴드 리스트: 타입/주파수/게인/Q/사용/삭제 + 추가, MAX_BANDS 캡)을 canonical ResultPage에 추가, `setFreeEqBands`에 라이브 연결 → 재생 중 즉시 들림(휴면 product-suite 의존 없음).
- `audioStore.parametricEqBands` 상태 + add/update/remove/reset/set 액션(sanitize+cap), ResultPage 효과가 변경 시 라이브 버스에 splice.
- `parametric-eq-model`에 순수 `sanitizeBands`(클램프+캡) 추가.
- **셀프테스트** `parametric-eq-selftest`(mock-AudioContext로 모델→applyBands DSP 경로 + sanitizeBands 검증) + `test` 등록.
- **검증**: typecheck 0, 전체 스위트 그린. 빈 밴드 리스트 = no-op(무회귀).
- **잔여**: 드래그-캔버스 편집기는 product 모듈 스위트(후속 마일스톤). 현재는 슬라이더 기반 컨트롤.

### C-2. 엔진 일원화(Rust를 기본 export로 승격)
- (a) **결과 형태 동등화 → 완료**(A-2 참조).
- (b) **렌더러 export 라우팅 스위치 → 완료** — `audio/export-backend.ts`의 `masterWithPreferredBackend()`가 `isRustOfflineRenderEnabled()` 시 `audio:master-rust-experimental`로 라우팅 + Python 폴백(throw/unusable). MasteringPage(단일)·HomePage(배치) 연결. `optionsToChainConfig`를 공유 정본으로 통합(ResultPage가 import). 플래그 **기본 ON→OFF**(라우팅이 살아났으므로 실기기 QA 전 default-on 금지). `export-backend-selftest`(24 checks). **기본 OFF → 프로덕션 export는 여전히 Python(무회귀).**
- (c) **톤/EQ 파리티 + 실기기 A/B QA** (🔴 출시 전, 헤드리스 불가) — 플래그 ON 후 실파일 Rust vs Python A/B.
- (d) **support-matrix/test:export-support** 갱신(정직성 게이트) — 승격(기본 ON) 시.

### C-3. 렌더러 단위테스트(vitest) 도입 → 완료 ✅
**커밋**: `test(renderer): introduce vitest unit/component harness (C-3)`
- `vitest` + `jsdom` + `@testing-library/react/dom/jest-dom` 도입, `vitest.config.ts`(jsdom env, `@` alias, `src/**/*.test.*`) + `vitest.setup.ts`(RTL cleanup, AudioContext stub).
- 렌더러 단위/컴포넌트 테스트 **24개 통과**: realtime-metrics-sink(코얼레싱), export-backend(라우팅+매핑), parametric-eq-model(sanitize+curve), **`ParametricEqPanel` 실제 렌더 + zustand 상호작용**(추가/삭제/토글/타입변경/캡).
- `test:unit`(vitest run)·`test:unit:watch` 스크립트 + `test` 체인에 편입.
- **검증**: typecheck 0(테스트 포함), 전체 스위트 그린. → **P1 "렌더러 단위테스트 0" 해소.**

### C-4. 레거시 `/python` 제거 → 완료 ✅ (사용자 승인)
**커밋**: `chore(legacy): remove pre-monorepo legacy Python engine (/python)`
- `/python`(v3.1, 19개 파일) 제거. 활성 `aimaster-desktop` 빌드는 미참조였고, 유일한 참조였던 루트 `/src/main/utils/pathUtils.ts`도 동일한 레거시 트리. git 이력에서 복구 가능. 활성 빌드 typecheck 0.
- **남은 레거시(별도 후속)**: 루트 `package.json`(설명에 "legacy root, see aimaster-desktop/" 명시) + 루트 `/src` + 루트 `vite.config.ts`/`tsconfig*`/`requirements.txt`/`scripts/`/`tests/` = 모노레포 이전 앱 전체. 원하면 일괄 제거 가능.

---

## D. 인프라/플래그 정합성 메모
- `rust-offline-render-flag.ts` 주석은 "DEFAULT = ON, device-verified"라고 하지만 승격 플랜은 "sign-off 후 기본 ON"이라 **불일치**. 현재 플래그는 라우팅에 미사용이라 런타임 영향 없음. 승격 시 정합성 정리 필요.

---

## E. 진행 현황 / 남은 작업
- ✅ A-1 worklet 게이트 안전 재개방
- ✅ A-2 / C-2(a) Rust 렌더 QC/분석 래핑 (결과 형태 동등화)
- ✅ C-2(b) 렌더러 export backend 스위치 (기본 OFF + 폴백)
- ✅ C-1 ResultPage 라이브 파라메트릭 EQ + 셀프테스트
- ✅ C-3 렌더러 vitest 도입 (24 tests)
- ✅ C-4 레거시 `/python` 제거 (사용자 승인)
- 🔴 (출시 전, 헤드리스 불가) 실기기 A/B QA → worklet 프리뷰 / Rust export 기본 ON 전환
- ⏳ 이후 Phase 2~4 → 결제/서명/정식 출시

**→ 헤드리스에서 가능한 Phase 1 코드 작업 전부 완료.** 남은 것은 실기기 오디오 QA(출시 전 단계)와, 선택적 후속(루트 레거시 앱 일괄 제거).
