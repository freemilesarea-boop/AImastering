# RUST-OFFLINE-RENDER-1 — Export-Support Promotion Plan

> What it takes to promote preview-only params to export-exact via the
> Rust offline path — and why we do NOT promote them yet.

---

## Candidates (once Rust offline is verified)

| Param | Rust chain processes it? | Blocker to "export-exact" |
|---|---|---|
| EQ lowCutHz / lowShelfDb / presenceDb / airDb | yes | needs Rust-offline as a verified, default export backend |
| Dynamics threshold / ratio / attack / release / mix | yes | same |
| Imager lowMonoHz | yes | same |
| Limiter lookaheadMs / isp / character | yes (lookahead/isp) | same; `character` partial |

## Why NOT promote in this milestone

1. **Experimental + OFF by default.** Until the flag defaults ON, the
   export still goes through Python for most users → those params are still
   preview-only in the shipped path.
2. **No loudness-match yet.** The Rust offline path doesn't loudnorm to
   `targetLufs` (see parity report).  Promoting before loudness parity
   would mislead on overall level.
3. **No on-device output verification.** The DSP core is tested headlessly,
   but real-file ffmpeg I/O + listening QA haven't run.

The OZONE-MODULE-NEXT-4 selftest (`test:export-support`) enforces honesty —
it fails if any param is marked export-exact without backing.

## Promotion procedure (future milestone)

1. Add a loudness-normalize stage to the Rust offline render (match
   `targetLufs`), or document loudness as Python-owned.
2. On-device QA: render real files via Rust offline; A/B vs Python; confirm
   no artefacts, ceiling held, acceptable loudness.
3. Add a per-param `rust-offline-ready` capability and, when the flag is
   ON, classify those params `exact` **only for the Rust backend** (the
   adapter would take the active backend into account).
4. Flip `VITE_LOUI_RUST_OFFLINE_RENDER` default ON after sign-off.
5. Update `module-support-matrix` + `test:export-support` to reflect the
   new exact set (the test gates the promotion).

Until then: the support matrix stays honest (EQ/Dynamics/limiter-detail =
preview-only), and the Rust path is an opt-in experiment.
