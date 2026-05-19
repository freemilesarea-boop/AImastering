# M3-P-NEXT-3 — Next Steps

> What comes after ProductPage is in place.

---

## 1. Immediate follow-ups

### M3-P-NEXT-4 — Module parameter slide-overs

Wire the Module Strip `onSelect(id)` callback to a slide-over panel.
Per-module components:

| Module | Component | Data source |
|---|---|---|
| EQ        | `EqParameterPanel`        | `masteringResult.dynamicEq` |
| Dynamics  | `DynamicsParameterPanel`  | `masteringResult.analysisReport.compressor` |
| Imager    | `ImagerParameterPanel`    | StereoScopePanel-style live correlation read |
| Limiter   | `LimiterParameterPanel`   | `masteringResult.analysisReport.limiter` |
| Export    | `ExportSlideOver`         | Routes to existing `ExportReportPanel` + `SaveButtons` |

Each panel mounts inside a `<SlideOver>` that:
- Anchors right, 480 px wide
- Slides in over 240 ms ease-out
- Captures focus, closes on ESC / backdrop click

Stories per module — same preset matrix as ProductPage.

### M3-P-NEXT-5 — Real engine parameter writes (M2-full bridge)

Once M2-full lands the Rust mastering chain:
- EQ panel emits parameter changes that get applied live
- Limiter ceiling becomes a live slider
- Glue compressor threshold / ratio / attack / release become live

Until M2-full lands, parameter panels are **read-only** — they display
what the Python pipeline computed.

### M3-P-NEXT-6 — ProductPage as default

Flip `VITE_LOUI_PRODUCT_LAYOUT` to `true` in the default build config
once:
- External opt-in (M3-P-NEXT-3 stable for one release cycle)
- Module parameter panels (M3-P-NEXT-4) ship
- Design verification (`05-DESIGN-VERIFICATION.md`) signs off

ResultPage stays as the flag-off fallback for one full release after.

### M3-P-NEXT-7 — Remove ResultPage

After one full release with ProductPage as default, delete:
- `pages/ResultPage.tsx`
- The flag check in `App.tsx`
- `product-layout-flag.ts`

---

## 2. Storybook-specific follow-ups

### Add `@storybook/addon-viewport`

Storybook 10 ships viewport metadata via story parameters, but a
viewport switcher in the toolbar requires the addon.  Adds ~12 KB to
the storybook bundle.

```json
"@storybook/addon-viewport": "10"
```

…and add it to `.storybook/main.ts`'s `addons` array.

### Live preset toolbar

Add a global Storybook toolbar that calls
`session.setPreset(presetId)` on the active mock session.  Faster
iteration than re-rendering via `args`.

### Visual regression (M3-P-NEXT-2 prerequisite)

Run Playwright against each ProductPage story.  Critical for catching
layout regressions across viewport sizes.  Pre-existing milestone task
in `m3-product-next-1/06-NEXT-STEPS.md` — the new stories slot in.

### Hot key shortcuts in Storybook

- `←/→` to switch between presets
- `Space` to toggle the engine-active flag
- `?` for a help overlay listing the keys

Wire via Storybook decorators that consume the active story's args.

---

## 3. Theme follow-ups

| Item | Target milestone |
|---|---|
| Light theme (export reports, printed materials) | M5+ |
| Font bundling (Inter or Geist) — replace system stack | M3-P-NEXT-4 |
| Animation tokens consumed via `loui-theme.motion` (instead of inline 120ms strings) | M3-P-NEXT-4 |
| Tailwind plugin: `bg-loui-panel` → `surface.panel` mapping | M3-P-NEXT-4 |
| Figma library hand-off for designer iteration | external |

---

## 4. Layout follow-ups

### Resizable meter rail

Drag-handle on the rail boundary to widen / narrow the meter column.
Persist to `localStorage` so user preferences survive reloads.

Implementation sketch: replace the fixed `320 px` column with a CSS
custom property `--loui-meter-width` controlled by a draggable splitter.

### Floating mini-meter

For users who pop ProductPage into a smaller window, surface the
top-line LUFS / TP readout as a floating chip when the meter rail goes
off-screen.

### Compact module strip

At < 1024 px the strip cards already hit their minWidth.  Below that,
collapse the strip into a single dropdown.  Out of scope until external
analytics show users on smaller screens.

---

## 5. Storybook hosting

For PR previews + designer review:

- **Local**: `pnpm --filter @aimaster/desktop storybook`
- **CI artefact**: `storybook-static/` uploaded as a GitHub Actions artefact (M3-P-NEXT-2)
- **Public preview**: Netlify / Vercel / GitHub Pages on every PR (future)
- **Per-release archive**: snapshot per Loui Mastering release as a "design changelog"

---

## 6. The bigger picture

This milestone moves Loui Mastering from "designed panels" to "designed
**product**."  The remaining gaps to a shippable v2 GA:

| Gap | Filled by |
|---|---|
| Visual regression coverage | M3-P-NEXT-2 |
| Module parameter editors    | M3-P-NEXT-4 |
| Real engine parameter writes | M2-full + M3-P-NEXT-5 |
| Product layout as default   | M3-P-NEXT-6 |
| V1 / ResultPage retirement  | M3-P-NEXT-7 |
| Reference profile UI integration | M4 |
| Plugin (VST3 / CLAP / AU) wrappers | M5+ |

ProductPage gives us the **scaffolding** that all of those gaps plug
into.  Without it, every new feature would have to choose between
landing in the old card-stack ResultPage (a dead-end) or growing a new
ad-hoc page.  With it, every future module is a card on the strip and
a slide-over panel — a consistent, designed surface.
