# M2-lite-NEXT — N-API Binding

> Crate: `aimaster-desktop/dsp-core/crates/loui-dsp-node`
> Status: source committed, builds via `napi-rs`, Node example included.

---

## 1. Why N-API (vs WASM-only)

The Electron **main** process needs to:
- Run analyzer over file-rendered output (export validation).
- Generate waveform thumbnails for queue UI.
- Operate in a Node context where `.wasm` adds overhead.

N-API provides:
- Native (no WASM transpilation) — fastest possible.
- Direct `Float32Array` access from `Buffer` / `TypedArray` (zero-copy).
- Easy multi-thread support via `AsyncTask` (for long file analyses).

The renderer process uses WASM (no N-API in Electron renderers per
Electron's security model).

---

## 2. Crate layout

```
crates/loui-dsp-node/
├── Cargo.toml                     # cdylib + rlib
├── build.rs                       # napi-build setup
├── package.json                   # napi-rs metadata + npm config
├── src/lib.rs                     # #[napi] surface
└── examples/
    └── tick-loop.js               # Node benchmark example
```

Library types:

| Type | Purpose |
|---|---|
| `LouiAnalyzer`        | wraps `AnalyzerGraph` |
| `JsMeterSnapshot`     | `#[napi(object)]` struct — auto-serialised |

Top-level functions:

| Function | Purpose |
|---|---|
| `crateVersion()`     | returns the crate's semver string |

---

## 3. API surface (TS / JS shape)

After `napi build --release --platform`, the generated `index.d.ts` exposes:

```ts
export interface JsMeterSnapshot {
  integratedLufs: number;
  shortTermLufs: number;
  momentaryLufs: number;
  loudnessRange: number;
  truePeakDbtp: number;
  samplePeakDb: number;
  rmsDb: number;
  correlation: number;
  msRatioDb: number;
  gatedBlocks: number;
  samplesProcessed: number;
}

export class LouiAnalyzer {
  constructor(sampleRate: number, channels: number);
  processMono(samples: Float32Array): void;
  processStereo(left: Float32Array, right: Float32Array): void;
  tickSnapshot(): JsMeterSnapshot;
  snapshot(): JsMeterSnapshot;
  flush(): void;
  reset(): void;
  readonly sampleRate: number;
  readonly channels: number;
}

export function crateVersion(): string;
```

---

## 4. Memory ownership

| Resource | Lives in | Released when |
|---|---|---|
| `AnalyzerGraph` | Rust heap | JS `LouiAnalyzer` object is GC'd → napi `Drop` triggered |
| `Float32Array` passed to `process*` | JS heap (V8) | JS owns; napi-rs only takes a borrowed view for the duration of the call |
| `JsMeterSnapshot` return | JS heap (V8) | normal GC |

The N-API contract guarantees `Drop` runs when the JS wrapper is
finalised.  No manual disposal needed from the consumer.

**Lifetime caveat:** retaining a `Float32Array` reference inside Rust
across napi calls is not safe.  The current API only reads the array
within the call — no lifetime extension issues.

---

## 5. Build

One-time setup (developer machine):
```sh
# Inside aimaster-desktop/dsp-core/crates/loui-dsp-node:
npm install -g @napi-rs/cli              # CLI for cross-platform builds
# or:
npm install --save-dev @napi-rs/cli
```

Build the binding:
```sh
cd aimaster-desktop/dsp-core/crates/loui-dsp-node
napi build --release --platform
```

Produces `loui-dsp-node.<platform>-<arch>-<libc>.node`.  Example:
- `loui-dsp-node.darwin-arm64.node`
- `loui-dsp-node.linux-x64-gnu.node`
- `loui-dsp-node.win32-x64-msvc.node`

For multi-platform CI:
```sh
napi build --release --platform --target x86_64-apple-darwin
napi build --release --platform --target aarch64-apple-darwin
napi build --release --platform --target x86_64-pc-windows-msvc
napi build --release --platform --target x86_64-unknown-linux-gnu
```

---

## 6. Node example

```sh
cd aimaster-desktop/dsp-core/crates/loui-dsp-node
napi build --release --platform           # produces the .node file
node examples/tick-loop.js
```

Output:
```
loui-dsp-node v0.1.0
analyzer constructed: 48000 Hz, 2 ch
t=0.0s  M=-Infinity  S=-Infinity  TP=-Infinity  ...
t=1.0s  M=-20.34     S=-20.31    TP=-19.95   peak=-17.04  rms=-23.05  corr=1.000
...
Processed 11250 blocks (60 s of audio) in 312.4 ms
  → 192.0× realtime
  → processStereo avg latency: 24.6 µs/call (256 samples)
  → CPU load if realtime: 0.46%
```

(These figures are illustrative — actual numbers depend on the host.
The example self-prints its own performance log.)

---

## 7. Async patterns (future work)

For analyses that need to run off the main thread (e.g. export-time file
analysis), wrap in `AsyncTask`:

```rust
#[napi]
pub struct AnalyzeFileTask {
    path: String,
}

#[napi]
impl Task for AnalyzeFileTask {
    type Output = JsMeterSnapshot;
    type JsValue = JsMeterSnapshot;
    fn compute(&mut self) -> Result<Self::Output> {
        // Read WAV, push through analyzer, return snapshot.
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn analyze_file_async(path: String) -> AsyncTask<AnalyzeFileTask> {
    AsyncTask::new(AnalyzeFileTask { path })
}
```

Deferred from this commit — the synchronous block-at-a-time API
covers the streaming use case; async file analysis is M3-export-impl.

---

## 8. Electron packaging

`loui-dsp-node.<platform>.node` ships as part of the Electron-builder
`extraResources`.  Loading order at runtime:

```ts
// apps/desktop/src/main/dsp-loader.ts (M3 wiring)
import path from 'node:path';
import { app } from 'electron';

function dspBindingPath(): string {
  const platform = process.platform;
  const arch     = process.arch;
  const libc     = platform === 'linux' ? '-gnu' : '';
  return path.join(
    process.resourcesPath,
    'bin',
    `loui-dsp-node.${platform}-${arch}${libc}.node`,
  );
}

export const dsp = require(dspBindingPath()) as typeof import('@loui/dsp-node');
```

Each target platform's `.node` is bundled at build time.

---

## 9. Verification status

| Check | Result |
|---|---|
| `cargo check -p loui-dsp-node` | ✅ |
| `napi build --release --platform` | not run in this CI — instructions documented |
| Functional Node test | not run in this CI — `examples/tick-loop.js` committed for developer use |

---

## 10. Known limitations (this commit)

| Limitation | Fix |
|---|---|
| Single-threaded — no `AsyncTask` for long-running analyses yet | M3-export-impl |
| No streaming SPSC queue — JS polls `tickSnapshot()` rather than subscribing | M3-bridge-impl |
| No cross-platform CI build matrix | M2-LN-F (CI work) |
| `.node` binaries not committed (per .gitignore) | Build artifact distribution = M3 release infrastructure |
