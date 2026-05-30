# M2-PRESET-TUNING — Benchmark / Tuning Notes (v1.0.0 lineup)

> The reasoning behind each preset's tuning + reference targets.  These
> are the design intents; on-device listening (PRESET_QA_MATRIX) confirms
> or revises them.  Loudness figures are the preset's TARGET, before
> platform normalization.

---

## 1. Tuning philosophy

Loui is tuned so **AI music sounds better**, not for "generic Ozone
mastering".  Across the lineup the recurring moves are:

- **Harsh-vocal control** — AI vocals glare around 3 kHz; presets that
  feature vocals pull presence back rather than push it.
- **Cymbal/air discipline** — AI hats/cymbals splash; air is lifted only
  where the genre wants it, and actively reduced in the AI-special set.
- **Fake-stereo cleanup** — AI upmixes produce phasey super-wide sides;
  low-mono frequency + width control keep mono fold-down safe.
- **Low-end mud** — a low-cut + low-shelf discipline keeps the 100–300 Hz
  region clear.
- **Mono / mobile** — high low-mono + restrained width so phone speakers
  and Shorts survive a fold-down.

---

## 2. Core

| Preset | LUFS | Tone intent | Notable moves |
|---|---|---|---|
| AI Pop | −10 | bright, modern | presence restrained (+0.6), air +2.2, width 110, glue |
| KPOP Loud | −8 | punchy, wide | air +3, presence +1.6, width 125, ratio 3 / fast attack, aggressive limiter |
| Streaming Pro | −14 | neutral reference | gentle everything, width 105 — the safe default |
| YouTube Safe | −14 | neutral | −1.5 dBTP ceiling for lossy headroom + YT normalize |

## 3. Character

| Preset | LUFS | Tone intent | Notable moves |
|---|---|---|---|
| Lofi Warm | −16 | warm, cozy | low-shelf +2.4, air −2.0, presence −1, classic limiter, 90% comp mix |
| EDM Wide | −9 | big, wide | width 140, low-mono 150 (mono sub), air +2.6, fast aggressive comp |
| Ballad Vocal | −14 | vocal-forward | presence +1.8, air +1.8, gentle 1.8:1 comp, low-cut 40 |
| Piano Natural | −16 | transparent | transparent limiter, 1.5:1 / 70% mix, minimal EQ, long lookahead |
| Vintage Soft | −13 | warm, soft | low-shelf +1.6, air −1.0, classic limiter saturation feel |

## 4. AI Special (the differentiators)

| Preset | LUFS | Targets | Notable moves |
|---|---|---|---|
| AI Vocal Cleaner | −14 | harsh AI vocal | presence −2.5, low-cut 46, low-shelf −1.0 (de-mud), air +0.5 |
| Cymbal Smooth | −14 | metallic AI cymbals | air −2.5, presence −1.5 |
| Stereo Repair | −14 | fake-wide AI stereo | width 90, low-mono 220 |
| Mono Safe Shorts | −11 | phone / Shorts | low-cut 50, low-mono 180, presence +1.2 for small-speaker clarity |

---

## 5. Reference notes

- Streaming targets assume platform normalization to ≈ −14 LUFS
  (Spotify/YouTube/Amazon) or −16 (Apple) — louder presets (KPOP/EDM)
  will be turned DOWN, so their value is density/impact, not final
  loudness.
- All presets keep a true-peak ceiling ≤ −0.8 dBTP (ISP on) so lossy
  encoders don't clip.
- The 7+ tone params (EQ bands, dynamics, low-mono) are **preview-only**
  until the export pipeline honours them — see PREVIEW_EXPORT_CONSISTENCY
  (M2-full).  Renderable (loudness/ceiling/width/output gain) is exact.

---

## 6. Versioning

Lineup version `1.0.0`.  Bump a preset's `version` whenever its tuning
changes; bump the lineup note here with the rationale.  Preset = product
quality — every change is a listening-tested decision.
