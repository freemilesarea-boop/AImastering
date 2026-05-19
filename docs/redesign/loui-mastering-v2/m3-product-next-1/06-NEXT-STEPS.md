# M3-P-NEXT-1 — Next Steps

> What comes after Storybook is in place.

---

## 1. Immediate follow-ups (within M3 family)

### M3-P-NEXT-2 — Playwright snapshot tests

Run Storybook in CI, take screenshots of every story, diff against a
committed baseline.  Catch visual regressions automatically.

```yaml
# .github/workflows/storybook-visual.yml (sketch)
- run: pnpm --filter @aimaster/desktop build-storybook
- run: npx playwright test storybook
- uses: actions/upload-artifact@v4
  with: { name: visual-diff, path: test-results/ }
```

Baseline: regenerate on intentional visual changes via
`npx playwright test --update-snapshots`.

### M3-P-NEXT-3 — ProductPage layout (Ozone-style)

The full single-page layout from
`m3-product/05-PRODUCT-LAYOUT.md` lives behind a new feature flag
`VITE_LOUI_PRODUCT_LAYOUT`.  Storybook hosts stories for each region:

- `Product Layout / Top Bar`
- `Product Layout / Analysis Canvas`
- `Product Layout / Meter Column`
- `Product Layout / Module Chain`
- `Product Layout / Full Page`

Then a new `apps/desktop/src/renderer/pages/ProductPage.tsx` assembles
them behind the flag.

### M3-P-NEXT-4 — Promote V2 to default

Once Storybook visual regressions are stable and external opt-in
(`m3-product/04-ROLLOUT-PLAN.md` Phase 2) reports no issues, flip the
CI build flag to `VITE_LOUI_WASM_ANALYZER=true`.

### M3-P-NEXT-5 — Remove V1

After one full release with V2 default, delete `LoudnessMeterPanel`,
`LoudnessStream`, and `loudnessProcessor.worklet.js`.

---

## 2. Storybook-specific follow-ups

### Live preset toolbar (M3-W-C)

Add a global toolbar to Storybook with a dropdown:
```
[ Preset: Spotify Loud ▾ ]
```
Switching the dropdown calls `session.setPreset()` on the active story's
mock session — faster iteration than re-rendering the story via args.

### Theme token migration

Refactor V2 panels to consume `loui-theme.ts` instead of inline Tailwind
utilities.  Order:
1. `StereoScopePanel` (smallest surface area)
2. `LoudnessMeterPanelV2`
3. `SpectrumAnalyzerPanel` (canvas-heavy; mostly unchanged)

Each migration is a small PR with story regression confirmation.

### a11y addon

Install `@storybook/addon-a11y`, add to addons list.  Surfaces axe-core
findings inside Storybook.  Useful for the verdict chip colour
contrast in low-luminance themes.

### Story-driven E2E (M3-P-NEXT-2 prerequisite)

Storybook 10 exposes a `test-runner` package that can drive Playwright
against every story.  Useful for:
- Hover / click interaction tests
- Animation completion verification
- "story does not throw" smoke

---

## 3. Storybook for future panels

When M2-full lands the Rust mastering chain, each new component gets a
story file alongside its source.  Expected new stories in M2-full:

- `EQCurveEditor.stories.tsx` (interactive EQ overlay)
- `BusCompMeter.stories.tsx` (GR meter for the glue comp)
- `MultibandPanel.stories.tsx`
- `LimiterPanel.stories.tsx`
- `ModuleChainCard.stories.tsx` (the bottom-row module visuals)

The mock session can be extended with EQ / Comp / Limiter parameter
streams (new event types) the same way it handles loudness today.

---

## 4. Theme follow-ups

| Item | Target milestone |
|---|---|
| Light theme (for export reports / printed materials) | M5+ |
| Font bundling (Inter or similar) — replace system stack | M3-P-NEXT-3 |
| Animation token integration (`motion.meterFollow` consumed by V2 panels) | M3-P-NEXT-3 |
| Tailwind plugin: map theme tokens to utility classes | M3-P-NEXT-3 |
| Designer hand-off Figma library | external work |

---

## 5. Storybook hosting

For PR previews / designer review:

- **Local**: `pnpm storybook` — already works
- **CI artefact**: `storybook-static/` uploaded as a GitHub Actions artefact (M3-P-NEXT-2)
- **Public preview**: deploy to Netlify / Vercel / GitHub Pages on every PR (future)
- **Per-release archive**: keep a snapshot of `storybook-static/` per Loui Mastering version, viewable as a "design changelog"

---

## 6. The bigger picture

This milestone moves Loui Mastering from "runs and analyses audio
correctly" to "is a designed product."  The remaining gaps to a
shippable v2 GA:

| Gap | Filled by |
|---|---|
| Visual regression coverage | M3-P-NEXT-2 |
| Designer-friendly hand-off | M3-P-NEXT-3 + Figma library |
| Production-grade page layout | M3-P-NEXT-3 |
| V1 retirement | M3-P-NEXT-5 |
| Rust mastering chain | M2-full (orthogonal) |
| Reference profile UI integration | M4 |
| Plugin (VST3 / CLAP / AU) wrappers | M5+ |

Storybook is the **infrastructure** that makes the visual half of all
those gaps tractable.  Without it, every UI change requires running the
full Electron app.  With it, designers and engineers iterate on
isolated panels at story-speed.
