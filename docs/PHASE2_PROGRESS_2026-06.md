# Phase 2 진행 보고 — Ozone 기본기 메우기

**작성일**: 2026-06-09
**브랜치**: `claude/dazzling-darwin-eav8na`
**목표**: Ozone 대비 비어 있던 핵심 DSP 모듈을 **단일 Rust 엔진(`loui-dsp`)** 에 구현. 이 엔진이 실시간 프리뷰 + 오프라인 렌더 양쪽을 구동하므로 한 곳에 넣으면 프리뷰·렌더에 동시 반영된다.

> 검증: Rust DSP는 `cargo test`로 **헤드리스 검증 가능**(렌더러 UI와 달리). 모든 신규 모듈은 realtime-safe(샘플 단위·무할당) + 기본 bypass로 추가해 **무회귀**.

---

## ✅ 완료

### P2-1. 진짜 4밴드 멀티밴드 컴프레서 (P0 — 가장 큰 격차)
**커밋**: `feat(dsp): real 4-band multiband compressor in Rust core (Phase 2 P0)`

- **`mastering/multiband.rs`** — subtractive 크로스오버 트리(채널당 3개의 cascaded Linkwitz-Riley-4 lowpass) → 밴드별 stereo-linked soft-knee 컴프레서 + makeup → 합산.
  - subtractive 분할이 **telescope**되어, 모든 밴드 unity 시 입력을 **bit-exact 재구성**(완벽한 no-op 기본값 → 프리뷰≙렌더 패리티 보존).
  - realtime-safe: 샘플 단위, 상태 전부 생성자에서 사전할당, process 내 무할당.
- **config**: `MultibandConfig` + `MultibandBandConfig`(기본 bypass=true·unity). `MasteringChainConfig`/체인(글루 컴프 뒤, 이미저 앞)/`set_config`/`reset`에 연결. 크레이트 루트 + WASM 재익스포트. WASM `setConfig`는 멀티밴드를 기본 bypass로 채움(플랫-arg 바인딩 확장은 후속).
- **테스트 7종**: unity bit-exact passthrough / bypass / forced reconstruction / 저역밴드 GR / 전밴드 피크 감소 / 고역톤 보존 / 크로스오버 정렬.
- **검증**: `cargo test -p loui-dsp` **73/73** + 하니스, `cargo check --workspace` 0.
- **알려진 한계(설계 정직성)**: subtractive 크로스오버는 크로스오버 근처 밴드 격리가 약함(위상 비상관 누설). v1로는 충분하나, 향후 정밀 격리가 필요하면 LR 보완(allpass-sum) 또는 진짜 트리로 업그레이드.

---

## 🟡 남은 Phase 2 항목

| 항목 | 우선순위 | 비고 |
|------|:--------:|------|
| **멀티밴드 컴프 노출** (WASM 플랫-arg 확장 + UI 패널 + 프리셋) | P0 후속 | DSP는 완료, 사용자 제어 연결만 남음 |
| 멀티밴드 Stereo Imager (4밴드 M/S) + M/S EQ | P1 | imager.rs 확장 |
| Saturation/Exciter (멀티밴드, 2~4 캐릭터) | P1 | 신규 모듈 |
| Transient/Impact (멀티밴드 attack/sustain) | P1 | 신규 모듈 |
| Dynamic EQ 완전 파라메트릭화 (Rust) | P1 | parametric_eq + 임계 구동 |
| De-esser 적응형 | P2 | |
| 멀티밴드 GR 메터링을 `GainReduction`에 연결 | P2 | 현재 `gain_reduction_db()` 보유, 미연결 |

**다음 권장**: P2-1 후속(멀티밴드 컴프를 WASM/UI/프리셋에 노출)으로 사용자가 실제로 쓰게 만들거나, P1의 멀티밴드 이미저/새추레이션 중 택일. 전부 Rust 코어라 cargo로 헤드리스 검증 가능.

---

## 참고: 엔진 일원화와의 시너지
Phase 1에서 Rust를 프리뷰+오프라인 렌더의 단일 엔진으로 묶었기 때문에, Phase 2의 DSP 모듈은 **한 번 구현하면 프리뷰·최종 렌더에 동시 적용**된다(이전 Python/Rust 이원화였다면 두 번 구현해야 했음). 이것이 Phase 1을 먼저 한 이유.
