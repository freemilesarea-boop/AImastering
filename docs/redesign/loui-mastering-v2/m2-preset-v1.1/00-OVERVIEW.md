# M2-PRESET-v1.1 — 13 Official Presets Tuned to v1.1 Release Candidate

> Pure sound-tuning milestone: refine the 13 official presets from initial
> values into a distinct, safe, release-candidate sound character.  No
> structure / DSP-algorithm / pipeline changes.

---

## 1. What shipped

| # | Deliverable | Where | Status |
|---|---|---|---|
| 1 | Preset value audit | `PRESET_VALUE_AUDIT.md` | ✓ |
| 2 | Tuning targets | `PRESET_TUNING_TARGETS.md` | ✓ |
| 3 | v1.1 tuning values | `loui-presets.ts` (all 13 → `1.1.0`) | ✓ |
| 4 | Differentiation selftest | `scripts/preset-differentiation-selftest.ts` (11/11) | ✓ |
| 5 | Differentiation report | `PRESET_DIFFERENTIATION_REPORT.md` | ✓ |
| 6 | Fixture / sanity | `PRESET_FIXTURE_SANITY.md` | ✓ |
| 7 | Listening notes v1.1 | `PRESET_LISTENING_NOTES_v1.1.md` | ✓ |
| 8 | Metadata / descriptions | refreshed per preset in `loui-presets.ts` | ✓ |
| 9 | Rollout recommendation | `ROLLOUT_RECOMMENDATION.md` | ✓ |

---

## 2. Headline tuning moves

- **Streaming Pro vs YouTube Safe** de-duplicated — SP = open reference,
  YT Safe = low-fatigue (soft top, gentle comp, −1.5 ceiling).
- **Anti-tear** on loud presets (KPOP / EDM): ceiling −1.0, more lookahead.
- **Phase-safe width**: wide presets lock the sub to mono (lowMono ≥ 150).
- **AI-special = problem solvers**: de-harsh (presence −2.0 + air lift),
  de-cymbal (air −3.0), stereo collapse (width 88 / lowMono 240), mono
  fold-down (width 95 / lowMono 200).
- **Piano Natural** kept maximally dynamic (1.4:1 / 60% mix).

---

## 3. Verification

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm test:preset-tuning` | 14/14 |
| `pnpm test:preset-differentiation` | 11/11 (min lineup diff = 6) |
| `pnpm test:realtime-graph` | 8/8 |
| `cargo test -p loui-dsp --lib` | 54/54 |
| `pnpm build:renderer` / `build:main` | OK |
| `pnpm build-storybook` | OK |
| full desktop suite | no regression |

---

## 4. Constraints honoured

No new DSP algorithm · no ProductPage structure change · no export
pipeline change · realtime flag default OFF · ResultPage/V1 intact · no
auto re-render on preset select · preview/export consistency preserved.
