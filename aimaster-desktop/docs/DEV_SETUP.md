# Development Setup

## Prerequisites

| Tool    | Version  | Install                              |
|---------|----------|--------------------------------------|
| Node.js | ≥ 20     | https://nodejs.org                   |
| pnpm    | ≥ 9      | `npm i -g pnpm`                      |
| Python  | 3.10–3.12| `brew install python@3.12` / python.org |
| FFmpeg  | any      | `brew install ffmpeg` / apt / winget |

## Quick Start

```bash
# 1. Clone and install
git clone <repo>
cd aimaster-desktop
pnpm install

# 2. Set up Python venv + deps
./setup-python.sh

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

### `pnpm dev` 가 Electron ENOENT 로 죽을 때

```bash
pnpm fix:electron
```

`pnpm install` 이 electron 의 postinstall 을 건너뛰는 경우가 있다(스토어 재사용,
사이드이펙트 캐시). 그러면 `node_modules/electron/dist` 가 없거나 반쯤 만들어진
채로 남는다 — 후자는 실행 파일이 있으니 겉보기엔 멀쩡하고, 실행할 때
`dyld: Library not loaded: @rpath/Electron Framework.framework` 로 죽는다.

그래서 파일 하나가 아니라 electron 자신의 기준(`dist/version` 이 `package.json`
의 버전과 일치)에 플랫폼별 필수 파일까지 같이 본다. 한 번 다시 받아도 안 되면
캐시를 건너뛰고 한 번 더 받는다.

`path.txt` 를 손으로 쓸 일이 생기면 **`echo` 를 쓰지 말 것.** electron 의
`index.js` 는 이 파일을 trim 없이 읽어서 실행 경로에 이어 붙이기 때문에, `echo`
가 붙이는 줄바꿈 하나 때문에 `spawn .../Electron\n ENOENT` 가 난다. 확인도
바이너리를 직접 `--version` 으로 부르면 안 된다 — 그 경로는 `path.txt` 를 읽지
않아서 깨진 상태에서도 버전이 멀쩡히 찍힌다. `node -p "require('electron')"` 로
봐야 한다. `pnpm fix:electron` 이 둘 다 그렇게 한다.

### Python 3.13+ 를 쓰고 있을 때

`setup-python.sh` 가 거부한다. 거부하는 게 맞다 — `requirements.txt` 의
`numpy==1.26.4` 는 cp312 까지만 휠이 있어서, 그 위에서는 pip 이 소스 빌드로
떨어지고 Fortran 툴체인 없는 맥에서 몇 분 뒤에 실패한다.

```bash
brew install python@3.12
PYTHON=python3.12 ./setup-python.sh
```

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
