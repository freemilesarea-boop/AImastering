# M3 Product — Future Layout Proposal

> Recommended Ozone-style layout for Loui Mastering.  Documented as a
> design target.  **NOT** implemented in this commit (per brief: focus
> on realtime analysis connection, not UI redesign).

---

## 1. Why this isn't shipping today

The user brief was explicit:
> 이번 단계에서는 DSP 체인을 변경하지 말고 UI 레이아웃과 실시간 분석 연결에 집중한다.

So the layout proposal is documented for the NEXT milestone
(M3-P-NEXT-3), not enforced in this commit.  Today's commit keeps
ResultPage's existing structure and only swaps the meter slot.

---

## 2. Proposed layout

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Loui Mastering          [Import]  [Export]    [▼ K-Pop Modern Loud]   ⚙   │  ← Top bar
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  ┌────────────────────────────────────────────┐  ┌────────────────────┐   │
│  │                                            │  │ Loudness           │   │
│  │      [ Live FFT Spectrum + EQ Curve ]      │  │   M  -14.2 LUFS    │   │
│  │                                            │  │   S  -13.8         │   │
│  │   ▒░░░░░░▒▒▒▒░░░░░░░░░░░░░░░░░             │  │   I  -14.0         │   │
│  │   ────────────────────────────             │  │                    │   │
│  │     50  100  200  500  1k  5k 20k          │  │ True Peak          │   │
│  │                                            │  │   -1.0 dBTP        │   │
│  │  (EQ curve drag handles overlaid)          │  │                    │   │
│  │                                            │  │ Stereo             │   │
│  └────────────────────────────────────────────┘  │   ●━━━━━━○━━━━━━┓ │   │
│                                                   │   correlation 0.87  │   │
│  ┌────────────────────────────────────────────┐  │   [ Stereo Balanced │   │
│  │ Timeline / waveform                         │  └────────────────────┘   │
│  │ ▁▂▄▆█▇▆▄▃▂▁▂▃▄▅▆▇█▇▆▅▄▃▂▁                  │                            │
│  └────────────────────────────────────────────┘                            │
│                                                                            │
├────────────────────────────────────────────────────────────────────────────┤
│  Module chain                                                              │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────────┐           │
│  │  EQ  │→ │Dynamics│→ │Imager│→ │Sat │→ │Limit │→ │ Export │            │
│  │  on  │  │  on    │  │  on  │  │  on │  │  on   │  │  WAV   │            │
│  └──────┘  └──────┘  └──────┘  └──────┘  └──────┘  └──────────┘           │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Region breakdown

### 3.1 Top bar

| Element | Purpose |
|---|---|
| Brand mark | "Loui Mastering" wordmark + logo |
| `[Import]` | open audio file picker |
| `[Export]` | save current mastered output |
| Preset dropdown | quick-pick of built-in presets |
| ⚙ Settings | sample rate, output dir, license, dev toggles |

### 3.2 Centre — analysis canvas

| Element | Notes |
|---|---|
| Live FFT spectrum | from M3-entry SpectrumAnalyzerPanel (same component) |
| EQ curve overlay | M4 — draggable nodes change EQ params; today read-only target curve |
| Click + drag | M4 — interactive EQ editing |
| Frequency markers | log-scaled grid |

### 3.3 Right column — meters

| Element | Source |
|---|---|
| Loudness M/S/I | LoudnessMeterPanelV2 |
| True peak | same |
| Stereo scope | StereoScopePanel (verdict + bars) |
| Peak/RMS | same |

### 3.4 Bottom row — module chain (M4)

| Element | Notes |
|---|---|
| EQ | from M2-full Rust EQ |
| Dynamics | M2-full |
| Imager | M2-full |
| Saturator | M2-full |
| Limiter | M2-full |
| Export | jumps to file-save dialog |

Each module card is clickable → opens a detail panel for parameter
editing (Ozone-style).

---

## 4. Why this layout

| Decision | Rationale |
|---|---|
| Spectrum + EQ curve as the hero element | Engineers and beginners both look at the spectrum first.  Aligning the EQ curve over it teaches the relationship. |
| Right-column meters | Eyes scan left-to-right; meters need scanning, not editing. |
| Bottom module chain | Spatially matches signal flow (left to right). |
| Single-page (no tabs) | All decisions visible at once.  Tabs hide complexity. |
| Top-bar global controls | Import / export / preset are session-level; modules are mix-level. |

---

## 5. Visual tokens

Already defined in the existing renderer:
- Background: `#09090b` (zinc-950)
- Cards: `bg-zinc-900/50 border-zinc-800`
- Headlines: `text-zinc-100`
- Mono numbers: `font-mono tabular-nums`
- Accent: violet (#a78bfa) for spectrum + active states
- Status: emerald (good) / amber (warn) / red (alert)

No new tokens needed for the layout — only re-arrangement.

---

## 6. Layout implementation plan (M3-P-NEXT-3)

Behind feature flag `VITE_LOUI_PRODUCT_LAYOUT`:

```
[unset] → existing ResultPage / MasteringPage layout
[true]  → new single-page ProductPage layout
```

Migration:
1. Create `ProductPage.tsx` as the new layout.
2. Mount V2 panels in their assigned regions.
3. Existing pages keep working unchanged.
4. Switch the default landing route based on flag.
5. Internal A/B as usual.

The current commit's `AnalyzerPanelStack` is the foundation — it can be
re-used in the new layout as a "right-column module."

---

## 7. Out of scope (still)

- Editable EQ curve (M4)
- Module parameter detail panels (M4)
- Drag-rearrangeable module chain (M4)
- Multiple-track project view (M5+)
- Collaboration / cloud sync (M5+)

The layout is designed to accommodate these without rework — each region
is independently sized and the V2 components fit verbatim.

---

## 8. Mockup → design system flow

Today: this doc + V2 components (working, demo-able).
Next: Storybook stories of the layout regions in isolation (M3-P-NEXT-1).
Then: visual design pass with the designer (assumed external resource).
Then: M3-P-NEXT-3 implementation of `ProductPage` behind flag.
