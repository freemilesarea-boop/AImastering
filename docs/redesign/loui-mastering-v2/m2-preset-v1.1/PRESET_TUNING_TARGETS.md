# M2-PRESET-v1.1 — Tuning Targets

> The sound goal for each preset.  Values in `loui-presets.ts` serve these
> goals; on-device listening (PRESET_LISTENING_NOTES_v1.1) confirms them.

---

## Core

| Preset | Goal | How v1.1 serves it |
|---|---|---|
| AI Pop | Flagship — bright & clear, never harsh | presence 0.5 (restrained 3 kHz), air 2.0, width 112, gentle glue at −10 |
| KPOP Loud | Loud / bright / punchy, no tearing | dense glue (thr −18, ratio 3.2), −1.0 ceiling + 2.0 lookahead, air 2.8 |
| Streaming Pro | Safest balanced reference | neutral EQ, air 1.6, width 106, −14 / −1.0 |
| YouTube Safe | Low listening fatigue for long sessions | soft top (air 1.0, presence 0.4), gentle long comp, −1.5 ceiling |

## Character

| Preset | Goal | How v1.1 serves it |
|---|---|---|
| Lofi Warm | Soft highs, warm low-mids | air −2.5, presence −1.2, lowShelf 2.6, relaxed comp |
| EDM Wide | Wide + strong low, no phase risk | width 138 over lowMono 160 (mono sub), air 2.6, fast aggressive glue |
| Ballad Vocal | Vocal up front, no excess low | lowCut 42 / lowShelf 0.2, presence 1.8, gentle 1.8:1 |
| Piano Natural | Preserve dynamics, no over-compression | ratio 1.4 / mix 60, transparent limiter, 5 ms lookahead, −16 |
| Vintage Soft | Soft, rounded texture | lowShelf 1.8, air −1.5, classic limiter glue |

## AI Special (problem-solving)

| Preset | Problem it solves | How v1.1 serves it |
|---|---|---|
| AI Vocal Cleaner | 2–5 kHz AI-vocal harshness, low-mid mud | presence −2.0 + air +0.8 (de-harsh, keep clarity), lowCut 46 / lowShelf −1.0 |
| Cymbal Smooth | Metallic AI cymbals / hi-hats | air −3.0 (cymbal band), presence −1.0 |
| Stereo Repair | Fake / over-wide AI stereo | width 88, lowMono 240 (strong mono bass) |
| Mono Safe Shorts | Mobile / Shorts mono collapse | width 95 + lowMono 200, presence 1.4 for tiny-speaker clarity, punchy glue at −11 |

---

## Global guardrails

- True-peak ceiling ≤ −1.0 dBTP on every loud preset (anti-tear).
- Width ≤ 150; any width > 130 keeps lowMono ≥ 150 (phase safety).
- Dynamic presets stay dynamic (Piano ratio ≤ 1.6, mix ≤ 70).
- No value out of its parameter range (no silent clamp).
- Preview ↔ export consistency preserved (same parameter state).
