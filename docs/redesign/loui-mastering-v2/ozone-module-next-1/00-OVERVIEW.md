# OZONE-MODULE-NEXT-1 — Live FFT Visualizer mounted in ProductPage

> Wire the live FFT spectrum + approximate EQ-curve overlay into
> ProductPage's central analyzer area, with a flag + error-boundary
> fallback to the proven spectrum panel.  Visualization only — no DSP /
> export / preset / revision / realtime-graph change.

---

## 1. What shipped

| # | Deliverable | Where | Status |
|---|---|---|---|
| 1 | Mount audit | `LIVE_VISUALIZER_MOUNT_AUDIT.md` | ✓ |
| 2 | FFT → visualizer adapter | `audio/modules/analyzer-to-visualizer-adapter.ts` (real data only, −Inf → floor, null = idle) | ✓ |
| 3 | Central mount | `LouiAnalyzerCanvas` body → live spectrum (canvas + EQ overlay), chrome kept | ✓ |
| 4 | EQ curve overlay | reads EQ param state (low cut/shelf/presence/air/output gain + bypass); "approximate" labelled | ✓ |
| 5 | Fallback flag | `live-visualizer-flag.ts` (`VITE_LOUI_LIVE_VISUALIZER` / `window.__LOUI_LIVE_VISUALIZER__`, default ON) + error boundary → `SpectrumAnalyzerPanel` | ✓ |
| 6 | Performance guard | data-driven redraw (no RAF), ResizeObserver cleanup, no double FFT subscription | ✓ |
| 7 | Storybook | visualizer data / no-signal / eq-bypassed / high-gain / narrow / fallback panel | ✓ |
| 8 | Verification | this doc §3 | ✓ |

---

## 2. How it works

```
WasmAnalyzerProvider session ──onFftFrame(≤30Hz)──▶ useAnalyzerSubscriptions(enableFft)
   └─ fftFrameToSpectrum(frame)  (null when no signal → idle state)
        └─ SpectrumWaveformCanvas (DPR-aware, redraw on frame only)
        └─ EQCurveOverlay (from EQ param state, approximate)
flag OFF / boundary trips ─▶ SpectrumAnalyzerPanel (unchanged fallback)
```

- Only the `LouiAnalyzerCanvas` body changed; the panel header/footer,
  grid, meter column, and session lifecycle are untouched.
- In live mode the old panel is not mounted → no duplicate FFT work.
- A/B swap, Update Preview, revision active-source changes all flow
  through the SAME session/audio element → the visualizer follows
  automatically (it renders whatever the session analyzes).

---

## 3. Verification

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm build:renderer` / `build:main` | OK |
| `pnpm build-storybook` | OK (+ live visualizer states + fallback) |
| `cargo test -p loui-dsp --lib` | 54/54 |
| full desktop suite + module/preset/revision selftests | no regression (22/22 · 9/9 · 14/14 · 11/11) |
| no signal → idle | adapter returns null → idle overlay (no mock) |
| flag off / boundary | renders `SpectrumAnalyzerPanel` |
| Export / Preset / Module chain / Revision | untouched |

---

## 4. Constraints honoured

No DSP / export / preset-tuning / realtime-flag-default change · the old
`SpectrumAnalyzerPanel` is NOT deleted (it is the fallback) · no full
ProductPage layout overhaul (only the analyzer body) · no mock/fallback
spectrum data (idle when silent).

Live FPS + the spectrum-moving-on-playback experience need the Electron
app (no audio device/display in the sandbox); verified here via build +
Storybook + the no-RAF data-driven design.
