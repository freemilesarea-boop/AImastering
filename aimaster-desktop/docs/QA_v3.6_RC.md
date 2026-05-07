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
- **Status** — `PASS` / `FAIL` / `N/A` / `BLOCKED` / `DEFERRED`
- **Notes** — paste the exact error message or screenshot link if FAIL.

Rows tagged `DEFERRED` are intentionally not exercised in this RC and do
not block release.  They are listed so the next RC inherits a complete
view.

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
| A9 | P0 | **Packaged build launches without LICENSE_HMAC_SECRET** — install a CI build with NO secret env baked in.  App must launch normally to the home page; no "AIMaster — startup blocked" dialog ever appears.  (License gate disabled in v3.6.0-rc.1+1.) |  |  |

## B · License / trial — REMOVED (gate disabled in v3.6.0-rc.1+1)

The license-key activation path is no longer exercised in this build:
LicenseModal isn't mounted, the TopBar badge is gone, the SettingsPage
LicenseSection is removed, license IPC channels are stripped from the
preload allowlist, and `audio:master` has no license check.  All
trial-counter and Pro-activation cases are therefore **N/A** for this
RC and do not block release.  When the gate is re-enabled in a future
build, restore B1–B6 from git history.

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

## E · Result page

| # | Severity | Case | Status | Notes |
|---|---|---|---|---|
| E1 | P0 | **Preview MP3 playback** — play / pause / seek work; UI clock matches audio position. |  |  |
| E2 | P0 | **A/B compare** — toggling between original and master is loudness-matched and click-free. |  |  |
| E3 | P1 | **Live loudness meter** — start playing the preview; LoudnessMeterPanel mounts, M / S / I bars update at ~10 Hz, TP bar reads ≤ -1 dBTP for healthy modes; meter freezes when paused, resumes on play. |  |  |
| E4 | P0 | **Export WAV** — Pro-tier user clicks "마스터 WAV 저장" → save dialog → file written, sample rate / bit depth match the requested settings. |  |  |
| E5 | P0 | **Export TXT report** — downloaded file contains: `=== AI Mastering Report ===`, `App         : @aimaster/desktop v3.6.0-rc.1`, `Schema      : phase-e/1`, and at minimum the `-- Loudness --` section.  Other Phase-D sections appear only if the analyzer emitted those fields. |  |  |
| E6 | P0 | **Export JSON report** — opens in any JSON viewer; `schemaVersion === "phase-e/1"`; `app.version === "3.6.0-rc.1"`. |  |  |
| E7 | P1 | TXT / JSON do **not** contain absolute file paths (`outputPath`, `previewPath`, waveform paths) or debug-only fields (`debugSummary`, `jobId`, `artifactDir`). |  |  |
| E8 | P0 | Result page renders even when Phase-D analyzer fields are entirely absent (current Python pipeline state) — only the Smart Recommendation panel (with "특별히 권장 사항이 없습니다" fallback) + Export panel are visible; SectionAnalysisPanel and AIArtifactWarningPanel emit no DOM. |  |  |

## F · Phase-D analyzer (DEFERRED — Python emit not yet shipped in this RC)

These cases **stay DEFERRED for v3.6.0-rc.1** because the Python pipeline
does not yet emit the corresponding fields.  They will become P0/P1 in
the v3.6.x patch that wires the analyzer.  Do not fail the RC because of
them; verify only that the UI does not crash when the fields are absent
(see E8).

| # | Severity | Case | Status | Notes |
|---|---|---|---|---|
| F1 | DEFERRED | When `sectionAnalysis` is emitted, the timeline renders with high/mid/low energy colours; tooltip shows section start/end. | DEFERRED |  |
| F2 | DEFERRED | When `aiArtifactCheck` has `present === true` findings, AIArtifactWarningPanel renders only those findings — never an "all clear" badge. | DEFERRED |  |
| F3 | DEFERRED | When `modeSuggestion.suggestedMode === currentMode`, no mode hint banner is shown. | DEFERRED |  |
| F4 | DEFERRED | When `vocalIntelligence.clarityScore <= 0.5`, SmartRecommendationPanel surfaces the "보컬 명료도가 낮은 패턴" rec. | DEFERRED |  |
| F5 | DEFERRED | When `translationCheck.phone <= 0.5`, the "전화기 스피커" rec is shown (warn severity). | DEFERRED |  |

## G · Edge cases

| # | Severity | Case | Status | Notes |
|---|---|---|---|---|
| G1 | P0 | **Large file 10 min+** — 10 minute WAV master completes; UI shows progress; no OOM on 16 GB RAM. |  |  |
| G2 | P1 | **Vocal-heavy KPOP track** — vocal protection report shows `vocalLossSeverity: ok`; result page renders without errors. |  |  |
| G3 | P1 | **Instrumental / lofi track** — vocal enhancer bypasses (no false-positive vocal recs from the legacy `vocalProtection` system); result page renders cleanly. |  |  |
| G4 | P2 | **AI-generated track (legacy `aiDetection`)** — supply a Suno/Udio export.  QC page surfaces the existing `harshHighmid` / `boomyLow` / `brickwall` flags (these are the v3.5 detectors that ARE wired; Phase-D `aiArtifactCheck` is deferred). |  |  |
| G5 | P2 | Cancelling mid-mastering returns to home cleanly; no orphan worker process. |  |  |
| G6 | P2 | After mastering, OS temp dir is reasonably clean (no >100 MB residue from a single run). |  |  |
| G7 | P1 | **Low-memory system** — 8 GB RAM machine masters a 5 min WAV without UI freezes; check with `top` / Task Manager that resident set stays < 2 GB. |  |  |
| G8 | P1 | **No system ffmpeg** — tested under A6 (Win) and on a clean macOS / Linux user with `which ffmpeg` returning nothing.  App must use the bundled `bin/ffmpeg` and complete an analyze + master cycle. |  |  |

