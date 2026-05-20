# M2-full-NEXT — Rollout Blockers

> Live status of what stands between today and `VITE_LOUI_REALTIME_PREVIEW`
> defaulting **ON**.  Supersedes the gate list in
> `m2-full-device-test/ROLLOUT_RECOMMENDATION.md §1`.

---

## 1. Blocker status

| # | Blocker | Status | This milestone |
|---|---|---|---|
| 1 | `wasm-bindgen --target no-modules` build for the worklet | **RESOLVED** | built + shipped as worklet-loadable assets |
| 2 | Worklet-loadable asset pipeline (glue + wasm + processor in `public/` → `dist/`) | **RESOLVED** | `build-wasm-worklet.sh`, verified in `dist/renderer/` |
| 3 | Renderer loader (main-thread compile → addModule → node) | **RESOLVED** | `mastering-worklet-loader.ts` + coded failure reasons |
| 4 | Wire the node into the production audio graph (flag + readiness gated) | **OPEN** | next milestone |
| 5 | Device test pass — Apple Silicon + Intel Mac + Windows Intel | **OPEN** | needs real audio device (not in sandbox) |
| 6 | Live CPU/glitch measurement < budget, zero xruns, flat memory | **OPEN** | part of device test |

---

## 2. What changed this milestone

The #1/#2 blockers called out in the device-test rollout recommendation
are now cleared:

- `wasm-bindgen --target no-modules` build exists and is reproducible
  (`pnpm --filter @loui/dsp-wasm run build:worklet`).
- The glue carries a bootstrap epilogue exposing
  `globalThis.__loui_init_mastering` so the processor can instantiate the
  chain synchronously from a main-thread-compiled `WebAssembly.Module`.
- The three assets ship from `public/` and are verified present in
  `dist/renderer/` after `pnpm build:renderer`.
- `loadMasteringWorklet()` orchestrates compile → addModule(glue) →
  addModule(processor) → node, with a timeout and seven coded failure
  reasons; on any failure the caller falls back to the re-render preview.
- Readiness now has a second probe (`detectWorkletAssetReadiness`) that
  confirms the build shipped the assets — without an AudioContext.

---

## 3. What still blocks ON-by-default

1. **Graph wiring (#4)** — insert the node as
   `source → mastering → analyzer-tap → destination`, gated by the flag
   AND both readiness probes, with the re-render preview as fallback.
2. **Device test (#5/#6)** — `DEVICE_TEST_MATRIX.md` on three platforms:
   - chain process < ~30% of the block period (jitter headroom),
   - analyzer + chain combined < 10% of one core,
   - zero xruns / no audible clicks under knob-drag config churn,
   - flat memory, clean fallback when the flag is toggled live.

Neither is completable in the CI sandbox (no audio device).  Until both
are green, the flag stays **OFF** and the proven re-render preview drives
all audible preview + export.

---

## 4. How to flip it on (once green)

1. `pnpm --filter @loui/dsp-wasm run build:all` (web + worklet).
2. Build with `VITE_LOUI_REALTIME_PREVIEW=true` (or set
   `window.__LOUI_REALTIME_PREVIEW__ = true` at runtime).
3. Confirm the debug panel shows `wasm phase: ready`, `node ready: yes`,
   CPU within budget, zero xruns.
4. Only then change the flag default — in a separate, reviewable commit.
