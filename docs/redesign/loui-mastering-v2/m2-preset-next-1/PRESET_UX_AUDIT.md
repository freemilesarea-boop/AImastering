# M2-PRESET-NEXT-1 — Preset UX Audit

> Current ProductPage preset flow, and where the browser mounts.

---

## 1. State + handlers (ProductPage.tsx, production path)

| Concern | Where | Notes |
|---|---|---|
| `presetId` state | `ProductPageProduction` (`useState<string\|undefined>(undefined)`) | the *active/highlighted* preset; starts unset |
| `setPresetId` | passed down as `onPresetChange` | updates highlight only |
| Apply on select | `ProductPageProductionInner.handlePreset` | wraps `onPresetChange` → `applyPreset(presetApplyPlan(preset))` + `setLastUsedPreset(id)` |
| `applyPreset` | `useApplyPreset()` (provider) | validated + clamped, single state update, dispatches wired commands |
| last-used save | `setLastUsedPreset(id)` in `handlePreset` | **saved**, but NOT restored on mount yet |

`handlePreset` is fed to `ProductLayoutInner.onPresetChange` → the
`LouiPresetHeader` chip `onTargetChange`.  So today, clicking a header
chip DOES apply the preset's full DSP tuning.

---

## 2. Effect of selecting a preset

| Target | Effect |
|---|---|
| Parameter state | merged in one `setState` (accepted params + bypasses) |
| Pending summary | wired params dispatched → `summarizePending` marks preview-ready / staged |
| Preview render | NOT triggered automatically — user runs Update Preview / Re-master |
| Realtime graph (flag ON) | `useRealtimeMasteringGraph` rAF effect pushes new config to the **same** worklet node (no graph rebuild) |
| Export | renderable subset staged via the dispatcher → applied on Re-master & Export |

This matches the required policy: **selection ≠ auto-render**; realtime
ON hears it immediately; export honours it on the next render.

---

## 3. The gap this milestone fills

- The rich `LouiPresetBrowser` (categories + descriptions + badges) exists
  + is story-validated but is **not mounted** in ProductPage.  Only the
  compact `LouiPresetHeader` chip strip is in the UX.
- No explicit "Browse Presets" entry point.
- last-used is saved but never surfaced (no badge / restore).
- No preset-change summary ("this preset changes LUFS / width / tone").

---

## 4. Mount strategy (chosen)

- Reuse the generic `LouiModuleSlideOver` (ESC / backdrop / focus-trap /
  reduced-motion already handled) to host the browser → new
  `LouiPresetSlideOver.tsx` composes it with the browser + a change
  summary footer.
- Entry point: a **"Browse Presets"** button in the `LouiPresetHeader`
  strip (no layout overhaul — the chips remain).
- Selection inside the browser reuses the SAME `handlePreset` path, so
  apply / last-used / pending / realtime-config behaviour is identical to
  the chips (single source of truth for "apply a preset").
- `lastUsedId` (read on mount, badge only) is kept distinct from
  `activeId` (currently applied) — restoring the highlight without
  auto-applying respects the no-auto-render policy.

No DSP, export-pipeline, realtime-flag-default, or ResultPage changes.
