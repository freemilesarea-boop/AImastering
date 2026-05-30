# 06 — 모듈 분리 계획

> v2 모노레포의 패키지 경계를 결정한다.
> 원칙: **단방향 의존 / 브랜드 분리 / 도메인 분리 / 테스트 가능성**.

---

## 1. 패키지 트리 (목표)

```
loui-mastering/                              ← 리포 루트 (v2)
├── apps/
│   ├── desktop/                             Electron 앱 (Loui)
│   ├── web/                  (future)       PWA (Loui)
│   └── cli/                  (future)       npm @loui/cli
├── packages/
│   ├── brand/                               @loui/brand          — 브랜드 토큰 (productName, logo, color)
│   ├── design-tokens/                       @loui/design-tokens  — 디자인 토큰 (다크/라이트 / 모션 / 타이포)
│   ├── ui/                                  @loui/ui             — React 컴포넌트 라이브러리 (브랜드 무관)
│   ├── icons/                               @loui/icons          — SVG 아이콘 세트
│   ├── engine-api/                          @loui/engine-api     — UI ↔ Engine TS 클라이언트
│   ├── shared-types/                        @loui/shared-types   — 공유 타입 (도메인별로 sub-export)
│   ├── preset-format/                       @loui/preset-format  — 프리셋 JSON 스키마 + zod 검증
│   ├── license-core/                        @loui/license-core   — 로컬 검증 + 머신 바인딩
│   ├── analytics/                           @loui/analytics      — opt-in 텔레메트리 클라이언트
│   └── utils/                               @loui/utils          — 공통 유틸 (path, time, format)
├── engine/
│   ├── orchestrator/                        @loui/engine         — Node.js job 스케줄러 + 프로젝트 스토어
│   ├── decoders/                            @loui/decoders       — WAV/FLAC/MP3/AAC 디코더 래퍼
│   └── recommend/                           @loui/recommend      — AI 추천 (rule-based + ONNX)
├── dsp-core/                                ★ Rust 워크스페이스
│   ├── crates/
│   │   ├── loui-dsp/                        ─ DSP 알고리즘 + 그래프 런타임
│   │   ├── loui-dsp-ffi/                    ─ C-ABI + N-API 바인딩
│   │   └── loui-dsp-wasm/                   ─ wasm-bindgen
│   └── Cargo.toml
├── services/
│   ├── license-server/       (future)       Loui Cloud 라이선스 서버
│   ├── preset-market/        (future)       프리셋 마켓플레이스
│   └── telemetry/            (future)       크래시/사용 텔레메트리
├── tests/
│   ├── dsp-regression/                      골든 입출력 비교
│   ├── e2e/                                 Playwright (desktop & web)
│   ├── perf/                                CPU/메모리 벤치마크
│   └── fixtures/                            10곡 골든 셋
├── tools/                                   빌드 / 사이닝 / 노타라이즈 / 배포 스크립트
└── docs/                                    설계 / 사용자 / 운영
```

---

## 2. 의존 방향

```
                          apps/desktop ──┐
                          apps/web ──────┼─▶ @loui/ui ─▶ @loui/design-tokens
                          apps/cli ──────┘            ─▶ @loui/icons
                                  │                  ─▶ @loui/brand
                                  ▼
                          @loui/engine-api  ─────▶ @loui/shared-types
                                  │                          │
                                  ▼                          │
                          @loui/engine     ◀──────────────────┘
                                  │  ─▶ @loui/decoders
                                  │  ─▶ @loui/recommend
                                  │  ─▶ @loui/preset-format
                                  │  ─▶ @loui/license-core
                                  │  ─▶ @loui/analytics
                                  ▼
                          (FFI) loui-dsp-ffi
                                  │
                                  ▼
                          loui-dsp  (Rust)
```

**금지된 의존:**
- `@loui/ui` ↛ `@loui/engine` (UI 는 engine-api 를 통해서만)
- `@loui/dsp` ↛ 모든 TS 패키지 (DSP 는 브랜드/도메인 무관 순수 함수)
- `@loui/brand` ↛ `@loui/design-tokens` (디자인 토큰은 브랜드 비종속, 그 반대)
- 모든 `apps/*` 는 서로 직접 import 금지

---

## 3. 패키지별 책임 / 비책임 / 경계 테스트

### 3.1 `@loui/dsp-core` (Rust)

| 항목 | 내용 |
|---|---|
| **책임** | 모듈 그래프 런타임, 모든 DSP 알고리즘, BS.1770-4 미터링, 오버샘플링, 디더 |
| **비책임** | 파일 I/O, 네트워크, UI, 라이선스, 상태 영속화 |
| **API 표면** | C-ABI + N-API + wasm-bindgen (3-way) |
| **테스트** | `cargo test` (DSP unit) + golden fixtures (`tests/dsp-regression/`) |
| **경계 테스트** | "이 코드가 std::fs 를 import 하면 빌드 실패" linter |

