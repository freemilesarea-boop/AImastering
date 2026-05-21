# RUST-OFFLINE-RENDER-2 — Loudness Parity / Safety Report

> From `pnpm test:rust-loudness` (9/9) — two-pass normalize driven over
> fixtures via the node WASM chain + analyzer, headless.

---

## 1. Results (all PASS)

| Check | Guarantee |
|---|---|
| solver: silence → no gain | quiet/silent material is never boosted |
| solver: boost/cut clamped | gain bounded to [maxCut −24, maxBoost +12] |
| silence fixture | appliedGain 0, output stays silent, no NaN |
| quiet sine → target | final integrated LUFS within **±2 LU** of target |
| loud sine | true-peak ceiling NOT exceeded after normalize (limiter holds it) |
| noise | finite, bounded by ceiling |
| stereo (L>R) | channel balance/ordering preserved |
| extreme low level | maxBoost (+12 dB) respected |
| metrics shape | measuredProcessedLufs / appliedLoudnessGainDb / finalLufs / targetLufs / finalTruePeakDb present |

## 2. Tolerances (1차)

- **Integrated LUFS:** ±2 LU on synthetic fixtures today (single push-into-
  limiter solve; one corrective pass).  A second corrective iteration can
  tighten this to ±1 LU later.
- **True peak:** the analyzer's 4× ISP estimate; treated as *approximate*
  until a dedicated high-oversampling export-peak stage is added.  The
  chain limiter still guarantees the sample/ISP peak ≤ ceiling.

## 3. vs Python export

- Python `loudnorm` and the Rust push-into-limiter are different methods →
  not sample-identical and may differ by ~1–2 LU at the margins.
- The Rust path now DOES respect `targetLufs` direction + the `targetTp`
  ceiling, which it did not in RENDER-1.

## 4. Not verified here (on-device QA)

- ffmpeg decode/encode round-trip on real files.
- Listening A/B vs Python on real material.
- Large-file time/memory profile + the ±LU spread on real (non-synthetic)
  programme material.