## I · Runtime failure logging + support bundle (v3.6 QA infrastructure)

| # | Severity | Case | Status | Notes |
|---|---|---|---|---|
| I1 | P0 | Trigger an artificial preview failure (e.g. open the app, paste a corrupted .mp3 path into the audio src via devtools).  In a separate window, invoke `await window.electronAPI.invoke('support:bundle')` and confirm `recentFailures` includes a `preview` category entry. |  |  |
| I2 | P0 | Trigger an artificial worklet failure (e.g. block AudioContext via devtools); confirm a `worklet` category entry appears with the LoudnessMeterPanel error message. |  |  |
| I3 | P0 | Master a track that emits `pipelineWarnings`; confirm `recentPipelineWarnings` in the support bundle contains those warnings (code, level, userMessage). |  |  |
| I4 | P0 | Save a support bundle via `support:bundle-export` and grep the resulting JSON for `/Users/`, `/home/`, `outputPath`, `previewPath`, `debugSummary`, `artifactDir`, `jobId`.  None of those tokens may appear; the user's home dir must show as `~`. |  |  |
| I5 | P1 | Bundle includes `app.version === "3.6.0-rc.1"`, non-empty `runtime.electronVersion` / `runtime.chromeVersion`, and `failureCounts` matching the visible counts. |  |  |
| I6 | P1 | After 60 forced failures of the same category, `recentFailures` for that category caps at 50 entries (oldest dropped). |  |  |

## H · Build / smoke

| # | Severity | Case | Status | Notes |
|---|---|---|---|---|
| H1 | P0 | `pnpm typecheck` is clean across all 4 workspaces. |  |  |
| H2 | P0 | `pnpm --filter @aimaster/desktop build` produces `dist/renderer/index.html`, `dist-electron/main/index.js`, `dist-electron/preload/index.js`, AND a `loudnessProcessor.worklet-*.js` asset under `dist/renderer/assets/`. |  |  |
| H3 | P0 | `pnpm --filter @aimaster/desktop test` runs phase-e-ui (14) + phase-e-render (15) + phase-e-paths (22) + loudness selftest (30+) with 0 failures. |  |  |
| H4 | P0 | `pnpm --filter @aimaster/desktop test:release-smoke` exits 0; "license gate" check is informational PASS only (gate disabled in v3.6.0-rc.1+1). |  |  |
| H5 | P0 | `PRODUCTION=true pnpm --filter @aimaster/desktop test:release-smoke` (NO `LICENSE_HMAC_SECRET` set) **also exits 0** — proves the gate is no longer enforced. |  |  |
| H6 | — | (removed) The previous "PRODUCTION=true + LICENSE_HMAC_SECRET=<32-char> exits 0" case is no longer applicable; the secret is not consumed by anything. | N/A |  |
| H7 | P0 | `pytest -q` in `services/python-audio` is green (`79 passed, 41 skipped` baseline). |  |  |
| H8 | P1 | `node scripts/prebuild.cjs` copies `ffmpeg` and `ffprobe` into `apps/desktop/public/bin/` (size > 0, executable bit set on POSIX). |  |  |
| H9 | P1 | `electron-builder.yml` win target list contains **only** `nsis`, no legacy `portable` target. |  |  |
| H10 | P0 | All `package.json` files report version `3.6.0-rc.1` (or `0.2.0` for `@aimaster/shared-types`). |  |  |
| H11 | P1 | CI workflow `build.yml` — `body_path` references `RELEASE_DRAFT_v3.6.0.md`, `prerelease: true`. |  |  |
| H12 | P0 | The `loudnessProcessor.worklet.js` source file is **plain JavaScript** (no `declare`, no `: type` annotations).  No `.ts` worklet variant exists alongside it.  Smoke fails fast otherwise. |  |  |
| H13 | P0 | **Linux RC build artefact integrity** — `pnpm --filter @aimaster/desktop exec electron-builder --linux AppImage --x64 --publish never` produces an AppImage in `out/`; `latest-linux.yml` reads `version: 3.6.0-rc.1`; the unpacked `resources/bin/{ffmpeg,ffprobe}` are present and executable; `app.asar` contains `dist/renderer/assets/loudnessProcessor.worklet-*.js`. |  |  |
| H14 | P0 | **Windows NSIS RC build** — produced via CI (`.github/workflows/build.yml` win runner) on a tag push or manual `workflow_dispatch` with `release_tag` empty; verify the resulting `Louver Mastering AI-Setup-3.6.0-rc.1.exe` installs on a clean Win VM (A5 / A6). |  |  |
| H15 | P0 | **macOS ZIP RC build** — produced via CI mac runner; install the unsigned ZIP on an Apple Silicon test machine and follow A7 (Gatekeeper workaround).  Verify the bundled `bin/ffmpeg` is executable (Gatekeeper sometimes quarantines bundled binaries). |  |  |

---

## Sign-off

| Reviewer | Decision (Approve / Reject) | Date |
|---|---|---|
|  |  |  |

If approved, promote tag `v3.6.0-rc.1` → `v3.6.0` once all P0 / P1 cases
PASS, RELEASE_DRAFT_v3.6.0.md is updated to remove the `prerelease: true`
flag, and the body_path comment is reset.
