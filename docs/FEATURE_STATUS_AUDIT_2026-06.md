# 기능 구현 상태 전수 점검 (2026-06)

**브랜치**: `claude/dazzling-darwin-eav8na`
**점검 방식**: 코드 확인(추측 아님) — 플래그 기본값, wasm 셋터 존재, 프리뷰/익스포트 경로, 게이트 조건.

> 요약: 기능은 대부분 **구현·헤드리스 검증되어 있으나**, Phase 2~4 모듈은 **`VITE_LOUI_RUST_OFFLINE_RENDER` 플래그가 OFF 기본값**이라 *익스포트 파일*엔 반영되지 않는다(프리뷰엔 근사로 들림). 플래그 ON + 디바이스 A/B QA가 "진짜로 다 켜는" 마지막 단계.

---

## 🚦 핵심: 두 플래그 (둘 다 기본 OFF)

| 플래그 | 기본 | 게이트하는 것 | OFF일 때 |
|--------|:----:|---------------|----------|
| `VITE_LOUI_RUST_OFFLINE_RENDER` | **OFF** | 익스포트를 Rust 체인으로 라우팅 | 익스포트 = **Python 엔진**(모듈 미적용) |
| `VITE_LOUI_REALTIME_PREVIEW` | **OFF** | 풀해상도 Rust 워클릿 프리뷰 | 프리뷰 = **네이티브 WebAudio 근사**(들림) |

**확인됨**: wasm-node `ALL FRESH`, `setMultibandConfig/Saturation/Transient/DynamicEqBands/ImagerMultiband` 셋터 존재, `applyOfflineConfig`가 모듈 배선. → **플래그 ON이면 익스포트 모듈 실제 동작.**

---

## ✅ 1. 지금 실제 동작 (사용자가 받음, 플래그 불필요)

- **코어(Python 엔진)**: 분석·마스터·QC·라우드니스/리미터/기본 EQ·배치·세션 저장/불러오기.
- **마스터링 이력(durable)**: electron-store 영속, 세션간 복원 — 실동작.
- **라이브 프리뷰 근사 체인**(meterReady 시, 플래그 무관): 파라메트릭 EQ · 멀티밴드(근사) · 4밴드 이미저(근사) · 새추레이션(근사) · 스템 리밸런스 근사(M/S 보컬/베이스/공간). → **프리뷰에서 실제로 소리 바뀜.**
- **UI/분석 → 설정 적용**: 장르 감지·레퍼런스(→ style/targetLUFS 적용), AI 음악 감지(→ 모듈 보정값 세팅), 모듈 프리셋(→ 스토어), 구간 분석 표시.

## 🟡 2. 구현·검증됐으나 익스포트엔 게이트 OFF (플래그 ON 필요)

`VITE_LOUI_RUST_OFFLINE_RENDER=OFF`라 아래는 **현재 익스포트 파일에 반영 안 됨**(프리뷰엔 근사로 들리는 것도 있어 **불일치**):

- 멀티밴드 컴프 · 4밴드 M/S 이미저 · 새추레이션/엑사이터 · 트랜지언트 · 다이내믹 EQ · 디에서 · 파라메트릭 EQ(익스포트)
- 정밀 스템 리밸런스 · 구간별 마스터링 · 보컬 라이딩
- 서라운드(폴드다운·멀티채널·ADM BWF·Dolby AC-3/E-AC-3/TrueHD)

→ **플래그 ON + 디바이스 A/B QA**로 활성화. (wasm·셋터 준비 완료 확인.)

> **객관적 증거(`test:module-effect`)**: node wasm으로 동일 신호를 모듈 ON/OFF 렌더 비교 — **8개 모듈(EQ·Dynamics·Imager·Limiter·Multiband·Saturation·Transient·DynamicEQ) 전부 출력을 실제로 변경**(Δrms 측정, NaN 없음). 즉 "구현 안 됨"이 아니라 라우팅만 OFF.
> (점검 중 발견: DynamicEQ는 `rangeDb`가 양수 크기 + `mode`가 방향. 음수 range는 Rust가 비활성 처리 — 렌더러 UI는 0~24 양수로 올바르게 전달하므로 정상.)

## ⏸ 3. 외부 아티팩트 대기

- **정밀 스템 분리(ONNX Demucs)**: 런타임·번들·자동감지 완료, **모델 미핀** → `getStemSeparator()`=null → 근사로 폴백. 모델 핀(`pin:stem-model`)하면 자동 ON. (가중치 호스트가 이 환경에서 차단되어 여기선 핀 불가.)

