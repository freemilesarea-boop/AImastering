# LOUI_MODULE_ROADMAP

> Order of work to grow the module suite, grounded in the existing Rust
> chain + export pipeline.

---

## Phase A — surface what's real (THIS milestone)

- Module suite data model + honesty matrix (`loui-module-suite.ts`,
  `module-support-matrix.ts`, `test:modules`).
- Status-badge + module-chain UI; central spectrum + EQ-curve visualizer
  (components + stories; additive chain overview mounted in ProductPage).
- EQ / Imager / Limiter / Maximizer surfaced as Live/preview honestly,
  reusing the existing parameter panels + slide-over.

## Phase B — promote preview-only → live (needs export support)

1. Rust **offline render** (or Python param support) so EQ tone /
   dynamics / low-mono reach the exported file → EQ + Dynamics become
   **live**.
2. Parity harness extension (preview vs export) gates each promotion.

## Phase C — new DSP modules (planned → preview-only)

| Priority | Module | DSP needed |
|---|---|---|
| 1 | Harshness Control / AI Harshness Guard | dynamic 2–5 kHz band (dynamic EQ core) |
| 2 | Dynamic EQ | multi-band dynamic gain |
| 3 | Bass Control / Low End Focus | sub mono + tilt + punch |
| 4 | Exciter | harmonic generator |
| 5 | Reference Match | reference spectrum analysis + tonal-delta guidance |

## Phase D — assistant flow

- Loui Assistant: analyse source → recommend preset + module chain +
  loudness target → user adjusts.  Built on the existing preset
  recommendation + analysis; "tonal guidance", never "copy reference".

---

## Won't do (now)

Stem EQ / Stem separation, Unlimiter, codec-accurate preview — out of
scope; not on the near roadmap.