### 3.2 `@loui/engine` (Node)

| 항목 | 내용 |
|---|---|
| **책임** | Job 스케줄링, 프로젝트 직렬화 (`.louiproj`), 그래프 검증, 파일 I/O, AI 추천 호출, 라이선스 게이트 |
| **비책임** | DSP (← dsp-core), UI, 결제, 라이선스 검증 (← license-core / 서버) |
| **API 표면** | engine-api 의 구현 (in-process 또는 IPC 서버) |
| **테스트** | unit + integration (모의 dsp-core 로) |

### 3.3 `@loui/engine-api` (TS 인터페이스)

| 항목 | 내용 |
|---|---|
| **책임** | UI → Engine 호출의 타입 안전 API. 전송 추상화 (IPC / HTTP / FFI). 진행도 / 에러 / 취소. |
| **비책임** | UI 컴포넌트, DSP, 비즈니스 로직 |
| **API 표면** | `createEngineClient({ transport })` |
| **테스트** | mock transport 로 contract test |

### 3.4 `@loui/ui` (React)

| 항목 | 내용 |
|---|---|
| **책임** | 재사용 가능한 시각화/입력 컴포넌트 (Spectrum, GR, EQ Curve, Meter, ModuleInspector...) |
| **비책임** | 라우팅, 상태 스토어, 브랜드 (← brand) |
| **API 표면** | named exports + Storybook |
| **테스트** | Vitest + RTL + Storybook 인터랙션 테스트 + Chromatic visual regression |

### 3.5 `@loui/brand`

| 항목 | 내용 |
|---|---|
| **책임** | productName / appId / 로고 SVG / 도메인 / 이메일 / 색상 키 (primary, accent) |
| **비책임** | 일반 디자인 토큰, 컴포넌트 |
| **API 표면** | `import { brand } from '@loui/brand'` — 단일 객체 |
| **OEM** | 향후 OEM 빌드 시 이 패키지만 교체하면 됨 |

### 3.6 `@loui/design-tokens`

| 항목 | 내용 |
|---|---|
| **책임** | 색상 스케일 / spacing / radius / shadow / typography / motion (브랜드 비종속) |
| **비책임** | 컴포넌트, 브랜드 색 |

### 3.7 `@loui/preset-format`

| 항목 | 내용 |
|---|---|
| **책임** | 프리셋 JSON 스키마 정의 (v1) + zod 런타임 검증 + 버전 마이그레이션 |
| **비책임** | 프리셋 저장소, UI |
| → | 상세는 `08-PRESET-SYSTEM-DESIGN.md` |

### 3.8 `@loui/license-core`

| 항목 | 내용 |
|---|---|
| **책임** | 로컬 키 검증, 머신 ID 바인딩, electron-store 암호화 저장, 만료/취소 캐싱 |
| **비책임** | 서버 발급 (← license-server) |

### 3.9 `@loui/analytics`

| 항목 | 내용 |
|---|---|
| **책임** | opt-in 텔레메트리 — Sentry 크래시 / 사용 이벤트 (모드 선택, 처리 성공/실패, 처리 시간) / 자동 PII 마스킹 |
| **비책임** | 결제, 라이선스 |

### 3.10 `@loui/shared-types`

| 항목 | 내용 |
|---|---|
| **책임** | UI ↔ engine-api ↔ engine 간 공유 타입 |
| **구조** | **도메인별 sub-export** (현재 800줄 단일 파일 분리) — `audio`, `mastering`, `qc`, `meters`, `ai`, `license`, `ipc`, `preset` |

---

## 4. 코드 이동 매핑 (v3 → v2)

