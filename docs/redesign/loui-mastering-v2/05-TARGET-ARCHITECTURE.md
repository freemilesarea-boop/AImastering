# 05 — 추천 아키텍처 (Loui Mastering v2)

> 본 문서는 v2 전체 시스템의 추천 아키텍처를 정의한다.
> 목표: **실시간 시각화 + 수동 제어 + AI 추천 하이브리드** / 상업용 출시 품질 / 향후 웹 버전까지 확장 가능.

---

## 1. 아키텍처 원칙 (Architectural Principles)

| # | 원칙 | 의미 |
|---|---|---|
| 1 | **Single DSP Core** | 한 개의 DSP 코어 라이브러리. 실시간/오프라인/네이티브/WASM 모두 동일 코드. |
| 2 | **Deterministic Output** | 같은 입력 + 같은 그래프 = 같은 SHA256 출력 (플랫폼/빌드 무관). |
| 3 | **Streaming First** | 블록 처리. 풀버퍼 금지. 라이브 미리듣기 가능. |
| 4 | **Module Graph** | 고정 파이프라인 폐기. 사용자 편집 가능한 노드 그래프. |
| 5 | **AI Suggests, User Decides** | AI 는 추천을 표시할 뿐 자동 적용 안 함 (사용자 명시적 accept). |
| 6 | **Strict Layering** | UI / Engine API / DSP Core / Native Bridge / OS — 단방향 의존. |
| 7 | **Brand-Agnostic Core** | DSP Core 와 Engine 은 브랜드 무관. UI 만 Loui. |
| 8 | **Telemetry Opt-in** | 데이터 수집은 명시 동의. |

---

## 2. 시스템 다이어그램

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              CLIENTS                                          │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────┐    │
│  │  Loui Desktop        │  │  Loui Web (future)   │  │  CLI / Plugin    │    │
│  │  (Electron)          │  │  (Browser PWA)       │  │  (future)        │    │
│  │                      │  │                      │  │                  │    │
│  │  React + Vite        │  │  React + Vite        │  │  Node CLI        │    │
│  │  @loui/ui            │  │  @loui/ui            │  │  npm scripts     │    │
│  └────────┬─────────────┘  └────────┬─────────────┘  └────────┬─────────┘    │
│           │                          │                         │              │
│           └────────────────┬─────────┴─────────────────────────┘              │
│                            ▼                                                  │
│                  ┌───────────────────────┐                                   │
│                  │   @loui/engine-api    │ ← 타입 안전 클라이언트            │
│                  │   (TS)                │   (전송 추상화: IPC / HTTP / FFI) │
│                  └────────┬──────────────┘                                   │
└───────────────────────────┼──────────────────────────────────────────────────┘
                            │
            ┌───────────────┼───────────────┐
            │               │               │
            ▼               ▼               ▼
┌─────────────────┐  ┌─────────────┐  ┌─────────────────┐
│  Desktop IPC    │  │  HTTP REST  │  │  In-process     │
│  (Electron)     │  │  (Web BE)   │  │  (FFI / WASM)   │
└────────┬────────┘  └──────┬──────┘  └────────┬────────┘
         └───────────┬──────┴──────────────────┘
                     ▼
            ┌────────────────────────────────────────────────┐
            │           @loui/engine (Node/Rust)              │
            │  ┌──────────────────────────────────────────┐  │
            │  │  Job Scheduler (concurrency / queue)     │  │
            │  │  Project store / Graph validation        │  │
            │  │  AI Recommendation Service               │  │
            │  │  Reference Track DB                      │  │
            │  └────────────────┬─────────────────────────┘  │
            │                   │                            │
            │                   ▼                            │
            │  ┌──────────────────────────────────────────┐  │
            │  │       @loui/dsp-core (★ Rust/C++)        │  │
            │  │   - Module Graph runtime                 │  │
            │  │   - Block-streaming                      │  │
            │  │   - EQ / Dyn / Comp / Limiter / ...      │  │
            │  │   - BS.1770-4 LUFS / TP                  │  │
            │  │   - Oversampling / Dither                │  │
            │  │   - Determinism guarantees               │  │
            │  └────────────────┬─────────────────────────┘  │
            │                   │                            │
            │     ┌─────────────┼──────────────┐             │
            │     ▼             ▼              ▼             │
            │  Native FFI   WASM build    libsoxr / KissFFT  │
            │  (N-API)      (browser)      (deps)            │
            └────────────────────────────────────────────────┘
                            │
                            ▼
            ┌───────────────────────────────────────────┐
            │  External Services (Loui Cloud)            │
            │  ┌─────────────────┐  ┌─────────────────┐ │
            │  │  License Server │  │  Preset Market  │ │
            │  │  (HMAC + Server │  │  (read CDN)     │ │
            │  │  validation)    │  │                 │ │
            │  └─────────────────┘  └─────────────────┘ │
            │  ┌─────────────────┐  ┌─────────────────┐ │
            │  │  Crash Telemetry│  │  AI Model Host  │ │
            │  │  (Sentry)       │  │  (optional)     │ │
            │  └─────────────────┘  └─────────────────┘ │
            └───────────────────────────────────────────┘
