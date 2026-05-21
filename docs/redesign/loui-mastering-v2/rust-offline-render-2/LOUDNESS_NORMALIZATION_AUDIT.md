# RUST-OFFLINE-RENDER-2 — Loudness Normalization Audit

> What loudness-measurement infrastructure is available for the Rust
> offline render.

---

## 1. Existing LUFS measurement (reused, not reimplemented)

| Where | What |
|---|---|
| `dsp-core/.../lufs.rs` | BS.1770-4 / EBU R128: K-weighting, 400 ms momentary, gated integrated (abs gate −70 LUFS, rel gate −10 LU), LRA |
| `dsp-core/.../analyzer.rs` | `Analyzer` aggregates loudness + true peak + sample peak |
| WASM `LouiAnalyzer` (node target) | `processStereo()` + `snapshot()` → `integratedLufs`, `truePeakDbtp`, `samplePeakDb` |

The realtime meters use this exact analyzer, so measuring the offline
buffer through it = the SAME loudness the user sees.  No new LUFS math.

## 2. Offline measurement path (new)

`offline-loudness.ts::measureStereoLoudness(left, right, sr)`:
- feeds the whole deinterleaved buffer through a node-WASM `LouiAnalyzer`
  in blocks, then `snapshot()`.
- silence → `integratedLufs = -Infinity` (handled, no NaN).

## 3. How Python hits target LUFS (for comparison)

Python uses ffmpeg `loudnorm` to match `target_lufs` (a measure-then-
linear/dynamic-normalize step).  Loui's Rust chain has NO loudnorm stage —
it limits true peak + applies output gain only.

## 4. Strategy chosen for Rust offline (push-into-limiter)

Rather than a post-gain that would breach the ceiling, the offline render
raises loudness by feeding more level INTO the chain's limiter:

1. Pass 1 — run the chain, measure integrated LUFS (+ true peak).
2. Solve  — `gainDb = targetLufs − measuredLufs`, bounded (maxBoost +12 /
   maxCut −24), silence skipped.
3. Pass 2 — re-run the chain with `inputGainDb += gainDb`; the limiter
   holds the true-peak ceiling, so loudness rises without clipping.

The ceiling is enforced by the chain's own true-peak limiter, so the final
true peak ≤ ceiling by construction (no separate limiter pass).

## 5. Documented differences vs Python

- Not a `loudnorm` algorithm — a single push-into-limiter solve (±~1–2 LU
  on first pass; iterate later if needed).
- True peak is the analyzer's 4× ISP estimate (same as the meters), not a
  separate higher-oversampling export stage — labelled approximate.
- Different engine ⇒ not sample-identical to Python (expected).
