# WASM 빌드 & 출시 준비 가이드

**작성일**: 2026-06-10
**대상**: Phase 2 모듈(멀티밴드 컴프·이미저·새추·트랜지언트·다이내믹EQ·디에서)을 실제 런타임에서 켜기 위한 빌드 파이프라인.

---

## 1. 핵심 사실 — 아티팩트는 "커밋된 생성물"이다

`dsp-core/crates/loui-dsp-wasm`(Rust)는 **wasm-bindgen으로 3개 타깃**으로 빌드되어 결과물이 **git에 커밋**된다. **CI는 이 아티팩트를 재빌드하지 않고 그대로 사용**한다.

| 타깃 | 빌드 스크립트 | 결과물(커밋됨) | 용도 |
|------|---------------|----------------|------|
| web | `build:web` | `packages/dsp-wasm/pkg/` | 렌더러(브라우저) — 분석/프리뷰 |
| nodejs | `build:node` | `packages/dsp-wasm/pkg-node/` | Electron main — Rust 오프라인 export |
| no-modules(worklet) | `build:worklet` | `apps/desktop/src/renderer/public/loui-mastering-wasm.nomodules.{js,wasm}` + `mastering-chain.worklet.js` | 실시간 worklet 프리뷰 |

> ⚠️ **Rust 바인딩에 `#[wasm_bindgen(js_name = ...)]` 메서드를 추가/변경하면 반드시 위 3개를 재빌드 + 커밋**해야 런타임에 반영된다. 안 하면 **조용히 stale**(새 메서드가 `typeof !== 'function'` → 가드 호출이 no-op).

> ⚠️ worklet 처리기(JS) 소스는 **`apps/desktop/src/renderer/audio/mastering-chain.worklet.js`** 이고, `public/`의 동명 파일은 `build:worklet`이 복사한 **생성물**이다. **소스를 편집**하고 재빌드할 것(생성물을 직접 편집하면 다음 빌드에 덮어써짐).

---

## 2. 재빌드 방법

### 1회 툴체인 셋업
```bash
rustup target add wasm32-unknown-unknown
# Cargo.lock의 wasm-bindgen 버전과 정확히 일치시킬 것 (현재 0.2.123)
cargo install wasm-bindgen-cli --version 0.2.123
```

### 전체 재빌드
```bash
cd aimaster-desktop
pnpm --filter @loui/dsp-wasm run build:all   # web + node + worklet
```

### 검증
```bash
cd apps/desktop
pnpm -s test:wasm-fresh   # 커밋 아티팩트가 Rust 바인딩과 동기인지 가드
pnpm -s test:rust-offline && pnpm -s test:rust-loudness  # node wasm 기능 검증
```

---

## 3. Freshness 가드 (재발 방지)

`pnpm test:wasm-fresh` (`scripts/wasm-freshness-selftest.ts`)가 다음을 검사:
1. `lib.rs`의 모든 `js_name` export가 커밋된 `pkg/.d.ts` **와** `pkg-node/.d.ts`에 존재
2. `public/mastering-chain.worklet.js` === `audio/` 소스(생성물 동기화)

→ `test` 스위트 + **CI(Linux 잡)** 에 편입. stale이면 CI가 **명시적으로 실패**(이전엔 조용히 stale 출시됨).

---

## 4. 출시 체크리스트 (모듈을 실제로 켜기)

Phase 2 모듈은 안전을 위해 **전부 기본 OFF + 플래그 게이트**로 들어가 있다. 출시 시:

1. **[필수] WASM 재빌드 + 커밋** — `build:all` (§2). `test:wasm-fresh` 통과 확인.
2. **Rust 오프라인 export 켜기** — `VITE_LOUI_RUST_OFFLINE_RENDER=on` (또는 `window.__LOUI_RUST_OFFLINE_RENDER__=true`). 그래야 export가 Rust 경로로 가고 모듈 config가 적용됨(Python 폴백 유지).
3. **worklet 프리뷰 켜기**(선택, 고정밀 실시간) — `VITE_LOUI_REALTIME_PREVIEW=on` 또는 localStorage. native 폴백 유지.
4. **실기기 오디오 A/B QA** (헤드리스 불가) — 실파일 Rust export vs Python 청감 비교, 5종 모듈 동작 확인, 실링/아티팩트 점검.
5. **support-matrix / `test:export-support`** 갱신(파라미터 export-exact 승격 정직성 게이트).
6. **macOS 공증 / Windows EV 서명**(인증서 — 결제 필요) → 정식 배포.
7. `git tag v* && push` → CI release-draft → publish.

### 모듈별 런타임 적용 경로
| 모듈 | Export(Rust) | native 프리뷰 | worklet 프리뷰 |
|------|:---:|:---:|:---:|
| 멀티밴드 컴프 | ✅ | ✅(WebAudio 근사) | ✅ |
| 4밴드 이미저 | ✅ | ✅ | ✅ |
| Saturation | ✅ | ✅(WaveShaper) | ✅ |
| Transient | ✅ | ❌(노드 근사 불가) | ✅ |
| Dynamic EQ / De-esser | ✅ | ❌ | ✅ |

→ Transient/Dynamic EQ/De-esser는 native 프리뷰 미반영(설계상). export·worklet에서 적용.

---

## 5. 패키징 — pkg-node 번들 (수정됨)
- 렌더러는 `@loui/dsp-wasm`(pkg/web)을 워크스페이스 의존성으로 번들(Vite), worklet 자산은 `public/`에서 복사.
- main의 Rust 오프라인 렌더는 `pkg-node`를 `process.resourcesPath/dsp-wasm-node`에서 `require`.
- **수정**: `electron-builder.yml extraResources`에 `../../packages/dsp-wasm/pkg-node → dsp-wasm-node` 추가. (이전엔 누락되어 패키지 앱에서 Rust export 불가 → Python 폴백이었음.)
- 출시 전 패키지 빌드에서 `resources/dsp-wasm-node/loui_dsp_wasm.cjs` 존재 + Rust export 동작을 실기기 확인할 것.
