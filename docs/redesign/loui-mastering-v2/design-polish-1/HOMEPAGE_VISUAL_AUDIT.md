# DESIGN-POLISH-1 — HomePage Visual Audit

> State of the HomePage before the Ozone-inspired / Loui-lavender redesign.

---

## 1. Current structure (`pages/HomePage.tsx`)

| Region | Current state |
|---|---|
| Container | `max-w-lg` (512px) centered column — narrow, sparse on 1280–1440px |
| Branding / hero | **none** — page opens straight into the dropzone |
| Engine status | not shown |
| Empty state | full DropZone + "파일 탐색기로 열기" link only |
| Quick presets | `QuickPresetBar` — 4 cards, zinc styling, active = white fill; **only shown after a file is queued** |
| Mastering modes | `ModeSelector` — 5–7 cards (incl. legacy), zinc, looks like a test grid |
| Advanced | `AdvancedSettingsPanel` — collapsible; LUFS / TP sliders + limiter segmented + optional gain/width/saturation; zinc accent |
| Preset browser entry | "전체 프리셋 둘러보기" — small zinc outline button next to 빠른 프리셋 header |
| Master CTA | white (`bg-zinc-100`) full-width button, "마스터링 시작 (N곡)" |
| Queue / file list | `QueueRow` cards w/ MiniPlayer |

---

## 2. Problems for a commercial first impression

1. **No identity** — entirely zinc/grey; no Loui lavender, no logo, no tagline.  Reads as a utility, not a product.
2. **No hero** — the first thing a user sees is a grey dashed box.
3. **Presets hidden until upload** — the product's headline capability (AI presets) is invisible on the first screen.
4. **Mode grid looks like a test UI** — 5–7 equal grey cards with mono LUFS/TP, no hierarchy.
5. **Weak CTA** — a plain white button; no brand, no ready/processing affordance.
6. **Narrow column** — 512px looks lost on a laptop/desktop.
7. **Contrast** — lots of `text-zinc-600/700` on near-black; some labels hard to read.

---

## 3. Functional wiring to PRESERVE (no regression)

- `useAudioStore` options: `updateOptions`, `setStyle`, `quickPreset`, `style`, `targetLufs`, `targetTp`, `limiterStrength`, `outputGainDb`, `stereoWidth`, `saturationAmount`.
- DropZone → `addFilesToQueue`; `handleOpenMulti`; queue (`QueueRow`, MiniPlayer, save/batch).
- `handleStartBatch` (analyze → master IPC loop); `pendingCount` / `doneCount` / `isBatchRunning`.
- Preset browser: `LouiPresetSlideOver` + `handlePresetSelect` (→ `louiPresetToMasteringOptions` → `updateOptions`).
- `AdvancedSettingsPanel` reads/writes the store directly.

---

## 4. Redesign approach (low-risk, single-column premium)

- Add a **lavender token set** + an always-visible **hero** (title + tagline + engine badge).
- Widen the column to `max-w-2xl` for a substantial-but-focused layout.
- Restyle dropzone, quick-preset cards, mode cards, advanced panel, CTA, and the browser-entry button with the Loui lavender identity (glow on active/hover, readable contrast).
- Keep all state/handlers + the preset-gated-by-queue flow intact.
- A full 2-column (settings rail) layout is noted as a future option — out of scope to avoid behavioural risk.
