# Development Setup

## Prerequisites

| Tool    | Version  | Install                              |
|---------|----------|--------------------------------------|
| Node.js | ≥ 20     | https://nodejs.org                   |
| pnpm    | ≥ 9      | `npm i -g pnpm`                      |
| Python  | ≥ 3.10   | https://python.org                   |
| FFmpeg  | any      | `brew install ffmpeg` / apt / winget |

## Quick Start

```bash
# 1. Clone and install
git clone <repo>
cd aimaster-desktop
pnpm install

# 2. Set up Python venv + deps
./scripts/setup-python.sh

# 3. Start dev mode
pnpm desktop         # Electron + Vite HMR
```

## Individual Commands

```bash
pnpm build           # Build all packages
pnpm typecheck       # Type-check all packages
pnpm lint            # Lint all packages

# Desktop only
pnpm --filter @aimaster/desktop dev
pnpm --filter @aimaster/desktop dist   # Build distributable
```

## Environment Variables

| Variable               | Default                    | Description           |
|------------------------|----------------------------|-----------------------|
| `AIMASTER_PYTHON`      | `python3`                  | Path to Python binary |
| `LICENSE_HMAC_SECRET`  | `aimaster-local-secret-v1` | HMAC signing secret   |

Set in `.env` at repo root (never commit this file).

## Project Structure

```
apps/desktop/src/
  main/
    index.ts              # BrowserWindow + app lifecycle
    ipc/
      audioHandlers.ts    # audio:* IPC
      licenseHandlers.ts  # license:* IPC
      fileHandlers.ts     # file:* IPC
      settingsHandlers.ts # settings:* IPC
    utils/
      logger.ts           # file + console logger
  preload/
    index.ts              # contextBridge whitelist
  renderer/
    App.tsx               # root, page router
    pages/                # HomePage MasteringPage ResultPage QCPage SettingsPage
    stores/               # Zustand: appStore audioStore licenseStore
    hooks/                # useAudioEngine useLicense
    components/           # common/ mastering/ qc/ license/ upload/

packages/
  shared-types/src/index.ts   # All TypeScript interfaces
  audio-engine/src/           # PythonBridge + FFmpeg check + RPC wrappers
  license-core/src/index.ts   # LicenseService + HMAC

services/python-audio/app/
  main.py                     # JSON-RPC dispatcher
  analyzers/analyzer.py       # ffprobe + numpy + soundfile
  mastering/mastering.py      # FFmpeg loudnorm 2-pass + EQ
  qc/qc_checker.py            # 12-item QC + platform targets
  utils/
    ffmpeg_wrapper.py         # loudnorm_pass1/2, ffprobe_info
    logger.py                 # stderr-only logger
```
