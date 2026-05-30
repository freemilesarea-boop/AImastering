# OZONE-MODULE-NEXT-2 — EQ Curve Overlay Precision + Active Band Dots

> Make the central EQ-curve overlay precise (RBJ magnitudes matching the
> real Rust EQ) and product-grade: per-band dots + value labels + bypass /
> high-gain states.  Visualization only — no DSP / export / preset /
> revision / realtime-graph change.

---

## 1. What shipped

| # | Deliverable | Where | Status |
|---|---|---|---|
| 1 | Parameter audit | `EQ_CURVE_PARAMETER_AUDIT.md` | ✓ |
| 2 | EQ curve model | `audio/modules/eq-curve-model.ts` (BandModel + RBJ magnitudes) | ✓ |
| 3 | Improved curve calc | matches Rust band layout; `test:eq-curve` 8/8 | ✓ |
| 4 | Active band dots | Low Cut / Low Shelf / Presence / Air + Output indicator, enabled/selected states | ✓ |
| 5 | Band value labels | compact (e.g. "90 Hz", "Low +3.5", "Out +0.5"); auto-hidden < 460 px | ✓ |
| 6 | Readability polish | lavender curve, dot glow, bypass dim, high-gain → amber warning | ✓ |
| 7 | Storybook | flat / low-cut / low-shelf / presence-cut / air / AI presets / bypassed / high-gain / narrow | ✓ |
| 8 | Verification | this doc §2 | ✓ |

---

## 2. Verification

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm test:eq-curve` | **8/8** (flat / bypass / shelf / presence / air / HPF / output / point) |
| `pnpm build:renderer` / `build:main` | OK |
| `pnpm build-storybook` | OK (+ EQ Curve stories) |
| `cargo test -p loui-dsp --lib` | 54/54 |
| full desktop suite + module/preset/revision selftests | no regression (22/22 · 9/9 · 14/14 · 11/11) |
| live visualizer / spectrum fallback | unchanged (overlay is additive over the canvas) |

ProductPage behaviour: the overlay reads live EQ param state, so preset
changes + EQ panel edits update the curve; bypass shows a flat dim line;
A/B swap + Update Preview keep the curve (it follows the param state, not
the audio source).  The `live-visualizer` flag + `SpectrumAnalyzerPanel`
fallback are untouched.

---

## 3. Honesty + constraints

- The curve uses the SAME RBJ coefficient formulas as the Rust EQ, so it
  tracks the real tone direction — but it is still labelled "approximate"
  (overlays a dBFS spectrum; omits the adaptive harshness dip).
- No DSP / export / preset-tuning / realtime-flag-default change · no
  ProductPage layout overhaul · `SpectrumAnalyzerPanel` not deleted · no
  drag-editing (out of scope).

On-device QA recommended for the curve-moving-with-playback feel (no
display in the sandbox); the SVG overlay recomputes only on band change.
