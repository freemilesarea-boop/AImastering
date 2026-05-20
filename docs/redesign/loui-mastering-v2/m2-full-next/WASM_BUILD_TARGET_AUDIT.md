# M2-full-NEXT — WASM Build Target Audit

> Audit of the current dsp-wasm build + asset handling, and the strategy
> for the second `no-modules` build target the AudioWorklet needs.

---

## 1. Current build (`--target web`) — unchanged

| Item | Value |
|---|---|
| Source crate | `dsp-core/crates/loui-dsp-wasm` |
| Build script | `dsp-core/scripts/build-wasm-bindings.sh` |
| Command | `cargo build --release --target wasm32-unknown-unknown -p loui-dsp-wasm` then `wasm-bindgen --target web` |
| Output dir | `packages/dsp-wasm/pkg/` (committed) |
| Output files | `loui_dsp_wasm.js` (ES-module glue), `loui_dsp_wasm_bg.wasm` (139 KB), `.d.ts` |
| Consumed by | renderer `import init, { LouiMasteringChain, … } from '@loui/dsp-wasm'` |
| pnpm | `pnpm --filter @loui/dsp-wasm run build` |

The `--target web` glue resolves its own `.wasm` via `import.meta.url`
and `fetch`, and uses ES-module syntax.  This is correct for the **main
thread** (renderer) and is the analyzer's loading path.

---

## 2. Why it can't load in a worklet

`AudioWorkletGlobalScope` has **no** `import.meta`, **no** `fetch`, **no**
dynamic `import()`, and a worklet processor's `process()`/constructor
cannot `await`.  The `--target web` glue relies on all of these, so it
cannot run inside the mastering worklet.

The mastering chain must process **inline** on the audio thread (unlike
the analyzer, which only taps audio to the main thread).  So the WASM has
to be instantiated *inside* the worklet — which requires a build that:

- exposes a single global value (no ES-module import), and
- supports **synchronous** instantiation from a pre-compiled
  `WebAssembly.Module` (`initSync`).

`wasm-bindgen --target no-modules` produces exactly this.

---

## 3. Asset-handling audit (Vite)

| Concern | Finding |
|---|---|
| Vite root | `apps/desktop/src/renderer` |
| `base` | `'./'` (relative — works under `file://` in Electron) |
| Public dir | `src/renderer/public/` → copied verbatim to `dist/renderer/` |
| Analyzer worklet | ships from `public/analyzer-tap.worklet.js`, loaded via root-relative URL `./analyzer-tap.worklet.js` (NOT `new URL(...,import.meta.url)` — that pattern is tree-shake-fragile) |
| `.wasm` | `assetsInclude: ['**/*.wasm']`; web build's wasm emitted under `assets/` |
| `server.fs.allow` | broadened to repo root so the web build's relative `.wasm` fetch works in dev |

**Conclusion:** the `public/` convention is the established, robust way
to ship worklet-loadable assets.  The no-modules glue + `.wasm` +
processor JS belong there.

---

## 4. Placement strategy (chosen)

1. Build `--target no-modules` to an intermediate staging dir
   `packages/dsp-wasm/pkg-worklet/` (gitignored — pure build output).
2. Append a small **bootstrap epilogue** to the glue that exposes
   `globalThis.__loui_init_mastering(wasmModule, sampleRate)` (a
   synchronous `initSync` + `new LouiMasteringChain`).
3. Copy three assets into `src/renderer/public/`:
   - `loui-mastering-wasm.nomodules.js` (glue + bootstrap)
   - `loui-mastering-wasm.nomodules.wasm` (the no-modules `.wasm`)
   - `mastering-chain.worklet.js` (the processor; source of truth is
     `src/renderer/audio/mastering-chain.worklet.js`)

The existing `--target web` output in `packages/dsp-wasm/pkg/` is **never
touched** — the renderer import path is unchanged.

---

## 5. pnpm scripts (added)

| Script | Effect |
|---|---|
| `@loui/dsp-wasm` `build` / `build:web` | existing `--target web` build (unchanged) |
| `@loui/dsp-wasm` `build:worklet` | new `--target no-modules` build → worklet assets |
| `@loui/dsp-wasm` `build:all` | both, web then worklet |

Run: `pnpm --filter @loui/dsp-wasm run build:all`.

---

## 6. Regression guarantees

- `--target web` build untouched → renderer/analyzer imports unchanged.
- `analyzer-tap.worklet.js` path untouched.
- The no-modules build is additive; the realtime flag stays **OFF**.
