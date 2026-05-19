# M3-bridge-impl — Production WASM Analyzer Wiring

> Connects the Rust dsp-core (M2-lite + M2-lite-NEXT + M3-entry) to
> actual audio streams via a real `WasmAnalyzerSessionFactory`.
> Synthetic factory remains as the dev-only fallback.

---

## 1. Where we are

| Milestone | Status |
|---|---|
| M1 / M1.5 / M1.75 | ✅ schemas + policy + reference profile |
| M2-lite           | ✅ Rust `loui-dsp` (LUFS / TP / peak / stereo) |
| M2-lite-NEXT      | ✅ WASM + N-API bindings + TS streaming types |
| M3-entry          | ✅ FFT streaming + V2 components + synthetic factory |
| **M3-bridge-impl (this)** | **✅ Real WASM factory + AudioWorklet tap + feature flag + dev panel** |
| M3 UI proper      | next — meter swap + spectrum page wire-up + Ozone-style polish |

---

## 2. What M3-bridge-impl delivers

| Artefact | Where |
|---|---|
| `@loui/dsp-wasm` workspace package | `packages/dsp-wasm/` (wasm-bindgen output, 99 KB .wasm + 29 KB .js + .d.ts) |
| Build script for the bindings    | `dsp-core/scripts/build-wasm-bindings.sh` |
| `WasmAnalyzerSessionFactory`     | `apps/desktop/src/renderer/audio/wasm-analyzer-session.ts` (440+ LOC) |
| AudioWorklet tap processor       | `apps/desktop/src/renderer/public/analyzer-tap.worklet.js` |
| Feature flag resolver            | `apps/desktop/src/renderer/audio/analyzer-factory-resolver.ts` |
| Dev demo route                   | `apps/desktop/src/renderer/pages/DevAnalyzerStreamPage.tsx` (URL: `?dev=analyzer-stream`) |
| Vite config for WASM + worklet   | `apps/desktop/vite.config.ts` (assetsInclude, fs.allow, asset naming) |
| 6 design docs                    | `docs/redesign/loui-mastering-v2/m3-bridge-impl/` |

---

## 3. Architecture (now real)

