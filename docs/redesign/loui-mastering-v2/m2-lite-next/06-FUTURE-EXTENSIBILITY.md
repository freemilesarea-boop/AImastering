# M2-lite-NEXT — Future Extensibility

> What this milestone preserves so VST3 / CLAP / AU / Web / headless
> server analyzer are still on the table without rework.

---

## 1. The principle

`loui-dsp` is **transport-agnostic**: it takes `&[f32]` slices and emits
`MeterSnapshot`.  Every binding crate (`loui-dsp-wasm`, `loui-dsp-node`,
future `loui-dsp-vst3`, etc.) is a thin wrapper that translates a host
ABI into those slices and back.

```
                              ┌──────────────────┐
                              │   loui-dsp        │
                              │  (pure Rust core) │
                              └────────┬──────────┘
                                       │ shared by all hosts
       ┌──────────────────┬────────────┼────────────┬────────────────┐
       │                  │            │            │                │
       ▼                  ▼            ▼            ▼                ▼
   loui-dsp-wasm     loui-dsp-node   loui-dsp-vst3 loui-dsp-clap   loui-dsp-au
   (browser /        (Electron /     (Cubase /     (Bitwig /       (Logic /
    web renderer)    Node CLI)       Pro Tools)    Reaper)         GarageBand)
                                       │            │                │
                                       │            │                │
                                  (M4+)         (M4+)            (M5+)
```

This milestone (M2-lite-NEXT) added the first two columns.  The remaining
columns require:
- A wrapper crate per format (~200-500 LOC each).
- No changes to `loui-dsp`.

---

## 2. Crate workspace layout (forward-compatible)

`Cargo.toml` workspace members list now:

```toml
[workspace]
members = [
    "crates/loui-dsp",          # ← M2-lite     core
    "crates/loui-dsp-wasm",     # ← M2-lite-NEXT WASM binding (this commit)
    "crates/loui-dsp-node",     # ← M2-lite-NEXT N-API binding (this commit)
    # Future:
    # "crates/loui-dsp-vst3",    # M4
    # "crates/loui-dsp-clap",    # M4
    # "crates/loui-dsp-au",      # M5
    # "crates/loui-dsp-cli",     # M3 headless analyzer CLI
]
```

Adding a new wrapper is `git add crates/<name>` + a single workspace
edit.  Existing crates are unaffected.

---

## 3. VST3 (M4)

Wrapper sketch (deferred):
```rust
// crates/loui-dsp-vst3/src/lib.rs
use vst3_sys::base::{IPluginBase, IPluginFactory};
use loui_dsp::{AnalyzerGraph, AnalyzerOptions};

struct LouiVst3Processor {
    analyzer: AnalyzerGraph,
    // ... format-specific param state
}

impl IAudioProcessor for LouiVst3Processor {
    fn process(&mut self, data: &mut ProcessData) -> tresult {
        let inputs = data.inputs();  // VST3 audio bus
        self.analyzer.process_planar(&inputs);
        OK
    }
}
```

Build target: `.vst3` bundle.  CI gates on Steinberg validator + audio
diff vs reference.

