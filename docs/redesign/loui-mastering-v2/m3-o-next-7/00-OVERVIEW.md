# M3-O-NEXT-7 — Ozone-grade Product Polish / Analyzer-Centric UX

> Lift the UX from "developer tool" toward an Ozone-class
> analyzer-centric product — polish + interaction, no DSP change.

---

## 1. What changed

| Deliverable | Where | Status |
|---|---|---|
| Product visual audit | `PRODUCT_VISUAL_AUDIT.md` | ✓ |
| Before / After A/B compare | `components/product/LouiABCompare.tsx` + ProductPage wiring | ✓ |
| Analyzer-first depth | `LouiAnalyzerCanvas` radial wash (live-only, CSS) | ✓ |
| Mastering chain visualization | `LouiModuleStrip` signal-flow chevrons + active glow | ✓ |
| Streaming target visualization | `LouiPresetHeader` loudness gradient (safe→loud→aggressive) | ✓ |
| Interaction polish | `useReducedMotion` + slide-over honours it; unified transitions | ✓ |
| Storybook visual QA | A/B (3) stories; existing analyzer / module / preset stories | ✓ |
| Performance regression report | `PERFORMANCE_REGRESSION_REPORT.md` | ✓ |

---

## 2. Headline feature — Before/After A/B

`LouiABCompare`:
- **A = original master preview, B = latest re-render**
- **Real preview source swap** (no fake bypass) — toggles the `<audio>`
  src, position-preserved, analyzer session intact
- **Keyboard B** to flip instantly (ignored in text inputs)
- **Loudness-matched** option — trims the louder side's volume by the
  measured LUFS delta so the comparison reflects TONE, not loudness

Wired into ProductPage's transport.  The LUFS for compensation comes
from the re-render response metrics (real measurement), not a guess.

---

## 3. Analyzer-centric touches

- **Depth wash** behind the spectrum (radial violet gradient) when the
  engine is live — centre-stage feel, CSS-only, zero CPU.
- **Module signal flow** — chevrons between cards show the chain order;
  active modules glow softly, bypassed stay flat.
- **Loudness gradient** under the streaming targets — green (safe) →
  amber (loud) → red (aggressive).

---

## 4. Interaction polish

- `useReducedMotion()` hook — slide-over transitions disable under
  `prefers-reduced-motion: reduce`.
- Transition timing stays unified (120 / 200 / 280 ms ease-out).
- A/B keyboard shortcut + focus-safe (ignores inputs).

---

## 5. What did NOT change

| Untouched | Verification |
|---|---|
| DSP quality | no DSP change |
| Analyzer RAF loop | no new per-frame work (see perf report) |
| Python pipeline / Rust DSP | none |
| Export architecture | none |
| ResultPage / V1 | kept |
| Realtime DSP | not faked — A/B is a real source swap |

---

## 6. Verification

| Check | Result |
|---|---|
| `pnpm typecheck`        | clean |
| `pnpm build:renderer`   | 444 KB JS / 99 KB WASM (+5 KB) |
| `pnpm build` (main)     | esbuild OK |
| `pnpm build-storybook`  | **15 components / 103 stories** |
| `cargo test -p loui-dsp --lib` | **31/31** |
| Analyzer FPS / CPU | no regression (perf report) |
| ProductPage fallback | unchanged (error boundary + flags) |
| Export workflow | unchanged |

---

## 7. Scope honesty

Implemented the highest-value, lowest-risk product-feel features:
A/B compare (headline), analyzer depth, chain visualization, target
gradient, reduced-motion.  Deferred (documented in the visual audit):
full resizable analyzer-first re-layout, animated flow line, loudness
history graph, module drag-reorder.  None of the deferred items require
DSP changes; they're a design backlog.

---

## 8. Next

- **M2-full** — real-time preview (Rust mastering chain in WASM); the
  7 remaining staged-only audio params become renderable.
- **M3-P-NEXT-7** — ResultPage / V1 removal (after a full release at
  default with zero error-boundary trips).
- **Design backlog** — analyzer-first re-layout, loudness history,
  drag-reorder (from the visual audit).
