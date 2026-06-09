# AImastering — AI 음원 자동 마스터링 데스크톱 앱

음악 파일을 업로드하면 AI가 자동으로 마스터링하여 스트리밍 플랫폼에 최적화된 음원을 생성합니다.

## ⚠️ 코드 위치

모든 활성 코드는 **`aimaster-desktop/`** 모노레포에 있습니다.

| 경로 | 용도 |
|---|---|
| `aimaster-desktop/apps/desktop/` | Electron 앱 (React 렌더러 + main/preload) |
| `aimaster-desktop/services/python-audio/` | 활성 Python 마스터링 엔진 (FFmpeg + NumPy) |
| `aimaster-desktop/dsp-core/` | Rust DSP 코어 (실시간 프리뷰 + 오프라인 렌더, WASM) |
| `aimaster-desktop/packages/` | 공유 패키지 (audio-engine / shared-types / dsp-wasm / license-core) |

> 모노레포 이전의 레거시 앱(루트 `src/`, `python/`)은 v3.6에서 제거되었습니다 (git 이력에 보존).

## 주요 기능

| 기능 | 설명 |
|------|------|
| **자동 마스터링** | YouTube Music 대응형 기본 프로필 (-14 LUFS / -1.0 dBTP) |
| **오디오 분석** | LUFS, True Peak, LRA, 스펙트럼 분석 |
| **QC 검사** | 5개 주요 플랫폼 기준 동시 점검 |
| **다중 프리셋** | YouTube, Spotify, Apple Music, Tidal, 방송용 |
| **무료 체험** | 3회 무료 처리 후 라이센스 필요 |

> ⚠️ 라우드니스 타깃 수치(-14 LUFS, -1.0 dBTP)는 본 프로그램의 기본 출력 스펙입니다. 각 플랫폼의 공식 처리 정책과 다를 수 있으며, 플랫폼 정책은 언제든 변경될 수 있습니다.

## 기술 스택

```
┌─────────────────────────────────────┐
│  Electron + React + TypeScript      │  데스크톱 UI
├─────────────────────────────────────┤
│  Zustand                            │  상태 관리
├─────────────────────────────────────┤
│  Tailwind CSS                       │  스타일링
├─────────────────────────────────────┤
│  Electron IPC                       │  UI ↔ Backend 통신
├─────────────────────────────────────┤
│  Node.js (AudioEngine.ts)           │  오케스트레이션
├─────────────────────────────────────┤
│  Python 3.9+ (오디오 처리)           │  분석 + 마스터링
├─────────────────────────────────────┤
│  FFmpeg (loudnorm 2-pass)           │  라우드니스 정규화
└─────────────────────────────────────┘
```

## 개발 환경 설정

### 사전 요구사항

- Node.js 18+
- Python 3.9+
- FFmpeg (시스템 PATH에 있어야 함)

```bash
# macOS
brew install node ffmpeg python3

# Ubuntu
sudo apt install nodejs ffmpeg python3 python3-pip python3-venv
```

### 설치 및 실행

```bash
# 1. 저장소 클론
git clone https://github.com/freemilesarea-boop/AImastering.git
cd AImastering/aimaster-desktop

# 2. 의존성 설치 (pnpm 워크스페이스)
pnpm install

# 3. Python 환경 설정
bash scripts/setup-python.sh

# 4. 개발 모드 실행
pnpm --filter @aimaster/desktop dev
```

### 빌드 및 패키징

```bash
cd aimaster-desktop/apps/desktop
pnpm dist:mac   # macOS (zip, x64+arm64)
pnpm dist:win   # Windows (portable)
```

### 테스트

```bash
cd aimaster-desktop/apps/desktop
pnpm typecheck       # tsc (renderer + main)
pnpm test            # tsx 셀프테스트 스위트 + vitest
pnpm test:unit       # 렌더러 단위/컴포넌트 테스트 (vitest)
```

## 폴더 구조

```
AImastering/
├── aimaster-desktop/                  # 활성 모노레포 (pnpm + turbo)
│   ├── apps/desktop/                  # Electron 앱
│   │   └── src/renderer/              #   React UI (pages / components / audio / stores)
│   │   └── src/main/                  #   Electron main + IPC 핸들러 + offline 렌더
│   ├── services/python-audio/         # Python 마스터링 엔진 (FFmpeg + NumPy)
│   ├── dsp-core/                      # Rust DSP 코어 (loui-dsp) + WASM/Node 바인딩
│   └── packages/                      # 공유 패키지 (shared-types / audio-engine / …)
└── docs/                              # 설계·로드맵·점검 문서
```

## 오디오 처리 파이프라인

```
[WAV 입력]
    ↓
[Pre-Analysis]     LUFS, TP, LRA 측정 (ffmpeg loudnorm pass1)
    ↓
[EQ]               High-pass 30Hz, Low/High Shelf, Air EQ
    ↓
[Compression]      글루 컴프레서 (-18dB threshold, 2:1)
    ↓
[Loudness Norm]    ffmpeg loudnorm pass2 (타깃: -14 LUFS, TP: -1.0)
    ↓
[Post-Analysis]    출력 파일 검증
    ↓
[WAV/FLAC/MP3 출력]
```

## 라이센스 구조

| 플랜 | 처리 횟수 | 기능 |
|------|----------|------|
| 무료 체험 | 3회 | 기본 마스터링, QC |
| Basic | 무제한 | + 배치 처리 |
| Pro | 무제한 | + 고급 EQ/컴프 파라미터, PDF 리포트 |

라이센스 키 형식: `AIMASTER-XXXX-XXXX-XXXX`

## 기여

Issue / PR 환영합니다. 개발 가이드는 `docs/ARCHITECTURE.md` 참고.

## 라이센스

MIT License — 자세한 내용은 `LICENSE` 파일 참고.
