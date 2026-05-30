# OZONE-MODULE-NEXT-5 — Draggable EQ + Live DSP Control + Realtime Status

> Turn the module UI from "shown" into "touched + heard live": drag EQ
> band points, with every edit flowing to the Rust realtime chain.  Honest
> separation of live-preview vs export support.  No fake audio, no export
> over-claiming, Rust offline still OFF.

---

## 1. What shipped

| # | Deliverable | Where | Status |
|---|---|---|---|
| 1 | Live parameter path audit | `LIVE_PARAMETER_PATH_AUDIT.md` | ✓ |
| 2 | Draggable EQ editor | `DraggableEQCurveEditor.tsx` | ✓ |
| 3 | EQ drag model | `eq-drag-model.ts` (+ `test:eq-drag` 7/7) | ✓ |
| 4 | EQ parameter binding | central overlay drags → `eq.setParam` (clamp/quantise/log → live chain) | ✓ |
| 5–7 | Dynamics / Limiter / Maximizer / Imager live control | already wired (audit §1) — verified, GR meter live | ✓ |
| 8 | Realtime status UX | `LouiRealtimeStatus` (live / starting / unavailable / off) | ✓ |
| 9 | Export honesty | module status + export-support badges unchanged (preview-only stays preview-only) | ✓ |
| 10 | Storybook | EQ-editor (flat/lowcut/presence-cut/air/warm/bypassed) + realtime-status (4) | ✓ |
| 11 | Verification | this doc §2 | ✓ |

---

## 2. Verification

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm test:eq-drag` | **7/7** (freq/gain round-trip, quantise/clamp/NaN, per-band drag) |
| `pnpm build:renderer` / `build:main` / `build-storybook` | OK |
| `cargo test -p loui-dsp --lib` | 54/54 |
| full desktop suite + all module/rust/export/preset/revision selftests | no regression |
| EQ drag → parameter state | via `setParam` (clamped/quantised/logged) |
| parameter state → realtime graph config | existing rAF → `updateConfig` (flag ON) |
| invalid drag value | `quantize` NaN-guard + clamp |
| realtime flag OFF | app fine; status chip says "edits apply on Update Preview" |
| realtime flag ON | `updateConfig` pushes live; status chip "Live preview active" |
| export / preset / revision / live visualizer | untouched |

---

## 3. Honesty + constraints

- **No fake audio:** drags write real parameter values that drive the real
  Rust chain (flag ON) or stage for re-render (flag OFF).
- **Live ≠ export:** the realtime status chip + module/export badges make
  clear that hearing an edit live does NOT mean it's in the exported file —
  EQ tone / Dynamics stay export-`preview-only` until the Rust offline
  backend is promoted (gated separately).
- Rust offline default OFF · Python pipeline kept · no ProductPage layout
  overhaul (draggable editor reuses the existing central overlay; status
  chip sits above the existing module chain) · ResultPage/V1 intact.
- 1차 drag scope: frequency (Low Cut) + gain (shelves/bell/output); no Q
  editing yet (planned).

On-device QA recommended for the drag-to-hear feel (no audio device in the
sandbox); the drag math + binding are verified headlessly + via Storybook.
