# VISUAL_PERFORMANCE_REPORT — Module-suite visualizer

> CPU/FPS characteristics of the spectrum + EQ-curve visualizer.

---

## 1. Design for budget

| Choice | Why |
|---|---|
| **Data-driven redraw** (no free RAF) | `SpectrumWaveformCanvas` redraws only when its props change.  The caller feeds FFT frames at the analyzer's existing cadence (≤30 Hz), so there is no extra render loop. |
| **DPR cap at 2** | avoids 3–4× overdraw on hi-DPI displays |
| **Single 2D canvas** for spectrum | cheaper than WebGL for a 128-bin line+fill; no shader/context overhead |
| **SVG for the EQ curve** | one ~96-point path, recomputed only on band change — negligible |
| **ResizeObserver** (not RAF polling) | resize-safe without per-frame layout reads |

## 2. Reuse, don't duplicate

The analyzer FFT frames already exist (`useAnalyzerSubscriptions` →
`onFftFrame`, 30 Hz cap).  When mounted live, the visualizer consumes the
SAME frames the existing meters use — no second analysis pass.  To avoid
running two full spectrum renders at once, the central visualizer is the
mount target; the legacy `SpectrumAnalyzerPanel` can be retired from that
view in the integration step.

## 3. Budget target (unchanged from M2-full)

- analyzer + UI redraw < ~10–15% of one core.
- At 30 Hz × 128 bins, a canvas line+fill is well under 1 ms/frame on
  modern hardware → ≪ budget.

## 4. Verification done here

- `pnpm build:renderer` / `build-storybook` OK.
- Components render from synthetic data in Storybook (no audio device).
- Live FPS measurement is an on-device QA item (sandbox has no display);
  the data-driven design guarantees no free-running loop is introduced.
