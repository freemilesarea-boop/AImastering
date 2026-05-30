# M2-lite-NEXT — Overview

> Connect the M2-lite Rust analyzer core to actual JS / Electron / browser
> consumers.  Build the bridging layer that turns `loui-dsp` from "Rust
> library" into "platform realtime audio engine".

---

## 1. Where we are

| Milestone | Status | Deliverable |
|---|---|---|
| M1     | ✅ done | EngineSchema + adapter |
| M1.5   | ✅ done | FixtureSchema + DSP policy |
| M1.75  | ✅ done | ReferenceProfile + adaptive recommender |
| M2-lite| ✅ done | Rust `loui-dsp` (analysis/metering) |
| **M2-lite-NEXT** | **this milestone** | **WASM + N-API bindings + TS streaming API** |
| M2-full | pending | Mastering chain Rust rewrite (EQ / Comp / Limiter) |
| M3 UI   | pending | Ozone-style modular UI |

---

## 2. What M2-lite-NEXT delivers

**Six artefacts, in priority order:**

| # | Artefact | Why |
|---|---|---|
| 1 | `loui-dsp-wasm` crate | Renderer / browser / AudioWorklet consumer |
| 2 | `loui-dsp-node` crate | Electron main / Node N-API consumer |
| 3 | Streaming bridge design | How audio-thread snapshots reach the UI |
| 4 | `@aimaster/shared-types/streaming` | TS contracts for both bindings |
| 5 | Performance verification | Baselines for both binding paths |
| 6 | Future extension preservation | VST3 / CLAP / AU / Web / headless |

**Both bindings expose the same `AnalyzerGraph` API**.  M3 UI code is written
once against `AnalyzerSession` and runs unmodified in either context.

---

## 3. What M2-lite-NEXT explicitly does NOT do

| Out-of-scope | Reason |
|---|---|
| **UI redesign** | M3 work; this milestone is plumbing |
| **Mastering chain Rust rewrite** | M2-full |
| **EQ / compressor / saturator rewrite** | M2-full |
| **Preset UX overhaul** | M3 |
| **Adaptive mastering rewrite** | M1.75 already covers; M2-full will refine |
| **wasm-pack + napi CLI install** | Build tooling — documented but not packaged |
| **Wiring the React hook into pages** | M3 UI |

---

## 4. Architecture (M2-lite-NEXT after this commit)

```
                  ┌───────────────────────────────────────────────────┐
                  │             Rust crate workspace                  │
                  │  (aimaster-desktop/dsp-core)                      │
                  │                                                    │
                  │   crates/loui-dsp           ← M2-lite             │
                  │     ├─ AnalyzerGraph                              │
                  │     ├─ MeterSnapshot                              │
                  │     ├─ Lufs / TruePeak / PeakRms / Stereo / FFT  │
                  │     └─ realtime-safe contract                     │
                  │                ▲                                  │
                  │                │  path dep                        │
                  │                │                                  │
                  │   crates/loui-dsp-wasm     ← THIS commit          │
                  │     ├─ #[wasm_bindgen] LouiAnalyzer              │
                  │     ├─ WasmMeterSnapshot getters                  │
                  │     └─ build: wasm-pack build --target web        │
                  │                                                    │
                  │   crates/loui-dsp-node     ← THIS commit          │
                  │     ├─ #[napi] LouiAnalyzer                       │
                  │     ├─ JsMeterSnapshot auto-serialised            │
                  │     └─ build: napi build --release --platform     │
                  └───────────────────────────────────────────────────┘
                                  │            │
                            (WASM .wasm)  (.node binary)
                                  ▼            ▼
                  ┌───────────────────────────────────────────────────┐
                  │   apps/desktop renderer        |  apps/desktop main │
                  │   (browser / web app future)   |  (Electron main)   │
                  │                                │                    │
                  │   • AudioWorkletProcessor      │  • for export      │
                  │     hosts WASM analyzer        │    file analysis    │
                  │   • port.postMessage(snap)     │  • thumbnails        │
                  │     every 100 ms                │                     │
                  │                                │                    │
                  │   • useAnalyzerStream React    │  • IPC to renderer  │
                  │     hook                       │                    │
                  └───────────────────────────────────────────────────┘
                                  │
                                  ▼
                  ┌───────────────────────────────────────────────────┐
                  │   @aimaster/shared-types/streaming                │
                  │     • MeterSnapshot / MeterTickSnapshot           │
                  │     • FftFrame                                    │
                  │     • StereoScopeFrame                            │
                  │     • AnalyzerSession + factory interfaces        │
                  └───────────────────────────────────────────────────┘
```

