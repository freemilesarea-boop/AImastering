# M3-P-NEXT-3 — Module Strip Specification

> The bottom-of-page module rack — UI shells only.

---

## 1. Why a UI shell first

We need a visual home for "what Loui Mastering actually does to your
audio."  But the engine work that would back parameter panels (real EQ
curve editor, comp graph, limiter dial) is M2-full territory — far
larger than M3-P-NEXT-3.

So we ship the **visual rack now**, with no real DSP wiring, and a
clean `onSelect(id)` callback that future PRs can connect to slide-over
parameter panels.

This is the same pattern Ozone uses on first-launch: cards visible,
states clear, parameters appear only on click.

---

## 2. Card definition

```ts
export interface ModuleCardDef {
  id: 'eq' | 'dynamics' | 'imager' | 'limiter' | 'export';
  label:    string;        // 'EQ', 'Dynamics', etc.
  subtitle: string;        // editorial — '7-band · adaptive'
  state:    'active' | 'bypass' | 'locked' | 'coming-soon';
  readout?: string;        // optional right-side value — '−2.1 dB'
}
```

---

## 3. The five default cards

| id | Label | Subtitle | State | Readout | Backing implementation |
|---|---|---|---|---|---|
| eq        | EQ        | 7-band · adaptive | active      | ±2.4 dB     | `dynamicEq` report in masteringResult |
| dynamics  | Dynamics  | Glue Comp         | active      | −2.1 dB     | Compressor + AnalysisReport |
| imager    | Imager    | Stereo width      | bypass      | +0          | Not wired (M2-full) |
| limiter   | Limiter   | True-peak guard   | active      | −1.0 dBTP   | Existing limiter + targetTruePeak |
| export    | Export    | WAV · MP3 · Report| coming-soon | —           | Will wire to ExportReportPanel in M3-P-NEXT-4 |

The readouts above are **defaults** for design review.  Real values come
from `masteringResult.analysisReport` once we wire the cards to the
store in M3-P-NEXT-4.

---

## 4. State styling

Four discrete states, each with a state pill, opacity, and accent
treatment:

| State | Pill text | Pill colour | Card opacity | Border |
|---|---|---|---|---|
| `active`      | `On`      | `meter.safe.fg`   on `meter.safe.bg`   | 1.0  | `surface.border` (or accent if selected) |
| `bypass`      | `Bypass`  | `text.muted`      on grey 18 %         | 0.78 | `surface.border` |
| `locked`      | `Locked`  | `meter.warn.fg`   on `meter.warn.bg`   | 0.78 | `surface.border` |
| `coming-soon` | `Soon`    | `meter.accent.fg` on accent 16 %       | 0.72 | `surface.border` |

Opacity is the primary "this is not really live" signal.  The pill
secondary.  Border accent denotes selection (future param-panel slot).

---

## 5. Mini visuals per module

Each card carries a 64 × 20 schematic SVG that hints at the module's
role — without pretending to be a real parameter graph:

| Module | Visual |
|---|---|
| EQ        | Three soft bumps (low / mid / high band curve) in `meter.accent` |
| Dynamics  | Linear-→-knee-→-flatten compressor curve in `meter.safe` |
| Imager    | Two outward arrows (stereo widening) in `text.tertiary` |
| Limiter   | Triangle wave clipping against a dashed ceiling — wave in `meter.warn`, ceiling in `meter.danger` |
| Export    | A box + outward arrow (export icon) in `text.tertiary` |

These are decorative — they communicate intent in two glances.  When
real parameter editors land (M2-full / M3-P-NEXT-4), the schematics will
be replaced by live parameter visualisers.

---

## 6. Click behaviour

Clicking a card calls `props.onSelect(id)` with the card's id string.
ProductPage stores the selection in local state and passes
`selectedId={state}` back, which highlights the selected card with the
accent-colour border.

This selection is **visual only** in M3-P-NEXT-3 — there is no
parameter panel to open.  M3-P-NEXT-4 will:

1. Add a `<SlideOver>` overlay that mounts when a card is selected
2. Route to a module-specific component (`EqParameterPanel`,
   `LimiterParameterPanel`, etc.)
3. Wire those to `masteringResult` reads + (future) live engine
   parameter writes

---

## 7. Storybook coverage

`LouiModuleStrip.stories.tsx` exposes five stories:

| Story | Module states | Purpose |
|---|---|---|
| `Default`         | mix of all four states            | Production state |
| `AllActive`       | every card active                 | Future state — full mastering chain live |
| `AllBypassed`     | every card in bypass              | "Source mode" preview |
| `AllLocked`       | every card locked                 | Trial / restricted licence visualisation |
| `ComingSoonHeavy` | first two active, rest "coming-soon" | Current shipping state truth |

Each story uses `useState` to track selection so designers can click
through and inspect the focused-state styling.
