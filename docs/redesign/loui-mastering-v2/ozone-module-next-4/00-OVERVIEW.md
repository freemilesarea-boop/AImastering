# OZONE-MODULE-NEXT-4 — Export-Renderable Support: honest classification + UI

> Make it crystal-clear which EQ / Dynamics / Limiter edits reach the
> exported file vs are preview-only.  The audit found the Python engine
> accepts NO per-band / per-knob DSP inputs, so we deliver an honest
> classification + UI (not fabricated promotions) and a selftest that
> blocks over-claiming.  No Python DSP added, no export-pipeline rewrite.

---

## 1. What shipped

| # | Deliverable | Where | Status |
|---|---|---|---|
| 1 | Export renderable audit | `EXPORT_RENDERABLE_AUDIT.md` | ✓ |
| 2 | Module export support matrix | `MODULE_EXPORT_SUPPORT_MATRIX.md` | ✓ |
| 3 | Export-parameter adapter | `engine-bridge/export-parameter-adapter.ts` (classify / matrix / summary) | ✓ |
| 4 | Approximation policy | `EXPORT_APPROXIMATION_POLICY.md` (approximate bucket empty, honest) | ✓ |
| 5 | Honesty badges | `ExportSupportBadge` + `ExportSupportSummary` | ✓ |
| 6 | Export summary in panel | exact / export-only / preview-only counts in the Re-master section | ✓ |
| 7 | Selftests | `test:export-support` 11/11 (over-claim guard) | ✓ |
| 8 | Storybook | badge states + summary (exact / preview-only / mixed / unsupported) | ✓ |
| 9 | Verification | this doc §2 | ✓ |

---

## 2. The honest outcome

- **Export-exact (only these 4 module params):** limiter.targetLufs,
  limiter.ceilingDbtp, imager.widthPct, eq.outputGainDb.
- **Export-only:** export.sampleRate, export.bitDepth.
- **Preview-only (Python can't honour):** EQ tone (lowCut/lowShelf/
  presence/air), all Dynamics, imager.lowMono, limiter lookahead/ISP/
  character.
- **Planned:** export format / dither; all DSP-less modules.

No EQ/Dynamics/Limiter-detail param was promoted, because Python genuinely
doesn't support them — and the selftest fails the build if the "exact"
set ever exceeds the renderable map or marks an unsupported knob exact.

The module-suite statuses (EQ/Dynamics preview-only; Imager/Limiter/
Maximizer live) were already honest from OZONE-STYLE-MODULE-SUITE; this
milestone proves it in code + surfaces it to the user.

---

## 3. Verification

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm test:export-support` | **11/11** (exact==renderable map; EQ/Dyn/limiter-detail preview-only; over-claim guard) |
| `pnpm build:renderer` / `build:main` | OK |
| `pnpm build-storybook` | OK (+ export-support stories) |
| `cargo test -p loui-dsp --lib` | 54/54 |
| full desktop suite + gr-meter/eq-curve/modules/preset/revision selftests | no regression |
| Re-master & Export / Export As-is | unchanged (only an added honest summary line) |
| Preset Browser / Live Visualizer / GR meter | untouched |

---

## 4. Constraints honoured

No Python DSP added · no unsupported param marked export-exact (selftest-
enforced) · no export-pipeline rewrite · realtime flag default OFF ·
ResultPage/V1 intact · no UI overhaul (one summary line + reusable badges).
