# M2-full — Rust Mastering Chain (WASM) + staged-only audit

> Build a realtime-safe Rust mastering preview chain, expose it to WASM,
> and honestly audit which parameters become renderable.  DSP quality +
> preview/export consistency + CPU stability over UI changes.

---

## 1. What shipped (A–H)

| Sub-step | Deliverable | Status |
|---|---|---|
| A | `dsp-core/.../mastering/` — chain skeleton + `StereoModule` trait + `MasteringChainConfig` + `process_stereo_block` + bypass + tests | ✓ |
| B | Limiter — lookahead, true-peak-safe ceiling, ISP headroom, GR meter | ✓ |
| C | Imager — M/S width, low-mono (Side high-pass), phase guard | ✓ |
| D | Dynamics — single-band glue comp (threshold/ratio/attack/release/mix) | ✓ |
| E | EQ — low-cut / low-shelf / presence / air + adaptive harshness flag + output gain | ✓ |
| F | WASM binding `LouiMasteringChain` + renderer wrapper + realtime flag (OFF default) | ✓ (worklet wiring device-test-gated) |
| G | `PREVIEW_EXPORT_CONSISTENCY.md` — two-engine policy + parity metrics | ✓ |
| H | `STAGED_ONLY_PARAMETER_AUDIT.md` — support matrix; RENDERABLE_MAP unchanged | ✓ |

Plus: `PERFORMANCE_BENCHMARK.md`, fallback plan (this doc §6).

---

## 2. Rust chain (cargo-tested)

`MasteringChain` runs the canonical order in place on planar stereo:

```
input gain → EQ → dynamics → imager → limiter → output gain
```

- Realtime-safe: no alloc / locks / unbounded loops; `#![forbid(unsafe_code)]`
- `set_config` recomputes coefficients, preserves state (no clicks)
- `reset` clears state on seek / source swap
- **54/54** cargo tests pass (31 prior + 23 new mastering tests)

Each module is unit-tested: bypass = passthrough, silence stays silent,
known behaviour (limiter never exceeds ceiling, comp attenuates loud
signal, imager width 0 → mono / 200 → ×2, EQ flat ≈ passthrough), and
the chain survives a full live config change with no NaN.

---

## 3. WASM + renderer bridge

- `LouiMasteringChain` exposed via wasm-bindgen (`setConfig` flat args,
  `processStereo` in-place, `limiterGrDb`, `reset`).
- WASM rebuilt: `loui_dsp_wasm_bg.wasm` 99 → 139 KB.
- Renderer: `realtime-mastering-chain.ts` maps the parameter state →
  chain config (`stateToChainConfig`, pure + typechecked).
- `realtime-preview-flag.ts` — `VITE_LOUI_REALTIME_PREVIEW` /
  `window.__LOUI_REALTIME_PREVIEW__`, **default OFF**.

The AudioWorklet tap that runs the chain live (mirroring the analyzer
tap) is gated behind the flag pending device CPU/glitch testing.  Flag
OFF → the existing re-render preview is used unchanged.

---

## 4. staged-only outcome (honest)

The Rust chain CAN process all 13 audio params (EQ ×5, dynamics ×5,
imager.lowMono, limiter.isp/lookahead).  But the Python EXPORT only
honours 4 (targetLufs/targetTp/width/gain).  So per the
consistency-first rule, **RENDERABLE_MAP stays at 4** — promoting the
others would label them "applied" while the exported file ignores them.

The 7+ become **realtime-preview-only** (flag-gated).  Full renderable
requires either a Rust offline render for export or Python pipeline
support (see STAGED_ONLY_PARAMETER_AUDIT.md §6).

---

## 5. Verification

| Check | Result |
|---|---|
| `cargo test -p loui-dsp --lib` | **54/54** |
| `cargo check -p loui-dsp-wasm` | clean |
| WASM rebuild | 139 KB, `LouiMasteringChain` in typings |
| `pnpm typecheck` | clean |
| `pnpm build:renderer` | 444 KB JS / 139 KB WASM |
| `pnpm build` (main) | esbuild OK |
| `pnpm build-storybook` | builds |
| Realtime flag OFF (default) | existing re-render preview unchanged |
| ProductPage fallback | unchanged |
| Re-render preview / export | no regression |

---

## 6. Fallback / rollback

| Lever | Effect |
|---|---|
| Realtime flag OFF (default) | re-render preview used; Rust chain dormant |
| `window.__LOUI_REALTIME_PREVIEW__ = false` | force re-render at runtime |
| Worklet attach failure | fall back to re-render preview |
| Remove the chain | delete `mastering/` module + revert lib.rs exports; analyzer-only dsp-core restored |

Nothing in M2-full removes the Python offline pipeline, the re-render
preview, the export workflow, or the ProductPage/V1 fallbacks.  The Rust
chain is purely additive and OFF by default.

---

## 7. Constraints honoured

- No fake realtime (the chain is real Rust DSP; live worklet is flag-
  gated, not faked)
- preview/export consistency policy documented (G)
- small-unit Rust DSP (A→E, each tested)
- Python offline chain kept as fallback
- re-render preview / export NOT removed
- realtime fails → re-render fallback
- did NOT build an Ozone-grade limiter in one shot (safe preview limiter)
- no UI redesign, no export rewrite

---

## 8. Next

- **Device test** the realtime worklet path; measure CPU; flip the flag
  on by default once green.
- **Rust offline render** (or Python param support) → promote the 7+
  staged-only params to RENDERABLE_MAP.
- **Parity harness** — extend the equivalence script to diff
  Rust-preview vs Python-export on fixtures.
- **Limiter O(1) sliding-max** optimisation.
- **M3-P-NEXT-7** — ResultPage/V1 removal (separate track).
