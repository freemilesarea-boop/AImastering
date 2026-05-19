# M3 Product — Spectrum Panel in ResultPage

> The first user-facing live spectrum analyser.  Mounted under the
> meter panel; visible only when V2 is on.

---

## 1. Where it lives

Inside `<AnalyzerPanelStack>` when the WASM analyzer flag is on:
```
ResultPage
   └── AnalyzerPanelStack
         └── V2PanelStack
              ├── LoudnessMeterPanelV2
              ├── SpectrumAnalyzerPanel        ← here
              └── StereoScopePanel
```

No page-level changes for the spectrum panel itself.  It rides on the
gate that was already added for the meter swap.

---

## 2. Visual design

```
┌────────────────────────────────────────────────────┐
│  Spectrum · live FFT       2048 pts · 128 bins      │
├────────────────────────────────────────────────────┤
│ 0 dB ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│                                                    │
│ -12 ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│                       ▓▓▓                          │
│ -24 ─ ─ ─ ─ ─ ─ ─ ─ ─▓▓▓▓▓▓ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│
│                    ▓▓▓▓▓▓▓▓▓▓                      │
│ -36 ─ ─ ─ ─ ─ ─ ─▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ─ ─ ─ ─ ─ ─ ─ ─│
│              ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓                │
│ -48 ─▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ─ ─ ─ ─ ─ │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓            │
│  50   100   200   500  1k  2k   5k  10k  20k      │
└────────────────────────────────────────────────────┘
```

- Filled trace: smoothed magnitude in violet gradient
- Thin white line: peak-hold (toggleable via `showPeakHold` prop)
- Log-frequency X (20 Hz – 20 kHz), dB Y (-90 to 0)
- Background: `#09090b` matches existing design tokens
- Container: `h-48` (192 px); flexible width

---

## 3. Data path

```
audio source (audio element)
   │
   ▼ (V2PanelStack inside WasmAnalyzerProvider)
WasmAnalyzerSession (one per page)
   │
   ▼ onFftFrame()
SpectrumAnalyzerPanel
   │
   ▼ frameRef updated in effect
RAF loop reads frameRef → draws to canvas
```

The RAF loop runs at ≤ 60 Hz; FFT frames arrive at 30 Hz (capped in the
session).  The RAF/frame mismatch is fine — the latest frame ref is
always the most-recent data.

---

## 4. Customisation knobs (props)

| Prop | Default | Effect |
|---|---|---|
| `session?: AnalyzerSession \| null` | provided by context | external session override |
| `dbRange?: { min, max }` | `-90 / 0` | Y axis span |
| `hzRange?: { min, max }` | `20 / 20000` | X axis span (logarithmic) |
| `showPeakHold?: boolean` | `true` | peak-hold trace on/off |

Customisations not yet exposed (future work):
- Bin count (128 default, see Rust side `SpectrumOptions::bins`)
- FFT size (2048 default — affects analysis latency vs resolution)
- Smoothing coefficient (0.5 default — controls visual time constant)
- Peak-hold decay rate (1.5 dB/frame default)
- Linear vs log Y axis
- A-weighting overlay
- EQ curve overlay (M4)

---

## 5. Performance

From M3-entry benchmarks (release builds, modern x86):

| Stage | Cost |
|---|---:|
| FFT 2048 (per frame) | 42.88 µs |
| Bin to 128 log bins + smoothing + peak-hold | ~8 µs |
| Magnitude `Vec<f32>` boundary copy (Rust → JS) | ~5 µs |
| Canvas render (grid + fill + peak-hold) | ~230 µs |
| **Total per frame @ 30 Hz** | **~290 µs** → 8.7 ms/s = **0.87% CPU** |

For typical ResultPage load (idle scrubbing + meter + spectrum), the
combined V2 budget stays under 4% CPU on modern desktops.

---

## 6. Resize / DPR

Canvas backing store is re-sized on `ResizeObserver` callback at
device-pixel ratio (DPR-aware):

```ts
const ro = new ResizeObserver((entries) => {
  const dpr = window.devicePixelRatio ?? 1;
  canvas.width  = entry.contentRect.width  * dpr;
  canvas.height = entry.contentRect.height * dpr;
});
```

The RAF loop reads `canvas.width / canvas.height` per frame — no
cached dimensions.  No re-render needed on resize.

---

## 7. Hide for off-screen panels (future)

Currently the panel renders RAF-driven even when scrolled out of view.
This wastes ~9 ms/s of CPU.  Mitigation: use `IntersectionObserver` to
pause RAF when off-screen.  Tracked as polish for M3-P-NEXT.

---

## 8. Verification status

| Check | Status |
|---|---|
| Builds with V2 panels mounted in ResultPage | ✅ |
| RAF loop guards against null canvas + null frame | ✅ |
| Renders empty state (no frames yet) | ✅ |
| Renders correctly with synthetic factory in dev page | ✅ |
| Real-audio rendering with WASM session | ⏳ manual smoke |
| 60+ fps stability over 60 s | ⏳ manual smoke |
| No frame drops during rapid window resize | ⏳ manual smoke |
