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

### P2-2. 멀티밴드 컴프 노출 (바인딩 → UI → Export) ✅
**커밋**: `feat(multiband): expose 4-band multiband comp through binding → UI → export (Phase 2)`

- **Rust(`loui-dsp-wasm`)**: `setMultibandConfig`(bypass·3 크로스오버·밴드별 5개 Float64Array) 추가. 플랫-arg `setConfig`가 멀티밴드를 **보존**(슬라이더 갱신 시 리셋 안 함). browser(프리뷰)+node(오프라인) wasm 양쪽 커버. `cargo check --workspace` 0.
- **공유 `multiband-config.ts`** (default/sanitize/pack/unity) — Rust config 미러, 단일 소스.
- **오프라인 바인딩**: `OfflineChainConfig.multiband?` + `applyOfflineConfig`가 `setMultibandConfig`를 **가드 호출**(typeof) → 구 아티팩트에선 안전 no-op, 재빌드 시 활성.
- **audioStore**: `multiband` 상태 + update/updateBand/set/reset.
- **export-backend**: 활성(non-unity)일 때만 rust 렌더 요청에 multiband 첨부; Mastering/HomePage가 스토어에서 전달.
- **`MultibandPanel`** UI(ResultPage): enable·크로스오버·밴드별 thr/ratio/makeup.
- **테스트**: multiband-config(5)+MultibandPanel(5)+export-backend 첨부(2). **vitest 36/36**, 전체 pnpm test 그린, typecheck 0.
- **런타임 활성화**: wasm/node 아티팩트 **재빌드** + Rust export 플래그 ON(C-2b, opt-in) 필요 → 빌드/디바이스 단계. 기본 경로 무변경(무회귀).

### P2-3. 멀티밴드 실시간 프리뷰 (WebAudio 근사 + worklet) ✅
**커밋**: `feat(multiband): realtime preview — WebAudio approx + worklet message (Phase 2)`
- **`multiband-chain.ts`**: WebAudio 4밴드 근사(cascaded LP/HP 크로스오버 → 밴드별 DynamicsCompressorNode → makeup → 합산), free EQ처럼 spliceable. idle(unity/bypass)이면 미삽입 → 무착색.
- **shared-audio-graph**: `rerouteBus`에 insert tail↔masterGain 사이 옵션 멀티밴드 단계 스레딩 + `setMultibandConfig(media,cfg)`(lazy-create+reroute, unity면 no-op).
- **worklet**: `'multiband'` 메시지 → 가드된 `chain.setMultibandConfig`(미재빌드 아티팩트에선 no-op).
- **ResultPage**: 멀티밴드 변경 시 native 근사 적용 + worklet에 packed 멀티밴드 post(변경/연결 시).
- **테스트**: multiband-chain mock-AudioContext(4). **vitest 40/40**, 전체 pnpm test 그린, typecheck 0.
- 기본 프리뷰 = WebAudio **근사**(출력 파일 = Rust 렌더가 정답). worklet 경로는 재빌드+활성 시 고정밀.

### P2-4. 4밴드 M/S 스테레오 이미저 (DSP) ✅
**커밋**: `feat(dsp): 4-band M/S stereo imager + shared crossover module (Phase 2)`
- **`crossover.rs`** 신설: LR4 lowpass + subtractive 4밴드 split을 공유 모듈로 추출, 멀티밴드 컴프를 거기에 맞춰 리팩터(DRY, 동작 무변경).
- **`imager.rs`**: 옵션 4밴드 M/S 폭 — Side를 4밴드로 분할(subtractive LR4)해 밴드별 width 적용(저역 모노 유지 + 고역 확장 등). unity widths면 Side를 정확 재구성(투명).
- **config**: `ImagerConfig`에 `multiband_enabled` + `band_widths_pct[4]` + 크로스오버 3개(기본 OFF → 단일밴드 동작 불변).
- 이미저 테스트 3종(unity 재구성 / 고역 Side 보존 / 저역 near-mono) — subtractive 위상 누설 정직 반영.
- **검증**: `cargo test -p loui-dsp` 76/76 + 하니스, `cargo check --workspace` 0.
- 노출(WASM setter + UI + 프리뷰)은 멀티밴드 컴프와 동일 패턴의 후속.

