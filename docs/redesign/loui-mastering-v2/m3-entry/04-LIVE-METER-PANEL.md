# M3-entry — LoudnessMeterPanelV2

> Stream-backed loudness meter.  Same screen content as the existing
> `LoudnessMeterPanel`; the data source is swappable.

---

## 1. Why V2 (not modify V1)

| Reason | Trade-off |
|---|---|
| Existing `LoudnessMeterPanel` is wired into multiple pages — touching it risks regression | Two components ship side-by-side for one milestone |
| V2 is data-source-swappable (factory pattern) — V1 is hard-coded to `loudnessProcessor.worklet.js` | Inevitable; V2 is the migration shape |
| Stream pipeline is unproven at M3-entry — keep V1 as fallback during A/B testing | Standard "feature flag" pattern |

After A/B testing in M3, V1 is deleted and V2 renamed to `LoudnessMeterPanel`.

---

## 2. Component API

```tsx
<LoudnessMeterPanelV2
  factory={analyzerFactory}                // optional; defaults to synthetic
  sessionOptions={{ sampleRate: 48_000, channels: 2 }}
  tickRate="30Hz"                          // '60Hz' | '30Hz' | '10Hz'
/>
```

Displays (in order):
- Momentary LUFS
- Short-term LUFS
- True peak (dBTP)
- Sample peak (dBFS)
- RMS (dBFS)

Plus a small footer with correlation + M/S ratio.

---

## 3. Visual design

```
┌────────────────────────────────────────────────┐
│  Loudness · stream            30Hz · 1,234,567 sm │
├────────────────────────────────────────────────┤
│ Momentary   ████████░░░░░░░░░░░░░░  -14.2 LUFS │
│ Short-term  █████████░░░░░░░░░░░░░  -13.8 LUFS │
│ True peak   ██████████░░░░░░░░░░░░   -1.0 dBTP │
│ Sample peak ██████████░░░░░░░░░░░░   -1.1 dBFS │
│ RMS         ██████░░░░░░░░░░░░░░░░  -20.3 dBFS │
├────────────────────────────────────────────────┤
│ correlation 0.987  │  M/S ratio  +7.4 dB         │
└────────────────────────────────────────────────┘
```

- Bar fill: linear scale across `dbToBar(value, minDb, maxDb)` range.
- Bar colour:
  - LUFS bars: green (-23..-14) / amber (-14..-10) / red (>-10).
  - Peak bars: violet (#a78bfa).
- Tabular-nums + monospace font for stable layout.

---

## 4. Update cadence

`tickRate` prop selects the cadence:
- `'60Hz'` — animation-smooth; rapid response.
- `'30Hz'` — default; matches typical broadcasting meters.
- `'10Hz'` — minimum perceived "live" feeling.

Lower tick rates reduce both:
- Bridge traffic (postMessage / wasm calls).
- React reconciliation work.

For dense screens with several meters, prefer `'10Hz'`.

---

## 5. Comparison vs V1

| Aspect | V1 (existing) | V2 (this commit) |
|---|---|---|
| Data source | hard-coded `LoudnessStream` (TS worklet) | any `AnalyzerSessionFactory` |
| LUFS engine | TS `loudnessCore.ts` | swappable (synthetic / WASM / N-API) |
| Updates | LoudnessStream callback | React hook + subscription |
| Cadence | fixed 100 ms | configurable per consumer |
| Includes correlation / MS ratio | no | yes |
| Test isolation | requires AudioWorklet | works with synthetic factory |

---

## 6. Performance

Rendering: pure DOM (no canvas).  React reconciliation per tick is small
— 5 bars + 2 footer items × `useMemo` on the row array.

| Cadence | React work per second |
|---|---:|
| 60 Hz | ~30 ms |
| 30 Hz | ~15 ms |
| 10 Hz | ~5 ms |

Combined CPU (synthetic factory + render): well under 1 % on idle desktop.

---

## 7. Verification (manual today; CI in M3)

| Test | How |
|---|---|
| Mounts cleanly with synthetic factory | manual: dev page |
| Bars animate within 500 ms of mount | manual: visual |
| Stops on unmount (no orphan timer) | manual: leak detector / DevTools |
| Re-mounts produce fresh state | manual: dev hot-reload |
| `tickRate` change re-creates subscription | manual: React DevTools |
| Resize handling | n/a (pure DOM, no canvas) |

For the CI plan:
- Add Playwright Electron tests at M3-bridge-impl (when WASM factory
  exists; synthetic factory isn't a realistic test source).
- Assert: bars present, values change after 1 s, no console errors.

---

## 8. Production wiring (M3 follow-up — NOT this commit)

```tsx
// apps/desktop/src/renderer/bootstrap.tsx
import { WasmAnalyzerSessionFactory } from './audio/analyzer-session-wasm';

const analyzerFactory = new WasmAnalyzerSessionFactory();

// Provide via context if many components share one session:
<AnalyzerSessionFactoryContext.Provider value={analyzerFactory}>
  <App />
</AnalyzerSessionFactoryContext.Provider>
```

Then in ResultPage / MasteringPage etc:
```tsx
const factory = useContext(AnalyzerSessionFactoryContext);
return <LoudnessMeterPanelV2 factory={factory} />;
```

Deferred — that's M3 UI plumbing, not foundation work.
