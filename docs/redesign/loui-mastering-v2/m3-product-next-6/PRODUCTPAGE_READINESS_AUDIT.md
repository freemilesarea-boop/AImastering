# M3-P-NEXT-6 — ProductPage Readiness Audit

> Is ProductPage ready to be the default `result` screen?  A
> feature-by-feature readiness check.

---

## 1. End-to-end flow

| Step | Status | Notes |
|---|---|---|
| Upload (Home → drop / pick) | ✓ | Unchanged — ProductPage is only the `result` slot |
| Mastering (MasteringPage → audio:master) | ✓ | Unchanged; produces masteringResult |
| Land on `result` | ✓ | App.tsx routes to ProductPage when flag on |
| Preview playback | ✓ | Hidden `<audio>` + transport strip; previewPath wired |
| Analyzer display | ✓ | V2 stack (LoudnessMeterPanelV2 + Spectrum + StereoScope) via WasmAnalyzerProvider |
| Module slide-over | ✓ | Click card → panel; ESC/backdrop/× close; focus trap |
| Parameter changes | ✓ | Central state + dispatcher + command/dispatch logs |
| Update Preview | ✓ | Re-render via audio:re-render-preview → audio swap |
| Export As-is | ✓ | file:save-wav (WAV) / file:save-audio (transcode) |
| Re-master & Export | ✓ | audio:master(override) → save |

---

## 2. Data wiring

| Source | Where | OK? |
|---|---|---|
| `masteringResult.previewPath` | `<audio src>` | ✓ |
| `masteringResult.outputPath`  | Export As-is source | ✓ |
| `audioStore.selectedFile`     | Re-master source | ✓ |
| `audioStore.options`          | base mastering options | ✓ |
| `analysisReport.mastering`    | target LUFS / TP display | ✓ |

All required fields are read from the existing store — no new pipeline
dependencies.

---

## 3. State coverage

| State | ProductPage behaviour |
|---|---|
| Normal (result present) | full layout |
| `masteringResult === null` | preview empty; analyzer idle; export disabled |
| `selectedFile === null` | preview control absent (no source to re-master) |
| Preview render failure | error in preview strip; old preview kept |
| Export failure | error in export panel; source intact |
| WASM analyzer off | V2 panels show "awaiting frames" empty state |

Gaps before this milestone:
- **No error boundary** — a render exception in ProductPage would crash
  the whole renderer.  → Fixed in this milestone (ProductPageErrorBoundary).

---

## 4. Fallback availability

| Mechanism | Status |
|---|---|
| ResultPage source intact | ✓ (never deleted) |
| Runtime flag → ResultPage | ✓ after this milestone (`__LOUI_PRODUCT_LAYOUT__ = false`) |
| Env flag → ResultPage | ✓ (`VITE_LOUI_PRODUCT_LAYOUT=false`) |
| Error boundary → ResultPage | ✓ after this milestone |

---

## 5. Regression surface

Promoting the default does NOT touch:
- `audio:master`, `file:save-wav`, `file:save-audio`
- Python pipeline
- V1 LoudnessMeterPanel (still used when WASM flag off inside V2 stack)
- ResultPage rendering

The ONLY change is which component the `result` slot mounts by default.

---

## 6. Readiness verdict

| Area | Verdict |
|---|---|
| Functional completeness | ✓ ready (full flow works behind the flag) |
| Failure handling | ⚠ needs error boundary (added this milestone) |
| Fallback | ✓ ready (ResultPage + flags + boundary) |
| Regression risk | Low (additive flag flip + boundary) |

**Conclusion**: ready to promote to default ONCE the error boundary is
in place.  This milestone adds the boundary + flips the default + keeps
every fallback path.

---

## 7. Post-promotion watch list

After default-ON ships, monitor (via support bundle `recordFailure`):
- `preview` failures (re-render path)
- `export` failures (save-wav / save-audio)
- any error-boundary trips (new failure category candidate)

If error-boundary trips spike, flip the env default back to OFF — a
one-line build-config change, no code revert.
