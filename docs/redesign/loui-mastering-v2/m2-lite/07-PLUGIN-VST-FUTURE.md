# M2-lite — Plugin / VST3 / AU extension future

> M2-lite already structures `loui-dsp` so it can host plugin formats
> without architecture changes.  This doc describes how the path is
> open without committing to it now.

---

## 1. Why M2-lite already enables this

`loui-dsp`:
- Has **zero external runtime dependencies** — easy to compile into a
  plugin shared library (`.vst3`, `.component`) without supply-chain noise.
- Has `#![forbid(unsafe_code)]` — plugin SDKs need FFI which lives in a
  separate crate with its own audit, not in core.
- Has a **realtime-safe contract** — every processor has zero-alloc
  `process_planar`, which is the basic requirement of any audio plugin host.
- Has the `AnalyzerGraph` composition pattern that maps to a single
  "AudioProcessor" entity inside a plugin format.

---

## 2. Plugin formats roadmap

| Format | Host examples | Timeline |
|---|---|---|
| **VST3** | Cubase, Ableton, Logic (via translator), FL Studio | M4 — after M2-full mastering chain lands |
| **AU**  (Audio Unit) | Logic, Ableton (macOS) | M4 — sibling of VST3 wrapper |
| **AAX** | Pro Tools | M5+ (commercial driver — needs Avid certification) |
| **CLAP** | Bitwig, Reaper, others | M4 — much simpler open-source alternative; could be earlier |
| **LV2** | Linux DAWs | M5+ if requested |

CLAP being open-source + permissive licensed is the lowest-risk first
target.  VST3 requires Steinberg license agreement (free but binding).

---

## 3. Crate layout (planned)

```
aimaster-desktop/dsp-core/
├── crates/
│   ├── loui-dsp/                    ← analysis + DSP (this commit)
│   ├── loui-dsp-mastering/         ← M2-full: EQ, comp, limiter, etc.
│   ├── loui-dsp-ffi/                ← N-API + WASM bindings  (M2-lite-NEXT)
│   ├── loui-dsp-clap/               ← CLAP plugin wrapper     (M4)
│   ├── loui-dsp-vst3/               ← VST3 plugin wrapper     (M4)
│   └── loui-dsp-au/                  ← AU plugin wrapper       (M4)
```

Each wrapper crate:
- Depends on `loui-dsp` (and `loui-dsp-mastering` when present).
- Implements the format's required entry points (parameter declarations,
  process callbacks, GUI hooks).
- Reuses the same `AnalyzerGraph` + `MasteringGraph` types.

---

## 4. Plugin "instance" shape (sketch)

```rust
// Future loui-dsp-clap/src/plugin.rs (sketch — NOT in this commit)
pub struct LouiPlugin {
    analyzer: AnalyzerGraph,
    mastering: MasteringGraph,
    parameter_set: ParameterSet,
    /// CLAP needs to publish "supports realtime-safe processing".
    is_realtime: AtomicBool,
}

impl PluginTrait for LouiPlugin {
    fn process(&mut self, inputs: &[&[f32]], outputs: &mut [&mut [f32]]) {
        // 1. Read parameters from atomic set
        let params = self.parameter_set.snapshot();
        // 2. Apply mastering chain
        self.mastering.process_in_out(inputs, outputs, &params);
        // 3. Observe with analyzer (no audio modification)
        self.analyzer.process_planar(outputs);
    }

    fn meter_snapshot(&self) -> MeterSnapshot {
        self.analyzer.tick_snapshot()
    }
}
```

---

## 5. Parameter automation

DAWs send parameter automation at audio block rate.  M2-full will
introduce a `ParameterSmoother` type (Linear or cubic ramp) that
smooths parameter jumps over `block_size` samples.  Plugin wrappers
use this universally.

---

## 6. GUI integration

Plugin GUIs run inside the DAW's host window.  Options:
1. **`baseview` + `nih-plug`** — pure-Rust, works for CLAP/VST3.
   Same GUI as Loui Mastering's standalone app (different framing).
2. **Web-rendered via `tao` + `wry`** — host the same React UI inside
   the plugin window.  Heavier but reuses 100% of the standalone UI.
3. **Headless** — no GUI; DAW handles parameter UI via host generic.

For M4, option 2 (web-rendered) is preferred because it preserves the
"Loui look" across standalone + plugin.  The `MeterSnapshot` JSON
contract works identically.

---

## 7. Licensing in plugin context

The plugin running inside a host DAW exists in a different licensing
context:

| Standalone Loui Mastering | VST3 / AU plugin |
|---|---|
| `@loui/license-core` checks the standalone app | Plugin license is per-DAW; user owns DAW license separately |
| Pro tier required for high-loudness presets, batch processing | Pro tier required for plugin install (separate purchase) |
| Trial: 3 free renders | Trial: ? (NFR / time-limited demo) |

The license server (M1.5 backlog) will need to enable per-plugin
activation in addition to per-app.

---

## 8. ABI stability concerns

VST3 / AU / AAX have specific ABI requirements — they must NOT use
unstable Rust ABIs across compiler versions.  The wrapper crates use
`#[repr(C)]` interfaces at the boundary.

`loui-dsp` itself doesn't need C ABI — only `loui-dsp-ffi` and the
format-specific wrappers do.  This keeps the core fast (Rust types,
inlinable) and the boundary stable.

---

## 9. Realtime-safety burden on plugins

Plugin hosts will fail certification if the plugin allocates / locks /
blocks in `process`.  M2-lite's existing realtime-safe contract
(`02-REALTIME-SAFETY.md`) is the foundation.

For M2-full mastering modules, the same contract applies.  The
`#[realtime_safe]` proc-macro (M2-lite-NEXT TODO) would catch
violations at compile time.

---

## 10. Plugin format-specific notes

### 10.1 VST3

- Steinberg SDK in C++.  Rust bindings via `vst3-sys` or `nih-plug`.
- Parameters are normalised `f32` in `[0, 1]`.  Wrapper provides
  conversion to engine-preset values.
- Bundles include both `.vst3` (file) + GUI resources.

### 10.2 AU

- Apple AudioUnit SDK in Objective-C.  Rust via `coremidi` for MIDI
  events; audio via `nih-plug`'s AU support.
- Code-signing + notarisation required (Apple Developer ID).

### 10.3 CLAP

- Open-source, simpler.  `clap-sys` + `nih-plug` for Rust.
- No mandatory commercial agreement.
- Bitwig + Reaper hosts; broader DAW support growing.

### 10.4 AAX

- Avid SDK.  Requires Avid Developer membership.  Linux/Windows/macOS.
- Used by Pro Tools, the dominant Hollywood / professional studio DAW.
- Highest commercial value but highest barrier to entry.

---

## 11. Out-of-scope for now

- Cloud-rendered mastering plugin (DAW sends audio to Loui Cloud, returns
  master).  Different product category — M5+ if ever.
- AI-driven parameter automation via VST3 events.  M4+ R&D.

---

## 12. M2-lite delivery vs plugin readiness

This commit:
- ✅ Crate compiles to a portable `.rlib` with zero deps.
- ✅ All processors realtime-safe.
- ✅ AnalyzerGraph is the same shape a plugin "instance" would be.
- ❌ FFI bindings (deferred to M2-lite-NEXT).
- ❌ Plugin wrappers (deferred to M4).

The path is open.  Each step from here is additive — no rewriting of
the core crate to enable plugin formats.
