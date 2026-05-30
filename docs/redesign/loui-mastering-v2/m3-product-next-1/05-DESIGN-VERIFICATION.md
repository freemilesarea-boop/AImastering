# M3-P-NEXT-1 — Design Verification Checklist

> Use this checklist when reviewing the V2 panels in Storybook.

---

## 1. Spacing rhythm

Open the AnalyzerPanelStack stories (any preset).  Check:

- [ ] Panel-to-panel gap is consistent (12 px / `space.3` between meter / spectrum / stereo)
- [ ] Internal panel padding is consistent (12 px)
- [ ] Meter row gap is 6-8 px and uniform across all 5 rows
- [ ] Header-to-content gap is one step bigger than internal gap (8-12 px)
- [ ] No "off-by-1-px" visual misalignments between bar widths

---

## 2. Typography

- [ ] Panel headers all use the same font size (14 px / `text.size.md`)
- [ ] Live numbers use `ui-monospace` + `tabular-nums` so digits don't jitter
- [ ] Sub-labels (e.g., row labels like "Momentary", "Short-term") use a tertiary-text colour, not primary
- [ ] No bold weight below 14 px (too dense)
- [ ] Korean / English text mixing is visually balanced when both appear

---

## 3. Contrast

Against the `#09090b` page background:

| Foreground | Min contrast | Status |
|---|---|---|
| `text.primary` (#fafafa) on `surface.panel` (#0f0f12) | 17.6 : 1 | ✅ WCAG AAA |
| `text.secondary` (#e4e4e7) on `surface.panel` | 14.5 : 1 | ✅ AAA |
| `text.tertiary` (#a1a1aa) on `surface.panel` | 6.3 : 1 | ✅ AA |
| `text.muted` (#71717a) on `surface.panel` | 3.4 : 1 | ⚠️ AA only for large text |

Action: keep `text.muted` to ≥ 12 px font and non-critical use only.

---

## 4. Meter colour readability

For each meter status colour, check:

- [ ] Bar foreground vs panel background → contrast > 3 : 1 (non-text use case)
- [ ] Bar foreground readable for users with red-green colour blindness
  - Status alone is not the only signal; verdict labels back it up textually
- [ ] Animation rate matches the data (bar follows the value, doesn't lag)

Test each preset (Storybook → `Audio Panels / Loudness Meter (V2)`):
- `SpotifyLoud` → bars in green band, no warning colours
- `ClippingRisk` → TP bar reaches danger zone, meter colour shifts
- `BrokenPhase` → correlation needle in the red-shaded zone

---

## 5. Animation smoothness

Open the `AnalyzerPanelStack` story.  Switch preset via args.  Watch:

- [ ] Meter bars animate from previous to new position over ~100 ms
- [ ] Bar fills move linearly (no easing — feels snappy)
- [ ] Verdict chip swaps without flicker (150 ms ease-out)
- [ ] No layout shift when verdict text grows ("Mono Safe" → "Very Wide")
- [ ] Spectrum trace updates at 30 Hz without stutter
- [ ] Peak-hold line decays smoothly (1.5 dB/frame default)

---

## 6. Panel hierarchy

Storybook page `Audio Panels / Analyzer Panel Stack (V2) / SpotifyLoud`:

- [ ] Loudness panel reads as the primary focus (top, largest)
- [ ] Spectrum panel reads as informational reference (middle, wide)
- [ ] Stereo panel reads as a quick-glance status (bottom, compact)
- [ ] Headers ("Loudness · stream", "Spectrum · live FFT", "Stereo · scope") use a parallel naming pattern

---

## 7. Edge cases

- [ ] `Loading` preset shows panels without crashing on NaN values
- [ ] `Disconnected` story (session=null) shows clear empty state, no errors
- [ ] `Idle` shows all meters at -∞ floor / silence label
- [ ] Window resize in the Storybook canvas doesn't break the spectrum canvas
- [ ] DPR scaling: load Storybook on a HiDPI display, confirm canvases are sharp

---

## 8. "Does it look commercial?"

Subjective overall check (compare side-by-side with Ozone screenshots):

- [ ] Spacing breathes — content doesn't feel cramped
- [ ] Numbers are the hero — large enough to read at typical desktop distance
- [ ] Colour usage is intentional — no random hues
- [ ] No accidental gaming-UI cues (no neon-on-black, no scan effects, no harsh borders)
- [ ] Verdict labels read like coaching, not like terminal output

---

## 9. Open issues

| ID | Issue | Severity |
|---|---|---|
| M3-W-A | StereoScopePanel verdict chip label can wrap to 2 lines for "Stereo Balanced" at narrow widths | Low |
| M3-W-B | Spectrum panel grid lines could be lighter at HDR brightness | Low |
| M3-W-C | LoudnessMeterPanelV2 bar fill animation timing curve isn't centralised in `loui-theme.motion` yet — still using inline `transition-[width] duration-100 ease-linear` | Trivial |
| M3-W-D | Verdict chip variants (Mono Safe / Wide / Phase Risk) use inline Tailwind classes; should move to theme tokens for a future visual refresh | Trivial |

---

## 10. Sign-off

When all checkboxes are green, mark this milestone "M3-P-NEXT-1 verified"
in the design log.  Next: M3-P-NEXT-2 adds Playwright snapshot tests
against the Storybook URLs to catch regressions automatically.
