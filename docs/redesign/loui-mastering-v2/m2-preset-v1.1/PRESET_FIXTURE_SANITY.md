# M2-PRESET-v1.1 — Fixture / Sanity Check

> Parameter-level safety that runs in CI (no audio device), plus the
> fixture-listening plan for on-device sign-off.

---

## 1. Automated sanity (CI — `test:preset-differentiation`)

All PASS:

| Check | Guarantees |
|---|---|
| chain config finite | no NaN/Inf reaches the realtime chain for any preset |
| ceiling ∈ [−3, −0.5] dBTP | true-peak headroom — no clipping target |
| loud presets ceiling ≤ −1.0 | loud masters won't tear / inter-sample clip |
| width ≤ 150, wide ⇒ lowMono ≥ 150 | no extreme width; sub stays mono → phase-safe fold-down |
| dynamic presets ratio/mix bounded | warm/natural presets are not over-compressed |
| all values in parameter range | nothing silently clamped on apply |

These are guardrails on the *tuning*, independent of source material.

## 2. Fixture listening plan (on-device — not run in CI)

The sandbox has no audio device + no Python engine, so signal-level
fixture rendering is a QA-station task.  Use the existing fixture tooling
(`scripts/dsp-equivalence-*.ts`, loudness fixtures) plus these
preset-targeted A/B comparisons:

| Fixture | Apply | Expect |
|---|---|---|
| AI harsh-vocal | AI Vocal Cleaner | 2–5 kHz glare reduced, vocal still intelligible (not dull) |
| AI splashy-cymbal | Cymbal Smooth | cymbal/hi-hat top tamed, body intact |
| Fake-wide AI stereo | Stereo Repair | mono fold-down loses no bass; no phasey cancellation |
| Solo piano / acoustic | Piano Natural | transients preserved, no pumping, < 3 dB GR |
| 808 / low-end heavy | Streaming Pro vs EDM Wide | bass mono-locked; EDM louder + wider but no flam |
| Loud pop | KPOP Loud | dense + loud, true-peak ≤ −1.0, no audible tearing |

## 3. Preview ↔ export consistency

For each fixture, after Update Preview + Re-master & Export, confirm the
renderable params match (loudness ≤ 1.5 LU, true peak ≤ 0.5 dB, width
direction).  Preview-only tone moves (EQ bands, low-mono, dynamics) are
the documented capability gap, not drift — see PREVIEW_EXPORT_CONSISTENCY
(M2-full).