```

---

## 3. 레이어 책임

### 3.1 `@loui/dsp-core` (Rust/C++ — 네이티브 + WASM)

**책임:**
- 모듈 그래프 런타임 (노드 추가/제거/연결/실행)
- 모든 오디오 DSP 알고리즘
- 라우드니스/메터링 측정
- 결정적 / 비결정적 모드 분리
- C-ABI 인터페이스 (N-API 와 wasm-bindgen 양쪽 노출)

**비책임:**
- 파일 I/O (호출자가 버퍼로 전달)
- 네트워크
- UI / 상태 영속화
- 라이선스 검증
- 텔레메트리

**핵심 타입 (Rust 예시):**
```rust
pub struct Graph {
    modules: Vec<Module>,
    connections: Vec<Edge>,
}
pub trait Module {
    fn id(&self) -> ModuleId;
    fn params(&self) -> &Params;
    fn process(&mut self, block: &mut AudioBlock, ctx: &mut ProcessCtx);
    fn meters(&self) -> Meters;
}
pub fn render_offline(graph: &Graph, input: &AudioBuffer, opts: RenderOpts) -> AudioBuffer;
pub fn create_realtime_runtime(graph: &Graph, sr: u32, block_size: usize) -> Runtime;
```

→ 9번 문서에서 상세.

### 3.2 `@loui/engine` (Node.js orchestrator)

**책임:**
- Job 스케줄링 (병렬도 / 큐)
- 프로젝트 상태 (`.louiproj` 직렬화)
- 모듈 그래프 검증 (사이클 / 호환성 / SR / 채널)
- 파일 I/O (WAV/FLAC/MP3/AAC 읽기/쓰기 — 별도 디코더 모듈)
- AI 추천 서비스 호출 (로컬 모델 또는 클라우드)
- 참조 트랙 DB / 매칭
- 라이선스 게이트 통합
- 텔레메트리 게이트

**언어 선택:**
- 1차: **TypeScript on Node.js** (기존 자산 재활용, FFI binding 으로 dsp-core 호출).
- 2차 (성능 한계 시): **Rust** 단일 바이너리 (Electron sidecar 또는 직접 임베드).

### 3.3 `@loui/engine-api` (typed client)

**책임:**
- UI 가 호출하는 타입 안전 API (TS).
- 전송 추상화 — Electron IPC / HTTP / 같은 프로세스 FFI 를 동일 인터페이스로.
- 진행도 / 에러 / 취소 통일.

**구조:**
```ts
const engine = createEngineClient({ transport: 'ipc' /* or 'http' or 'embedded' */ });
const job = await engine.master({ projectId, graph, target });
job.onProgress((p) => ...);
const result = await job.result();
```

### 3.4 `@loui/ui` (React 컴포넌트 라이브러리)

**책임:**
- 시각화 컴포넌트 (Spectrum / GR / EQ Curve / Meter 등)
- 모듈 인스펙터 폼
- 트랜스포트 / 타임라인
- 디자인 토큰 사용
- 브랜드 무관 (Loui / Studio / OEM)

### 3.5 `apps/desktop` (Electron app)

**책임:**
- Electron main (윈도우/메뉴/업데이트)
- preload (whitelisted IPC bridge)
- @loui/ui + @loui/engine-api 통합
- 파일 시스템 통합 (drag&drop, 출력 경로)
- 자동 업데이트 (electron-updater)

### 3.6 `apps/web` (future)

**책임:**
- 같은 @loui/ui + @loui/engine-api
- 백엔드 HTTP API 호출 (마스터링은 서버에서)
- 또는 WASM dsp-core 로 직접 실행 (제한 모드)

### 3.7 `services/loui-cloud` (future)

**책임:**
- License 발급/검증/취소
- 프리셋 마켓플레이스 (다운로드 / 등록 / 결제)
- 텔레메트리 수집 (Sentry 자체 호스팅 or SaaS)
- AI 추천 모델 호스팅 (선택)

---

## 4. 데이터 모델 (핵심)

### 4.1 모듈 그래프 (직렬화 가능)

```json
{
  "version": "1.0.0",
  "graph": {
    "id": "graph_01HF...",
    "samplerate": 44100,
    "channels": 2,
    "nodes": [
      { "id": "src",     "type": "source", "params": {} },
      { "id": "eq1",     "type": "eq",     "params": { "bands": [...] } },
      { "id": "dyneq1",  "type": "dynamicEq", "params": {...} },
      { "id": "mbcomp1", "type": "multibandComp", "params": {...} },
      { "id": "buscomp", "type": "busComp", "params": {...} },
      { "id": "img",     "type": "imager", "params": {...} },
      { "id": "sat",     "type": "saturator", "params": {...} },
      { "id": "lim",     "type": "limiter", "params": {...} },
      { "id": "lnorm",   "type": "loudnessNorm", "params": { "targetLufs": -14, "targetTp": -1.0 } },
      { "id": "dith",    "type": "dither", "params": { "type": "tpdf", "bitDepth": 16 } },
      { "id": "sink",    "type": "sink",   "params": {} }
    ],
    "edges": [
      { "from": "src",     "to": "eq1" },
      { "from": "eq1",     "to": "dyneq1" },
      ...
      { "from": "dith",    "to": "sink" }
    ]
  }
}
```

### 4.2 프로젝트 (.louiproj)

```json
{
  "version": "1.0.0",
  "createdAt": "2026-05-19T...",
  "source": { "path": "...", "hash": "sha256:..." },
  "graph": { ... },                    // 위 그래프
  "ai": { "recommendations": [...], "appliedIds": [...] },
  "history": [ { "ts": "...", "action": "param.eq1.band[0].gain", "from": 0, "to": 2.0 } ],
  "target": { "lufs": -14, "tp": -1.0, "platform": "spotify" }
}
```

### 4.3 프리셋

→ `08-PRESET-SYSTEM-DESIGN.md` 참조.

---

## 5. 통신 / 진행도 모델

### 5.1 통신 채널

| 클라이언트 | 전송 | 보안 |
|---|---|---|
| Loui Desktop ↔ Engine | Electron IPC (contextBridge) | preload whitelist |
| Loui Web ↔ Engine | HTTPS REST + WebSocket (progress) | JWT + CSRF |
| Engine ↔ License Server | HTTPS REST | mTLS or HMAC |
| Engine ↔ DSP Core | N-API (in-process) | — |
| Engine ↔ AI Service | gRPC or REST | mTLS |

### 5.2 진행도 메시지 통일

```
type ProgressEvent =
  | { type: 'progress', jobId, percent, stage }
  | { type: 'meter',    jobId, meters: MeterSnapshot }   // 실시간 모드만
  | { type: 'log',      jobId, level, message }
  | { type: 'error',    jobId, code, message }
  | { type: 'done',     jobId, result: MasteringResult }
