# RUST-OFFLINE-RENDER-1 — Architecture + Option Choice

## Options evaluated

| Option | Stability | Big files | Memory | Speed | Cross-platform packaging | ffmpeg I/O | Verdict |
|---|---|---|---|---|---|---|---|
| A. N-API (`loui-dsp-node`) | high | good | native | fastest | **hard** (per-triple native build + ship .node) | external | rejected (build/packaging cost; MasteringChain not yet exported) |
| B. Rust CLI binary (child_process) | high | good | native | fast | medium (ship a binary per platform) | external | rejected (extra binary per OS) |
| C/D. **Node-target WASM in main** | high | good | wasm linear mem | good | **easy** (one .wasm + .cjs, no native build) | ffmpeg | **CHOSEN** |

## Chosen: `wasm-bindgen --target nodejs` in the Electron main process

**Why:**
- **Exact parity** — it's the SAME `loui-dsp-wasm` `MasteringChain` the
  realtime preview runs (same coeffs, same chain order).  No second
  implementation to drift.
- **No native toolchain / no per-platform binary** — one `.wasm` + `.cjs`,
  loadable via `require` on every OS Electron ships to.
- **Verifiable headlessly** — the parity harness runs the node WASM under
  tsx (no Electron, no audio device), so the DSP core is tested in CI.
- ffmpeg (already bundled) does decode → f32 PCM and encode → WAV/MP3.

**Trade-off:** WASM is a bit slower than native and processes in linear
memory; for whole-file offline render this is fine (block loop, no
allocation).  If profiling later demands it, the N-API path (option A) can
replace the loader behind the same `processAudioFileRust` interface.

## Components

| Piece | File |
|---|---|
| node WASM build | `dsp-core/scripts/build-wasm-node.sh` → `packages/dsp-wasm/pkg-node/` (`.cjs` glue) |
| loader (require + path resolve) | `src/main/offline/load-mastering-chain-node.ts` |
| pure block render core | `src/main/offline/rust-offline-render-core.ts` |
| file orchestration (ffmpeg decode/encode) | `src/main/offline/process-audio-file-rust.ts` |
| IPC | `audio:master-rust-experimental` (audioHandlers.ts) — falls back to Python |
| flag | `renderer/audio/rust-offline-render-flag.ts` (default OFF) |
| parity harness | `scripts/rust-offline-parity-selftest.ts` |

## Config parity

`stateToChainConfig(state)` (renderer) → the 22-arg flat config →
`applyOfflineConfig` calls `setConfig` in the SAME order the preview uses.
Identical config drives preview AND offline render.
