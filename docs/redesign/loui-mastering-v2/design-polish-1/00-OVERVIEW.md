# DESIGN-POLISH-1 — HomePage Ozone-inspired Redesign · Loui Lavender Identity

> Make the HomePage feel like a commercial AI-mastering product on first
> sight, in Loui's lavender identity.  Pure UI/UX polish — no DSP / export
> / preset-tuning / realtime-graph logic changed.

---

## 1. What shipped

| # | Deliverable | Where | Status |
|---|---|---|---|
| 1 | Visual audit | `HOMEPAGE_VISUAL_AUDIT.md` | ✓ |
| 2 | Lavender design tokens | `theme/loui-home.ts` (`loui`, `louiAlpha`) | ✓ |
| 3 | Layout polish + hero | `components/home/LouiHomeHero.tsx` + HomePage (wider `max-w-2xl`, always-visible hero) | ✓ |
| 4 | Quick preset card redesign | `QuickPresetBar` — lavender active glow, dot, LUFS/TP, streaming-safe badge | ✓ |
| 5 | Mode section polish | `ModeSelector` — "빠른 모드" label, lavender selected glow, hierarchy | ✓ |
| 6 | Advanced settings redesign | `Slider` / `LimiterStrengthCtl` / `AdvancedSettingsPanel` — lavender accent, readable values | ✓ |
| 7 | CTA / status polish | lavender gradient "마스터링 시작" with ready / processing (spinner) states | ✓ |
| 8 | Preset browser entry polish | empty-state teaser card + queue-state "전체 프리셋 · AI Special" lavender button | ✓ |
| 9 | Storybook | `LouiHomeHero.stories` (3) + `HomePage.stories` (6: empty/file/preset/advanced/processing/narrow) | ✓ |
| 10 | Verification | this doc §4 | ✓ |

---

## 2. Loui lavender identity

Tokens (`theme/loui-home.ts`): primaryLavender `#A78BFA`, activeViolet
`#8B5CF6`, softLavender `#C4B5FD`, deepPanel `#111118`, panelElevated
`#181820`, borderSubtle `rgba(255,255,255,0.08)`, glowLavender
`rgba(167,139,250,0.28)`, successMint `#34D399`, warningAmber `#FBBF24`.

Applied as: hero gradient title + brand mark, lavender glow on
active/hover cards, lavender slider/segmented accents, gradient CTA.  No
RGB-gaming saturation; contrast kept readable (text on elevated panels,
not pure black).

---

## 3. First-impression changes

- **Hero** (always visible): brand mark + "Loui Mastering" gradient title
  + "AI 음악을 스트리밍 기준으로 마스터링" + engine-status badge.
- **Empty state** now also shows a lavender **capability teaser** ("AI Pop
  · KPOP Loud · AI Vocal Cleaner … AI Special 포함") that opens the browser
  — the product's headline capability is visible before upload.
- Premium **dropzone** (lavender dashed border + ambient glow + framed
  upload glyph).

---

## 4. Verification

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm build:renderer` | OK (485 KB JS) |
| `pnpm build:main` | esbuild OK |
| `pnpm build-storybook` | OK (+ hero & HomePage stories) |
| `cargo test -p loui-dsp --lib` | 54/54 |
| full desktop suite + preset selftests | no regression (22/22 · 14/14 · 11/11) |
| ProductPage | untouched |

---

## 5. Responsive notes

- Container `max-w-2xl` (672px) centered — substantial on 1280/1440/16:9
  without sprawling; vertical scroll within `flex-1 overflow-y-auto`.
- Card grids: quick presets `grid-cols-2 sm:grid-cols-4`, modes
  `grid-cols-2 sm:grid-cols-3` → wrap cleanly on narrow widths.
- Preset slide-over inherits `width: min(560px, 100vw)` (narrow-safe).
- Hero is `flex justify-between` with `truncate`/`whitespace-nowrap` so
  the badge never wraps awkwardly.
- `NarrowLayout` stories (mobile viewport) added for both hero & HomePage.

---

## 6. Constraints honoured

No DSP change · no preset-tuning value change · no export-pipeline change ·
realtime flag default unchanged (OFF) · ProductPage structure untouched ·
ResultPage/V1 intact · all audioStore wiring + preset-browser select path
preserved.
