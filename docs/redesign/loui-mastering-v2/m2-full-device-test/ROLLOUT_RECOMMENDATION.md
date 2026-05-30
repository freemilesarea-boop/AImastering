# M2-full Device Test — Rollout Recommendation

> Can the realtime-preview flag be turned ON by default?  Current
> verdict + the gate.

---

## 1. Current verdict: **NOT YET — keep flag OFF**

The realtime infrastructure is built + verified at the code level, but
two prerequisites remain before the flag can default ON:

1. **`wasm-bindgen --target no-modules` build** of loui-dsp-wasm for the
   worklet (the renderer uses the `--target web` build, which can't load
   in an AudioWorkletGlobalScope — see AUDIOWORKLET_GRAPH_AUDIT.md §4).
2. **Device test pass** (DEVICE_TEST_MATRIX.md) on Apple Silicon + Intel
   Mac + Windows Intel — CPU < 10%, zero glitches, zero xruns, flat
   memory, clean fallback.

Neither can be completed in the CI sandbox (no audio device; build
tooling change).  So the flag stays **OFF by default** and the app uses
the proven re-render preview.

---

## 2. What IS done (this milestone)

| Item | Status |
|---|---|
| AudioWorklet graph audit | ✓ |
| Mastering worklet prototype (AudioWorklet, not ScriptProcessor) | ✓ (degrades to passthrough until no-modules WASM) |
| Realtime readiness detector | ✓ (`detectRealtimeReadiness`) |
| CPU / glitch instrumentation | ✓ (`RealtimeMetrics` + worklet metric posts) |
| Debug metrics panel | ✓ (`LouiRealtimeDebugPanel` + 5 stories) |
| Parameter live-update path | ✓ (`stateToChainConfig` → port message → `setConfig`) |
| Failure / fallback handling | ✓ (readiness gate + worklet try/catch → passthrough) |
| Device test matrix template | ✓ |
| Performance / benchmark report | ✓ (M2-full) |

---

## 3. Remaining steps to flag-ON

| Step | Owner | Blocks flag-on? |
|---|---|---|
| Add `no-modules` WASM build target + sync to a worklet-loadable asset | build | yes |
| Wire the mastering node into the production graph (gated by flag + readiness) | renderer | yes |
| Run DEVICE_TEST_MATRIX on 3 platforms | QA | yes |
| Confirm < 10% CPU + zero glitches/xruns | QA | yes |
| Confirm clean fallback on worklet failure | QA | yes |

When all pass: flip `isRealtimePreviewEnabled()` default to ON (or set
`VITE_LOUI_REALTIME_PREVIEW=true` in the build), keeping the runtime
`false` override + the error/fallback path.

---

## 4. Fallback guarantees (already in place)

| Failure | Behaviour |
|---|---|
| Flag OFF (default) | re-render preview; mastering node never created |
| Readiness fails (no AudioWorklet/WASM) | flag forced effectively off; re-render preview |
| no-modules WASM absent | worklet runs as safe passthrough; re-render preview drives the sound |
| Worklet `process` exception | catch → passthrough + bypass that block |
| Bad config | caught → bypass; never crashes the audio thread |

The re-render preview, Python export, and ProductPage/V1 fallbacks are
all untouched — realtime is purely additive + OFF.

---

## 5. Recommendation

- **Ship now with the flag OFF.**  The infrastructure (readiness,
  metrics, debug panel, fallback, worklet prototype, param path) is in
  place and verified at the code level.
- **Schedule the no-modules WASM build + a device-test pass** as the
  follow-up that flips the flag on.
- Until then, users get the stable re-render preview; power users / QA
  can opt in via `window.__LOUI_REALTIME_PREVIEW__ = true` for testing
  (with the safe passthrough degrade until the no-modules WASM lands).
