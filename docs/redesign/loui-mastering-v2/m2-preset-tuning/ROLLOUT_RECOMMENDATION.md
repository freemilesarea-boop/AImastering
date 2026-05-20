# M2-PRESET-TUNING — Rollout Recommendation

> Can the new preset framework ship enabled?  Yes — it is additive and
> safe under both realtime-flag states.

---

## 1. Verdict: **ship the framework ON; presets apply on user selection**

The preset framework is safe to enable by default because:

- It only acts on **explicit user preset selection** — initial load still
  seeds from the rendered master (no auto-apply, no surprise re-render).
- Applying a preset updates the central parameter state, which:
  - **flag OFF (default):** stages the renderable params for the existing
    re-render preview / export — exactly the current pathway, no graph.
  - **flag ON:** pushes a new config to the **same** worklet node — no
    graph rebuild, no glitch (rAF-batched).
- Every tuned value is in-range (selftest), so nothing clamps silently.

The realtime-preview flag itself stays **OFF by default** (unchanged).

---

## 2. What ships

| Item | Status |
|---|---|
| 13-preset lineup (Core / Character / AI Special) with real DSP tuning | ✓ |
| Rich preset metadata (category / platform / loudness / tone / badges / version) | ✓ |
| `applyPreset` bulk path (validated, dispatched, single state update) | ✓ |
| ProductPage wiring — selection applies tuning, persists last-used | ✓ |
| Preset browser (`LouiPresetBrowser`) + header badges | ✓ |
| Consistency selftest (`test:preset-tuning`, 14/14) | ✓ |
| QA matrix + listening template + benchmark notes | ✓ |

---

## 3. Constraints honoured

- No graph rebuild on preset switch (config push to the same node).
- No fake loudness-only differentiation — every preset tunes real
  EQ / dynamics / imager / limiter parameters distinctly.
- No preview/export parameter drift — both read the same state; the
  renderable subset is exact, tone params are the documented preview-only
  gap (not drift).
- ProductPage fallback (re-render preview / ResultPage) untouched.
- Realtime flag default unchanged (OFF).
- No ScriptProcessor, no UI redesign (compact header enhanced + a new
  browser component, no layout overhaul).

---

## 4. Follow-ups (not blocking)

1. Mount `LouiPresetBrowser` in an expandable preset surface (it is
   story-validated + exported, ready to drop in).
2. Promote the 7+ preview-only tone params to export-renderable (needs the
   Rust offline render or Python param support) so AI-special tone moves
   reach the exported file.
3. On-device listening pass (PRESET_QA_MATRIX) → revise tuning to v1.1.
4. Per-source auto-recommendation (analysis → suggested preset).
