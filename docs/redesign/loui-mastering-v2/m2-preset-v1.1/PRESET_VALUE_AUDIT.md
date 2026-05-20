# M2-PRESET-v1.1 — Preset Value Audit (v1.0.0 → v1.1.0)

> Full extracted values + the similarity issues v1.1 resolves.

---

## 1. v1.1.0 value table

EQ: lowCut(Hz) / lowShelf(dB) / presence(dB) / air(dB) · Dyn: thr(dB) /
ratio / atk(ms) / rel(ms) / mix(%) · Img: width(%) / lowMono(Hz) · Lim:
LUFS / ceil(dBTP) / look(ms) / character.

| Preset | LC | LS | Pres | Air | Thr | Rat | Atk | Rel | Mix | W | LM | LUFS | Ceil | Look | Char |
|---|--|--|--|--|--|--|--|--|--|--|--|--|--|--|--|
| AI Pop | 34 | 0.8 | 0.5 | 2.0 | −15 | 2.2 | 8 | 110 | 100 | 112 | 120 | −10 | −1.0 | 2.5 | glue |
| KPOP Loud | 36 | 1.0 | 1.4 | 2.8 | −18 | 3.2 | 5 | 90 | 100 | 128 | 145 | −8 | −1.0 | 2.0 | aggressive |
| Streaming Pro | 30 | 0.6 | 0.7 | 1.6 | −14 | 2.0 | 12 | 130 | 100 | 106 | 110 | −14 | −1.0 | 2.5 | glue |
| YouTube Safe | 30 | 0.5 | 0.4 | 1.0 | −13 | 1.9 | 14 | 150 | 95 | 102 | 115 | −14 | −1.5 | 3.5 | glue |
| Lofi Warm | 26 | 2.6 | −1.2 | −2.5 | −16 | 2.4 | 18 | 230 | 88 | 94 | 105 | −16 | −1.0 | 3.0 | classic |
| EDM Wide | 30 | 1.2 | 0.8 | 2.6 | −17 | 3.0 | 4 | 80 | 100 | 138 | 160 | −9 | −1.0 | 1.5 | aggressive |
| Ballad Vocal | 42 | 0.2 | 1.8 | 1.6 | −13 | 1.8 | 16 | 170 | 88 | 100 | 110 | −14 | −1.0 | 3.0 | glue |
| Piano Natural | 26 | 0.0 | 0.3 | 1.0 | −9 | 1.4 | 28 | 260 | 60 | 100 | 80 | −16 | −1.0 | 5.0 | transparent |
| Vintage Soft | 30 | 1.8 | 0.2 | −1.5 | −15 | 2.5 | 16 | 190 | 100 | 98 | 110 | −13 | −1.0 | 3.0 | classic |
| AI Vocal Cleaner | 46 | −1.0 | −2.0 | 0.8 | −14 | 2.4 | 10 | 140 | 100 | 100 | 130 | −14 | −1.0 | 3.0 | glue |
| Cymbal Smooth | 32 | 0.6 | −1.0 | −3.0 | −14 | 2.0 | 14 | 150 | 100 | 100 | 120 | −14 | −1.0 | 3.0 | glue |
| Stereo Repair | 32 | 0.4 | 0.4 | 1.0 | −14 | 2.0 | 12 | 130 | 100 | 88 | 240 | −14 | −1.0 | 2.5 | glue |
| Mono Safe Shorts | 50 | 0.2 | 1.4 | 1.6 | −16 | 2.6 | 8 | 110 | 100 | 95 | 200 | −11 | −1.0 | 2.0 | glue |

---

## 2. Similarity issues in v1.0.0 (fixed in v1.1)

| Pair | v1.0 problem | v1.1 fix |
|---|---|---|
| Streaming Pro ↔ YouTube Safe | almost identical (air 1.4/1.2, presence 0.8/0.6, same comp) | YT Safe → low-fatigue: air 1.0, presence 0.4, longer/gentler comp (1.9:1, rel 150, mix 95), ceiling −1.5, lookahead 3.5.  SP → reference: air 1.6, presence 0.7 |
| KPOP Loud tearing risk | ceiling −0.8 + lookahead 1.8 too hot | ceiling −1.0, lookahead 2.0; density via thr −18 / ratio 3.2; air 3.0→2.8, presence 1.6→1.4 |
| EDM Wide phase risk | width 140 / lowMono 150 | width 138, lowMono 160 (sub mono-locked) |
| AI Vocal Cleaner dull risk | presence −2.5 (could dull) | presence −2.0 + air +0.8 (de-harsh, keep clarity) |
| Cymbal Smooth target | air −2.5 + presence −1.5 (broad) | air −3.0 (cymbal band) + presence −1.0 (less dulling) |
| Piano over-compression | ratio 1.5 / mix 70 | ratio 1.4 / mix 60 / lookahead 5 (more dynamic) |
| Stereo Repair strength | width 90 / lowMono 220 | width 88 / lowMono 240 (stronger collapse) |
| Mono Safe collapse | width 100 | width 95 + lowMono 200 (fold-down proof) |

---

## 3. Differentiation result

Minimum parameter difference across the whole 13-preset lineup: **6**
(`streaming-pro` ↔ `stereo-repair`), well above the ≥3 requirement.
AI-special presets differ from every Core preset in **≥4** parameters.
See `PRESET_DIFFERENTIATION_REPORT.md`.
