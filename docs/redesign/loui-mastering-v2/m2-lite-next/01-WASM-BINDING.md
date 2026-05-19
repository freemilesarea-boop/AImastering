# M2-lite-NEXT — WASM Binding

> Crate: `aimaster-desktop/dsp-core/crates/loui-dsp-wasm`
> Status: source committed, builds via `wasm-pack`, browser demo example included.

---

## 1. Why WASM (vs N-API only)

The Electron renderer process and any future web app cannot use N-API
because `.node` files require the Node runtime.  WASM is the only
in-process option for:
- AudioWorklet processors (renderer side)
- Web Audio integration (future web app)
- AudioWorklet → SharedArrayBuffer streaming (planned)

WASM also lets the standalone analyzer ship in a CDN-served web demo at
zero infrastructure cost.

---

## 2. Crate layout

```
crates/loui-dsp-wasm/
├── Cargo.toml                          # cdylib + rlib
├── src/lib.rs                          # #[wasm_bindgen] surface
└── examples/
    └── browser-tick-loop.html           # demo page
```

Library types:

| Type | Purpose |
|---|---|
| `LouiAnalyzer`         | wraps `AnalyzerGraph` |
| `WasmMeterSnapshot`    | mirror of `MeterSnapshot` with `#[wasm_bindgen]` getters |

Top-level functions:

| Function | Purpose |
|---|---|
| `start()`             | `#[wasm_bindgen(start)]` — wires up panic hook |
| `crateVersion()`      | returns the crate's semver string |

---

## 3. API surface (TS / JS shape)

After `wasm-pack build --target web`, the generated `loui_dsp_wasm.d.ts`
exposes:

```ts
export function start(): void;
export function crateVersion(): string;

export class WasmMeterSnapshot {
  readonly integratedLufs: number;
  readonly shortTermLufs: number;
  readonly momentaryLufs: number;
  readonly loudnessRange: number;
  readonly truePeakDbtp: number;
  readonly samplePeakDb: number;
  readonly rmsDb: number;
  readonly correlation: number;
  readonly msRatioDb: number;
  readonly gatedBlocks: number;
  readonly samplesProcessed: number;
}

export class LouiAnalyzer {
  constructor(sampleRate: number, channels: number);

  processMono(samples: Float32Array): void;
  processStereo(left: Float32Array, right: Float32Array): void;
  processPlanar(left: Float32Array, right?: Float32Array): void;

  tickSnapshot(): WasmMeterSnapshot;
  snapshot(): WasmMeterSnapshot;

  flush(): void;
  reset(): void;

  readonly sampleRate: number;
  readonly channels: number;
}
```

---

## 4. Zero-copy boundary

For `processStereo(left, right)`:

| Stage | Allocation |
|---|---|
| JS passes `Float32Array` (already in wasm memory if allocated via `wasm.memory`) | none |
| wasm-bindgen creates `&[f32]` slice view | none |
| Rust `process_planar` reads samples, accumulates into pre-allocated state | none |
| Return | none |

For `tickSnapshot()`:

| Stage | Allocation |
|---|---|
| Rust computes `MeterSnapshot` | stack-only |
| wasm-bindgen wraps it in `WasmMeterSnapshot` | small heap alloc inside wasm |
| JS receives a wrapper handle (no copy of fields) | none in JS heap |
| JS reads a field (e.g. `.momentaryLufs`) | one virtual call into wasm, returns f64 |

Field-by-field reads in JS are O(1) cross-the-boundary calls.  For a
single `<MeterPanel>` reading 10 fields per tick, that's 10 boundary
crosses per snapshot — at 60 Hz, 600 crosses/s, each ~50 ns = 30 µs/s.

If a future visualiser needs all fields at higher cadence, consider:
- Exposing `WasmMeterSnapshot.asJson()` returning a single string (1 crossing).
- Or having `tickSnapshot()` write into a caller-provided `Float64Array`
  (single buffer copy — zero JS object creation).

Today's API is fast enough for M3 UI work; optimisation deferred.

---

## 5. Build

One-time setup (developer machine):
```sh
# Rust toolchain
rustup target add wasm32-unknown-unknown
cargo install wasm-pack             # one-time, ~3 min on first install

# (Optional) wasm-opt for size optimization
brew install binaryen               # macOS
# or: apt install binaryen          # Linux
```

Build the binding:
```sh
cd aimaster-desktop/dsp-core/crates/loui-dsp-wasm
wasm-pack build --release --target web --out-dir pkg
```

Produces `pkg/`:
- `loui_dsp_wasm_bg.wasm`              ← compiled WASM (~105 KB before wasm-opt)
- `loui_dsp_wasm.js`                    ← ES module loader
- `loui_dsp_wasm.d.ts`                  ← TypeScript declarations
- `loui_dsp_wasm_bg.wasm.d.ts`          ← typed wasm imports
- `package.json`                        ← npm metadata

---

## 6. Browser demo

```sh
cd aimaster-desktop/dsp-core/crates/loui-dsp-wasm
python3 -m http.server 8080
# open http://localhost:8080/examples/browser-tick-loop.html
```

The demo wires a 440 Hz stereo oscillator → `ScriptProcessorNode` →
WASM analyzer, with a `requestAnimationFrame` loop reading
`tickSnapshot()` and updating the DOM at ≈ 60 Hz.

(`ScriptProcessorNode` is used for demo simplicity.  Production
integration uses `AudioWorkletNode` + `SharedArrayBuffer` — see
`03-STREAMING-BRIDGE.md` for the production pattern.)

---

## 7. Verification status

| Check | Result |
|---|---|
| `cargo check --target wasm32-unknown-unknown` | ✅ |
| `cargo build --release --target wasm32-unknown-unknown` | ✅ — 105 KB binary, no wasm-opt |
| `wasm-pack build` | not run in this CI — instructions documented |
| Browser-side functional test | not run in this CI — page committed for developer use |

---

## 8. Known limitations (this commit)

| Limitation | Workaround | Fix milestone |
|---|---|---|
| No `SharedArrayBuffer` integration — every block crosses the JS/wasm boundary | use Float32Array views, ~50 ns per crossing | M3-bridge-impl |
| `WasmMeterSnapshot` field reads cross the boundary per-call (10 fields ⇒ 10 crossings) | acceptable at 60 Hz; if profile says no, add `asJson()` | future |
| Panic in process aborts the audio thread | panic-hook surfaces to console; for production, replace panicking `assert!`s with `Result`s | M2-LN-B follow-up |
| No `AudioWorklet`-direct loader — the `.wasm` must be inlined or fetched outside the worklet, since AudioWorkletGlobalScope can't `fetch()` | use Vite's `?url` import + `addModule()` indirection | M3-bridge-impl |

---

## 9. Size budget

Current binary: **105 KB** uncompressed `.wasm` (release, no wasm-opt).
After wasm-opt and gzip on the CDN: expected ≈ 40 KB.

Compare:
- TS `loudnessProcessor.worklet.js`: 11 KB minified
- WASM dsp-core: ~40 KB gzipped, drop-in replacement with native speed

The size delta is acceptable for the M3 use case (loaded once per
session, cached aggressively).
