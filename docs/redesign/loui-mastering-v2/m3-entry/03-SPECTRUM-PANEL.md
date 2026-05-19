# M3-entry — SpectrumAnalyzerPanel

> Live FFT visualiser.  Foundation for the M3 Ozone-style spectrum.

---

## 1. Component shape

```tsx
import { SpectrumAnalyzerPanel } from './components/SpectrumAnalyzerPanel';

<SpectrumAnalyzerPanel
  factory={analyzerFactory}            // optional, defaults to synthetic
  sessionOptions={{ sampleRate: 48_000, channels: 2 }}
  dbRange={{ min: -90, max: 0 }}
  hzRange={{ min: 20, max: 20_000 }}
  showPeakHold
/>
```

Renders to a canvas inside a flex / grid container.  Resize-safe via
`ResizeObserver`; DPR-aware backing store.

---

## 2. Visual design

```
┌────────────────────────────────────────────────┐
│  Spectrum · live FFT     2048 pts · 128 bins   │
├────────────────────────────────────────────────┤
│ 0 dB ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─│
│                                                │
│ -12 ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│                       ▓▓▓                      │
│ -24 ─ ─ ─ ─ ─ ─ ─ ─ ─▓▓▓▓▓▓ ─ ─ ─ ─ ─ ─ ─ ─ ─│
│                    ▓▓▓▓▓▓▓▓▓▓                  │
│ -36 ─ ─ ─ ─ ─ ─ ─▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ─ ─ ─ ─ ─ ─ ─│
│              ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓             │
│ -48 ─▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ─ ─ ─ ─ │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓        │
│  50   100   200   500  1k  2k   5k  10k  20k  │
└────────────────────────────────────────────────┘
```

- Filled trace = smoothed magnitude (violet gradient).
- Thin white line = peak-hold (optional).
- Grid: log-frequency vertical lines + dB horizontal lines.
- Background: `#09090b` (matches design tokens).

---

## 3. Rendering details

### 3.1 Canvas + DPR

```ts
const dpr = window.devicePixelRatio ?? 1;
canvas.width  = clientWidth  * dpr;
canvas.height = clientHeight * dpr;
canvas.style.width  = clientWidth  + 'px';
canvas.style.height = clientHeight + 'px';
```

ResizeObserver fires on container resize; backing store is reallocated
at the new size.

### 3.2 RAF loop

```ts
requestAnimationFrame(function draw(ts) {
  if (ts - lastDraw < 16) {       // ~60 fps cap
    requestAnimationFrame(draw);
    return;
  }
  // … render current frameRef.current …
});
```

`frameRef` is updated by an effect that watches the `fft` from
`useAnalyzerStream`.  The RAF loop reads the ref — no React re-render
per frame.

### 3.3 Coordinate mapping

```ts
// X: log frequency
function freqToX(f, fMin, fMax) {
  return (log10(f) - log10(fMin)) / (log10(fMax) - log10(fMin));
}

// Y: dB
function dbToY(db, dbMin, dbMax) {
  return 1 - clamp01((db - dbMin) / (dbMax - dbMin));
}
```

---

## 4. Performance

| Stage | Cost (per frame, modern desktop) |
|---|---:|
| Read `frameRef` | < 100 ns |
| Clear + fill background | ~50 µs |
| Grid lines (9 vertical + 8 horizontal) | ~50 µs |
| Fill trace (128 segments) | ~80 µs |
| Peak-hold trace | ~50 µs |
| Total per render | **~230 µs** |

At 60 fps: ~14 ms/s = **0.014% CPU** for rendering.  Combined with the
WASM analyzer cost (~0.50 % CPU at 48k / 256-block / FFT 2048), total
spectrum panel is **< 1 % CPU**.

---

## 5. Resize behaviour

- Container resize → `ResizeObserver` callback → new canvas backing
  store size (DPR-multiplied).
- Renderer reads `canvas.width`/`canvas.height` each frame — no
  cached dimensions.
- No state lost across resize.

---

## 6. Subscription wiring

The component opts into FFT frames via:

```tsx
const { fft } = useAnalyzerStream({ ..., enableFft: true });
```

When hidden (parent unmounts the component), `useAnalyzerStream`'s
cleanup unsubscribes → factory stops emitting FFT frames → analyzer
CPU drops.

---

## 7. Visual customisation knobs

| Prop | Effect | Default |
|---|---|---|
| `dbRange.min` / `dbRange.max` | Y axis span | -90 / 0 |
| `hzRange.min` / `hzRange.max` | X axis span | 20 / 20 000 |
| `showPeakHold` | toggle peak-hold trace | true |

For M3 Ozone-style polish: additional knobs come (line vs filled,
log/lin axis toggle, freeze mode, A/B overlay, EQ curve overlay).
This is the **foundation**, not the final visual.

---

## 8. Known limitations

| Issue | Workaround | Tracked |
|---|---|---|
| No fade-out animation on peak-hold | render-only — bind opacity to time | M3-E |
| Peak-hold line stays at -∞ until first real peak (looks jittery on start-up) | clip to dbRange.min visually | M3-E |
| No frequency tooltip on hover | M3 polish | — |
| No EQ curve overlay | M3 EQ panel work | — |
