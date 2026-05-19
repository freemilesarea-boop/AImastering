# M3-bridge-impl — Existing TS Analyzer vs WASM Analyzer Diff

> What changes when a page swaps from V1 (TS worklet) to V2 (WASM bridge).

---

## 1. Existing audio analyzer surfaces

The renderer currently has **one** audio analyzer surface:

| Component | Audio source | Analyzer code path |
|---|---|---|
| `LoudnessMeterPanel` (V1) | `<audio>` element (HTMLMediaElement) | `LoudnessStream` → `loudnessProcessor.worklet.js` (TS-compiled to JS) |

The worklet runs the LUFS analyzer (`loudnessCore.ts` algorithm) entirely
inside the audio thread.  Tick rate is 100 ms (10 Hz), posted via
`MessagePort` to the panel.

---

## 2. What V2 replaces

| Aspect | V1 | V2 (this commit) |
|---|---|---|
| Audio thread analyzer | TS LUFS, no FFT, no peak-RMS observation, no stereo correlation | minimal tap (memcpy + postMessage), no analysis |
| Main thread analyzer | none (worklet does it) | Rust dsp-core (LUFS / TP / peak / stereo / FFT) via WASM |
| Tick cadence | 100 ms (fixed) | 16/33/100 ms (per subscriber) |
| FFT spectrum stream | none | 30 Hz log-binned magnitudes + peak-hold |
| Stereo / correlation stream | none | 30 Hz correlation + MS ratio + width index |
| Integrated LUFS + LRA | available via worklet at 100 ms | via `requestSnapshot()` (off-thread, 1 Hz cap) |
| API style | event-emitter on `LoudnessStream` | `AnalyzerSession` subscription model |
| WASM build dependency | none | requires `@loui/dsp-wasm` (pre-built or built via `pnpm --filter @loui/dsp-wasm build`) |
| Bundle size impact | 10 KB worklet JS | 10 KB worklet (tap) + 99 KB WASM + 29 KB JS bindings |

---

## 3. Code path comparison

V1 (existing, shipping):
```
<audio> → MediaElementSource → LoudnessProcessor (worklet)
                                       │
                                       ▼  port.postMessage({ M, S, I, TP })
                                LoudnessStream (main thread)
                                       │
                                       ▼  onMetrics callback
                                LoudnessMeterPanel (React)
```

V2 (this commit, not yet wired into pages):
```
<audio> → MediaElementSource → AnalyzerTap (worklet)
                                       │
                                       ▼  port.postMessage({ left, right })
                                WasmAnalyzerSession (main thread)
                                  ├─ LouiAnalyzer (WASM)
                                  └─ LouiSpectrumAnalyzer (WASM)
                                       │
                            ┌──────────┼──────────────┐
                            ▼          ▼              ▼
                          tick       fft frame   stereo frame
                          (60Hz)     (30Hz)      (30Hz)
                            │          │              │
                            ▼          ▼              ▼
                  LoudnessMeterPanelV2   SpectrumAnalyzerPanel   (future)
```

---

## 4. Functional parity

LUFS / TP / RMS / peak / correlation values:
- V1 uses TS K-weighted biquad (BS.1770-4 implementation in `loudnessCore.ts`).
- V2 uses the Rust K-weighted biquad (same BS.1770-4 implementation, port).

Cross-language parity (measured in M2-lite-NEXT M5 doc):
- max ΔLUFS-I: **0.32 LU**
- max ΔTP:     **0.22 dB**

Within M3 target tolerance (≤ 0.5 LU).  No audible difference expected
for users; engineers comparing absolute values should round to 0.1 LU.

---

## 5. What does NOT change

- The audio playback path itself (`<audio>` element + browser audio engine) is unchanged.
- `ResultPage`, `MasteringPage`, `HomePage`, etc. are **unchanged** in this commit.
- The existing `LoudnessMeterPanel` is **unchanged** and remains the default everywhere.
- The Python mastering pipeline is **unchanged**.
- The TS realtime preview pipeline (mastering preview path) is **unchanged**.

Only `App.tsx` gained a URL-query check that routes to the dev page.
No other production page touched.

---

## 6. Migration plan (M3-meter-swap)

Step 1 — feature-flag the swap inside `LoudnessMeterPanel`:
```tsx
function LoudnessMeterPanel(props) {
  if (isWasmAnalyzerEnabled()) {
    return <LoudnessMeterPanelV2 {...mapPropsToV2(props)} />;
  }
  return <LoudnessMeterPanelV1 {...props} />;
}
```

Step 2 — A/B test for 1 release.  Measure CPU + frame drops + LUFS deltas.

Step 3 — flip default to WASM.  Keep V1 importable behind dev flag for 1 more release.

Step 4 — delete V1 worklet (`loudnessProcessor.worklet.js`) + `LoudnessStream`
class.  Bundle shrinks by ~10 KB.

The same pattern applies to spectrum + stereo panels.

---

## 7. Risk inventory

| Risk | V1 behaviour | V2 behaviour | Mitigation |
|---|---|---|---|
| Worklet fails to load (404 / CSP) | Component shows "starting…" forever | Same | Health check + fallback to synthetic |
| WASM .wasm fails to fetch | n/a | Same | Health check + fallback |
| AudioContext refused (autoplay policy) | Component shows nothing | Same | User-gesture promise; UI hint |
| Sample rate mismatch (worklet @ 44.1, analyzer @ 48) | LUFS drifts | LUFS drifts | Recreate analyzer on first audio frame using actual sample rate |
| WASM heap fragmentation over long session | n/a | gradual memory grow | `stop()` then `start()` between tracks |
| postMessage queue grows under main-thread stall | n/a | bounded by GC; no spike | M3-bridge-impl-NEXT: SAB ring |

The mitigations are all small follow-up PRs and don't gate this commit.
