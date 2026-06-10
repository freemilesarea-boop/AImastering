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

- ✅ `remixStems` / `applyPreciseRebalance` (additive reconstruction, per-stem
  dB, model-rate → render-rate resample) — unit tested with a fake separator.
- ✅ approximation chain (`rebalance-chain`) M/S mapping — unit tested.
- ✅ WOLA core — `planSegments` coverage, Hann partition-of-unity reconstruction,
  `resampleLinear` — unit tested.
- ✅ model manager — `ensureModel` download/verify/cache, checksum + size
  rejection, unconfigured → null (no download) — unit tested with injected fs.
- ✅ `getStemSeparator()` returns `null` while unpinned (graceful fallback).
- ❌ real separation quality / runtime — requires the model + onnxruntime-node +
  audio device, validated in pre-launch QA (same bucket as flag-flip A/B).

## What flips it ON

The whole precise path is built and tested; it is gated by exactly **three**
switches, all OFF today:

1. **Manifest** — pin a real `url` + `sha256` + `bytes`. Until then
   `isModelConfigured()` is false and `getStemSeparator()` returns null.
2. **Runtime** — add `onnxruntime-node` (optionalDependency) + lockfile +
   electron-builder native-addon packaging. `loadOrt()` already lazy-loads it
   and degrades gracefully when absent.
3. **UI** — flip `PRECISE_AVAILABLE = true` in `StemRebalancePanel.tsx`.

### Pinning the manifest (switch 1) — no code edit required

The bundled `HTDEMUCS_MANIFEST` is a placeholder with an empty `sha256`. A
**sidecar** `stem-model.manifest.json` overrides it at runtime
(`resolveManifest` → `manifestSidecarPath` = `userData/models/`), validated by
`parseManifest` (rejects malformed shapes / path-traversal filenames; an empty
sha256 stays intentionally unpinned). Generate it with one command:

```bash
# hash a local export (records the runtime download URL too):
pnpm --filter @aimaster/desktop pin:stem-model \
  --file ./htdemucs.onnx \
  --url  https://<host>/htdemucs.onnx \
  --out  ./stem-model.manifest.json

# or download + hash in one shot:
pnpm --filter @aimaster/desktop pin:stem-model --url https://<host>/htdemucs.onnx
```

The script prints (and writes) `id/fileName/url/sha256/bytes/modelSampleRate`.
Drop the sidecar at `userData/models/stem-model.manifest.json` (or paste the
values into `HTDEMUCS_MANIFEST`). `sha256`/`bytes` are computed from the real
bytes — they are never hand-written.

> **Hosting is a maintainer decision.** The `url` must point at a stable public
> host the app downloads from at runtime (e.g. a GitHub Release asset or a CDN).
> This sandbox cannot reach the upstream Demucs weight hosts (HuggingFace and
> `dl.fbaipublicfiles.com` both return HTTP 403 under the network policy), so the
> export + first pin must run where those (or your mirror) are reachable.

## Status checklist

- [x] Approximation tier (live, no ML) — `rebalance-config.ts`, `rebalance-chain.ts`
- [x] Backend-agnostic `StemSeparator` interface + real `OnnxStemSeparator`
- [x] Pure `remixStems` + `applyPreciseRebalance` (separate → resample → re-sum) + tests
- [x] WOLA inference core (`stem-inference.ts`: segments, Hann, overlap-add, resample) + tests
- [x] Model manager (`stem-model-manager.ts`: download-on-first-use, checksum, cache) + tests
- [x] Lazy `onnxruntime-node` loader (`loadOrt`, graceful when absent)
- [x] Precise rebalance wired into `process-audio-file-rust` → behind `options.rebalance`
- [x] Renderer → export plumbing (`MasteringOptions.rebalance`, `MasteringPage`)
- [x] UI: two-tier `StemRebalancePanel` (precise gated by `PRECISE_AVAILABLE`)
- [x] Sidecar manifest mechanism (`resolveManifest`/`parseManifest`, validated) + tests
- [x] `pin:stem-model` script — computes real sha256/bytes, writes the sidecar
- [ ] HT-Demucs ONNX export + host the `.onnx` + run `pin:stem-model` (switch 1) — needs a reachable weight host
- [ ] `onnxruntime-node` optionalDependency + lockfile + electron-builder packaging (switch 2)
- [ ] Flip `PRECISE_AVAILABLE = true` (switch 3) + pre-launch listening QA