### P2-5. 4밴드 M/S 이미저 노출 (바인딩→UI→Export+프리뷰) ✅
**커밋**: `feat(imager): expose 4-band M/S imager — binding → UI → export + preview (Phase 2)`
- **Rust(`loui-dsp-wasm`)**: `setImagerMultiband` 추가 + 플랫-arg `setConfig`가 이미저 4밴드 필드 보존. `cargo check --workspace` 0.
- 공유 `imager-config.ts`, 오프라인 바인딩(`OfflineChainConfig.imagerMultiband?` + 가드 호출), audioStore 상태/액션, export-backend 첨부(활성 시), Mastering/HomePage 전달.
- 프리뷰: **`imager-multiband-chain.ts`**(WebAudio M/S 4밴드 근사) — `rerouteBus`를 N개 post-insert 스테이지 체이닝으로 일반화해 멀티밴드+이미저 동시 삽입. worklet `'imagerMultiband'` 메시지 + ResultPage native 효과 + worklet 시드.
- **`ImagerMultibandPanel`** UI(ResultPage): enable·크로스오버·밴드별 폭.
- **테스트**: imager-config(4)+chain mock(3)+패널(5)+export(1). **vitest 53/53**, 전체 pnpm test 그린, typecheck 0.
- 기본 disabled → 무회귀. 런타임 활성화는 멀티밴드 컴프와 동일 게이트(wasm 재빌드 + Rust export 플래그).

### P2-6. Saturation / Exciter 모듈 (DSP) ✅
**커밋**: `feat(dsp): saturation/exciter module — 4 characters + multiband (Phase 2)`
- **`saturation.rs`**: drive → waveshaper → dry/wet mix. 캐릭터 4종(Warm 소프트 / Tape tanh / Tube 비대칭+DC블록 / Modern 하드 odd) + 옵션 4밴드(밴드별 drive, 공유 크로스오버). drive 0 / mix 0 / bypass → 정확 passthrough.
- config: `SaturationCharacter` enum + `SaturationConfig`(기본 bypass·drive 0) → 체인(멀티밴드 컴프 뒤, 이미저 앞)·set_config·reset·재익스포트, WASM setConfig 보존.
- 테스트 8종. **`cargo test -p loui-dsp` 84/84** + 하니스, `cargo check --workspace` 0. 기본 bypass → 무회귀.
- 노출(WASM setter + UI + 프리뷰)은 후속(컴프/이미저 동일 패턴).

### P2-7. Saturation/Exciter 노출 (바인딩→UI→Export+프리뷰) ✅
**커밋**: `feat(saturation): expose saturation/exciter — binding → UI → export + preview (Phase 2)`
- **Rust(`loui-dsp-wasm`)**: `setSaturation`(bypass·character u8·drive·mix·멀티밴드·크로스오버·bandDrives[4]) + setConfig 보존. `cargo check` 0.
- 공유 `saturation-config.ts`: config + default/sanitize/pack/unity, **셰이퍼 수식(Rust와 동일) + `makeSaturationCurve`**(WebAudio 프리뷰 곡선), 캐릭터↔코드.
- 오프라인 바인딩(`OfflineChainConfig.saturation?` + 가드 호출, characterCode 와이어), audioStore 상태/액션, export-backend 첨부(활성 시·문자열→코드), Mastering/HomePage 전달.
- 프리뷰: **`saturation-chain.ts`**(WebAudio WaveShaper 4밴드 + DC블록) — `rerouteBus` 스테이지 순서 multiband→**saturation**→imager. worklet `'saturation'` 메시지 + ResultPage native 효과 + 시드.
- **`SaturationPanel`** UI: enable·캐릭터·drive·mix·옵션 밴드별 드라이브.
- **테스트**: config(7)+chain mock(4)+패널(6)+export(1). **vitest 71/71**, 전체 pnpm test 그린, typecheck 0. 기본 bypass → 무회귀.

### P2-8. Transient / Impact 셰이퍼 (DSP) ✅
**커밋**: `feat(dsp): transient/impact shaper — multiband attack/sustain (Phase 2)`
- **`transient.rs`**: 차분 엔벨로프(fast/slow follower) → `gain_db = attack%·relu(fast−slow) + sustain%·relu(slow−fast)`(±12dB 클램프·노이즈게이트). attack>0 펀치, sustain>0 바디. 옵션 4밴드(밴드별 attack/sustain, 공유 크로스오버). 0/bypass → passthrough.
- config: `TransientBandConfig` + `TransientConfig`(기본 bypass) → 체인(새추레이션 뒤, 이미저 앞)·set_config·reset·재익스포트, WASM setConfig 보존.
- 테스트 6종. **`cargo test -p loui-dsp` 90/90** + 하니스, `cargo check --workspace` 0. 기본 bypass → 무회귀.
- 노출(WASM setter + UI + 프리뷰)은 후속.

