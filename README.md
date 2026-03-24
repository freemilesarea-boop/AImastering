# AImastering — AI 음원 자동 마스터링 데스크톱 앱

음악 파일을 업로드하면 AI가 자동으로 마스터링하여 스트리밍 플랫폼에 최적화된 음원을 생성합니다.

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

### Python 오디오 엔진 단독 실행 및 테스트 (macOS 기준)

```bash
# 프로젝트 루트에서 실행
cd services/python-audio

# 가상 환경 생성 및 활성화
python3 -m venv .venv
source .venv/bin/activate

# 의존성 설치
pip install -r requirements.txt

# 테스트 실행 (ffmpeg가 시스템 PATH에 있어야 함)
pytest tests/ -v
```

> **참고:** `pytest-timeout` 패키지가 설치되어 있지 않은 경우 `pip install pytest-timeout` 으로 별도 설치하거나,
> `requirements.txt`를 통해 자동 설치됩니다. ffmpeg 미설치 환경에서는 해당 테스트가 자동으로 skip됩니다.

### 빌드 및 패키징

```bash
# macOS DMG 빌드
npm run dist:mac

# Windows NSIS 인스톨러 빌드
npm run dist:win
```

## 폴더 구조

```
AImastering/                        ← 프로젝트 루트
├── src/
│   ├── main/                       # Electron 메인 프로세스
│   │   ├── ipc/                    # IPC 핸들러
│   │   ├── services/               # 비즈니스 로직 서비스
│   │   └── utils/                  # 유틸리티
│   ├── preload/                    # contextBridge API
│   └── renderer/                   # React UI
│       ├── components/             # UI 컴포넌트
│       ├── pages/                  # 페이지 단위 뷰
│       ├── store/                  # Zustand 스토어
│       └── hooks/                  # 커스텀 훅
├── services/
│   └── python-audio/               # Python 오디오 엔진 (JSON-RPC)
│       ├── app/
│       │   ├── main.py             # JSON-RPC 서버 진입점
│       │   ├── analyzers/          # 오디오 분석 (LUFS, TP, LRA)
│       │   ├── mastering/          # 마스터링 파이프라인 (EQ, 컴프, loudnorm)
│       │   ├── qc/                 # QC 검사기
│       │   └── utils/              # FFmpeg 래퍼, 오디오 I/O, 로거
│       ├── tests/                  # pytest 테스트 스위트
│       │   ├── conftest.py         # 공용 픽스처 (ffmpeg 기반 테스트 오디오 생성)
│       │   ├── test_ffmpeg_wrapper.py
│       │   ├── test_pipeline.py
│       │   └── test_rpc_dispatcher.py
│       ├── pyproject.toml          # pytest 설정 (pythonpath, testpaths)
│       └── requirements.txt        # Python 의존성
├── docs/                           # 설계 문서
└── scripts/                        # 빌드/설정 스크립트
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
