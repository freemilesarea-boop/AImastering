# OZONE-MODULE-NEXT-1 — Live Visualizer Mount Audit

> Where the central analyzer lives, the FFT data path, and the safest
> place to mount the live visualizer.

---

## 1. Central analyzer area (before)

| Piece | Where | Notes |
|---|---|---|
| Central canvas | `LouiAnalyzerCanvas` (ProductPage grid, `minmax(0,1fr) 320px`) | panel chrome (header "Spectrum" + footer legend) wrapping the spectrum |
| Spectrum | `SpectrumAnalyzerPanel` (inside `LouiAnalyzerCanvas` body) | owns its canvas; subscribes the session's FFT internally |
| Meters | `LouiMeterColumn` → `LoudnessMeterPanelV2` + `StereoScopePanel` | tick/stereo subscriptions (independent) |
| Session | `WasmAnalyzerProvider` → one `AnalyzerSession`; `useWasmAnalyzerSession()` | lifecycle owned by the provider; audio element drives it |
| Module suite slot | additive `moduleSuiteSlot` (chain overview), below the preset header | from OZONE-STYLE-MODULE-SUITE |

## 2. FFT data path

- `useAnalyzerSubscriptions(session, { enableFft: true })` → `fft: FftFrame | null`.
- `FftFrame`: `binCentresHz` + `magnitudeDb` (dBFS, −Infinity for silence) +
  optional `peakHoldDb`, `sampleRate`, `fftSize`.  Emitted ≤30 Hz.
- Toggling `enableFft` registers/cancels the subscription upstream (cost
  follows visibility).

## 3. Safest mount

- Replace ONLY the body of `LouiAnalyzerCanvas` (the `SpectrumAnalyzerPanel`
  slot) — keep the panel chrome (header/footer legend) so layout height,
  the grid, and meters are untouched.
- Render the live spectrum (`SpectrumWaveformCanvas` + `EQCurveOverlay`)
  measured to fill the body via `ResizeObserver`; the full
  `LouiMasteringVisualizer` chrome is the standalone/story component (would
  double the header here).
- **No double FFT work**: in live mode `SpectrumAnalyzerPanel` is NOT
  mounted, so only `LiveSpectrumBody` subscribes to FFT.
- **Fallback**: a flag (`isLiveVisualizerEnabled`, default ON) + an error
  boundary — if the visualizer throws, render `SpectrumAnalyzerPanel`.
- **EQ overlay**: read EQ params from the parameter-state provider, but
  only when present (`hasParameterStateProvider`) so non-provider usages
  (storybook) don't throw.

## 4. Risk controls

- Data-driven redraw (no RAF) keeps the analyzer FPS budget.
- ResizeObserver cleanup on unmount.
- Flag + boundary guarantee the proven panel is always recoverable.