---

## 5. Verification done in this commit

| Check | Status |
|---|---|
| `cargo check -p loui-dsp-wasm --target wasm32-unknown-unknown` | ✅ |
| `cargo build -p loui-dsp-wasm --target wasm32-unknown-unknown --release` | ✅ — 105 KB binary |
| `cargo check -p loui-dsp-node` | ✅ |
| `cargo test -p loui-dsp` | ✅ 26/26 (no regression after dead-code cleanup) |
| `pnpm typecheck` shared-types incl. streaming/ | ✅ |
| `pnpm typecheck` apps/desktop incl. useAnalyzerStream | ✅ |

---

## 6. Verification deferred (needs external tooling)

| Check | Tooling | Document |
|---|---|---|
| `wasm-pack build --target web` | `wasm-pack` (cargo-installed) | `01-WASM-BINDING.md` § 5 |
| `napi build --release --platform` | `@napi-rs/cli` (npm-installed) | `02-N-API-BINDING.md` § 5 |
| Browser tick-loop demo | Browser + HTTP server | `01-WASM-BINDING.md` § 6 |
| Node tick-loop demo | Built `.node` artefact | `02-N-API-BINDING.md` § 6 |

Each deferred check has a documented one-line command in its respective
doc — runnable from a developer machine with network + npm + cargo-install
access.

---

## 7. Next commits (after this one)

Suggested ordering for the M3 UI track:

1. **M3-bridge-impl**: implement `AnalyzerSessionFactory` for WASM
   (AudioWorklet) and N-API (Electron main).  No UI yet — just session
   creation tested via existing components.
2. **M3-meter-panel**: rebuild `LoudnessMeterPanel` against
   `useAnalyzerStream`.  Replace the existing `loudnessProcessor.worklet.js`
   TS implementation with WASM.  A/B test for ≥ 1 release.
3. **M3-spectrum-panel**: new `<SpectrumAnalyzerPanel>` using `FftFrame`
   subscriptions.  Live with vectorscope at the same cadence.

---

## 8. Issues surfaced this milestone (for backlog)

| ID | Issue | Severity |
|---|---|---|
| **M2-LN-A** | `processPlanar` in WASM accepts `Option<Vec<f32>>` which allocates per-call for stereo — `processStereo` fast path exists but users may hit the slow path | Low |
| **M2-LN-B** | wasm-bindgen `start` hook depends on `console_error_panic_hook` — opt-in feature; size cost ~10 KB | Trivial |
| **M2-LN-C** | N-API `Float32Array` lifetime is per-call; for cross-frame sharing (SharedArrayBuffer / wasm memory) the binding needs a `RingBuffer` type | Medium |
| **M2-LN-D** | No triple-buffer / SPSC publisher implementation yet — UI thread polls instead of subscribing to wake-up | Medium (M3) |
| **M2-LN-E** | FFT analyzer not yet exposed via binding — `MeterSnapshot` covers loudness only.  Spectrum needs separate `Spectrum::process` API in loui-dsp | High (M3 dependency) |
| **M2-LN-F** | Build matrix not yet in CI — both wasm + napi builds should be PR-gated | Low |

---

## 9. Document map

| Doc | Audience |
|---|---|
| `00-OVERVIEW.md` (this) | Milestone leads |
| `01-WASM-BINDING.md` | Frontend / browser devs |
| `02-N-API-BINDING.md` | Electron / Node devs |
| `03-STREAMING-BRIDGE.md` | Audio-pipeline architects |
| `04-TS-STREAMING-API.md` | UI consumers of analyzer data |
| `05-PERFORMANCE-VERIFICATION.md` | Performance engineering |
| `06-FUTURE-EXTENSIBILITY.md` | Plugin / platform planning |
