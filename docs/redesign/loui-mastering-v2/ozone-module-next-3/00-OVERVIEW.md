# OZONE-MODULE-NEXT-3 — Limiter / Maximizer Gain Reduction Meter

> Show how hard the Limiter / Maximizer is working with a real GR meter,
> driven by the actual `limiterGrDb` from the Rust limiter.  Metering only
> — no Limiter DSP change, no new Maximizer algorithm, no fake values.

---

## 1. What shipped

| # | Deliverable | Where | Status |
|---|---|---|---|
| 1 | GR data audit | `GR_METER_DATA_AUDIT.md` | ✓ |
| 2 | GR meter model | `audio/modules/gr-meter-model.ts` (state/source/peak/decay) + `test:gr-meter` 6/6 | ✓ |
| 3 | GR meter component | `LouiGainReductionMeter.tsx` (vertical full + horizontal compact, ticks, peak hold, decay) | ✓ |
| 4 | Limiter/Maximizer UI | full meter in the Limiter slide-over panel; compact meter in the realtime debug overlay | ✓ |
| 5 | Realtime metrics wiring | `realtime-gr-context.tsx` from `useRealtimeMasteringGraph` metrics (data-driven, peak decay) | ✓ |
| 6 | Storybook | unavailable / idle / light / active / heavy / extreme / peak-hold / compact / panel | ✓ |
| 7 | Verification | this doc §2 | ✓ |

---

## 2. Verification

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm test:gr-meter` | **6/6** (unavailable / thresholds / clamp / peak / decay / label) |
| `pnpm build:renderer` / `build:main` | OK |
| `pnpm build-storybook` | OK (+ GR meter stories) |
| `cargo test -p loui-dsp --lib` | 54/54 |
| full desktop suite + eq-curve/modules/preset/revision selftests | no regression |
| realtime flag OFF | GR shows "unavailable" (no fake) |
| realtime flag ON | meter follows `limiterGrDb` (peak hold + decay) |
| Export / Preset / Revision / live visualizer | untouched |

---

## 3. Honesty + constraints

- The meter renders the REAL `limiterGrDb` (Rust limiter) — never a
  fabricated value.  Off-realtime → "unavailable".
- States: idle (<0.3) / active (<3) / heavy (<6) / clipping-risk (≥6 dB) →
  mint → lavender → amber → red.
- No Limiter DSP change · no new Maximizer algorithm (Maximizer shares the
  limiter's GR, honestly) · no export/preset/realtime-flag-default change ·
  debug panel kept · no layout overhaul.

On-device QA recommended for the meter moving with playback (no audio
device in the sandbox); updates are data-driven (no RAF).
