# M2-full-NEXT-2 — Rollout Recommendation

> Can `VITE_LOUI_REALTIME_PREVIEW` default ON?  Updated verdict after the
> production-graph wiring.

---

## 1. Verdict: still **OFF by default** — but now device-testable

The realtime mastering node is now wired into the real ProductPage audio
graph, **flag- and readiness-gated**.  The remaining blocker is the
device test itself (CPU / glitch / memory on real hardware), which cannot
run in the CI sandbox (no audio device).

So the flag stays **OFF by default**; QA can flip it ON to test.

---

## 2. What is now done

| Blocker | Status |
|---|---|
| no-modules WASM build + assets | RESOLVED (M2-full-NEXT) |
| Worklet loader (compile → addModule → node) | RESOLVED (M2-full-NEXT) |
| **Splice node into production graph (flag + readiness gated)** | **RESOLVED (this milestone)** |
| Parameter live-update bridge | RESOLVED (rAF-batched, NaN-guarded) |
| Metrics / debug overlay on the real graph | RESOLVED |
| Fallback on every failure path | RESOLVED |
| Device test pass (3 platforms) | OPEN — needs hardware |
| Live CPU < budget / zero xruns / flat memory | OPEN — device test |

---

## 3. How QA turns it on

1. `pnpm --filter @loui/dsp-wasm run build:all` (web + worklet assets).
2. Run the app with `VITE_LOUI_REALTIME_PREVIEW=true`, or at runtime set
   `window.__LOUI_REALTIME_PREVIEW__ = true` and reload.
3. Open a track on ProductPage and press play.  The debug overlay
   (bottom-right) shows: wasm phase, node ready, CPU %, xruns, limiter GR.
4. Device-test hooks in the console:
   - `__LOUI_REALTIME_DEBUG__.dumpMetrics()` → console.table
   - `__LOUI_REALTIME_DEBUG__.getState()` → load + status
   - `__LOUI_REALTIME_DEBUG__.exportJSON()` → JSON for the QA bundle

---

## 4. Acceptance gate (before flag default ON)

Per `DEVICE_TEST_MATRIX.md`, on Apple Silicon + Intel Mac + Windows Intel:

- chain process time < ~30% of the block period (jitter headroom),
- analyzer + chain combined < 10% of one core,
- zero xruns / no audible clicks under rapid knob-drag (config churn),
- flat memory across a long session,
- clean fallback: toggling the flag / failing the load returns to the
  re-render preview with no crash and no silence.

Only when all are green should the flag default change — in a separate,
reviewable commit.

---

## 5. Safety summary (why this is safe to merge OFF)

| Failure | Behaviour |
|---|---|
| Flag OFF (default) | hook inert; analyzer graph byte-identical; re-render preview drives sound |
| readiness fail | hook does not attach; native playback |
| worklet load / wasm init / node ctor fail | manager removes node → analyzer-only graph; re-render preview |
| process error on audio thread | worklet degrades to passthrough + bypass |
| session recreated (play/pause) | hook re-attaches to the new session; old graph disposed |
| dispose (unmount) | `setInsertNode(null)` restores analyzer-only graph; idempotent |

Re-render preview, Python export, ResultPage/V1, A/B compare, Update
Preview: all untouched.  Realtime is additive + OFF.