### P2-9. Transient / Impact 노출 (바인딩→UI→Export+worklet) ✅
**커밋**: `feat(transient): expose transient/impact — binding → UI → export + worklet (Phase 2)`
- **Rust(`loui-dsp-wasm`)**: `setTransient`(bypass·attack·sustain·멀티밴드·크로스오버·bandAttacks[4]·bandSustains[4]) + setConfig 보존. `cargo check` 0.
- 공유 `transient-config.ts`, 오프라인 바인딩(가드 호출), audioStore 상태/액션, export-backend 첨부(활성 시·밴드 2배열), Mastering/HomePage 전달.
- 프리뷰: **worklet `'transient'` 메시지만** (트랜지언트 디자이너는 WebAudio 노드 근사가 불가 → 기본 native 프리뷰 미반영, 패널에 명시). ResultPage post/seed.
- **`TransientPanel`** UI: enable·attack·sustain·옵션 4밴드.
- **테스트**: config(4)+패널(5)+export(1). **vitest 81/81**, 전체 pnpm test 그린, typecheck 0. 기본 bypass → 무회귀.

### P2-10. 완전 파라메트릭 Dynamic EQ (DSP) ✅
**커밋**: `feat(dsp): fully-parametric dynamic EQ — threshold-driven per-band (Phase 2)`
- **`dynamic_eq.rs`**: 최대 6밴드, 각 밴드 = bell/low-shelf/high-shelf 필터 + **밴드패스 사이드체인 검출 → 임계값 대비 동적 게인**. mode `DownCut`(라우드 시 컷, 디에스/제어) / `UpBoost`(콰이엇 시 부스트). ±range 클램프, 게인 0.05dB 이상 변할 때만 계수 재계산(고정주파수 precompute → 저비용). 비활성/range0/bypass → passthrough.
- biquad에 RBJ `band_pass`(검출용) 추가.
- config: `DynEqFilterType`+`DynEqMode` enum + `DynEqBandConfig`+`DynamicEqConfig`(MAX 6, 기본 bypass) → 체인(정적 EQ 뒤, 글루컴프 앞)·재익스포트, WASM setConfig 보존.
- 테스트 6종(passthrough / 비활성 / in-band 컷 / out-of-band 보존 / quiet 부스트 / range0). **`cargo test -p loui-dsp` 96/96** + 하니스, `cargo check --workspace` 0. 기본 bypass → 무회귀.
- 노출(WASM setter + UI)은 후속.

### P2-11. Dynamic EQ 노출 (바인딩→밴드리스트 UI→Export+worklet) ✅
**커밋**: `feat(dyneq): expose dynamic EQ — binding → band-list UI → export + worklet (Phase 2)`
- **Rust(`loui-dsp-wasm`)**: `setDynamicEqBands`(bypass + 10개 병렬 배열, 밴드당 1엔트리, type/mode u8 코드) + setConfig 보존. `cargo check` 0.
- 공유 `dyneq-config.ts`(밴드 모델 + sanitize/unity + 병렬배열 pack + 코드맵), 오프라인 바인딩(구조적 밴드+코드, 가드 호출), audioStore(밴드 add/update/remove), export-backend 첨부(활성 시·코드), Mastering/HomePage 전달.
- 프리뷰: **worklet `'dyneq'` 메시지만** (트랜지언트처럼 WebAudio 근사 불가 → 기본 프리뷰 미반영). post/seed.
- **`DynamicEqPanel`** 밴드 리스트 편집기: 추가/삭제 + 밴드별 type/mode/freq/Q/threshold/ratio/range.
- **테스트**: config(4)+패널(5)+export(1). **vitest 91/91**, 전체 pnpm test 그린, typecheck 0. 기본 bypass → 무회귀.

## ✅ Phase 2 Ozone 핵심 5종 모듈 — DSP + 전 경로 노출 완료

| 모듈 | DSP | 노출(바인딩/UI/Export) | 프리뷰 |
|------|:---:|:---:|------|
| 멀티밴드 컴프 | ✅ | ✅ | native+worklet |
| 4밴드 M/S 이미저 | ✅ | ✅ | native+worklet |
| Saturation/Exciter | ✅ | ✅ | native+worklet |
| Transient/Impact | ✅ | ✅ | worklet only |
| Dynamic EQ | ✅ | ✅ | worklet only |

## 🟡 남은 Phase 2 항목

| 항목 | 우선순위 | 비고 |
|------|:--------:|------|
| 모듈 프리셋(스타일별 기본값) | P2 | 5종 모듈 묶음 원클릭 |
| De-esser 적응형 / 멀티밴드 GR 메터 연결 | P2 | |
| (출시 전) wasm 아티팩트 재빌드 + 실기기 A/B QA → 기본 ON | 🔴 | 헤드리스 불가 |
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
