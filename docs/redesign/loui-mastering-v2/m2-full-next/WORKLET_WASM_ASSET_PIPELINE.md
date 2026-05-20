# M2-full-NEXT — Worklet WASM Asset Pipeline

> How the Rust MasteringChain WASM gets from a Rust crate into a running
> `AudioWorkletProcessor`, end to end.

---

## 1. Pipeline overview

```
dsp-core/crates/loui-dsp-wasm  (Rust)
   │  cargo build --release --target wasm32-unknown-unknown
   ▼
target/.../loui_dsp_wasm.wasm
   │  wasm-bindgen --target no-modules --no-modules-global wasm_bindgen
   ▼
packages/dsp-wasm/pkg-worklet/   (gitignored staging)
   loui_dsp_wasm.js   ← glue (defines `wasm_bindgen`)
   loui_dsp_wasm_bg.wasm
   │  append bootstrap epilogue + copy
   ▼
apps/desktop/src/renderer/public/
   loui-mastering-wasm.nomodules.js    ← glue + bootstrap
   loui-mastering-wasm.nomodules.wasm
   mastering-chain.worklet.js          ← processor (copied from audio/)
   │  vite build (public/ copied verbatim)
   ▼
dist/renderer/   (same three files at root-relative URLs)
```

Build command: `pnpm --filter @loui/dsp-wasm run build:worklet`
(script: `dsp-core/scripts/build-wasm-worklet.sh`).

---

## 2. The bootstrap epilogue

`wasm-bindgen --target no-modules` emits
`let wasm_bindgen = (function(exports){ … })(…)` — a value with
`.initSync` and `.LouiMasteringChain` attached.  As a worklet **module**,
`wasm_bindgen` stays in module scope, so the build appends:

```js
globalThis.__loui_wasm_bindgen = wasm_bindgen;
globalThis.__loui_init_mastering = function (wasmModule, sr) {
  wasm_bindgen.initSync({ module: wasmModule });   // synchronous
  return new wasm_bindgen.LouiMasteringChain(sr);
};
```

This is the contract the processor's constructor already expects.

---

## 3. Load sequence (main thread → worklet)

`apps/desktop/src/renderer/audio/mastering-worklet-loader.ts`
(`loadMasteringWorklet(ctx, opts)`):

| Phase | Thread | Action |
|---|---|---|
| `compiling-wasm` | main | `fetch(wasm)` → `WebAssembly.compile` → `Module` |
| `loading-glue` | main → worklet | `ctx.audioWorklet.addModule(glueUrl)` → defines `globalThis.__loui_init_mastering` in the worklet scope |
| `loading-processor` | main → worklet | `ctx.audioWorklet.addModule(workletUrl)` → registers `loui-mastering-chain` |
| `constructing-node` | main | `new AudioWorkletNode(ctx, 'loui-mastering-chain', { processorOptions: { wasmModule, sampleRate } })` |
| (ctor) | worklet | `__loui_init_mastering(wasmModule, sampleRate)` — synchronous, no `await` |
| `ready` | — | node returned to caller |

Why compile on the main thread?  The audio thread cannot `fetch` or
`await`; `WebAssembly.Module` is structured-cloneable, so it is passed in
via `processorOptions` and instantiated synchronously with `initSync`.

---

## 4. Failure handling (coded reasons)

`loadMasteringWorklet` rejects with a `MasteringWorkletLoadError` whose
`code` is one of:

| Code | Meaning | Caller action |
|---|---|---|
| `wasm-fetch-failed` | `.wasm` asset missing / network | re-render preview |
| `wasm-compile-failed` | corrupt / invalid wasm | re-render preview |
| `glue-module-failed` | `addModule(glue)` threw | re-render preview |
| `processor-module-failed` | `addModule(processor)` threw | re-render preview |
| `node-construct-failed` | node ctor threw (e.g. init throw) | re-render preview |
| `timeout` | load exceeded `timeoutMs` (default 5 s) | re-render preview |
| `unsupported` | no AudioWorklet / WebAssembly | re-render preview |

In the worklet itself, a missing bootstrap or an init/`process()`
exception degrades to **safe passthrough** (audio is copied input→output,
never silenced).  So there are two independent safety nets:

1. Loader rejects → caller uses the re-render preview.
2. Worklet construct succeeds but init/process fails → passthrough +
   `bypass`; the re-render preview still drives audible sound.

---

## 5. Readiness probe (no AudioContext)

`detectWorkletAssetReadiness()` in `realtime-readiness.ts` `fetch`-probes
the three asset URLs (with per-asset timeout) and returns coded reasons
(`glue-missing` / `wasm-missing` / `processor-missing`).  Combined with
the existing environment probe (`detectRealtimeReadiness`), both must
pass before the flag can be flipped on.

---

## 6. Debug panel surfacing

`LouiRealtimeDebugPanel` accepts an optional `wasmLoad`
(`MasteringWorkletLoadState`) and renders: phase, wasm compiled, glue
loaded, processor registered, node ready, fallback reason, last error.
Stories: `WasmReady`, `WasmLoading`, `WasmLoadFailed`.

---

## 7. What this milestone does NOT do

- Does **not** turn the realtime flag on (still OFF by default).
- Does **not** wire the node into the production audio graph (that is the
  next milestone — flag + readiness gated).
- Does **not** change the `--target web` build, the analyzer worklet, the
  re-render preview, or the Python export pipeline.
