# MODULE_STATUS_POLICY — Honesty Contract

> Loui never shows a module as more capable than it is.  Status is data
> (`loui-module-suite.ts`), enforced by `pnpm test:modules`.

---

## 1. The four statuses

| Status | Badge | Meaning | Rule (enforced) |
|---|---|---|---|
| **live** | "Live" (mint dot) | works in BOTH realtime preview AND export | preview ≠ none AND export ≠ none |
| **preview-only** | "Preview only" (lavender) | heard in the realtime preview chain; export does NOT apply it | preview ≠ none AND export ≠ full |
| **export-only** | "Export only" | applied on the offline export render, not the preview | export ≠ none AND preview == none |
| **planned** | "Coming soon" (muted) | UI shell, no DSP yet | preview == none AND export == none, default bypassed |

## 2. Grounding

- Preview backing = the Rust `MasteringChain` (EQ / dynamics / imager /
  limiter) running in the realtime path.
- Export backing = the 4 renderable params (`RENDERABLE_MAP`): targetLufs,
  targetTp, stereoWidth, outputGainDb.
- `module-support-matrix.ts::validateModuleHonesty` rejects any module
  whose status contradicts its preview/export flags; the selftest fails
  the build if violated.

## 3. UI rules

- Planned modules are visible (so the roadmap is honest) but badged
  "Coming soon", default-bypassed, and never imply processing.
- AI-special modules that are delivered as presets carry `presetBacked`
  and say so in their description ("delivered as a preset").
- The EQ-curve overlay is labelled "approximate" — it shows direction, not
  a measured biquad response.
- No third-party algorithm names; Loui uses Loui Glue / Loui Clean Limit /
  Loui Loud Push.

## 4. Promotion path

A module moves planned → preview-only when its Rust DSP lands; preview-only
→ live when the export pipeline honours its params.  Each promotion is a
data edit in `loui-module-suite.ts` + a green `test:modules`.
