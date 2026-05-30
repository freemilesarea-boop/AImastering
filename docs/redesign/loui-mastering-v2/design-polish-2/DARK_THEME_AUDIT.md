# DESIGN-POLISH-2 — Dark Theme Audit

> Where pure-black / near-black + over-strong glow lived before the
> charcoal refinement, and how each was resolved.

---

## 1. Pure-black / near-black sources (before)

| Location | Value | Role | Fix |
|---|---|---|---|
| `tailwind.config.js` `surface.950` | `#09090b` | `body` background (`@apply bg-surface-950`) | → `#13131A` + ladder 900/800/700 |
| `theme/loui-theme.ts` `surface.background` | `#09090b` | all ProductPage panels' page bg | → `#13131A` |
| `theme/loui-theme.ts` `surface.panel` | `#0f0f12` | ProductPage card/panel bg | → `#1A1A24` |
| `theme/loui-home.ts` `deepPanel` | `#111118` | HomePage app bg | → `#13131A` |
| `theme/loui-home.ts` `panelElevated` | `#181820` | HomePage cards | → `#222230` (more elevation) |
| `main.tsx` / `App.tsx` root | `#09090b` | inline root container bg | → `#13131A` |
| `SpectrumAnalyzerPanel` canvas | `#09090b` fill + `bg-black` wrapper | analyzer backdrop | → `#1A1A24` / `bg-surface-900` |
| `HomePage` optional-options `details` | `bg-zinc-950/60` | inset panel | → `bg-[#13131A]` |
| `HomePage` QueueRow cards | `bg-zinc-900/*` | file cards | → `bg-surface-800/*` charcoal |

(`ResultPage` / `LicenseModal` backdrop / `SectionAnalysisPanel` are V1 /
modal-scrim and intentionally left — backdrops legitimately darken.)

---

## 2. Contrast / glow / depth issues (before)

| Issue | Before | After |
|---|---|---|
| Harsh pure-white text | `#fafafa` primary, `#e4e4e7` secondary | alpha ladder 0.92 / 0.70 / 0.55 / 0.42 / 0.30 |
| Borders too dark / invisible | `#27272a` solid | `rgba(255,255,255,0.08)` subtle + `0.14` elevated |
| Over-strong lavender glow | `glowLavender 0.28` | `0.18` — active-only, idle minimal |
| Flat panels (no elevation) | bg ≈ panel ≈ well | distinct ladder: bg `#13131A` < panel `#1A1A24` < well `#222230` < overlay `#2A2A36` |
| Analyzer grid too hard | `#27272a` lines, `#52525b` labels | `rgba(255,255,255,0.07)` lines, `0.42` labels |

---

## 3. Token system (after)

- `theme/loui-theme.ts` — `surface` (charcoal ladder + `borderElevated`),
  `text` (alpha hierarchy).  Drives **all** ProductPage components.
- `theme/loui-home.ts` — `appBackground / mainPanel / elevatedPanel /
  surfaceSubtle / borderSubtle / borderElevated / glowLavender(0.18)` +
  text tokens.  Drives HomePage.  Legacy aliases (`deepPanel`,
  `panelElevated`) preserved so no call site breaks.
- `tailwind.config.js` — `surface` palette 950/900/800/700 for utility
  classes (`bg-surface-900`, …).

Both files now express the SAME charcoal + lavender language, giving
HomePage ↔ ProductPage surface/border/radius consistency.
