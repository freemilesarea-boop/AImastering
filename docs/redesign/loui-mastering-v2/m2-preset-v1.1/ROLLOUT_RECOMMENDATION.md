# M2-PRESET-v1.1 — Rollout Recommendation

> Status of the v1.1.0 preset lineup.

---

## 1. Verdict: **ship v1.1.0 as the release-candidate lineup**

The 13 presets are now tuned to distinct, intentional sound characters
(not loudness-only re-skins), every value is safe + in-range, and the
automated differentiation + sanity suite is green.  v1.1.0 is the
release-candidate sound; final sign-off is the on-device listening pass
(`PRESET_LISTENING_NOTES_v1.1.md`).

---

## 2. What changed vs v1.0.0

- All 13 presets bumped to `1.1.0` with re-tuned EQ / dynamics / imager /
  limiter (see `PRESET_VALUE_AUDIT.md`).
- Resolved the Streaming Pro ↔ YouTube Safe near-duplication.
- Anti-tear pass on loud presets (KPOP / EDM ceilings + lookahead).
- Phase-risk control on wide presets (lowMono raised).
- AI-special presets sharpened into clear problem-solvers.
- Descriptions refreshed to match the v1.1 character.

---

## 3. Safety / consistency

| Guarantee | Status |
|---|---|
| No NaN in chain config | ✓ (selftest) |
| True-peak headroom on all presets | ✓ |
| Loud presets anti-tear (ceiling ≤ −1.0) | ✓ |
| Wide presets phase-safe (lowMono ≥ 150) | ✓ |
| Dynamic presets not over-compressed | ✓ |
| Preview ↔ export consistency | ✓ (same parameter state; renderable subset exact) |
| Every pair ≥3 param diffs; AI-special vs Core ≥4 | ✓ |

---

## 4. Constraints honoured

- No new DSP algorithm · no ProductPage structure change · no export
  pipeline change · realtime flag default unchanged (OFF) · ResultPage/V1
  intact · no auto re-render on preset select.

This was a pure sound-tuning + verification milestone.

---

## 5. Next

1. On-device listening pass → record in `PRESET_LISTENING_NOTES_v1.1.md`.
2. Fold any listening revisions into a v1.2 tuning bump.
3. (Separate track) promote preview-only tone params to export-renderable.
