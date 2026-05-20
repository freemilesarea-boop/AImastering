# M3-O-NEXT-7 — Product Visual Audit (vs Ozone)

> Where ProductPage stood vs an Ozone-grade analyzer-centric product,
> and what this milestone changed.

---

## 1. Comparison axes

| Axis | Before (M3-P-NEXT-6) | Ozone-grade target | This milestone |
|---|---|---|---|
| Information density | Good — 5 regions | High but readable | Maintained; added depth cues |
| Hierarchy | Clear regions | Analyzer dominant | Analyzer depth wash + glow |
| Analyzer prominence | Present, not dominant | Centre-stage | Radial depth behind trace when live |
| Module discoverability | Cards + states | Signal chain visible | Signal-flow chevrons + active glow |
| Loudness visibility | Meter rail | Always-on, prominent | Meter rail (unchanged) + LU-match in A/B |
| Transport visibility | Play + scrubber | Always present | + A/B compare control |
| Interaction affordance | Hover/active | Tactile, instant | A/B (B key), reduced-motion, transitions |
| Whitespace | Even (space tokens) | Breathing | Maintained |
| Motion | Slide-over + meters | Purposeful | reduced-motion respected |
| Color emphasis | Restrained violet/green | Accent-led | Loudness gradient, active glow |
| Dark contrast | AAA/AA | Deep, layered | Maintained |

---

## 2. The headline gap closed: Before/After

The single biggest "product feel" gap was the absence of an instant
A/B compare.  Ozone-class tools let you flip between processed and
reference instantly.  M3-O-NEXT-7 adds **LouiABCompare**:
- A = original master preview, B = latest re-rendered preview
- **Real preview source swap** (no fake bypass), position-preserved
- Keyboard **B** to flip
- Optional **loudness-matched** comparison (volume trim by the measured
  LUFS delta) so A/B reflects TONE, not loudness

---

## 3. Implemented this milestone

| Item | Status |
|---|---|
| Before/After A/B compare (real swap + B key + LU match) | ✓ implemented |
| Analyzer depth wash (radial, live-only, CSS) | ✓ implemented |
| Module signal-flow chevrons + active glow | ✓ implemented |
| Streaming-target loudness gradient (safe→loud→aggressive) | ✓ implemented |
| reduced-motion (slide-over honours `prefers-reduced-motion`) | ✓ implemented |
| Unified transitions (120/200/280 ms ease-out) | ✓ maintained |

---

## 4. Designed, deferred (documented, not built)

| Item | Why deferred |
|---|---|
| Full analyzer-first re-layout (resizable, larger canvas) | Higher layout-regression risk; A/B + depth deliver most of the feel |
| Animated flow line along the chain | Cosmetic; chevrons + glow suffice; revisit with motion budget |
| Loudness history graph during render | Needs a time-series capture; preview strip timestamp covers feedback for now |
| Module drag-reorder | Requires engine chain reordering (M2-full) |
| Streaming normalization tooltips / LRA map | Editorial content pass; not blocking |

These are honest non-goals for this milestone — listed so the design
team has the backlog.  None require DSP changes.

---

## 5. Constraints honoured

- No DSP quality change (polish + interaction only)
- No analyzer CPU increase (depth wash is CSS; A/B reuses the existing
  audio element + analyzer session)
- No ResultPage removal, no V1 removal
- No Python pipeline / Rust DSP / export-architecture changes
- No fake realtime DSP (A/B is a real source swap)

---

## 6. Screenshot comparison (manual)

Sandbox can't render screenshots.  For the design review, capture in
Storybook:
- `Product / ProductPage / SpotifyLoud` (analyzer depth)
- `Product / A-B Compare / Available` (A/B control)
- `Product / Module Strip / Default` (signal-flow chevrons + glow)
- `Product / ProductPage` (preset gradient under targets)

Compare side-by-side with Ozone's main view.  Verify the analyzer reads
as centre-stage and the module chain reads as a signal flow.
