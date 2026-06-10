# Stem Separation Plan — ONNX-local Demucs (Phase 3)

_Status: design + skeleton landed; precise tier gated OFF until the model ships._

## Goal

Replace iZotope-style "Master Rebalance" with a two-tier stem-aware control that
beats it on transparency and on Asian-pop source material:

| Tier | Backend | When | Heard |
| --- | --- | --- | --- |
| **근사 (approximation)** | WebAudio M/S + band EQ | **now**, always on | live in preview |
| **정밀 (precise)** | ONNX-local Demucs, 4 stems | opt-in, on export | offline render |

The approximation tier (`rebalance-chain.ts`) ships today with **zero ML**: a
mid/side decomposition raises the centre vocal, lifts/cuts bass, and widens the
sides. It is exact-passthrough at unity, so there is no coloration when idle.

The precise tier does true `vocals / drums / bass / other` separation with
per-stem gain, then sums the (additive) stems back to stereo. This document
covers the precise tier.

## Why ONNX-local (vs cloud / Python)

Chosen backend: **ONNX local** (decided with the user).

- **No server, no per-render cost, offline-first** — fits a desktop master
  tool; the user's audio never leaves the machine (privacy = a selling point).
- **`onnxruntime-node`** is a prebuilt native addon (CPU + optional CoreML /
  DirectML), so no Python toolchain in the shipped app.
- The existing Python engine (`services/python-audio`) stays ML-free
  (soundfile + numpy only) — we do **not** add torch there.

## Architecture

```
renderer (StemRebalancePanel, preciseEnabled + stemGainsDb)
        │  export options
        ▼
main/offline/process-audio-file-rust.ts
        │  if isPreciseRebalanceActive → getStemSeparator()
        ▼
main/offline/stem-separation.ts   ← StemSeparator interface (THIS skeleton)
        │  OnnxStemSeparator.separate(stereo) → 4 stems
        ▼
remixStems(stems, gainsDb)        ← pure, already in rebalance-config.ts
        │  Σ stems·gain → stereo
        ▼
Rust mastering chain (unchanged) → QC/analysis → file
```

`StemSeparator` is the seam. The rest of the export path only knows "give me a
rebalanced stereo buffer"; it never imports the runtime. `getStemSeparator()`
returns `null` when no model is installed and the caller falls back to the
approximation tier — so the whole feature degrades gracefully.

### Contract

- Input: interleaved-free stereo (`{ left, right, sampleRate }`).
- Output: `Record<StemId, StereoBuffer>` whose **0 dB sum reconstructs the
  input** (Demucs stems are additive — verified by the `remixStems` unit test).
- `remixStems` applies per-stem gain in dB and re-sums; muting a stem = floor
  gain (−24 dB), not a hard zero, to avoid artifacts.

## Model

- **HT-Demucs (v4)** exported to ONNX (`htdemucs.onnx`), ~80–330 MB depending on
  quantization (int8 dynamic quant target ≈ 80–120 MB).
- **Download-on-first-use**: not bundled in the installer. On first precise
  render we fetch the weights to `app.getPath('userData')/models/`, checksum
  (SHA-256) against a pinned manifest, and cache. Subsequent runs are offline.
- A "정밀 분리 사용" toggle in the UI triggers the one-time download with
  progress; `PRECISE_AVAILABLE` in `StemRebalancePanel.tsx` flips to `true` once
  the download/runtime path is wired and validated.

## Inference

- Resample to model rate (44.1 kHz), process in overlapping windows
  (~7.8 s segments, 25 % overlap), weighted-overlap-add to avoid seam clicks.
- Run on CPU by default; opportunistically use CoreML (macOS) / DirectML
  (Windows) execution providers when present.
- Emit progress via the `onProgress` callback (chunk index / total) so the UI
  can show a determinate bar.

## Dependencies (deferred — NOT yet added)

- `onnxruntime-node` as an **optionalDependency**, loaded via lazy
  `await import('onnxruntime-node')` so a missing/failed native addon never
  breaks app startup — it just leaves `isReady()` false.
- electron-builder: ship the addon's `.node` binaries per-platform; the model
  itself is downloaded, not packaged.

## Headless verifiability

- ✅ `remixStems` (additive reconstruction, per-stem dB) — unit tested.
- ✅ approximation chain (`rebalance-chain`) M/S mapping — unit tested.
- ✅ `getStemSeparator()` returns `null` with no model (graceful fallback).
- ❌ real separation quality / runtime — requires the model + audio device,
  validated in pre-launch QA (same bucket as flag-flip A/B listening).

## Status checklist

- [x] Approximation tier (live, no ML) — `rebalance-config.ts`, `rebalance-chain.ts`
- [x] Backend-agnostic `StemSeparator` interface + ONNX skeleton (gated OFF)
- [x] Pure `remixStems` additive remix + tests
- [x] UI: two-tier `StemRebalancePanel` (precise gated by `PRECISE_AVAILABLE`)
- [ ] `onnxruntime-node` optionalDependency + lazy loader
- [ ] HT-Demucs ONNX export + quantization + pinned manifest
- [ ] Download-on-first-use to userData + checksum + progress
- [ ] Windowed inference (WOLA) wired into `process-audio-file-rust`
- [ ] electron-builder native-addon packaging per platform
- [ ] Flip `PRECISE_AVAILABLE = true` + pre-launch listening QA
