# MODULE_EXPORT_SUPPORT_MATRIX

> Per-parameter export support, derived in code (`export-parameter-adapter.ts`)
> and enforced by `pnpm test:export-support` (11/11).  Reflects what the
> Python engine truly honours.

---

## Per-parameter

| Module | Param | Export support |
|---|---|---|
| EQ | lowCutHz / lowShelfDb / presenceDb / airDb | preview-only |
| EQ | outputGainDb | **exact** |
| EQ | adaptive | preview-only |
| Dynamics | thresholdDb / ratio / attackMs / releaseMs / mixPct | preview-only |
| Imager | widthPct | **exact** |
| Imager | lowMonoHz / stereoize / band* | preview-only |
| Limiter | targetLufs | **exact** |
| Limiter | ceilingDbtp | **exact** |
| Limiter | isp / lookaheadMs / character | preview-only |
| Export | sampleRate / bitDepth | export-only |
| Export | format / dither | planned |

## Per-module status (loui-module-suite)

| Module | Status | Why |
|---|---|---|
| EQ | preview-only | tone bands not honoured by Python (output gain is exact) |
| Dynamics (Loui Glue) | preview-only | Python uses fixed per-style comp |
| Imager | live | width is export-exact |
| Limiter (Loui Clean Limit) | live | ceiling export-exact |
| Maximizer (Loui Loud Push) | live | loudness export-exact |
| Dynamic EQ / Exciter / Bass / Low End / Harshness / Reference | planned | no DSP |
| AI presets | preview-only | preset-backed via the preview chain |

## Legend

- **exact** — reaches the exported file via a MasteringOptions field Python
  honours (also drives the re-render preview).
- **export-only** — applied on the export render only (sample rate / bit depth).
- **preview-only** — heard in the Rust realtime preview, NOT in the export.
- **approximate** — RESERVED, empty today (see EXPORT_APPROXIMATION_POLICY).
- **planned** — no DSP yet.

No status here over-claims; the selftest enforces it.