| v3 위치 | v2 위치 | 변환 |
|---|---|---|
| `aimaster-desktop/services/python-audio/app/mastering/` | `dsp-core/crates/loui-dsp/src/modules/*` | **Rust 포팅** (알고리즘 보존, FFmpeg 의존 제거) |
| `aimaster-desktop/services/python-audio/app/qc/` | `engine/orchestrator/src/qc/` | Node.js TS 포팅 또는 dsp-core 메터에서 파생 |
| `aimaster-desktop/services/python-audio/app/analyzers/` | `dsp-core/crates/loui-dsp/src/analyze/` | Rust 포팅 |
| `aimaster-desktop/services/python-audio/app/utils/ffmpeg_wrapper.py` | `engine/decoders/` | symphonia (Rust) 또는 ffmpeg-wasm 으로 대체 |
| `aimaster-desktop/packages/audio-engine/` | `packages/engine-api/` + `engine/orchestrator/` | 분리 |
| `aimaster-desktop/packages/shared-types/` | `packages/shared-types/` | 도메인별 분리 |
| `aimaster-desktop/packages/license-core/` | `packages/license-core/` | 그대로 가져옴 + RemoteValidator 구현 |
| `aimaster-desktop/apps/desktop/src/renderer/audio/` (TS DSP) | **참조 구현으로만 보존** → `dsp-core` 의 Rust 와 결과 일치 검증 | Rust 가 정본, TS 는 회귀용 |
| `aimaster-desktop/apps/desktop/src/renderer/components/` | `packages/ui/src/components/` | 재사용 가능한 것은 ui 패키지로, 페이지 전용은 apps/desktop 에 |
| `aimaster-desktop/apps/desktop/src/renderer/pages/` | `apps/desktop/src/pages/` | 1 메인 + 보조 페이지로 재구성 |
| `aimaster-desktop/apps/desktop/src/main/ipc/` | `apps/desktop/src/main/ipc/` | engine-api transport 어댑터로 슬림화 |

---

## 5. 패키지 매니저 / 빌드 도구

| 도구 | 역할 |
|---|---|
| **pnpm workspaces** | JS 패키지 (현재와 동일) |
| **Turborepo** | 빌드 그래프 / 캐시 (현재와 동일) |
| **Cargo workspaces** | Rust 패키지 (`dsp-core/`) |
| **wasm-pack** | WASM 빌드 |
| **napi-rs** | N-API binding |
| **changesets** | 버전 / CHANGELOG 자동화 |
| **Storybook** | `@loui/ui` 컴포넌트 카탈로그 |
| **Playwright** | E2E (desktop via Playwright Electron, web via standard) |

---

## 6. 버저닝 / 릴리즈 라인

| 패키지 | SemVer | 비고 |
|---|---|---|
| `dsp-core` | 독립 SemVer | DSP 변경은 골든 회귀 통과 필요 |
| `@loui/ui` | 독립 SemVer | 브레이킹 시 desktop 동시 PR 필요 |
| `@loui/engine`, `engine-api` | 함께 버저닝 | 같은 IPC contract |
| `apps/desktop` | "Loui Mastering 1.x" 사용자 노출 버전 | 별도 |
| `@loui/preset-format` | 독립 SemVer | major bump 시 마이그레이션 함수 강제 |

릴리즈 채널:
- `latest` (stable)
- `beta` (RC + 베타)
- `nightly` (자동) — opt-in

---

## 7. 디렉토리 / 파일 네이밍 규칙

- 디렉토리 / 파일: `kebab-case` (예외: React 컴포넌트 파일은 PascalCase)
- TS export 심볼: `camelCase` (변수/함수), `PascalCase` (타입/컴포넌트)
- Rust: 표준 (snake_case)
- 테스트: `*.test.ts` (Vitest), `*_test.rs` (Rust)
- 픽스처: `tests/fixtures/<category>/<name>.wav`

---

## 8. 마이그레이션 단계와 매핑

`05-TARGET-ARCHITECTURE.md` § 11 의 M0~M6 와 본 문서의 패키지 도입 시점:

| 마일스톤 | 도입 패키지 |
|---|---|
| M0 | `@loui/brand`, `@loui/design-tokens` (브랜드 토큰만 분리, 이후 점진 채택) |
| M1 | `@loui/engine-api`, `@loui/shared-types` (분리), `.louiproj` 포맷 |
| M2 | `dsp-core` (Rust workspace) + 5개 핵심 모듈 |
| M3 | `@loui/ui` (Spectrum/GR/EQ/Meter 우선), `apps/desktop` UI 재구성 |
| M4 | `@loui/recommend`, `@loui/preset-format` |
| M5 | `@loui/license-core` (RemoteValidator), `services/license-server` |
| M6 | `@loui/analytics`, i18n 패키지, 베타 → GA |

---

## 9. 검증 / 가드레일

1. **Linter**: import 규칙 (eslint-plugin-import + custom rule)
2. **Boundary tests**: 각 패키지의 forbidden import 자동 검증
3. **Bundle size budget**: `@loui/ui` 100KB gzip 이내 (CI 강제)
4. **DSP determinism CI**: 모든 PR 에서 골든 회귀 통과 의무
5. **a11y CI**: Storybook + axe-core
6. **Visual regression**: Chromatic 또는 자체 Playwright snapshot
7. **Type contract test**: engine-api 의 mock transport 와 실제 transport 가 같은 타입 만족 — 컴파일 시 검증
