# M2-full Device Test — Realtime WASM AudioWorklet Validation

> Validate the Rust/WASM realtime mastering preview in a real Electron
> environment; build the readiness / instrumentation / fallback so the
> flag can be turned on once device tests pass.  Stability over features.

---

## 1. What shipped

| Deliverable | Where | Status |
|---|---|---|
| AudioWorklet graph audit | `AUDIOWORKLET_GRAPH_AUDIT.md` | ✓ |
| Mastering worklet prototype | `audio/mastering-chain.worklet.js` (AudioWorklet; WASM-in-worklet) | ✓ |
| Realtime readiness detector | `audio/realtime-readiness.ts` | ✓ |
| CPU / glitch instrumentation | `audio/realtime-metrics.ts` + worklet metric posts | ✓ |
| Device test matrix | `DEVICE_TEST_MATRIX.md` (QA template) | ✓ |
| Parameter live-update path | `stateToChainConfig` → port message → `setConfig` | ✓ |
| Failure / fallback handling | readiness gate + worklet try/catch → passthrough | ✓ |
| Debug metrics panel | `LouiRealtimeDebugPanel` + 5 stories | ✓ |
| Benchmark / perf report | M2-full `PERFORMANCE_BENCHMARK.md` | ✓ |
| Rollout recommendation | `ROLLOUT_RECOMMENDATION.md` | ✓ |

---

## 2. Architecture

The mastering chain must process inline (not a main-thread tap), so the
Rust WASM runs INSIDE an `AudioWorkletProcessor`:

```
element → MediaElementSource → loui-mastering-chain worklet → analyzer tap → destination
```

- AudioWorklet (NOT ScriptProcessor).
- Stereo, processed on the audio thread, allocation-free steady state.
- Params via `port.postMessage` → `setConfig` between blocks.
- Metrics posted every 64 blocks (process time, xruns, GR) → `RealtimeMetrics`.

---

## 3. Honest status

Two prerequisites remain before the flag can default ON (neither
completable in the CI sandbox — no audio device + a build-tooling change):

1. **`wasm-bindgen --target no-modules`** build for the worklet (the
   renderer's `--target web` build can't load in a worklet scope).
2. **Device test pass** on Apple Silicon + Intel Mac + Windows Intel.

So the flag stays **OFF by default**.  The worklet degrades to a safe
passthrough until the no-modules WASM lands; the app uses the proven
re-render preview throughout.

---

## 4. Verification

| Check | Result |
|---|---|
| `cargo test -p loui-dsp --lib` | **54/54** |
| `pnpm typecheck` | clean |
| `pnpm build:renderer` | 444 KB JS / 139 KB WASM |
| `pnpm build` (main) | esbuild OK |
| `pnpm build-storybook` | **16 components / 108 stories** |
| Realtime flag OFF (default) | existing path unchanged |
| Fallback (readiness/worklet/config failure) | passthrough + re-render, no crash |

Live device CPU/glitch measurement is deferred to QA (DEVICE_TEST_MATRIX).

---

## 5. Fallback guarantees

| Failure | Behaviour |
|---|---|
| Flag OFF (default) | re-render preview; mastering node never created |
| AudioWorklet/WASM unavailable | readiness fails → re-render preview |
| no-modules WASM absent | worklet = safe passthrough; re-render drives sound |
| process exception / bad config | caught → passthrough + bypass; no audio-thread crash |

Re-render preview, Python export, ProductPage/V1 fallbacks: all
untouched.  Realtime is additive + OFF.

---

## 6. Constraints honoured

- glitch-free priority (safe passthrough on any failure)
- no audio-thread blocking (no await/locks; metrics are cheap posts)
- CPU tracked (instrumentation + debug panel)
- fallback always available (3 levers + worklet degrade)
- realtime fails → re-render preserved
- AudioWorklet only (no ScriptProcessor)
- no re-render/export/ResultPage/V1 removal; no fake realtime; no UI redesign

---

## 7. Next

1. Add the `no-modules` WASM build target + worklet-loadable asset.
2. Wire the mastering node into the production graph (flag + readiness gated).
3. Run DEVICE_TEST_MATRIX on 3 platforms → flip the flag on when green.
