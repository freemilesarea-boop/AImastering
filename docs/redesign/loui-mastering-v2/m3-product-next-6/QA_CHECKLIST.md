# M3-P-NEXT-6 — QA Smoke Checklist

> Run before AND after promoting ProductPage to default.  Manual smoke
> pass covering the full commercial workflow + the fallback paths.

---

## 0. Preconditions

- A real audio file (WAV / FLAC / MP3) on disk.
- A dev or packaged build of the desktop app.
- DevTools console available (for flag toggles).

Default build: ProductPage is the result screen.  To test the classic
path: `window.__LOUI_PRODUCT_LAYOUT__ = false` + reload.

---

## 1. Core flow (ProductPage default)

| # | Step | Expected |
|--:|---|---|
| 1 | Drop / pick an audio file | lands on Home with the file queued |
| 2 | Choose a style + run mastering | progress → result screen |
| 3 | Result screen is ProductPage | TopBar "Loui Mastering", spectrum centre, meter rail |
| 4 | Press Play | preview audio plays; transport scrubber moves |
| 5 | Analyzer shows live data | loudness bars + spectrum + stereo update while playing |
| 6 | Click a module card (e.g. Limiter) | slide-over opens with parameters |
| 7 | ESC / backdrop / × | slide-over closes; focus returns to card |
| 8 | Change Target LUFS | preview strip shows "1 renderable" pending; limiter card green dot |
| 9 | Click "Update Preview" | "Re-rendering…" → "Preview updated"; audio swaps |
| 10 | Open Export module | format / SR / bit depth / dither chips + Export section |
| 11 | Export As-is (WAV) | save dialog → file saved (WAV) |
| 12 | Re-master & Export (WAV) | re-master → save dialog → file saved |
| 13 | Pick FLAC + Re-master & Export | transcode → FLAC saved |
| 14 | Cancel a save dialog | returns to idle, no file, no error |
| 15 | (Force) render failure | error shown; previous preview keeps playing |

---

## 2. Fallback paths

| # | Step | Expected |
|--:|---|---|
| 16 | `window.__LOUI_PRODUCT_LAYOUT__ = false` + reload | result screen is the classic ResultPage |
| 17 | Classic ResultPage Save WAV / MP3 | works exactly as before |
| 18 | `window.__LOUI_PRODUCT_LAYOUT__ = true` + reload | back to ProductPage |
| 19 | Build with `VITE_LOUI_PRODUCT_LAYOUT=false` | classic ResultPage by default |

---

## 3. Error boundary

| # | Step | Expected |
|--:|---|---|
| 20 | Simulate a ProductPage render crash | red banner + classic ResultPage rendered in place |
| 21 | Save / export from the fallback | works (ResultPage save buttons) |
| 22 | Console shows the crash log | `[ProductPage] render crash …` |
| 23 | Support bundle includes the failure | `preview` category entry |

---

## 4. Empty / loading states

| # | Step | Expected |
|--:|---|---|
| 24 | Reach `result` with no masteringResult (edge) | analyzer idle; export disabled; no crash |
| 25 | WASM analyzer flag off | V2 panels show "awaiting frames"; no crash |
| 26 | No source file (selectedFile null) | preview control absent; rest renders |

---

## 5. Regression (must NOT break)

| # | Check | Expected |
|--:|---|---|
| 27 | `audio:master` (initial mastering) | unchanged |
| 28 | `file:save-wav` (WAV / MP3 save) | unchanged |
| 29 | `file:save-audio` (transcode) | new path works; failures safe |
| 30 | Python pipeline | unchanged |
| 31 | HomePage / AnalysisPage / MasteringPage / QCPage / SettingsPage | unchanged |

---

## 6. Automated gates (CI)

These run in CI and must pass before promotion ships:

```
pnpm --filter @aimaster/desktop typecheck       # clean
pnpm --filter @aimaster/desktop build           # renderer + main
pnpm --filter @aimaster/desktop build-storybook # 14 components / 100 stories
cargo test -p loui-dsp --lib                     # 31/31
```

---

## 7. Sign-off

| Gate | Owner | Status |
|---|---|---|
| Core flow (1–15)        | QA | ☐ |
| Fallback paths (16–19)  | QA | ☐ |
| Error boundary (20–23)  | QA | ☐ |
| Empty/loading (24–26)   | QA | ☐ |
| Regression (27–31)      | QA | ☐ |
| Automated gates (CI)    | CI | ☐ |

When all gates are green, ProductPage default is cleared for the
release.  If any gate fails, set `VITE_LOUI_PRODUCT_LAYOUT=false` in the
build config (one line) to ship classic ResultPage while the fix lands.
