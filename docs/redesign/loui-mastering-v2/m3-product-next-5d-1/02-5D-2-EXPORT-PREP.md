# M3-P-NEXT-5D-2 — Export Override Reuse (Preparation)

> Everything needed to make the final export honour the same overrides
> the preview already reflects — building on 5D-1's pending summary.

---

## 1. Goal

Today the preview can re-render with overridden targetLufs / targetTp /
stereoWidth / outputGainDb, but the EXPORT still saves the original
master WAV.  5D-2 closes that gap by reusing the SAME override.

The structure is already in place after 5D-1:
- `summarizePending(...).renderOverride` — the full diff-from-base override
- `mergeOptions(base, override)` — produces full options
- `audio:master` — the existing channel that produces a WAV

---

## 2. Reuse — no new override structure

The export must NOT build its own override.  It reuses
`summary.renderOverride` so "what you preview is what you export" holds
by construction.

```
Export flow (5D-2):
  override = summarizePending(state, lastRendered, base).renderOverride
  options  = mergeOptions(base, override)
  result   = audio:master(sourceAudioPath, _, options)   ← EXISTING channel
  file:save-wav(result.outputPath)
```

No new pipeline code — `audio:master` is the proven master path.

---

## 3. Tasks

1. **Export pending detection** — ExportParameterPanel reads the preview
   bridge (or a new export-specific summary) to know "N parameters
   changed since master".
2. **"Re-master & Export" action** — runs the flow above.
3. **"Export As-is" action** — saves the original master WAV (current
   behaviour) for users who only want the unchanged master.
4. **Consistency check** — verify the export override == the override
   that produced the current preview (warn if the preview is stale).

---

## 4. Export UI (sketch)

```
┌─ Export ──────────────────────────────────┐
│  Format / Sample Rate / Bit Depth / Dither │
│  ─────────────────────────────────────────│
│  ⚠ 3 parameters changed since master        │
│    targetLufs −9 → −7                       │
│    targetTp   −1.0 → −0.8                    │
│    stereoWidth 1.0 → 1.3                     │
│  [ Re-master & Export ]   [ Export As-is ]  │
└────────────────────────────────────────────┘
```

The change list comes straight from `summary.renderablePending` mapped
to human labels.

---

## 5. Risks + mitigations

| Risk | Mitigation |
|---|---|
| Re-master latency on export    | Show progress (reuse `audio:progress` events) |
| Preview ≠ export override       | Both derive from `summary.renderOverride` — identical by construction |
| Format/SR/depth not yet wired   | 5D-2 also wires the export ChipRow → MasteringOptions.sampleRate/bitDepth (already fields) + format via the existing save path |
| Export pipeline change risk     | NONE — reuse `audio:master`; no Python change |

---

## 6. Format / sample-rate / bit-depth

The ExportParameterPanel's format/SR/depth/dither chips are still UI
shells (M3-P-NEXT-4).  `MasteringOptions` already has `sampleRate` +
`bitDepth`, so wiring those into the export override is trivial.
`format` + `dither` need the export save path to honour them — a small
`file:save-wav` extension (documented in M3-P-NEXT-5C
`05-OVERRIDE-REUSE.md`).

This is the higher-risk part of 5D-2 (touches the save path), so it
ships AFTER the safe re-master-via-`audio:master` flow.

---

## 7. Sequencing

| PR | Scope | Risk |
|---|---|---|
| 5D-2-a | "Re-master & Export" via `audio:master` + change list UI | Low |
| 5D-2-b | "Export As-is" toggle                                    | Low |
| 5D-2-c | Wire sampleRate / bitDepth into the export override       | Low |
| 5D-2-d | format / dither via `file:save-wav` extension            | Med (save-path change) |

5D-2-a/b/c carry no pipeline risk.  5D-2-d is the only one touching the
export save path; gate it carefully.

---

## 8. Beyond 5D-2

| Item | Milestone |
|---|---|
| Remaining 7 wired params renderable | needs MasteringOptions fields (M2-full) |
| 13 pending params                   | needs EngineSchema additions (M2-full) |
| Real-time preview                   | Rust mastering chain in WASM (M2-full) |
| Auto-render mode                    | 5D-3 |
| In-flight render cancellation       | 5D-4 |

After 5D-2, the four most impactful mastering decisions (loudness,
ceiling, width, output gain) flow end-to-end: UI → preview → export.