```
┌─────────────────────────────────────────────────────────────────────┐
│  apps/desktop renderer (browser context inside Electron)            │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ HTML5 <audio> / AudioBufferSource (existing preview path)   │    │
│  └────────────────────────┬────────────────────────────────────┘    │
│                           │ MediaElementAudioSourceNode             │
│                           ▼                                          │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ AnalyzerTap AudioWorkletProcessor (audio thread)             │    │
│  │   • Copies planar input → Float32Array                       │    │
│  │   • port.postMessage({ left, right }, [transferables])       │    │
│  │   • Passthrough output (no analysis on audio thread)         │    │
│  └────────────────────────┬────────────────────────────────────┘    │
│                           │ port.onmessage (main thread)            │
│                           ▼                                          │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ WasmAnalyzerSession (main thread)                            │    │
│  │   • loui-dsp-wasm LouiAnalyzer  (LUFS / TP / peak / stereo)  │    │
│  │   • loui-dsp-wasm LouiSpectrumAnalyzer (FFT 2048, log bins)  │    │
│  │   • Subscription throttling (10/30/60 Hz)                    │    │
│  └────────────────────────┬────────────────────────────────────┘    │
│                           │                                          │
│      ┌────────────────────┼──────────────────────────┐               │
│      ▼                    ▼                          ▼               │
│ ┌──────────────┐  ┌──────────────────────┐  ┌─────────────────┐    │
│ │ tick (60 Hz) │  │ fft (30 Hz)          │  │ stereo (30 Hz)  │    │
│ │ MeterTick    │  │ FftFrame             │  │ StereoFrame     │    │
│ └─────┬────────┘  └───────────┬──────────┘  └─────────┬───────┘    │
│       │                       │                       │             │
│       ▼                       ▼                       ▼             │
│ ┌──────────────────────┐  ┌──────────────────────┐                 │
│ │ LoudnessMeterPanelV2 │  │ SpectrumAnalyzerPanel│                 │
│ └──────────────────────┘  └──────────────────────┘                 │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 4. Design decisions

### 4.1 Main-thread WASM (not worklet-WASM)

The WASM analyzer runs on the **main thread**, not inside the AudioWorklet.
The worklet's only job is to copy input samples and forward them via
`port.postMessage` with `Transferable[]` (zero-copy buffer ownership transfer).

| Decision | Rationale |
|---|---|
| Worklet does memcpy only | Audio thread stays trivially fast (process is ~5 µs/block) |
| Main thread runs WASM | No worklet+ESM-import complexity; Vite handles WASM trivially via @loui/dsp-wasm |
| Latency: ~16 ms (one block period) | Well within M3 UI budget; humans don't notice |
| Future: worklet-WASM | M3-bridge-impl-NEXT — needs Vite plugin for SharedArrayBuffer + worklet imports |

### 4.2 Worklet shipped from Vite's `public/`

Vite's `new URL('./x.js', import.meta.url)` pattern is sensitive to tree-shaking
when the importing module is behind a build-time-resolvable conditional
(in our case, the `?dev=analyzer-stream` URL check).  After investigating
Vite's dead-code elimination behaviour, we ship the worklet from
`src/renderer/public/analyzer-tap.worklet.js` — Vite always copies
public/ files verbatim, no static-analysis required.

The source of truth still lives in `src/renderer/audio/` (deleted) →
we copied the working file into `public/`.  A simple `sync` script can
keep them in sync if duplicates ever diverge (future cleanup).

### 4.3 Eager factory construction in resolver

Both factories are constructed eagerly at module load:
```ts
const wasmFactory = new WasmAnalyzerSessionFactory();
const syntheticFactory = new SyntheticAnalyzerSessionFactory();
```

This prevents Vite's tree-shaker from eliminating the WASM factory when
the env var is statically `undefined`.  Construction is cheap — the
factory holds only a worklet URL string until `create()` is called.

### 4.4 Feature flag

`VITE_LOUI_WASM_ANALYZER=true` at build time **or**
`window.__LOUI_WASM_ANALYZER__ = true` at runtime.  Default: synthetic.

The dev panel exposes a `[toggle]` button so testers can A/B without
rebuilding.

---

## 5. Verification in this commit

### Verified ✅

| Check | Status |
|---|---|
| `cargo test -p loui-dsp --lib` | 31/31 pass |
| `pnpm typecheck` shared-types | clean |
| `pnpm typecheck` apps/desktop  | clean (incl. 4 new TS files + vite config edits) |
| `cargo build --release --target wasm32-unknown-unknown` | 99 KB wasm |
| `wasm-bindgen --target web` post-processing | OK (29 KB JS + 12.5 KB .d.ts) |
| `pnpm build:renderer` | OK (97 modules, all assets emitted) |
| WASM + analyzer-tap.worklet.js both in `dist/renderer/` | ✅ |
| Synthetic factory still works | ✅ (default path) |
| Existing `LoudnessMeterPanel` unaffected | ✅ (untouched) |
| Existing pages unaffected | ✅ (App.tsx only adds URL-query branch) |

### Deferred to follow-up commits

| Check | Why |
|---|---|
| End-to-end analyzer attach + meter update in browser | Needs running Electron — manual smoke per `02-AUDIOWORKLET-BRIDGE.md` |
| `await session.start()` actually instantiating WASM at runtime | Same — manual |
| 60 fps in Electron for 60+ seconds | Same — manual; perf budget proven by M3-entry benchmarks |
| Cross-tab leak check | Manual via Chromium devtools |

---

## 6. Issues surfaced (for backlog)

| ID | Issue | Severity |
|---|---|---|
| **M3-BI-A** | Worklet source file lives in `public/`, breaking the in-file source organisation under `audio/` — sync script TBD | Low — works correctly |
| M3-BI-B | Vite's dead-code elimination of `new URL` patterns inside conditionally-rendered routes — documented workaround in 03-VITE-ASSET-NOTES.md | Medium — design note |
| M3-BI-C | No SharedArrayBuffer ring buffer yet — main-thread postMessage path used.  Latency ~16 ms is fine for meters/spectrum but not for low-latency feedback | Medium — M3-bridge-impl-NEXT |
| M3-BI-D | `WasmAnalyzerSessionFactory.create()` requires `start()` then `attach(source)` — two-step API; could be made one-shot helper | Low |
| M3-BI-E | `analyzer-tap.worklet.js` exists in both `src/renderer/audio/` (source) and `src/renderer/public/` (deployed) — duplicate fixed: only `public/` retained | Resolved in this commit |
| M3-BI-F | `LouiAnalyzer` / `LouiSpectrumAnalyzer` instances aren't explicitly disposed via `free()` on track change — current `reset()` keeps state but doesn't reclaim WASM heap.  Long sessions: memory grows linearly with track count | Medium |

---

## 7. Document map

| Doc | Topic |
|---|---|
| `00-OVERVIEW.md` (this) | Milestone summary |
| `01-WASM-SESSION-FACTORY.md` | The factory class: lifecycle, attach, subscription, dispose |
| `02-AUDIOWORKLET-BRIDGE.md`  | Worklet processor: protocol, realtime safety, performance |
| `03-VITE-ASSET-NOTES.md`     | What went wrong with `new URL`, why we use `public/` |
| `04-FEATURE-FLAG-FLOW.md`    | Resolver + env var + runtime override |
| `05-EXISTING-PIPELINE-DIFF.md` | V1 (`LoudnessMeterPanel` + worklet) vs V2 (this commit) |
| `06-STREAMING-PERFORMANCE.md` | Bridge cost + GC + backpressure |

---

## 8. Next commits

1. **M3-meter-swap**: feature-flag V2 in ResultPage / MasteringPage behind
   the same toggle.  A/B test for 1+ release.  Promote V2; delete V1.
2. **M3-spectrum-page**: drop SpectrumAnalyzerPanel into ResultPage / MasteringPage.
3. **M3-stereo-scope**: vectorscope component.
4. **M3-bridge-impl-NEXT**: worklet-WASM (SharedArrayBuffer ring path).
5. **M3-export-impl**: N-API factory for Electron-main-side file analysis.
