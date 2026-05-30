# OZONE-MODULE-NEXT-2 — EQ Curve Parameter Audit

> The EQ params, the real Rust band layout the curve must mirror, and the
> overlay's data path.

---

## 1. EQ parameters (UI state)

From `module-parameter-definitions.ts` (module `eq`):

| Param | Range | Default | Binding |
|---|---|---|---|
| `lowCutHz` | 20–120 Hz | 32 | adaptive-eq bands[lowCut].freqHz |
| `lowShelfDb` | ±6 dB | 1.2 | bands[lowShelf].gainDb |
| `presenceDb` | ±6 dB | 1.4 | bands[presence].gainDb |
| `airDb` | ±6 dB | 2.0 | bands[air].gainDb |
| `outputGainDb` | ±12 dB | 0 | gain-staging.targetPeakDb (export-renderable) |
| `adaptive` | bool | true | gentle 4 kHz harshness dip (NOT drawn) |
| (module) `bypass` | bool | — | — |

## 2. Real Rust EQ band layout (`dsp-core/.../mastering/eq.rs`)

RBJ-cookbook biquads, fixed layout:

| Band | Type | Freq | Q |
|---|---|---|---|
| Low Cut | high-pass | `lowCutHz` (≥20) | 0.707 |
| Low Shelf | low shelf | 120 Hz | 0.707 |
| Presence | peaking bell | 3 kHz | 1.1 |
| Air | high shelf | 12 kHz | 0.707 |
| Harshness | peaking | 4 kHz | 1.4 | (−1.5 dB when `adaptive`) |
| Output | gain | — | — |

The curve model reproduces the first four + output gain with the SAME
coefficient formulas, so it tracks the real preview tone direction.  The
adaptive harshness dip is intentionally not drawn (it is an automatic
control, not a user band).

## 3. Overlay data path (before → after)

| | Before (NEXT-1) | After (NEXT-2) |
|---|---|---|
| Curve math | ad-hoc heuristic `responseDb` | `eq-curve-model.ts` RBJ magnitudes (matches Rust) |
| Band model | none | `BandModel[]` (id/label/type/freq/gain/q/enabled/color) |
| Band dots | none | per-band points + output indicator |
| Labels | none | compact value labels (auto-hidden < 460 px) |
| Bypass | dim line | flat 0 dB + "EQ bypassed" note |

Overlay reads EQ params via the parameter-state provider in
`LouiAnalyzerCanvas` (`EqOverlayFromState`, guarded by
`hasParameterStateProvider`).  Props stay backward-compatible
(`width/height/bands/bypassed` + new optional `sampleRate/selectedBandId/
onSelectBand/showLabels`).

## 4. Honesty

The model is accurate to the band coefficients but remains a
*visualization* — it overlays a dBFS spectrum and omits the harshness dip.
Labelled "EQ curve · approximate" in the UI; no DSP/audio value changes.
Validated by `pnpm test:eq-curve` (8/8).