```

`meter` 이벤트는 실시간 미리듣기 / 라이브 분석 시 60Hz 이하로 throttle.

---

## 6. 실시간 ↔ 오프라인 통합 전략

| 모드 | DSP 코어 호출 | 분기 차이 |
|---|---|---|
| **Realtime preview** | `runtime.process(block)` 매 블록 | look-ahead 짧음 / 4× oversample |
| **A/B compare** | dual runtime, 동기화된 transport | trim gain 라우드니스 매칭 |
| **Offline render** | `render_offline(graph, buffer, opts)` 1회 | look-ahead 김 / 8~16× oversample / iterative ref match 허용 |
| **Live LUFS meter** | `runtime.meters()` 100ms 풀 | DSP 결과와 분리 (passive) |

**보장**: 같은 graph 로 realtime preview 와 offline render 의 결과가 LUFS ±0.1 / TP ±0.2 dB / 스펙트럼 ΔdB RMS<0.3 이내 일치.

---

## 7. AI 추천 통합

```
[Input audio + Reference (optional)]
        │
        ▼
┌─────────────────────────────────────────────┐
│  Feature extractor (dsp-core)               │
│  - Section detect (verse/chorus)            │
│  - Spectral profile (1/3 oct, MS)           │
│  - Dynamic profile (LRA, crest, transient)  │
│  - Stereo profile (correlation, MS ratio)   │
│  - AI artifact detect                       │
└──────────────┬──────────────────────────────┘
               │ features
               ▼
┌─────────────────────────────────────────────┐
│  Recommendation engine (Python or Rust ML)  │
│  - Rule-based fallback                      │
│  - ONNX / GGML model (optional)             │
│  → Recommendation[]                         │
└──────────────┬──────────────────────────────┘
               │
               ▼
