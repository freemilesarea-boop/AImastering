# M2-PRESET-TUNING — Preset QA / Listening Matrix

> Manual listening QA for the preset lineup.  Each preset is auditioned
> against representative source material on representative playback
> systems.  Fill `LISTENING_NOTES_TEMPLATE.md` per (preset × source).

---

## 1. Source material set

| Code | Source | Why |
|---|---|---|
| S1 | AI-generated vocal pop | core AI use case; sibilance / 3 kHz glare |
| S2 | Female vocal (acoustic) | presence + air honesty |
| S3 | Male vocal (rap/spoken) | low-mid mud, plosives |
| S4 | EDM / electronic | width, sub, loudness |
| S5 | Solo piano | dynamics, transparency, no pumping |
| S6 | Low-end-heavy (808 / bass) | mono bass, limiter behaviour |
| S7 | AI track w/ fake-wide stereo | stereo-repair correctness |
| S8 | AI track w/ harsh cymbals | cymbal-smooth correctness |

---

## 2. Playback systems

| Code | System | Checks |
|---|---|---|
| P1 | Studio / headphones (flat) | tonal balance, artefacts |
| P2 | AirPods / earbuds | consumer tilt, harshness |
| P3 | Phone speaker (mono) | mono fold-down, bass survival |
| P4 | Laptop speakers | low-end loss, presence |
| P5 | Car | sub + midbass, loudness war |
| P6 | YouTube upload (post-normalize) | perceived loudness after −14 LUFS normalize |

---

## 3. Preset × priority-source grid

Minimum required auditions (✓ = must listen before sign-off):

| Preset | S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 | Key systems |
|---|----|----|----|----|----|----|----|----|---|
| AI Pop | ✓ | ✓ |  | ✓ |  | ✓ |  | ✓ | P1 P2 P3 P6 |
| KPOP Loud | ✓ | ✓ |  | ✓ |  | ✓ |  |  | P1 P2 P5 P6 |
| Streaming Pro | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |  | P1 P6 |
| YouTube Safe | ✓ | ✓ |  | ✓ |  |  |  |  | P6 |
| Lofi Warm |  | ✓ | ✓ |  |  | ✓ |  |  | P2 P4 |
| EDM Wide |  |  |  | ✓ |  | ✓ | ✓ |  | P1 P3 P5 |
| Ballad Vocal |  | ✓ | ✓ |  | ✓ |  |  |  | P1 P2 |
| Piano Natural |  |  |  |  | ✓ |  |  |  | P1 P4 |
| Vintage Soft |  | ✓ | ✓ |  | ✓ |  |  |  | P2 P4 |
| AI Vocal Cleaner | ✓ | ✓ | ✓ |  |  |  |  | ✓ | P1 P2 |
| Cymbal Smooth | ✓ |  |  | ✓ |  |  |  | ✓ | P1 P2 |
| Stereo Repair | ✓ |  |  | ✓ |  | ✓ | ✓ |  | P1 P3 |
| Mono Safe Shorts | ✓ | ✓ |  | ✓ |  | ✓ |  |  | P3 P4 |

---

## 4. Per-audition pass criteria

- No audible distortion / pumping / harsh peaks at the preset's loudness.
- Mono fold-down (P3) keeps the bass present and no phase cancellation
  (especially Stereo Repair / Mono Safe Shorts / EDM Wide).
- Vocal intelligibility preserved (AI Vocal Cleaner must reduce harshness
  without dulling).
- After YouTube normalize (P6) the perceived loudness sits in a sensible
  range vs a reference master.
- **Preview ≈ export**: re-render + export, confirm loudness/width/ceiling
  match the preview within the documented tolerance (≤1.5 LU).

---

## 5. Sign-off

A preset ships when every required (✓) audition passes and the
preview/export consistency check holds.  Record results in dated
`LISTENING_NOTES_*.md` files from the template.
