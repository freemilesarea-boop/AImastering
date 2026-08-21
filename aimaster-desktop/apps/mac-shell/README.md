# apps/mac-shell — macOS mobile-style app

A minimal **Electron wrapper** that ships the **same `apps/mobile`** server-mastering
app (4-step flow: 서버 → 파일 → 마스터 → 결과) as a macOS `.dmg`/`.zip`.

> Why this approach (candidate A): Capacitor has **no official macOS target**
> (iOS/Android/Web only; desktop is via the community Electron platform). Wrapping
> the already-built mobile SPA in a tiny Electron window is the **fastest, lowest-
> risk** path — it reuses 100% of the mobile UI/logic and the Render API, adds **no
> new framework**, and reuses the repo's existing electron/electron-builder.

## What it does / does NOT do
- ✅ Loads `apps/mobile/dist` (built Vite SPA) in a BrowserWindow via an `app://`
  scheme (ES modules need this; `file://` blocks module CORS).
- ✅ Web fallbacks kick in automatically (`Capacitor.isNativePlatform() === false`):
  file `<input>` to pick, `<a download>` to save (Downloads), `navigator.share`
  → download fallback to share. Talks to the **Render API** over HTTPS.
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
# 1) Build the mobile SPA (optionally inject server env for a "prod" build)
#    VITE_MASTERING_API_URL=https://<render>.onrender.com \
#    VITE_MASTERING_API_KEY=...  (omit for the test build → user types them in-app)
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

## API URL / KEY (req 9–10)
- **Test build**: no env injected → the in-app "서버 설정" screen takes URL/KEY
  (same as Android). Kept as-is.
- **Prod build**: set `VITE_MASTERING_API_URL` / `VITE_MASTERING_API_KEY` before
  step 1 → baked into the SPA; the settings screen can be hidden later (P1).

## Gatekeeper / signing
Not code-signed/notarized yet → first launch shows "unidentified developer".
**Right-click the app → Open** (once), or `xattr -dr com.apple.quarantine
"/Applications/Loui Mastering.app"`. Signing is a later step (same as the
desktop app; see `docs/MACOS-RELEASE.md`).

## Logs / crash (macOS)
- The app is a plain web view; renderer logs appear in the window's DevTools
  (View menu) and in `~/Library/Logs/Loui Mastering/` if enabled.
- Crash reports: `~/Library/Logs/DiagnosticReports/Loui Mastering-*`.

## Boundaries
- No changes to `apps/desktop` (Electron engine app), `services/*`, Android
  project, payment/account. Adding this workspace package only updates the
  lockfile (electron/electron-builder already present via apps/desktop).