## 🔬 4. 디바이스 QA 대기 (헤드리스 검증 끝, 실 오디오/장치 미검증)

- 실시간 Rust 워클릿 프리뷰(`VITE_LOUI_REALTIME_PREVIEW=OFF`).
- 서라운드 멀티채널 **실제 플레이어/DAW 재생·청취 품질**(채널 마스크·무결성·ADM·Dolby는 ffmpeg로 헤드리스 검증됨).
- 전 기능의 **주관적 청취 품질**.

---

## 📋 "진짜로 다 켜는" 데 남은 것

1. **`VITE_LOUI_RUST_OFFLINE_RENDER` ON** → 익스포트가 모듈 적용 + 프리뷰와 일치. **디바이스 A/B QA 필요**(헤드리스 불가).
2. **`VITE_LOUI_REALTIME_PREVIEW` ON** → 풀해상도 프리뷰. 디바이스 QA 필요.
3. **정밀 스템 모델 핀** → 정밀 분리 ON.
4. **서명/공증(결제)** → 정식 배포.

> 1·2·4는 본질적으로 실 장치/사람이 필요. 헤드리스(이 환경)에서 더 끌어올릴 수 있는 건 **익스포트 모듈이 오프라인 렌더에서 실제로 오디오를 바꾸는지 end-to-end 셀프테스트**(node wasm은 헤드리스 실행 가능) — 요청 시 추가 가능.

## 정직한 결론

"구현이 안 된" 게 아니라 **"구현됐지만 안전을 위해 기본 OFF"** 가 정확합니다. 다만 그 결과가 *프리뷰엔 들리는데 익스포트엔 없는* 불일치라 사용자가 "안 됨"으로 체감하는 게 타당함. 출시 준비의 본질 = 위 1~4(대부분 장치/사람/라이선스 의존).

---

## 🔍 2차 전수 점검 (모든 패널·마운트 대조) — 추가 발견

### 발견 A — Transient / Dynamic EQ / De-esser: **라이브 프리뷰 전무**
`shared-audio-graph` 네이티브 셋터: `setFreeEqBands·setMultibandConfig·setImagerMultibandConfig·setSaturationConfig·setRebalanceConfig`만 존재.
**Transient·DynamicEq·Deesser는 네이티브 프리뷰도, 워클릿 메시지도 없음** → 사용자가 슬라이더를 움직여도 **프리뷰가 전혀 안 바뀜**. (Rust 익스포트에선 동작 — `test:module-effect`가 Transient·DynamicEQ 변화 증명. Deesser는 DynEq로 병합.) → **플래그 OFF인 지금은 프리뷰·익스포트 둘 다 무반응**(이중 휴면). 다른 모듈(EQ·멀티밴드·이미저·새추레이션·리밸런스·파라메트릭)은 라이브 프리뷰 있음.

### 발견 B — 미사용/죽은 UI (기능 수만 부풀림)
실제 앱에서 어디서도 렌더 안 되는 컴포넌트:
- 완전 미사용 Loui 7종: `LouiSnapshotSlots·LouiRealtimeToggle·LouiModuleChain·LouiMasteringVisualizer·LouiPlaybackBar·LouiAudioDebugPanel·LouiShortcutHelp`
- 미사용 표준 패널 3종: `ABComparePanel·MasteringReportPanel·PreviewPanel`
- → "기능 많아 보이는데 안 됨" 체감의 일부. (제품 `components/product` 클러스터 46개는 HomePage가 일부 사용 — 전부 죽은 건 아님.)

### 검증 완료(정상 동작)
- 마운트 페이지: Home·Mastering·Result·Tweak·QC·Settings·DevAnalyzer.
- ResultPage 피처 섹션 전부 스토어에 배선. 미터/분석(Analyzer·LoudnessV2·Spectrum·StereoScope·MultibandGr·ExportReport·SmartRecommendation·AIArtifactWarning) 렌더됨.
- 라이브 프리뷰 근사(EQ·멀티밴드·이미저·새추레이션·리밸런스·파라메트릭) 동작.

### 권장 후속(헤드리스 가능)
1. **Transient/DynamicEq/Deesser 라이브 프리뷰 추가**(WebAudio 근사) — 발견 A 해소. 사용자 체감 직접 개선.
2. **죽은 컴포넌트 정리**(발견 B) — 혼선·번들 정리.
