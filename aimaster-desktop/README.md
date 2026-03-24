# AIMASTER Desktop

AI 기반 음원 자동 마스터링 데스크톱 애플리케이션.

> WAV / FLAC / MP3 업로드 → AI 아티팩트 감지 → 스타일 프리셋 선택 → 자동 마스터링 → QC 체크 → 저장

YouTube Music · Spotify · Apple Music 기준 **−14 LUFS / −1.0 dBTP** 타깃으로 자동 정규화합니다.

---

## 목차

1. [요구 사항](#요구-사항)
2. [FFmpeg 준비](#ffmpeg-준비)
3. [설치](#설치)
4. [개발 실행](#개발-실행)
5. [빌드 · 패키징](#빌드--패키징)
6. [앱 기능](#앱-기능)
7. [기술 스택](#기술-스택)
8. [패키지 구조](#패키지-구조)
9. [환경 변수](#환경-변수)

---

## 요구 사항

| 도구     | 최소 버전 | 설치 링크                        |
|----------|-----------|----------------------------------|
| Node.js  | 20        | https://nodejs.org               |
| pnpm     | 9         | `npm i -g pnpm`                  |
| Python   | 3.10      | https://python.org               |
| FFmpeg   | 4.x 이상  | [FFmpeg 준비](#ffmpeg-준비) 참조 |

---

## FFmpeg 준비

AIMASTER는 오디오 분석과 마스터링에 **FFmpeg** 와 **FFprobe** 를 사용합니다.
앱이 실행되는 머신에 두 바이너리가 모두 설치되어 있어야 합니다.

### macOS

```bash
# Homebrew (권장)
brew install ffmpeg

# 설치 확인
ffmpeg -version
ffprobe -version
```

### Linux (Ubuntu / Debian)

```bash
sudo apt update
sudo apt install ffmpeg

# 설치 확인
ffmpeg -version
```

### Windows

**방법 A — winget (Windows 10/11)**
```powershell
winget install Gyan.FFmpeg
```

**방법 B — Scoop**
```powershell
scoop install ffmpeg
```

**방법 C — 수동 설치**
1. https://ffmpeg.org/download.html 에서 Windows 빌드 다운로드
2. 압축 해제 후 `bin/` 폴더를 시스템 PATH에 추가

### 경로 직접 지정 (선택)

시스템 PATH 외의 위치에 FFmpeg가 설치된 경우 환경 변수로 지정합니다.

```bash
# .env 파일 또는 셸 프로파일
export AIMASTER_FFMPEG=/opt/custom/bin/ffmpeg
export AIMASTER_FFPROBE=/opt/custom/bin/ffprobe
```

앱은 다음 순서로 FFmpeg 바이너리를 탐색합니다.

1. 패키징된 앱 내부 `resources/bin/` (배포 빌드 전용)
2. `AIMASTER_FFMPEG` / `AIMASTER_FFPROBE` 환경 변수
3. 플랫폼 기본 설치 디렉토리 (Homebrew, apt, Scoop 등)
4. 시스템 `PATH` (최후 수단)

---

## 설치

```bash
# 1. 저장소 클론
git clone <repo-url>
cd aimaster-desktop

# 2. Node 패키지 설치 (모노레포 전체)
pnpm install

# 3. Python 가상 환경 및 의존성 설치
./scripts/setup-python.sh
```

`setup-python.sh` 는 `services/python-audio/` 하위에 `.venv` 를 생성하고
`requirements.txt` 의 패키지를 설치합니다.

> **Windows 사용자** — PowerShell에서 `bash ./scripts/setup-python.sh` 로 실행하거나,
> 스크립트 내용을 참고하여 수동으로 가상 환경을 생성하세요.

---

## 개발 실행

```bash
# Electron + Vite HMR 동시 실행 (권장)
pnpm desktop
```

내부적으로 다음을 병렬 실행합니다.

- `vite` — 렌더러(React) 개발 서버 (포트 5173, HMR 포함)
- `tsc --watch` — main 프로세스 TypeScript 컴파일
- `electron .` — 컴파일 완료 후 앱 실행

```bash
# 패키지별 개별 실행
pnpm --filter @aimaster/desktop dev

# 타입 검사 (전체 모노레포)
pnpm typecheck

# 린트
pnpm lint
```

### Python 서비스 수동 테스트

```bash
cd services/python-audio
source .venv/bin/activate  # Windows: .venv\Scripts\activate
python -m app.main
# stdin에 JSON-RPC 요청을 입력하면 stdout으로 응답이 나옵니다
```

---

## 빌드 · 패키징

### 1단계 — 모든 TypeScript 패키지 빌드

```bash
pnpm build
```

Turborepo가 의존성 순서를 자동으로 파악하여 빌드합니다.

```
shared-types → audio-engine, license-core → desktop
```

### 2단계 — 배포용 앱 패키징

```bash
pnpm --filter @aimaster/desktop dist
```

`electron-builder` 가 실행되어 플랫폼에 맞는 설치 파일을 생성합니다.

| 플랫폼  | 출력 파일                          |
|---------|------------------------------------|
| macOS   | `dist/AIMASTER-*.dmg`              |
| Windows | `dist/AIMASTER-Setup-*.exe`        |
| Linux   | `dist/AIMASTER-*.AppImage`         |

> **주의** — 패키징 빌드에는 FFmpeg 바이너리를 `resources/bin/` 에 사전 배치해야
> 사용자 머신에 FFmpeg가 없어도 앱이 동작합니다. 자세한 내용은
> `apps/desktop/electron-builder.yml` 을 참고하세요.

---

## 앱 기능

### 화면 구성

```
홈 (파일 업로드)
  └→ 분석 결과
       └→ 처리 중 (진행 상황)
            └→ 결과 (저장 / 비교)
```

#### 1. 홈 — 파일 업로드

- 드래그 앤 드롭 또는 파일 선택 대화상자로 오디오 파일 불러오기
- 지원 포맷: **WAV, FLAC, AIFF, AIF, MP3, M4A**
- 파일을 불러오면 즉시 분석 단계로 이동

#### 2. 분석 결과

| 항목 | 내용 |
|------|------|
| 파일 정보 | 포맷 · 샘플레이트 · 비트 뎁스 · 채널 · 길이 · 파일 크기 |
| Loudness | Integrated LUFS · True Peak · Loudness Range (LRA) + QC 상태 뱃지 |
| 묵음 구간 | 시작/끝 무음이 500ms 초과 시 경고 표시 |
| 스타일 프리셋 | Balanced / Warm / Bright / Punch 4가지 중 선택 |

#### 3. 처리 중

5단계 파이프라인 진행 상황을 실시간으로 표시합니다.

1. 파일 검사
2. 분석 (loudnorm pass-1)
3. 톤 보정 (EQ + 다이나믹스)
4. Loudness normalization (pass-2)
5. 사후 검증

오류 발생 시 오류 유형별 한국어 안내 메시지와 재시도 버튼이 표시됩니다.

#### 4. 결과

| 구성 요소 | 설명 |
|-----------|------|
| Before / After 비교 | Integrated LUFS · True Peak · LRA 수치 비교 (증감 표시) |
| 프리뷰 플레이어 | 320 kbps MP3 프리뷰 재생 (시크 바 포함) |
| 저장 버튼 | MP3 저장 (무료/유료 공통) · WAV 마스터 저장 (유료 전용) |
| QC 요약 | −14 LUFS 달성 여부 · True Peak −1 dBTP 이하 여부 · 처리 시간 |

### 스타일 프리셋

| 프리셋 | 특성 | 적합한 장르 |
|--------|------|-------------|
| **Balanced** | 중립, 원음 보존 | 범용 |
| **Warm** | 3.5 kHz 완화, 고역 롤오프 | 보컬, 어쿠스틱, 복고풍 |
| **Bright** | 9 kHz 존재감, 저역 클린업 | 팝, 일렉트로닉, 현대적 |
| **Punch** | 80 Hz 바디, 2 kHz 어택감 | 힙합, EDM, 댄스 |

### AI 아티팩트 보정

FFT 에너지 비율 분석을 통해 다음 문제를 자동 감지하고 보정합니다.

| 감지 항목 | 기준 | 처리 |
|-----------|------|------|
| 거친 고음역 (Harsh High-Mid) | 3–5 kHz 에너지 > 28% | 4 kHz −3 dB 보정 |
| 과도한 저역 (Boomy Low-End)  | 60–200 Hz 에너지 > 45% | 120 Hz −4 dB 보정 |

### 라이선스 티어

| 항목 | 무료 | 유료 (Pro) |
|------|------|------------|
| 처리 횟수 | 3회 (총) | 무제한 |
| MP3 프리뷰 저장 | ✓ | ✓ |
| WAV 마스터 저장 | ✗ | ✓ |
| 스타일 프리셋 | Balanced만 | 전체 4종 |
| 레포트 내보내기 | 보기 전용 | ✓ |

라이선스 키 형식: `AIMASTER-XXXX-XXXX-XXXX`

---

## 기술 스택

| 레이어 | 기술 |
|--------|------|
| 데스크톱 셸 | Electron 28 |
| UI | React 18 + TypeScript + Tailwind CSS v3 |
| 상태 관리 | Zustand |
| 렌더러 빌드 | Vite 5 |
| 패키징 | electron-builder |
| 모노레포 | pnpm workspaces + Turborepo |
| 오디오 엔진 | Python 3.10 + FFmpeg + soundfile + numpy |
| IPC 프로토콜 | JSON-RPC over stdin/stdout |
| 라이선스 저장 | electron-store (AES-256-CBC 암호화) |

---

## 패키지 구조

```
aimaster-desktop/
├── apps/
│   └── desktop/               # Electron 앱 (main + renderer + preload)
├── packages/
│   ├── audio-engine/          # Node.js 오케스트레이션 (PythonBridge, FFmpeg 유틸)
│   ├── license-core/          # HMAC 라이선스 검증 서비스
│   └── shared-types/          # 공유 TypeScript 인터페이스
├── services/
│   └── python-audio/          # 오디오 처리 서비스 (JSON-RPC 서버)
├── scripts/
│   └── setup-python.sh        # Python venv 초기화 스크립트
└── docs/
    ├── ARCHITECTURE.md        # 아키텍처 상세
    ├── MASTERING_SPEC.md      # 마스터링 파이프라인 명세
    ├── LICENSE_FLOW.md        # 라이선스 정책 및 활성화 흐름
    └── DEV_SETUP.md           # 개발 환경 상세 설정
```

자세한 내용은 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 를 참고하세요.

---

## 환경 변수

`.env` 파일을 저장소 루트에 생성하여 설정합니다 (`.gitignore` 에 포함됨).

```dotenv
# Python 인터프리터 경로 (기본값: python3)
AIMASTER_PYTHON=/path/to/python3

# FFmpeg 바이너리 경로 (PATH 탐색보다 우선)
AIMASTER_FFMPEG=/opt/homebrew/bin/ffmpeg
AIMASTER_FFPROBE=/opt/homebrew/bin/ffprobe

# 라이선스 HMAC 서명 시크릿 (프로덕션에서 반드시 변경)
LICENSE_HMAC_SECRET=your-secure-random-secret
```

> `LICENSE_HMAC_SECRET` 은 프로덕션 배포 전 반드시 충분히 긴 무작위 값으로 교체하세요.
> 기본값 `aimaster-local-secret-v1` 은 개발 전용입니다.
