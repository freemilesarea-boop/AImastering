# apps/mac-shell — macOS mobile-style app

A minimal **Electron wrapper** that ships the **same `apps/mobile`** on-device
mastering app (3-step flow: 파일 → 마스터 → 결과) as a macOS `.dmg`/`.zip`.

> Why this approach (candidate A): Capacitor has **no official macOS target**
> (iOS/Android/Web only; desktop is via the community Electron platform). Wrapping
> the already-built mobile SPA in a tiny Electron window is the **fastest, lowest-
> risk** path — it reuses 100% of the mobile UI/logic, adds **no new framework**,
> and reuses the repo's existing electron/electron-builder.

## What it does / does NOT do
- ✅ Loads `apps/mobile/dist` (built Vite SPA) in a BrowserWindow via an `app://`
  scheme (ES modules need this; `file://` blocks module CORS).
- ✅ Web fallbacks kick in automatically (`Capacitor.isNativePlatform() === false`):
  file `<input>` to pick, `<a download>` to save (Downloads), `navigator.share`
  → download fallback to share. **Masters on-device (Web Audio); no server.**
- ❌ No local python engine, no engine IPC, no preload, no node integration.
- ❌ Does not touch the desktop Electron app (`apps/desktop`) or its build.

## Structure (files)
```
apps/mac-shell/
  package.json          # @aimaster/mac-shell; electron + electron-builder (already in workspace)
  main.cjs              # Electron main: app:// protocol + BrowserWindow (no IPC)
  electron-builder.yml  # mac dmg+zip, arm64+x64, appId com.louver.mastering.mac
  www/                  # (generated) copy of ../mobile/dist — gitignored
  out/                  # (generated) .dmg / .zip output — gitignored
```

## Build
```bash
# 1) Build the mobile SPA (on-device mastering; no server env needed)
pnpm --filter @aimaster/mobile build

# 2) Package the macOS app (run on macOS — dmg/zip需 macOS)
pnpm --filter @aimaster/mac-shell dist:mac
#   → copies ../mobile/dist → www, then electron-builder --mac dmg zip --x64 --arm64
#   → out/Loui Mastering-1.0.0-arm64.dmg / -x64.dmg / .zip

# Dev run (any OS with a display):
pnpm --filter @aimaster/mac-shell start
```
CI: `.github/workflows/build-mac-mobile.yml` (macos-14) builds + uploads the
artifact `loui-mastering-mac`.

## Server / API
None. Mastering runs entirely on-device (Web Audio). There is no Render/API URL
or key — the old "서버 설정" screen and server env were removed in the
on-device migration.

## Gatekeeper / signing
Not code-signed/notarized yet → first launch shows "unidentified developer".
**Right-click the app → Open** (once), or `xattr -dr com.apple.quarantine
"/Applications/Loui Mastering.app"`. Signing is a later step (same as the
desktop app; see `docs/MACOS-RELEASE.md`).

## Logs / crash diagnostics (macOS) — P0 "black screen at result/export"
`main.cjs` logs every crash path to **stderr + a file**:
`~/Library/Application Support/Loui Mastering/loui-mac-shell.log`
(the exact path is printed at startup). Captured events:
- main `uncaughtException` / `unhandledRejection`
- `render-process-gone` (the renderer crash that turns the window black) — the
  app auto-recovers (reload, with a backoff) and, after repeated crashes, shows
  a **visible error screen** instead of a silent black window.
- `child-process-gone` (esp. **GPU** — the classic macOS Electron black screen)
- `did-fail-load`, `unresponsive`/`responsive`
- all renderer **console** output at warning/error level (uncaught JS errors and
  unhandled promise rejections land here with file:line)

Env levers:
- `LOUI_DEBUG=1` — open DevTools (detached) + log verbose console.
- `LOUI_DISABLE_HW_ACCEL=1` — disable GPU acceleration (off by default). Use only
  to A/B test if the log reports a **GPU** `child-process-gone`.

```bash
LOUI_DEBUG=1 pnpm --filter @aimaster/mac-shell start   # repro + watch the log
```
- macOS crash reports (if the process itself dies):
  `~/Library/Logs/DiagnosticReports/Loui Mastering-*`.

## Boundaries
- No changes to `apps/desktop` (Electron engine app), `services/*`, Android
  project, payment/account. Adding this workspace package only updates the
  lockfile (electron/electron-builder already present via apps/desktop).