[UI: 모듈 파라미터 옆에 "AI 추천: +2.0 dB" 고스트 표시]
       │
       ▼
[사용자: Accept all / Accept this / Reject / Compare A/B]
       │
       ▼
[graph 업데이트 + history 기록]
```

**핵심**: AI 추천은 **모듈 파라미터 변화 제안**이지, 별도 모듈이 아니다. 사용자가 "AI 마법 버튼" 을 누르지 않고도 각 모듈에서 추천값을 볼 수 있다.

---

## 8. 확장성 / 향후 진입

### 8.1 플러그인 (3rd party)

- 자체 모듈을 ONNX/WASM 형태로 등록 가능 (v2.x).
- 그래프 노드에 `type: "custom://author.name"` 으로 삽입.

### 8.2 VST3 / AU / AAX 

- dsp-core 가 결정적이므로, 같은 코드를 VST3 래퍼로 빌드 가능 (v3.x).
- DAW 내 마스터링 트랙으로 동작.

### 8.3 협업 (Studio plan)

- 프로젝트 클라우드 저장 (`.louiproj` + 소스 해시)
- 권한 모델 (소유자/리뷰어)
- 변경 히스토리 sync

---

## 9. 보안 모델

| 자산 | 위협 | 완화 |
|---|---|---|
| 라이선스 키 | 도용/공유 | HMAC 서명 + 머신 바인딩 + 서버 활성화 카운트 |
| 사용자 오디오 | 임시 파일 잔존 | 메모리 우선, 임시 파일 종료 시 `unlink`, 옵션 암호화 |
| 프리셋 마켓 결제 | 결제 우회 | Stripe webhooks + 서버측 검증 |
| Auto-update | 변조된 바이너리 | code signing 강제 + 업데이트 매니페스트 SHA |
| 텔레메트리 | PII 누출 | 파일명/경로 마스킹, 사용자 opt-in 명시 |

---

## 10. 시퀀스 예 (사용자 흐름)

### 10.1 곡 마스터링 (실시간 미리듣기 → 최종 출력)

```
User                     UI (React)       Engine API     Engine        DSP Core
 │                          │                │             │              │
 │── drag file ─────────────▶                │             │              │
 │                          │── analyze ────▶│── analyze ─▶│── features ─▶│
 │                          │                │             │              │
 │                          │◀── recommend ─ │◀── result ─│              │
 │                          │                │             │              │
 │── adjust EQ band ────────▶ (debounce)     │             │              │
 │                          │── preview ────▶│── stream ──▶│── process ──▶│
 │                          │◀ meter ─ block ◀ block ─────◀ block ───────◀│
 │◀── audio out  ◀────[Web Audio dest]                                    │
 │                                                                         │
 │── click "Export" ────────▶                │             │              │
 │                          │── master ────▶ │── master ─▶│── render ────▶│
 │                          │◀ progress ────│◀ progress ──│              │
 │                          │◀── done ──────│◀── done ────│              │
 │◀ download WAV ──────────                                                │
```

### 10.2 결정성 회귀 테스트 (CI)

```
CI agent ──▶ engine.renderOffline(graph, fixture.wav)
         ──▶ assert sha256(out) == golden.sha256
         ──▶ assert |lufs(out) - golden.lufs| < 0.05
         ──▶ assert |tp(out)   - golden.tp|   < 0.1
```

---

## 11. 마이그레이션 전략 요약

| 단계 | 기간 | 핵심 작업 |
|---|---|---|
| **M0** Audit & freeze v3 | 1주 | 본 문서 셋 / v3 코드 동결 / 사용자 마이그레이션 약속 |
| **M1** Engine API + Project file | 2주 | TS 측 engine-api 추상화 / `.louiproj` 스키마 / IPC 통일 |
| **M2** DSP Core Skeleton (Rust) | 4주 | 그래프 런타임 / 5개 핵심 모듈 (EQ/Comp/Limiter/Loudness/Dither) / WASM 빌드 / Determinism CI |
| **M3** UI Studio | 6주 | 새 메인 화면 / 시각화 / 모듈 인스펙터 / 단축키 |
| **M4** AI Recommend + Reference | 4주 | feature extractor / 추천 엔진 / 참조 트랙 매칭 / UI 통합 |
| **M5** License + 결제 + Auto-update | 3주 | RemoteValidator / Stripe / 사인/노타라이즈 / EV cert |
| **M6** 베타 → GA | 4주 | i18n / a11y / 텔레메트리 / 문서 / FAQ / 결제 / 환불 정책 |

총 약 **24주** (6개월).
