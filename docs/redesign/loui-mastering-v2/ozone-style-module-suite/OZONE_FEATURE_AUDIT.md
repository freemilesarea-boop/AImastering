# OZONE-STYLE-MODULE-SUITE — Feature Audit + Loui Reinterpretation

> We studied the *structure* of a pro modular mastering suite (module
> categories + the "assistant → adjust" flow) and re-imagined it for Loui
> — AI-music + streaming focused, charcoal/lavender.  We do **not** copy
> any product's names, UI, logos, art, or algorithms; Loui uses its own
> names (Loui Glue / Loui Clean Limit / Loui Loud Push) and its own DSP.

---

## 1. Reference feature groups → Loui mapping

| Reference concept (generic) | Loui module | Honest status today | Backing |
|---|---|---|---|
| Equalizer | **EQ** | preview-only (+ export output gain) | Rust EQ (lowCut/shelf/presence/air) |
| Dynamic EQ | Dynamic EQ | planned | none |
| Dynamics / bus comp | **Dynamics** (Loui Glue) | preview-only | Rust single-band comp |
| Imager | **Imager** | **live** (width export) | Rust M/S width + low-mono |
| Limiter | **Limiter** (Loui Clean Limit) | **live** | Rust true-peak limiter + export ceiling |
| Maximizer / loudness | **Maximizer** (Loui Loud Push) | **live** | export targetLufs + preview limiter |
| Exciter | Exciter | planned | none |
| Stabilizer / spectral | (folded into Harshness) | planned | none |
| Bass Control | Bass Control | planned | (low shelf approximates) |
| Low End Focus | Low End Focus | planned | none |
| Spectral Shaper / Harshness | Harshness Control | planned (today via AI presets) | AI presets use Rust EQ |
| Match EQ / Reference | Reference Match | planned (guidance, not copy) | none |
| Dither / Codec preview | Dither / Export | export-only (SR/bitDepth) | export pipeline |
| Master Assistant / Custom Flow | Loui Assistant Flow | planned (preset-recommendation today) | preset lineup |
| Unlimiter / Stem EQ | — | not on the near roadmap | n/a |

---

## 2. AI-special (Loui differentiators — preset-backed)

| Module | Status | Backing |
|---|---|---|
| AI Vocal Cleaner | preview-only | preset → Rust EQ |
| Cymbal Smooth | preview-only | preset → Rust EQ |
| Stereo Repair | preview-only (width export) | preset → Rust imager |
| Mono Safe Shorts | preview-only | preset → Rust chain |
| AI Harshness Guard | planned | needs dynamic EQ DSP |

---

## 3. Capability matrix (구현 가능 / 부분 / 추후 / 표시 금지)

| Bucket | Modules |
|---|---|
| **구현 가능 (live)** | Imager (width), Limiter, Maximizer (loudness) |
| **부분 구현 (preview-only)** | EQ tone, Dynamics, AI presets (Vocal Cleaner / Cymbal Smooth / Stereo Repair / Mono Safe Shorts) |
| **export-only** | Dither / Export (sample rate · bit depth) |
| **추후 구현 (planned)** | Dynamic EQ, Exciter, Bass Control, Low End Focus, Harshness Control, Reference Match, AI Harshness Guard |
| **표시 금지 (never claim done)** | any planned module shown as "Live"; any tone param shown as export-applied when it isn't |

The matrix is enforced in code by `module-support-matrix.ts` +
`pnpm test:modules` (9/9) — a module can't claim more than it backs.
