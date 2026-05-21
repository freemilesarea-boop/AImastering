# OZONE-STYLE-MODULE-SUITE — Modular Mastering UI + Realtime Visualizer

> Grow Loui from a preset-based AI mastering app toward a modular
> workstation: an honest module suite, status system, module-chain UI, and
> a realtime spectrum + EQ-curve visualizer.  AI-music/streaming focused,
> charcoal/lavender — NOT a clone of any product (own names, own DSP, no
> third-party assets).  No DSP / export / preset / revision regressions.

---

## 1. What shipped

| # | Deliverable | Where | Status |
|---|---|---|---|
| 1 | Feature audit + roadmap + status policy | `OZONE_FEATURE_AUDIT.md`, `LOUI_MODULE_ROADMAP.md`, `MODULE_STATUS_POLICY.md` | ✓ |
| 2 | Module suite data model + matrix | `audio/modules/loui-module-suite.ts`, `module-support-matrix.ts` | ✓ |
| 3 | Honesty system + selftest | `LouiModuleStatusBadge`, `test:modules` 9/9 | ✓ |
| 4 | Module chain UI | `components/product/modules/LouiModuleChain.tsx` | ✓ |
| 5 | Realtime visualizer | `LouiMasteringVisualizer` + `SpectrumWaveformCanvas` + `EQCurveOverlay` | ✓ |
| 6 | ProductPage module-suite surface | additive `moduleSuiteSlot` (chain overview → opens existing panels) | ✓ |
| 7 | Storybook QA | `LouiModuleSuite.stories` (badges/chain/planned/visualizer×3/hub/narrow) | ✓ |
| 8 | Performance report | `VISUAL_PERFORMANCE_REPORT.md` | ✓ |
| 9 | Rollout plan | `LOUI_MODULE_ROADMAP.md` (phases A–D) | ✓ |

---

## 2. Honesty (the core discipline)

Every module declares `status` ∈ {live, preview-only, export-only,
planned} backed by what really exists (Rust chain for preview; the 4
renderable params for export).  `module-support-matrix.ts` +
`test:modules` fail the build if a module claims more than it backs.
Planned modules are visible but badged "Coming soon" and bypassed — no
fake DSP, no "implemented" illusions.

Live today: **Imager** (width), **Limiter** (Loui Clean Limit),
**Maximizer** (Loui Loud Push).  Preview-only: EQ tone, Dynamics (Loui
Glue), AI presets.  Everything else: planned.

---

## 3. Scope decisions (honest)

- The big central visualizer ships as **production-ready components +
  stories** and an additive ProductPage chain overview; the live FFT
  mount (replacing the legacy spectrum panel) is the documented next step
  to avoid double-rendering / FPS regression in one turn.
- EQ/Limiter/etc. reuse the EXISTING parameter panels + slide-over; the
  module chain navigates to them.  No new DSP, no panel rewrites.
- Reference Match / Assistant Flow are designed (roadmap) not faked.

---

## 4. Verification

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm test:modules` | **9/9** (honesty rules + renderable backing) |
| `pnpm build:renderer` / `build:main` | OK |
| `pnpm build-storybook` | OK (+ module-suite stories) |
| `cargo test -p loui-dsp --lib` | 54/54 |
| full desktop suite + preset/revision selftests | no regression (22/22 · 14/14 · 11/11 · 11/11) |
| Rust preview chain / export / preset / revision | untouched (additive only) |

---

## 5. Constraints honoured

No third-party names/logos/art/algorithms · no fake modules · no
"implemented" illusions (status-enforced) · existing Export / Revision /
Preset / ProductPage flows intact · realtime flag default OFF.

On-device QA recommended for live spectrum FPS + the module-chain → panel
navigation in Electron.
