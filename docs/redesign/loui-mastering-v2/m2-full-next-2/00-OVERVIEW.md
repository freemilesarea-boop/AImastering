# M2-full-NEXT-2 — Realtime Mastering Node → Production Audio Graph

> Splice the Rust/WASM realtime mastering node into ProductPage's real
> preview audio graph, flag- and readiness-gated, so QA can test the
> realtime preview on-device.  The flag stays OFF by default.

---

## 1. What shipped

| # | Deliverable | Where | Status |
|---|---|---|---|
| 1 | Audio-graph audit | `PRODUCT_AUDIO_GRAPH_AUDIT.md` | ✓ |
| 2 | Graph manager + lifecycle tests | `audio/realtime-mastering-graph.ts`; `scripts/realtime-graph-selftest.ts` (8/8) | ✓ |
| 3 | ProductPage flag-gated integration | `hooks/useRealtimeMasteringGraph.tsx`; `ProductPage.tsx` | ✓ |
| 4 | Parameter live-update bridge | `stateToChainConfig` → rAF-batched `updateConfig`, NaN-guarded | ✓ |
| 5 | Metrics / debug overlay | `LouiRealtimeDebugPanel` wired to live graph metrics + load state | ✓ |
| 6 | Fallback handling | every failure → analyzer-only graph + re-render preview | ✓ |
| 7 | Device-test hooks | `window.__LOUI_REALTIME_DEBUG__` (getState / getMetrics / dumpMetrics / exportJSON) | ✓ |
| 8 | Verification | this doc §3 | ✓ |
| 9 | Rollout recommendation | `ROLLOUT_RECOMMENDATION.md` | ✓ |

---

## 2. Architecture

The mastering node shares the analyzer session's AudioContext + the one
`MediaElementSource` (browser allows only one per element/context).  It is
spliced in via a new `setInsertNode` on the analyzer session:

```
flag OFF (default):  source → analyzer-tap → destination          (unchanged)
flag ON + ready:     source → mastering-node → analyzer-tap → destination
```

`useRealtimeMasteringGraph(session)` owns the lifecycle: attach on
`[session]` change, dispose on cleanup, rAF-batched config from the
parameter state.  Inert when the flag is OFF.

---

## 3. Verification

| Check | Result |
|---|---|
| `cargo test -p loui-dsp --lib` | **54/54** |
| `cargo check -p loui-dsp-wasm` | clean |
| `pnpm typecheck` | clean |
| `pnpm test:realtime-graph` | **8/8** lifecycle tests |
| `pnpm build:renderer` | 457 KB JS; worklet + wasm assets emitted |
| `pnpm build:main` | esbuild OK |
| `pnpm build-storybook` | builds |
| Flag OFF (default) | analyzer graph byte-identical; re-render preview unchanged |
| Flag ON + readiness OK | mastering node spliced in |
| Flag ON + readiness/load fail | analyzer-only graph; native playback |
| dispose ×N | idempotent, no error (test 6/7) |

Live device CPU/glitch measurement is deferred to QA (no audio device in
the sandbox).

---

## 4. Constraints honoured

- realtime flag NOT defaulted ON.
- re-render preview / Python export / ResultPage / V1 NOT removed.
- one `MediaElementSource` per element (reuses the analyzer's).
- AudioWorklet only (no ScriptProcessor); no fake realtime.
- no UI redesign — only a dev-only debug overlay when the flag is ON.

---

## 5. Next

1. Run `DEVICE_TEST_MATRIX` on 3 platforms with the flag ON.
2. When green, flip the flag default in a separate commit.
3. Extend the parity harness (Rust-preview vs Python-export).