Time estimate: 2-3 weeks for a working VST3 with the analyzer (no DSP
audio modification yet — that's M2-full).

---

## 4. CLAP (M4 — earlier than VST3)

CLAP is open-source + simpler than VST3.  Wrapper sketch:
```rust
// crates/loui-dsp-clap/src/lib.rs
use nih_plug::prelude::*;

struct LouiClapPlugin {
    analyzer: AnalyzerGraph,
}

impl Plugin for LouiClapPlugin {
    fn process(&mut self, buffer: &mut Buffer, _: &mut AuxiliaryBuffers, _: &mut impl ProcessContext<Self>) -> ProcessStatus {
        let channels: Vec<&[f32]> = buffer.iter_channels().collect();
        self.analyzer.process_planar(&channels);
        ProcessStatus::Normal
    }
}
```

`nih_plug` provides CLAP support out of the box.  Time estimate: 1 week
for an MVP.

Hosts: Bitwig Studio, Reaper, future CLAP-supporting DAWs.

---

## 5. AU (M5)

Apple AudioUnit SDK in Objective-C.  Rust bindings via `nih_plug` (AU
support) or hand-written via `objc` + `coremidi`.

Code-signing + notarisation required (Apple Developer ID).  Time
estimate: 2-3 weeks including the signing infrastructure.

Hosts: Logic, GarageBand, Ableton (macOS), Studio One.

---

## 6. Web app (future)

The WASM crate from this commit is **already** the web binding.  What's
missing for a standalone web app:

- A web-bundled React app (separate from Electron renderer)
- A loui.studio domain + CDN distribution of the WASM
- A web-specific audio input pipeline (`getUserMedia` for live input,
  drag-and-drop for files)
- License gating compatible with web auth (cookies vs Electron native)

No changes needed to `loui-dsp` or `loui-dsp-wasm` — only application
layer work.

Time estimate: standalone web demo (read-only meter) ≤ 1 week; full
mastering web app ≤ 3 months (depends on M2-full).

---

## 7. Headless server analyzer

For backend services (mass-analysis pipelines, AI training data
preparation, etc.):

```rust
// crates/loui-dsp-cli/src/main.rs
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = &args[1];
    let snap = analyze_file(path);
    println!("{}", serde_json::to_string(&snap).unwrap());
}
```

This already exists in skeleton form as `loui-dsp/examples/analyze_wav.rs`
(M2-lite).  Promoting to a proper CLI crate is a 1-day change.

Use cases:
- CI checks (does this audio meet our LUFS/TP policy?)
- Server-side preview generation
- AI training data label generation (LUFS / spectral profile bins)
- Streaming platform compliance batch checks

---

## 8. Plugin license gating

When plugin formats land (M4), licensing diverges from standalone:

| Standalone | Plugin |
|---|---|
| `@loui/license-core` in Electron main | Plugin-format-specific (VST3 = parameter automation key, AU = activation file, etc.) |
| Trial: 3 free renders | Trial: time-limited or NFR demo |
| Per-machine activation | Per-DAW activation (or per-user-account license server) |

The plugin wrapper crates will integrate with the same license server
backend (M1.5 § 6 deferred infrastructure) — the JSON-over-HTTPS check
is host-agnostic.

---

## 9. ABI stability promise (forward-looking)

`loui-dsp::MeterSnapshot` is a `Copy` struct of `f64` + `u32` / `u64`
primitives.  No pointer fields, no `Box<>`, no `String`.  This means:
- Easy to serialise across any FFI boundary.
- Stable layout (annotated `#[repr(C)]` in M3 for cross-version compat).
- No issues exposing through any plugin SDK.

The Rust API itself follows SemVer:
- v0.x: breaking changes allowed in MINOR bumps (current phase).
- v1.0: breaking changes require MAJOR bump (M2-full or later).

Plugin wrappers will pin to a specific major version + offer
backward-compat shims if needed.

---

## 10. What this commit does NOT preclude

| Scenario | Preserved by this commit? |
|---|---|
| Add VST3 wrapper without touching loui-dsp | ✓ |
| Add CLAP wrapper without touching loui-dsp-wasm | ✓ |
| Run loui-dsp in a server backend | ✓ (examples/analyze_wav.rs proves it) |
| Embed loui-dsp in another Rust project | ✓ (it's a regular crate) |
| Swap WASM for WebGPU compute (future) | ✓ (same Rust core, different binding) |
| Mobile (iOS / Android via UniFFI) | ✓ (UniFFI binding adds a crate, doesn't change core) |

---

## 11. What this commit explicitly DEFERS

| Item | Reason |
|---|---|
| Plugin wrapper crates | M4+ — requires M2-full mastering DSP first |
| SAB ring publisher in WASM | Needs cross-origin isolation setup (M3) |
| AsyncTask for Node N-API | Synchronous API covers M3 needs |
| Mobile bindings | Out of M2-lite-NEXT scope |
| `serde` integration in loui-dsp | Adds dependency; current binding-specific serialisation works |

These all remain straightforward additions when needed.

---

## 12. Summary

> M2-lite-NEXT does **not** lock the project into "Electron-only" or
> "WASM-only" delivery.  Every alternate consumer (plugin, web, mobile,
> server) is a new wrapper crate that depends on the unchanged `loui-dsp`
> core.

The architectural decisions in this commit (transport-agnostic core,
zero-dep DSP, planar buffers, RT-safe contract) are exactly what
plugin SDKs require — no rework is anticipated.
