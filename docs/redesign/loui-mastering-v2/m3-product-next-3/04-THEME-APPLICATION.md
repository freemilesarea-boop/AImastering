# M3-P-NEXT-3 — Theme Application

> How `loui-theme.ts` v1 tokens map to the product-layout components.

---

## 1. Approach

M3-P-NEXT-1 created the theme as a token module sitting on the side of
the codebase — additive, unconsumed.  M3-P-NEXT-3 wires those tokens
into the new product components via **inline style consumption**:

```tsx
import { surface, text, typography, space } from '../../theme/loui-theme.js';

<button style={{
  background: surface.well,
  color:      text.tertiary,
  paddingInline: space['3'],
  borderRadius:  radius.chip,
}} />
```

No Tailwind classes are used in `components/product/*`.  Existing V2
panels (`LoudnessMeterPanelV2`, `SpectrumAnalyzerPanel`,
`StereoScopePanel`) continue to use their Tailwind classes — they are
**embedded** inside the Loui-themed shells, not re-themed in this
milestone.

The choice is intentional:

- Tailwind classes in V2 panels couple them to a class-name-driven
  styling pipeline.  Refactoring them is M3-P-NEXT-4 work, not this PR.
- New product components have no Tailwind dependency.  Future extraction
  as a standalone design-system package is trivial.

---

## 2. Token usage matrix

| Component | Surface tokens | Text tokens | Meter tokens | Space tokens | Type tokens | Motion tokens |
|---|---|---|---|---|---|---|
| LouiTopBar         | `background`, `border`, `well` | `primary`, `secondary`, `tertiary`, `muted`, `disabled` | `accent.fg/bg` | `2 / 3 / 4` | `size.{xs,sm,md,lg}`, `weight.{medium,semi}` | `120ms ease-out` (inline) |
| LouiPresetHeader   | `background`, `well`, `border` | `primary`, `secondary`, `tertiary`, `muted` | `accent.fg` | `2 / 3 / 4` | `size.{xs,sm}`, `weight.{medium,semi}` | `120ms ease-out` |
| LouiAnalyzerCanvas | `background`, `panel`, `well`, `border`, `overlay` | `primary`, `tertiary`, `muted` | `safe.fg` (live pulse) | `3 / 4` | `size.{xs,sm,md}`, `weight.semi` | `120ms ease-out` (pulse glow) |
| LouiMeterColumn    | `panel`, `border` | `primary`, `muted` | — | `3 / 4` | `size.{xs,md}`, `weight.semi` | — |
| LouiModuleStrip    | `background`, `panel`, `well`, `border` | `primary`, `secondary`, `tertiary`, `muted` | `safe`, `warn`, `danger`, `accent` (state pills + mini visuals) | `2 / 3 / 4` | `size.{xs,sm,md}`, `weight.{medium,semi}`, `family.mono` (readouts) | `120ms ease-out` |
| LouiStatusBar      | `background`, `border`, `well`, `overlay` | `secondary`, `tertiary`, `muted` | `safe.fg` (running dot) | `4` | `size.xs`, `family.mono` | `120ms ease-out` |
| ProductPage (transport) | `background`, `well`, `border` | `primary`, `tertiary`, `muted` | — | `2 / 3 / 4` | `size.xs`, `family.mono` | `100ms linear` (scrubber fill) |

---

## 3. Documented constants

Hard-coded numeric constants outside the token system:

| Where | Constant | Why it's not a token |
|---|---|---|
| LouiTopBar height | `48 px` | OS-window header band height — fixed by Electron drag-region |
| LouiPresetHeader height | `80 px` | 56 px chip + `space.3` × 2 padding; chip height is content-driven |
| Preset chip min-width | `132 px` | Two-line label + readout layout — content shape |
| LouiMeterColumn width | `320 px` | Locks analyzer canvas's aspect ratio at 1440 / 1280 / 1024 viewports |
| LouiModuleStrip card height | `124 px` | 3-line layout (title row + subtitle + visual row) at `space.3` insets |
| Module card min-width | `168 px` | Five cards × 168 = 840 px content; fits the 1024 px narrow viewport |
| LouiStatusBar height | `28 px` | Single-row, mono digits at `size.xs` — comfortable click target |
| Live pulse dot | `6 px` | Sub-token size for status indicators (chip rule of thumb) |
| Transport play button | `28 px × 28 px` | Square button with a `999 px` border-radius (circle) |

These are documented in `01-LAYOUT-SPEC.md` and stay constants — adding
them to `space.*` would dilute the spacing scale (which is for content
spacing, not chrome sizing).

---

## 4. Tailwind class survival

| Codebase area | Class style | M3-P-NEXT-3 status |
|---|---|---|
| `components/*.tsx` (V1 + V2 panels)                          | Tailwind | unchanged |
| `pages/*.tsx` (legacy ResultPage etc.)                       | Tailwind | unchanged |
| `pages/ProductPage.tsx`                                      | Inline style + Loui tokens | new |
| `components/product/*.tsx`                                   | Inline style + Loui tokens | new |
| `components/product/LouiModuleStrip.stories.tsx`             | Mix — needs Tailwind context for host preview | new |
| `theme/loui-theme.ts` + `theme/loui-theme.stories.tsx`       | Inline style + tokens | unchanged from M3-P-NEXT-1 |

Two single-class Tailwind usages remain inside product components — for
Electron drag regions:
- `className="drag-region"` on the LouiTopBar root
- `className="no-drag"` on Top-bar buttons, transport controls, preset
  chips (so the drag region doesn't swallow clicks)

These classes are CSS variables defined in `index.css`, not Tailwind
utility classes per se.

---

## 5. Future migration plan (M3-P-NEXT-4+)

Once ProductPage is the default, the next refactor is the V2 panels:

1. **LoudnessMeterPanelV2** — most contained, swap Tailwind for inline tokens
2. **StereoScopePanel** — verdict chip colours move from Tailwind classes to `meter.*`
3. **SpectrumAnalyzerPanel** — mostly canvas-driven; only the header / footer chrome needs token migration

Each migration is a separate PR with a side-by-side Storybook regression
confirmation (no visual diff against the prior story).

The optional final step is a **Tailwind plugin** that maps
`bg-loui-panel` → `surface.panel`, etc.  That makes the tokens consumable
as Tailwind classes for the rest of the app (HomePage, AnalysisPage,
MasteringPage) without a wholesale rewrite.  Listed under
`06-NEXT-STEPS.md`.

---

## 6. Visual references

The colour palette is shaped by these references (from `loui-theme.ts`
header):

- **Apple Pro Apps (Logic Pro, Final Cut)** — near-black ramp, no shadows
- **iZotope Ozone** — meter-first information density, accent on a single
  colour (we use violet)
- **Ableton Live 11+** — restrained saturation, hairline borders
- **Teenage Engineering** — surface contrast via tonal elevation, not
  shadows

No reference influence is taken from:

- Gaming UIs — no neon, no scanlines, no chromatic aberration
- Web-app design systems (Material, Tailwind UI) — they pick palettes for
  light themes by default; we are dark-first
- Pro Tools / Sonarworks — their layout density is too cramped for a
  consumer-grade audio app
