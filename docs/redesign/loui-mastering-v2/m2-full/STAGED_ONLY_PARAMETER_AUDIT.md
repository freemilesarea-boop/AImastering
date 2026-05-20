# M2-full-H — Staged-only Parameter Audit

> Which audio parameters were staged-only, and their renderable status
> after the Rust mastering chain landed.

---

## 1. The staged-only set (before M2-full)

After M3-P-NEXT-5D-1, RENDERABLE_MAP had 4 entries (preview + export):
`targetLufs`, `targetTp` (ceilingDbtp), `stereoWidth` (widthPct),
`outputGainDb`.  The remaining **7 wired audio parameters** were
staged-only — changeable in the UI but not reflected in preview/export:

| # | UI id | module | EngineSchema path |
|--:|---|---|---|
| 1 | `lowCutHz`     | eq       | adaptive-eq.bands[lowCut].freqHz |
| 2 | `lowShelfDb`   | eq       | adaptive-eq.bands[lowShelf].gainDb |
| 3 | `presenceDb`   | eq       | adaptive-eq.bands[presence].gainDb |
| 4 | `airDb`        | eq       | adaptive-eq.bands[air].gainDb |
| 5 | `adaptive`     | eq       | adaptive-eq.adaptive |
| 6 | `lowMonoHz`    | imager   | stereo-imager.lowMonoFrequency |
| 7 | `isp`          | limiter  | limiter.oversample |

(Plus dynamics threshold/ratio/attack/release/mix + limiter.lookaheadMs,
which were `pending` bindings — see §3.)

---

## 2. Per-parameter support matrix (after M2-full)

| UI id | Rust realtime preview | Python offline export | Verdict |
|---|---|---|---|
| eq.lowCutHz       | ✓ (EQ high-pass)        | ✗ (no MasteringOptions field) | preview-only |
| eq.lowShelfDb     | ✓ (EQ low shelf)        | ✗ | preview-only |
| eq.presenceDb     | ✓ (EQ presence peak)    | ✗ | preview-only |
| eq.airDb          | ✓ (EQ air shelf)        | ✗ | preview-only |
| eq.adaptive       | ✓ (gentle harshness dip)| ✗ | preview-only |
| imager.lowMonoHz  | ✓ (Side high-pass)      | ✗ | preview-only |
| limiter.isp       | ✓ (ISP headroom)        | partial (Python TP) | preview-only |
| dynamics.threshold| ✓ (glue comp)           | ✗ | preview-only |
| dynamics.ratio    | ✓                       | ✗ | preview-only |
| dynamics.attackMs | ✓                       | ✗ | preview-only |
| dynamics.releaseMs| ✓                       | ✗ | preview-only |
| dynamics.mixPct   | ✓                       | ✗ | preview-only |
| limiter.lookaheadMs| ✓ (limiter lookahead)  | ✗ | preview-only |

The Rust chain CAN process all of these.  The Python export (the
`audio:master` / `MasteringOptions` path) CANNOT — it only accepts
targetLufs / targetTp / stereoWidth / outputGainDb / sampleRate /
bitDepth.

---

## 3. Decision: keep them staged-only for export (consistency-first)

Per the brief — "preview/export consistency 우선" and "지원 불가한 것은
억지 구현 금지" — these parameters are **NOT** added to RENDERABLE_MAP.

Reasons:
1. **Export honesty** — RENDERABLE_MAP drives both the re-render preview
   AND the export.  Adding a param the Python export ignores would label
   it "applied" while the exported file is unchanged — dishonest.
2. **Realtime not yet device-tested** — the Rust chain is built + WASM-
   exposed + unit-tested (54/54), but the AudioWorklet tap that runs it
   live is behind an OFF-by-default flag (`VITE_LOUI_REALTIME_PREVIEW`)
   pending CPU/glitch device testing.
3. **Two-engine truth** — preview (Rust, realtime) and export (Python,
   offline) are different engines; parity is bounded (see
   PREVIEW_EXPORT_CONSISTENCY.md).  Promoting a param requires BOTH to
   honour it.

So: the Rust chain unlocks these params for the **future realtime
preview**, but they stay staged-only for the export/re-render path until
the Python offline render (or a Rust offline render) supports them.

---

## 4. RENDERABLE_MAP — unchanged (still 4)

```ts
RENDERABLE_MAP_LOOKUP = {
  'loudness-norm:targetLufs':  'targetLufs',
  'limiter:ceilingDb':         'targetTp',
  'stereo-imager:width':       'stereoWidth',
  'gain-staging:targetPeakDb': 'outputGainDb',
};
```

No change.  Adding the 7 would break export honesty.

---

## 5. The realtime path (when the flag is on)

When `VITE_LOUI_REALTIME_PREVIEW=true` (future, device-tested):
- `stateToChainConfig(state)` maps ALL audio params → the Rust chain
- the AudioWorklet tap processes the playing buffer through the chain
- ALL 13 params above are heard live

At that point the preview reflects more than the export.  The A/B +
consistency policy surfaces the gap (PREVIEW_EXPORT_CONSISTENCY.md): the
preview is a fuller approximation; the export reflects only the Python-
supported subset until M2-full-export lands.

---

## 6. Path to full renderable

| Step | Unlocks |
|---|---|
| Rust chain + WASM (this milestone) | realtime preview of all 13 (flag-gated) |
| AudioWorklet device test + flag-on default | realtime preview shipped |
| Rust OFFLINE render (export via Rust chain) | export honours all 13 → add to RENDERABLE_MAP |
| OR Python pipeline gains EQ/dynamics/imager params | same |

Until one of the last two lands, the 7 (+ dynamics + lookahead) stay
staged-only for export — honestly labelled in the UI.
