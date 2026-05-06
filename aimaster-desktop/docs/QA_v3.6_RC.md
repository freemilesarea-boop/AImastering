# QA Checklist — Louver Mastering AI v3.6.0-rc.1

> Internal QA for the v3.6.0 RC build.  All P0 cases must PASS before
> we promote the RC tag to production.  Run on the three target
> platforms (Win NSIS / Linux AppImage / macOS unsigned ZIP).

Tester:
Build/commit:
Date:
Platform / arch / OS version:

---

## How to use this checklist

Each row has columns:
- **Severity** — P0 (release-blocker) / P1 (must-fix before next RC) / P2 (track for follow-up)
- **Status** — `PASS` / `FAIL` / `N/A` / `BLOCKED`
- **Notes** — paste the exact error message or screenshot link if FAIL.

If a row is N/A on the current platform, write the reason (e.g. "macOS
only").  Do not leave rows blank.

---

## A · Install / first launch

| # | Severity | Case | Status | Notes |
|---|---|---|---|---|
| A1 | P0 | **Fresh install** — uninstall any previous version, install RC, app launches and reaches the home page without crash. |  |  |
| A2 | P0 | First-launch grants no console errors in Electron devtools (open with `Ctrl/Cmd+Shift+I`). |  |  |
| A3 | P1 | Window controls (close / minimize / drag) work. |  |  |
| A4 | P1 | App version label in the report and in `electronAPI.version` reads `3.6.0-rc.1`. |  |  |
| A5 | P0 (Win) | **Windows: NSIS installer** runs to completion, creates Start Menu + Desktop shortcuts, and lets the user choose the install path. |  |  |
| A6 | P1 (Win) | **Windows clean machine without ffmpeg in PATH** — install on a VM without ffmpeg installed system-wide.  App must use the bundled binary in `bin/`, not error out. |  |  |
| A7 | P0 (mac) | **macOS Gatekeeper** — first launch shows the unsigned-app warning.  Verify the documented `xattr -dr com.apple.quarantine` workaround works.  Document the user-facing copy. |  |  |
| A8 | P1 (Linux) | **Linux AppImage** — `chmod +x` then run; appears in app menu (when the user enables FUSE/AppImage integration). |  |  |

## B · License / trial

| # | Severity | Case | Status | Notes |
|---|---|---|---|---|
| B1 | P0 | Free tier: trial counter shows correct remaining count after each mastering. |  |  |
| B2 | P0 | After exhausting trial, mastering is blocked with the documented Korean message; license modal opens. |  |  |
| B3 | P0 | Activating a valid Pro key: trial counter disappears, WAV save unlocks. |  |  |
| B4 | P1 | Tampering with `electron-store` license file (manually editing tier) → app rejects the record (HMAC mismatch) and reverts to free. |  |  |
| B5 | P1 | Deactivating Pro returns the user to free tier; trial count not reset to 0 (cannot bypass quota). |  |  |
| B6 | P2 | If `LICENSE_HMAC_SECRET` is missing in a production build, `pnpm test:release-smoke` warns *before* packaging (not at runtime). |  |  |

## C · File import

| # | Severity | Case | Status | Notes |
|---|---|---|---|---|
| C1 | P0 | **Drag-drop** a `.wav` from Explorer / Finder / Files. |  |  |
| C2 | P0 | Drag-drop a `.mp3`. |  |  |
| C3 | P0 | Drag-drop a `.flac`. |  |  |
| C4 | P0 | **File open dialog** picks the same files. |  |  |
| C5 | P1 | **Korean path** — file in `~/음악/한글_파일명.wav` analyzes and masters without filename mojibake. |  |  |
| C6 | P1 | **Filename with spaces** — `My Demo Track v2.wav` works end-to-end (analyze → master → export). |  |  |
| C7 | P1 | **Filename with `#` or `?`** — verify both URL-style chars survive `aimaster-local://` URL roundtrip in BeforeAfterCompare / preview. |  |  |
| C8 | P2 | Drop a non-audio file (e.g. `.png`).  App rejects with a friendly Korean error, not a stack trace. |  |  |

## D · Mastering — all 7 modes

For each mode, master a 30 s vocal-heavy KPOP clip and verify: (a) the
processing completes, (b) the result page renders, (c) `LUFS` /
`truePeak` / `LRA` are within the mode's documented target.

| # | Mode | Target LUFS / TP | Status | Measured | Notes |
|---|---|---|---|---|---|
| D1 | Natural | -14 / -1.0 |  |  |  |
| D2 | Balanced | -12 / -1.0 |  |  |  |
| D3 | Bright | -12 / -1.0 |  |  |  |
| D4 | Loud | -10 / -1.0 |  |  |  |
| D5 | KPOP Loud | -9 / -0.8 |  |  |  |
| D6 | Warm (legacy) | -14 / -1.0 |  |  |  |
| D7 | Punch (legacy) | -11 / -1.0 |  |  |  |

## E · Result page (Phase-E intelligence UX)

| # | Severity | Case | Status | Notes |
|---|---|---|---|---|
| E1 | P0 | **Preview MP3 playback** — play / pause / seek work; UI clock matches audio position. |  |  |
| E2 | P0 | **A/B compare** — toggling between original and master is loudness-matched and click-free. |  |  |
| E3 | P1 | **Live loudness meter** — N/A for v3.6.0-rc.1 (LoudnessMeterPanel exists but is not wired to a page). | N/A |  |
| E4 | P0 | **Export WAV** — Pro-tier user clicks "마스터 WAV 저장" → save dialog → file written, sample rate / bit depth match the requested settings. |  |  |
| E5 | P0 | **Export TXT report** — `pnpm test:phase-e-ui` heading set is present in the downloaded file (App, Generated, Schema, Mode, Loudness, Section Analysis, Mode Suggestion, AI Artifact Check, Vocal Intelligence, Translation Check). |  |  |
| E6 | P0 | **Export JSON report** — opens in any JSON viewer; `schemaVersion === "phase-e/1"`; `app.version === "3.6.0-rc.1"`. |  |  |
| E7 | P1 | TXT / JSON do **not** contain absolute file paths (`outputPath`, `previewPath`, waveform paths) or debug-only fields (`debugSummary`, `jobId`, `artifactDir`). |  |  |
| E8 | P0 | Result page renders even when Phase-D analyzer fields are entirely absent (run with the Python engine that does not yet emit them — only the Smart Recommendation panel + Export panel are visible, fallback Korean copy is shown). |  |  |

## F · Phase-D analyzer presence (when emitted)

| # | Severity | Case | Status | Notes |
|---|---|---|---|---|
| F1 | P1 | When `sectionAnalysis` is emitted, the timeline renders with high/mid/low energy colours; tooltip shows section start/end. |  |  |
| F2 | P1 | When `aiArtifactCheck` has `present === true` findings, AIArtifactWarningPanel renders only those findings — never an "all clear" badge. |  |  |
| F3 | P1 | When `modeSuggestion.suggestedMode === currentMode`, no mode hint banner is shown. |  |  |
| F4 | P2 | When `vocalIntelligence.clarityScore <= 0.5`, SmartRecommendationPanel surfaces the "보컬 명료도가 낮은 패턴" rec. |  |  |
| F5 | P2 | When `translationCheck.phone <= 0.5`, the "전화기 스피커" rec is shown (warn severity). |  |  |

## G · Edge cases

| # | Severity | Case | Status | Notes |
|---|---|---|---|---|
| G1 | P0 | **Large file 10 min+** — 10 minute WAV master completes; UI shows progress; no OOM on 16 GB RAM. |  |  |
| G2 | P1 | **AI-generated track with artifact warning** — supply a Suno/Udio export with metallic 4–7 kHz; AIArtifactWarningPanel surfaces the metallic finding. |  |  |
| G3 | P1 | **Vocal-heavy KPOP track** — vocal protection report shows `vocalLossSeverity: ok`; smart recs include vocal-aware suggestion. |  |  |
| G4 | P1 | **Instrumental / lofi track** — vocal enhancer bypasses (no false-positive vocal recs); smart recs are coherent. |  |  |
| G5 | P2 | Cancelling mid-mastering returns to home cleanly; no orphan worker process. |  |  |
| G6 | P2 | After mastering, OS temp dir is reasonably clean (no >100 MB residue from a single run). |  |  |

## H · Build / smoke

| # | Severity | Case | Status | Notes |
|---|---|---|---|---|
| H1 | P0 | `pnpm typecheck` is clean across all 4 workspaces. |  |  |
| H2 | P0 | `pnpm --filter @aimaster/desktop build` produces `dist/renderer/index.html`, `dist-electron/main/index.js`, `dist-electron/preload/index.js`. |  |  |
| H3 | P0 | `pnpm --filter @aimaster/desktop test` runs phase-e-ui (14) + phase-e-render (15) + loudness selftest (30+) with 0 failures. |  |  |
| H4 | P0 | `pnpm --filter @aimaster/desktop test:release-smoke` exits 0 (or only emits documented production warnings). |  |  |
| H5 | P0 | `pytest -q` in `services/python-audio` is green (`79 passed, 41 skipped` baseline). |  |  |
| H6 | P1 | `node scripts/prebuild.cjs` copies `ffmpeg` and `ffprobe` into `apps/desktop/public/bin/` (size > 0, executable bit set on POSIX). |  |  |
| H7 | P1 | `electron-builder.yml` win target list contains **only** `nsis`, no legacy `portable` target. |  |  |
| H8 | P0 | All `package.json` files report version `3.6.0-rc.1` (or `0.2.0` for `@aimaster/shared-types`). |  |  |
| H9 | P1 | CI workflow `build.yml` — `body_path` references `RELEASE_DRAFT_v3.6.0.md`, `prerelease: true`. |  |  |

---

## Sign-off

| Reviewer | Decision (Approve / Reject) | Date |
|---|---|---|
|  |  |  |

If approved, promote tag `v3.6.0-rc.1` → `v3.6.0` once all P0 / P1 cases
PASS, RELEASE_DRAFT_v3.6.0.md is updated to remove the `prerelease: true`
flag, and the body_path comment is reset.
