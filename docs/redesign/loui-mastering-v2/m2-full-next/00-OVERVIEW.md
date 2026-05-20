# M2-full-NEXT — no-modules WASM Build + Worklet-loadable Asset 연결

> Build the `wasm-bindgen --target no-modules` artifact + the
> worklet-loadable asset pipeline so an `AudioWorkletProcessor` can
> actually load the Rust `LouiMasteringChain` WASM.  Infrastructure only —
> the realtime flag stays OFF.

---

## 1. What shipped

| # | Deliverable | Where | Status |
|---|---|---|---|
| 1 | Build-target audit | `WASM_BUILD_TARGET_AUDIT.md` | ✓ |
| 2 | no-modules build script + pnpm scripts | `dsp-core/scripts/build-wasm-worklet.sh`; `@loui/dsp-wasm` `build:web`/`build:worklet`/`build:all` | ✓ |
| 3 | Worklet-loadable assets | `src/renderer/public/{loui-mastering-wasm.nomodules.js,.wasm, mastering-chain.worklet.js}` | ✓ |
| 4 | Worklet loader (glue bootstrap) | epilogue in glue → `globalThis.__loui_init_mastering`; processor unchanged | ✓ |
| 5 | Renderer asset-URL passing | `mastering-worklet-loader.ts` (URLs + main-thread compile → addModule → node) | ✓ |
| 6 | Readiness extension | `detectWorkletAssetReadiness()` + coded reasons | ✓ |
| 7 | Debug panel WASM load state | `LouiRealtimeDebugPanel` `wasmLoad` + 3 new stories | ✓ |
| 8 | Build verification | this doc §3 | ✓ |
| 9 | Docs | pipeline / dev-prod paths / rollout blockers | ✓ |

---

## 2. Architecture

The renderer's `--target web` WASM glue can't run in a worklet (no
`import.meta`/`fetch`/`await`).  So a second `--target no-modules` build
ships glue that supports synchronous instantiation:

```
main thread:  fetch(.wasm) → WebAssembly.compile → Module
              addModule(glue)      → globalThis.__loui_init_mastering
              addModule(processor) → registerProcessor('loui-mastering-chain')
              new AudioWorkletNode(..., { processorOptions:{ wasmModule, sampleRate } })
worklet ctor: __loui_init_mastering(wasmModule, sampleRate)  // initSync — no await
```

Assets ship from Vite `public/` (verbatim copy → stable root-relative
URL, dev = prod), mirroring `analyzer-tap.worklet.js`.

---

## 3. Verification

| Check | Result |
|---|---|
| `cargo test -p loui-dsp --lib` | **54/54** |
| `cargo check -p loui-dsp-wasm` | clean |
| `pnpm --filter @loui/dsp-wasm run build:worklet` | glue 34 KB + wasm 139 KB + processor 6 KB |
| `pnpm build:web` (web target) | `pkg/` unchanged — renderer import path intact |
| `pnpm typecheck` | clean |
| `pnpm build:renderer` | 444 KB JS; **all three worklet assets present in `dist/renderer/`** |
| `pnpm build:main` | esbuild OK |
| `pnpm build-storybook` | builds (panel 5 → 8 stories) |
| Realtime flag OFF (default) | existing re-render preview unchanged |

Live device CPU/glitch measurement remains deferred to QA (no audio
device in the sandbox).

---

## 4. Honest status

The worklet WASM can now **load** — but it is not yet wired into the
production graph and has not been device-tested.  The flag stays **OFF
by default**.  Two safety nets remain: the loader rejects (caller → re-
render preview) and the worklet degrades to passthrough on any init/
process failure.

---

## 5. Constraints honoured

- realtime flag NOT defaulted ON.
- `--target web` import path NOT broken (analyzer + renderer unchanged).
- analyzer worklet path NOT broken.
- re-render preview / Python export / ResultPage / V1 NOT removed.
- AudioWorklet only (no ScriptProcessor); no fake realtime.

---

## 6. Next

1. Wire the mastering node into the production audio graph (flag + both
   readiness probes gated; re-render fallback).
2. Run `DEVICE_TEST_MATRIX` on 3 platforms → flip the flag on when green.
3. Extend the parity harness to diff Rust-preview vs Python-export.
