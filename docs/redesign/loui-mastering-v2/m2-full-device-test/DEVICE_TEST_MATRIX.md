# M2-full Device Test — Matrix

> The device + scenario grid QA fills in on real hardware.  The sandbox
> has no audio device, so these rows are TEMPLATES with target
> thresholds; QA records measured values + pass/fail.

---

## 1. Devices

| Device | CPU | OS | Status |
|---|---|---|---|
| Intel Mac (2019+)        | x86-64 | macOS | ☐ |
| Apple Silicon (M1/M2/M3) | ARM64  | macOS | ☐ |
| Windows Intel            | x86-64 | Win 10/11 | ☐ |
| Low-spec (if available)  | —      | — | ☐ |

---

## 2. CPU scenarios (record % of one core)

| Scenario | Target | Intel Mac | Apple Si | Win Intel |
|---|---|---|---|---|
| Idle (no playback)            | < 2%  | ☐ | ☐ | ☐ |
| Playback only                 | < 5%  | ☐ | ☐ | ☐ |
| Analyzer on                   | < 6%  | ☐ | ☐ | ☐ |
| Realtime mastering ON         | < 8%  | ☐ | ☐ | ☐ |
| **Analyzer + mastering**      | **< 10%** | ☐ | ☐ | ☐ |
| Export rendering + playback   | (no glitch) | ☐ | ☐ | ☐ |

Source the chain CPU from the debug panel (`cpu (chain)` = avgProcessMs
/ blockPeriodMs).

---

## 3. Glitch / stability scenarios (pass = no audible artefact)

| Scenario | Expected | Result |
|---|---|---|
| A/B compare while playing        | no click on swap | ☐ |
| Rapid knob movement (params)     | no zipper / no glitch | ☐ |
| Extreme width (0 / 200)          | stable, no NaN | ☐ |
| Extreme limiter (−3 dBTP, hot)   | no overshoot, no click | ☐ |
| Long playback (30 min)           | no memory growth, no drift | ☐ |
| Suspend/resume (tab/app blur)    | resumes cleanly | ☐ |
| Worklet load failure (simulated) | falls back to re-render, no crash | ☐ |

---

## 4. Memory

| Metric | Target | Result |
|---|---|---|
| Heap after 30 min playback | flat (± noise) | ☐ |
| WASM memory | bounded (no growth per block) | ☐ |
| xruns over 30 min | 0 (or rare, recovered) | ☐ |

The debug panel's `xruns` counter is cumulative — it must stay 0 (or
near-0 with recovery) over a long session.

---

## 5. Analyzer regression

| Metric | Target | Result |
|---|---|---|
| Spectrum FPS (realtime ON vs OFF) | no drop | ☐ |
| Meter responsiveness | unchanged | ☐ |

---

## 6. How to run

1. Build: `VITE_LOUI_REALTIME_PREVIEW=true pnpm --filter @aimaster/desktop build`
   (or set `window.__LOUI_REALTIME_PREVIEW__ = true` in DevTools).
2. Master a track, reach ProductPage, press Play.
3. Open the realtime debug panel (dev overlay).
4. Walk the scenarios above; record CPU / xruns / glitches.
5. Toggle the flag OFF mid-session — confirm seamless fallback to
   re-render preview.

---

## 7. Pass criteria (gate for flag-on default)

ALL must hold on Apple Silicon + Intel Mac + Windows Intel:
- Analyzer + mastering combined < 10% CPU
- Zero audible glitches across all scenarios
- Zero xruns over a 30-min session (or rare + auto-recovered)
- Flat memory
- Clean fallback on simulated worklet failure

Until every row passes, the flag stays OFF (see
ROLLOUT_RECOMMENDATION.md).
