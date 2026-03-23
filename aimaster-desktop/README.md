# AIMASTER Desktop

AI 음원 자동 마스터링 데스크톱 애플리케이션.

> WAV 업로드 → AI 아티팩트 감지 → 스타일 프리셋 → 자동 마스터링 → QC 체크 → 다운로드

## Tech Stack

| Layer        | Technology                              |
|--------------|-----------------------------------------|
| Shell        | Electron 28                             |
| UI           | React 18 + TypeScript + Tailwind CSS    |
| State        | Zustand                                 |
| Build        | Vite 5 (renderer) + tsc (main)          |
| Packaging    | electron-builder                        |
| Monorepo     | pnpm workspaces + Turborepo             |
| Audio Engine | Python 3.10+ + FFmpeg + soundfile/numpy |
| IPC          | JSON-RPC over stdin/stdout              |

## Quick Start

```bash
pnpm install
./scripts/setup-python.sh
pnpm desktop
```

See [docs/DEV_SETUP.md](docs/DEV_SETUP.md) for full setup guide.

## Mastering Pipeline

```
Input → ffprobe → loudnorm pass1 → AI detection → EQ filter → loudnorm pass2 → WAV + MP3
```

Target: **-14 LUFS Integrated / -1.0 dBTP True Peak** (YouTube Music / Spotify)

## Packages

| Package             | Description                          |
|---------------------|--------------------------------------|
| `@aimaster/desktop` | Electron app (main + renderer)       |
| `@aimaster/audio-engine` | Node orchestration + PythonBridge |
| `@aimaster/license-core` | HMAC license validation          |
| `@aimaster/shared-types` | Shared TypeScript interfaces     |

## License

Key format: `AIMASTER-XXXX-XXXX-XXXX`
Free: 3 trials + MP3 preview | Pro: unlimited + WAV master + all presets + report export
