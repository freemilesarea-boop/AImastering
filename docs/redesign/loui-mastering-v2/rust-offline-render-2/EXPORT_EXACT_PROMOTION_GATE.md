# EXPORT_EXACT_PROMOTION_GATE

> The checklist that must be GREEN before any preview-only param is
> promoted to export-exact via the Rust offline backend.  Not satisfied
> yet — no promotion in this milestone.

---

## Gate (all required)

| # | Condition | Status |
|---|---|---|
| 1 | `audio:master-rust-experimental` two-pass render works end-to-end on-device (ffmpeg decode/encode + real files) | ☐ on-device QA |
| 2 | Loudness normalization fixture suite green (`test:rust-loudness`) | ✅ 9/9 |
| 3 | Final integrated LUFS within tolerance of target on REAL programme material (target ±1.5 LU) | ☐ on-device QA |
| 4 | True-peak ceiling never exceeded on real material | ✅ (synthetic) / ☐ real |
| 5 | EQ / Dynamics / Limiter edits audibly + measurably present in the OUTPUT (not just preview) | ☐ on-device QA |
| 6 | Python fallback verified (induced Rust failure → Python output, no crash) | ✅ (fallback path) / ☐ real induced |
| 7 | Preview ↔ export listening difference within agreed tolerance | ☐ listening |
| 8 | Large-file stability (memory/time) | ☐ profiling |
| 9 | Flag default-ON decision signed off | ☐ |

## Promotion procedure (once gated)

1. Add a per-param `rust-offline-exact` capability to the support model.
2. When the Rust backend is the ACTIVE export path, the
   `export-parameter-adapter` classifies those params `exact` (backend-
   aware); when Python is active they remain `preview-only`.
3. Update `test:export-support` expectations + `module-support-matrix`
   (the selftest gates the change — it fails if a param is marked exact
   without the backend backing it).
4. Flip `VITE_LOUI_RUST_OFFLINE_RENDER` default after sign-off; keep the
   Python fallback.

## Honesty rule (unchanged)

Until the gate is green, EQ tone / Dynamics / Imager low-mono / Limiter
lookahead·ISP stay **preview-only** in the shipped (Python-default) path.
No "export exact" claim is made for them.
