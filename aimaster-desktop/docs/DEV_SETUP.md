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
pnpm desktop         # Electron + Vite HMR — 홈 화면에서 시작
pnpm --filter @aimaster/desktop dev:daw   # DAW 창으로 바로 (개발용)
```

`pnpm desktop` 은 Vite 개발 서버와 Electron 을 함께 띄웁니다. 첫 창은 홈
화면이고, DAW 는 상단의 **DAW** 버튼으로 들어갑니다.

DAW 작업 중이라면 `dev:daw` 쪽이 낫습니다 — 리로드할 때마다 홈에서 두 번씩
클릭해 들어가지 않아도 됩니다. `LOUI_DEV_PAGE` 환경변수로 동작하고
**개발 모드에서만** 읽힙니다(`src/renderer/stores/appStore.ts`).

### 2번(Python)은 언제 필요한가

Electron 앱 자체는 Python 없이 **뜹니다.** DAW · 믹서 · 플러그인 · 에디터는
전부 Web Audio 라서 브라우저 안에서 끝납니다. Python 이 필요한 건 마스터링
엔진 쪽(AI Analyze / Master) 호출이고, 그때까지는 없어도 됩니다.

### 리눅스에서 root 로 실행할 때

컨테이너 등에서 root 로 돌리면 Chromium 이 샌드박스를 거부하며 즉시 죽습니다
(`Running as root without --no-sandbox is not supported`). 그럴 때만:

```bash
ELECTRON_DISABLE_SANDBOX=1 pnpm desktop
```

일반 사용자 계정(맥 · 윈도우 · 데스크톱 리눅스)에서는 필요 없습니다.

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
