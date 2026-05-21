# RUST-OFFLINE-RENDER-1 — Parity / Safety Report

> From `pnpm test:rust-offline` (7/7) — the node-target WASM MasteringChain
> driven over fixtures, headless (no audio device).

---

## 1. Safety invariants (all PASS)

| Fixture | Check |
|---|---|
| silence | stays silent, no NaN/Inf |
| 1 kHz sine | no NaN, output length == input length |
| loud sine (0.98) @ −1 dBTP ceiling | sample peak ≤ ceiling (+0.03 tol) both channels |
| white noise | no NaN, bounded ≤ ceiling |
| stereo (440/660 L/R) | both channels processed, non-silent |
| master bypass | output ≈ input (max diff < 1e-3) |
| metrics | samples / duration / renderMs / peak all sane |

→ The offline render is **safe**: no NaN, no clipping past the ceiling,
length preserved, bypass is transparent.

## 2. Preview ↔ offline parity

- The offline render uses the EXACT same Rust `MasteringChain` + the same
  22-arg config as the realtime preview, processed in 512-sample blocks.
- Block-boundary state (limiter lookahead, EQ/comp filter memory) is
  continuous across the whole file, same as the worklet — so the offline
  result tracks the preview's tone/dynamics direction closely.

## 3. Known differences vs the Python export (documented, not bugs)

| Aspect | Python export | Rust offline (this path) |
|---|---|---|
| Loudness to target LUFS | loudnorm matches `targetLufs` | **no loudnorm stage** — limiter + output gain only; not loudness-matched |
| EQ tone | fixed per-`style` overlay | the user's actual EQ band values (the whole point) |
| Dynamics | fixed per-`style` comp | the user's actual comp params |
| Limiter | ffmpeg alimiter (no lookahead/ISP) | Rust true-peak limiter w/ lookahead + ISP |
| Saturation | ffmpeg compand | not in the Rust chain |

**Implication:** Rust offline ≠ sample-identical to Python (different
engines, expected).  Crucially, it is **not loudness-normalized to
target** yet, so loudness-dependent expectations differ.  This is why the
path is experimental + OFF by default and why loudness-dependent params
are NOT promoted in this milestone (see export-support plan).

## 4. Not yet verified here (needs on-device QA)

- ffmpeg decode/encode round-trip on real files (no Electron/ffmpeg run in
  the sandbox) — the DSP core is verified; the file I/O is exercised
  on-device.
- Large-file memory/time profile.
- A/B listening vs Python output.
