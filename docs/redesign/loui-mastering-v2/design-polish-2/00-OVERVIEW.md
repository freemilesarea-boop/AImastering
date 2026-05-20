# DESIGN-POLISH-2 — Charcoal / Lavender Pro-Audio Theme Refinement

> Remove pure black; move Loui from a "black RGB tool" to a Logic Pro /
> Ableton 12 / Apple-Pro-App charcoal mood, keeping the lavender accent.
> Colour/surface only — no layout, DSP, or feature changes.

---

## 1. What shipped

| # | Deliverable | Where | Status |
|---|---|---|---|
| 1 | Theme audit | `DARK_THEME_AUDIT.md` | ✓ |
| 2 | Global background → charcoal | `tailwind.config.js` (`surface` ladder), `main.tsx`, `App.tsx` | ✓ |
| 3 | Panel elevation ladder | `loui-theme.ts` `surface` (bg<panel<well<overlay) + `borderElevated`; `loui-home.ts` elevated cards | ✓ |
| 4 | Glow refinement | `glowLavender 0.28 → 0.18`; active-only | ✓ |
| 5 | Typography contrast | `text` alpha hierarchy (0.92 / 0.70 / 0.55 / 0.42 / 0.30) | ✓ |
| 6 | Analyzer background | `SpectrumAnalyzerPanel` canvas `#1A1A24` + subtle grid | ✓ |
| 7 | CTA / active card | lavender retained, glow restrained (token-driven) | ✓ |
| 8 | Home ↔ Product consistency | shared charcoal+lavender token language | ✓ |
| 9 | Storybook visual QA | `Theme / Charcoal + Lavender` surface story; story bg decorators → charcoal | ✓ |
| 10 | Verification | this doc §3 | ✓ |

---

## 2. The charcoal + lavender system

| Token | Value |
|---|---|
| appBackground | `#13131A` |
| mainPanel | `#1A1A24` |
| elevatedPanel | `#222230` |
| surfaceSubtle | `#2A2A36` |
| borderSubtle | `rgba(255,255,255,0.08)` |
| borderElevated | `rgba(255,255,255,0.14)` |
| primaryLavender / activeViolet / softLavender | `#A78BFA` / `#8B5CF6` / `#C4B5FD` |
| glowLavender | `rgba(167,139,250,0.18)` (subtle) |
| text primary/secondary/muted | `rgba(255,255,255,0.92 / 0.62 / 0.42)` |

Leverage: `loui-theme.surface`/`text` drive every ProductPage component
(analyzer, meters, slide-overs, preset browser, status bar) — so the
charcoal mood propagated app-wide from a few token edits.

---

## 3. Verification

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm build:renderer` | OK |
| `pnpm build:main` | OK |
| `pnpm build-storybook` | OK (+ surface story) |
| `cargo test -p loui-dsp --lib` | 54/54 |
| full desktop suite + preset selftests | no regression (22/22 · 14/14 · 11/11) |
| readability / analyzer visibility | preserved (subtle grid + alpha text, contrast kept) |
| preset browser / ProductPage | no regression (token-driven) |

---

## 4. Constraints honoured

No light theme · no white backgrounds · no DSP change · no ProductPage
structure change · no export/realtime logic change · realtime flag default
OFF · ResultPage/V1 intact.  Pure colour/surface refinement.

Note: visual confirmation was done via Storybook build + token reasoning;
the sandbox has no display, so an on-device eyeball pass in Electron is
recommended.
