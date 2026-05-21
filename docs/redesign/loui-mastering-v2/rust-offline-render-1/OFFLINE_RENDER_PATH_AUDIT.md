# RUST-OFFLINE-RENDER-1 — Offline Render Path Audit

> How the current export render works, and where the Rust path slots in.

---

## 1. Current export render (Python)

```
audio:master (audioHandlers.ts) ──► masterFile (packages/audio-engine)
   └─ PythonBridge.call('master', params)  [JSON-RPC over stdio, 15-min timeout]
        └─ services/python-audio … run_pipeline
   returns { outputPath (temp WAV), previewPath (temp _preview.mp3), loudnessAfter }
```

- Output WAV → `os.tmpdir()/{name}_master_{style}_{LUFS}.wav` (`resolveOutputPath`).
- Preview MP3 → Python derives `{wav}_preview.mp3`; main has an mp3 fallback path.
- `file:save-wav` copies; `file:save-audio` transcodes (ffmpeg).
- sampleRate / bitDepth applied by ffmpeg at the Python output stage.

## 2. ffmpeg availability (main)

`resolveFFmpegPath()` (audio-engine) finds the bundled binary
(`process.resourcesPath/bin`) / `AIMASTER_FFMPEG` / PATH.  Main can decode
+ encode arbitrary audio already (`audioTranscode.ts`).

## 3. Rust DSP availability

- `loui-dsp-wasm` (the SAME chain as preview) — was only `--target web` /
  `--target no-modules`.  This milestone adds `--target nodejs`
  (`pkg-node/`) so the main process can run it via `require`.
- `loui-dsp-node` (N-API) exists but exports only the analyzer (no
  MasteringChain) and needs native per-platform builds — not used here.
- `MasteringChain.process_stereo_block` is allocation-free → offline =
  looping blocks.

## 4. Where the Rust path slots in (additive)

```
renderer state ─stateToChainConfig→ chainConfig
  └─ audio:master-rust-experimental (NEW IPC)
       ffmpeg decode → f32 stereo PCM
       → renderStereoBuffer (node WASM MasteringChain, same as preview)
       → ffmpeg encode WAV (sampleRate/bitDepth) + preview MP3
       on ANY failure → masterFile (Python)  [fallbackUsed:true]
```

`audio:master` is unchanged; the new IPC is opt-in behind a flag.

## 5. Honest gap

The Rust chain has a true-peak limiter + output gain but **no
loudness-normalize-to-target stage** (Python's loudnorm).  So Rust-offline
output is NOT loudness-matched to `targetLufs` the way Python is — see
RUST_OFFLINE_PARITY_REPORT.md.  This is why the path is experimental + OFF
by default, and why we don't yet promote loudness-dependent params.
