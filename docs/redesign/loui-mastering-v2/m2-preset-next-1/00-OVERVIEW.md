# M2-PRESET-NEXT-1 — Mount the Preset Browser in ProductPage UX

> Connect `LouiPresetBrowser` into the real product flow: a "Browse
> Presets" entry point + a slide-over the user can open, explore by
> category, and select from — reusing the existing apply path.

---

## 1. What shipped

| # | Deliverable | Where | Status |
|---|---|---|---|
| 1 | Preset UX audit | `PRESET_UX_AUDIT.md` | ✓ |
| 2 | Browser entry point | `LouiPresetHeader` "Browse Presets" button (`onBrowse`) | ✓ |
| 3 | Slide-over / modal | `LouiPresetSlideOver` (wraps generic `LouiModuleSlideOver`) | ✓ |
| 4 | Apply flow integration | reuses `handlePreset` → `applyPreset` (no new apply path) | ✓ |
| 5 | Last-used persistence | `getLastUsedPreset` on mount → browser `lastUsedId` badge | ✓ |
| 6 | Preset change summary | `preset-summary.ts` → `previous → current` change groups | ✓ |
| 7 | Storybook | `LouiPresetSlideOver.stories.tsx` (10 stories) | ✓ |
| 8 | Verification | this doc §4 | ✓ |

---

## 2. UX flow

```
LouiPresetHeader [Browse Presets] ──▶ LouiPresetSlideOver (open)
   │                                      │ category-grouped cards + badges
   │                                      │ previous→current change summary
   ▼                                      ▼ select
chip click ───────────────────────▶ handlePreset(id)
   • setPreviousPresetId(prev)  • onPresetChange(id) (highlight)
   • applyPreset(plan)          • setLastUsedPreset(id)
```

Both the header chips and the browser call the **same** `handlePreset`, so
apply / last-used / pending-summary / realtime-config behaviour is
identical regardless of entry point.

---

## 3. Policy honoured

- **Selection ≠ auto-render**: applying a preset only stages parameter
  state; the user runs Update Preview / Re-master & Export to commit it.
  (Realtime flag ON hears it immediately via a config push — no graph
  rebuild.)
- last-used is a **badge hint only** — it does not auto-apply on load (the
  master is already rendered); `lastUsedId` is kept distinct from the
  applied `activeId`.
- Reuses the generic slide-over (ESC / backdrop / focus-trap / reduced
  motion) — accessible + narrow-screen friendly (`width: min(…, 100vw)`).

---

## 4. Verification

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm build:renderer` | 476 KB JS, OK |
| `pnpm build:main` | esbuild OK |
| `pnpm build-storybook` | OK (+10 slide-over stories) |
| `cargo test -p loui-dsp --lib` | 54/54 |
| `pnpm test` (desktop suite) | no regression (14/14 · 15/15 · 22/22) |
| `pnpm test:preset-tuning` / `test:realtime-graph` | 14/14 · 8/8 |
| header chip behaviour | unchanged (same apply path) |
| realtime flag OFF / ON | both fine (config push, no rebuild) |

---

## 5. Constraints honoured

- No auto re-render on preset select · no DSP change · no export-pipeline
  change · realtime flag default unchanged (OFF) · ResultPage/V1 intact ·
  no layout overhaul (button added to the existing header; browser is an
  overlay).

---

## 6. Next

- Optional: per-source auto-recommendation surfaced as the "Recommended"
  badge target.
- Promote preview-only tone params to export-renderable (separate track).
