# AImastering — AI 음원 자동 마스터링 데스크톱 앱

음악 파일을 업로드하면 AI가 자동으로 마스터링하여 스트리밍 플랫폼에 최적화된 음원을 생성합니다.

## ⚠️ 코드 위치 (v3.2 부터)

| 디렉토리 | 상태 | 용도 |
|---|---|---|
| `aimaster-desktop/` | **활성** | Electron 앱 + 활성 Python 엔진 (`services/python-audio/`) |
| `python/`           | **legacy** | v3.1 이하 모듈, **신규 변경 금지**.  자세한 내용 → `python/LEGACY.md` |

신기능 / 버그 수정은 모두 `aimaster-desktop/services/python-audio/` 에서.

## 🚀 Phase 1 출시 (데스크톱)

- **Phase 1 출시 대상 = `aimaster-desktop/apps/desktop`** (Windows / macOS Electron 앱).
- **마스터링은 사용자 컴퓨터의 로컬 엔진에서 실행된다** — 번들된 Python/FFmpeg 엔진(Electron IPC
  `audio:master`) + Rust DSP WASM 프리뷰. **Render 등 외부 마스터링 서버가 필요 없다.**
- **Render 마스터링 서버는 데스크톱 출시의 blocker가 아니다.** Render가 다운/과금 초과여도
  데스크톱 빌드·출시·마스터링은 정상 동작한다. (근거: `docs/LOCAL_MASTERING_MIGRATION.md`)
- 데스크톱이 쓰는 서버는 **라이선스/계정/결제 검증(LICENSE_API_URL)** 과 **자동 업데이트(GitHub
  Releases)** 뿐 — Render 마스터링과 무관.
- **모바일 앱(`apps/mobile`)과 `apps/mac-shell`은 Render 마스터링 API에 의존하므로 Phase 1
  출시 범위에서 제외**한다(로컬 엔진 전환 = Phase 3 이전까지 배포 대상 아님).

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
git clone https://github.com/your-org/aimastering.git
cd aimastering

# 2. Node.js 의존성 설치
npm install

# 3. Python 환경 설정
npm run setup:python
# 또는: bash scripts/setup-python.sh

# 4. 개발 모드 실행
npm run dev
```

### 빌드 및 패키징

```bash
# macOS DMG 빌드
npm run dist:mac

# Windows NSIS 인스톨러 빌드
npm run dist:win
```

## 폴더 구조

```
AImastering/
├── src/
│   ├── main/           # Electron 메인 프로세스
│   │   ├── ipc/        # IPC 핸들러
│   │   ├── services/   # 비즈니스 로직 서비스
│   │   └── utils/      # 유틸리티
│   ├── preload/        # contextBridge API
│   └── renderer/       # React UI
│       ├── components/ # UI 컴포넌트
│       ├── pages/      # 페이지 단위 뷰
│       ├── store/      # Zustand 스토어
│       └── hooks/      # 커스텀 훅
├── python/
│   ├── main.py         # JSON-RPC 서버 진입점
│   ├── pipeline/       # 마스터링 파이프라인
│   ├── analysis/       # QC 분석
│   └── utils/          # FFmpeg 래퍼, 오디오 I/O
├── docs/               # 설계 문서
└── scripts/            # 빌드/설정 스크립트
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
