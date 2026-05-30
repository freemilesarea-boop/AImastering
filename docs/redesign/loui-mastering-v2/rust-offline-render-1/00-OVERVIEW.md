# RUST-OFFLINE-RENDER-1 — Rust MasteringChain Offline Export Path

> Add an additive, experimental offline export render that runs the SAME
> Rust MasteringChain as the realtime preview, so a future milestone can
> promote EQ/Dynamics/Limiter detail to export-exact.  Python pipeline
> kept; Rust path is OFF by default and falls back to Python on any failure.

---

## 1. What shipped

| # | Deliverable | Where | Status |
|---|---|---|---|
| 1 | Offline render path audit | `OFFLINE_RENDER_PATH_AUDIT.md` | ✓ |
| 2 | Architecture + option choice (node-WASM in main) | `RUST_OFFLINE_RENDER_ARCHITECTURE.md` | ✓ |
| 3 | node-target WASM build | `build-wasm-node.sh` → `packages/dsp-wasm/pkg-node/` (`build:node`) | ✓ |
| 4 | Offline renderer (core + file orchestration) | `src/main/offline/{load-mastering-chain-node,rust-offline-render-core,process-audio-file-rust}.ts` | ✓ |
| 5 | Experimental IPC | `audio:master-rust-experimental` (additive; Python fallback) | ✓ |
| 6 | Renderer flag + wiring | `rust-offline-render-flag.ts`; onCreateRevision branches on it | ✓ |
| 7 | Preview MP3 / output WAV | ffmpeg encode in the offline path | ✓ |
| 8 | Python fallback | main-process fallback in the IPC (`fallbackUsed`) | ✓ |
| 9 | Parity / fixture harness | `scripts/rust-offline-parity-selftest.ts` (7/7) | ✓ |
| 10 | Parity report + promotion plan | `RUST_OFFLINE_PARITY_REPORT.md`, `EXPORT_SUPPORT_PROMOTION_PLAN.md` | ✓ |
| 11 | UI honesty | "EXPERIMENTAL · Rust offline render (falls back to Python)" badge on the revision stack; backend tag on created revisions | ✓ |

---

## 2. How it works

```
flag OFF (default) → audio:master (Python)            [unchanged]
flag ON            → audio:master-rust-experimental
                       ffmpeg decode → renderStereoBuffer (node WASM, same
                       chain as preview) → ffmpeg WAV + MP3
                       on ANY failure → masterFile (Python), fallbackUsed
```

The node WASM is the SAME `loui-dsp-wasm` `MasteringChain` the preview
runs (`wasm-bindgen --target nodejs`), driven by the SAME 22-arg config
from `stateToChainConfig`.

---

## 3. Verification

| Check | Result |
|---|---|
| `cargo test -p loui-dsp --lib` / `cargo check -p loui-dsp-wasm` | 54/54 / clean |
| node WASM loads + processes in Node | ✓ (require `.cjs`) |
| `pnpm test:rust-offline` | **7/7** (silence/sine/loud-ceiling/noise/stereo/bypass/metrics) |
| `pnpm typecheck` | clean |
| `pnpm build:renderer` / `build:main` / `build-storybook` | OK |
| full desktop suite + all module/export/preset/revision selftests | no regression |
| flag OFF | existing `audio:master` flow identical |
| flag ON | experimental IPC called; Python fallback on failure |

---

## 4. Honest status + constraints

- **Experimental, OFF by default.** Output quality (esp. loudness — the
  Rust chain has no loudnorm-to-target stage) must be device-verified
  before any default switch.
- No params promoted to export-exact yet (see promotion plan); the
  honesty selftest still gates over-claiming.
- Python `masterFile` NOT removed · `audio:master` unchanged · Rust path
  default OFF · ResultPage/V1 intact · export pipeline not rewritten.
- The DSP core is verified headlessly; ffmpeg file I/O + listening QA are
  on-device follow-ups (no Electron/audio device in the sandbox).
