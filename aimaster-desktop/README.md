# AIMASTER Desktop

오디오 파일을 -14 LUFS / -1 dBTP 기준으로 자동 마스터링하는 Electron 데스크톱 앱.

> WAV / FLAC / MP3 업로드 → AI 아티팩트 감지 → 스타일 프리셋 선택 → 자동 마스터링 → QC 체크 → 저장

---

## 목차

1. [사전 요구 사항](#사전-요구-사항)
2. [설치](#설치)
3. [개발 실행](#개발-실행)
4. [빌드 및 패키징](#빌드-및-패키징)
5. [환경 변수](#환경-변수)
6. [프로젝트 구조](#프로젝트-구조)
7. [구현 상태](#구현-상태)
8. [에러 로그 위치](#에러-로그-위치)

---

## 사전 요구 사항

| 도구 | 최소 버전 | 확인 명령어 |
|------|-----------|-------------|
| Node.js | 20.x | `node --version` |
| pnpm | 9.x | `pnpm --version` |
| Python | 3.10+ | `python3 --version` |
| FFmpeg | 4.4+ | `ffmpeg -version` |
| FFprobe | FFmpeg 포함 | `ffprobe -version` |

### FFmpeg 설치

**macOS**
```bash
brew install ffmpeg
# 확인
ffmpeg -version | head -1
ffprobe -version | head -1
```

**Ubuntu / Debian**
```bash
sudo apt update && sudo apt install -y ffmpeg
```

**Windows**
1. https://www.gyan.dev/ffmpeg/builds/ 에서 `ffmpeg-release-essentials.zip` 다운로드
2. 압축 해제 후 `bin/` 폴더를 시스템 PATH에 추가
3. 새 PowerShell에서 `ffmpeg -version` 확인

---

## 설치

```bash
# 1. 저장소 클론
git clone <repo-url>
cd aimaster-desktop

# 2. Node.js 의존성 설치 (루트에서 실행 — pnpm workspaces가 모든 패키지 처리)
pnpm install

# 3. Python 가상환경 생성 및 의존성 설치
./setup-python.sh

# 완료 후 표시된 export 명령어를 복사해 셸에 적용
# 예: export AIMASTER_PYTHON='/path/to/.venv/bin/python'
```

**setup-python.sh가 실패하는 경우 — 수동 설치:**
```bash
python3 -m venv services/python-audio/.venv
source services/python-audio/.venv/bin/activate
pip install -r services/python-audio/requirements.txt
deactivate
export AIMASTER_PYTHON="$(pwd)/services/python-audio/.venv/bin/python"
```

---

## 개발 실행

> **주의:** `AIMASTER_PYTHON` 환경 변수가 설정되어 있어야 Python 오디오 엔진이 실행됩니다.

```bash
# 한 번에 실행 (권장)
export AIMASTER_PYTHON="$(pwd)/services/python-audio/.venv/bin/python"
pnpm desktop
# 또는
pnpm --filter @aimaster/desktop dev
```

내부적으로 `concurrently`가 두 프로세스를 동시에 실행합니다:
- **RENDERER**: `vite` — http://localhost:5173 에서 React 렌더러 서빙
- **MAIN**: `node esbuild.main.cjs --dev` → `wait-on http://localhost:5173` → `electron dist/main/index.js`

Electron DevTools는 개발 모드에서 자동으로 열립니다.

### 각 프로세스를 분리해서 실행 (디버깅용)

```bash
# 터미널 1: Renderer Vite dev server
cd apps/desktop
pnpm dev:renderer
# → "Local: http://localhost:5173/" 출력 확인 후 터미널 2 실행

# 터미널 2: Main process
cd apps/desktop
export AIMASTER_PYTHON="/absolute/path/.venv/bin/python"
pnpm dev:main
```

### Python 엔진만 단독 테스트

```bash
# 엔진 단독 실행 (stdin에 JSON-RPC 요청을 수동으로 보낼 수 있음)
source services/python-audio/.venv/bin/activate
cd services/python-audio
python -m app.main
# stderr에 "READY" 출력되면 정상
# Ctrl+D로 종료
```

---

## 빌드 및 패키징

```bash
# 1. 전체 빌드
cd apps/desktop
pnpm build

# 생성 파일:
#   dist/renderer/   — Vite로 번들된 React 앱
#   dist/main/       — esbuild로 번들된 Electron main (단일 CJS, @aimaster/* 패키지 인라인)
#   dist/preload/    — esbuild로 번들된 preload 스크립트

# 2. 배포 패키지 생성 (electron-builder)
pnpm dist

# 결과물: apps/desktop/out/
#   macOS  → AIMASTER-x.x.x.dmg (arm64 + x64 universal)
#   Windows → AIMASTER Setup x.x.x.exe (NSIS)
#   Linux  → AIMASTER-x.x.x.AppImage
```

**빌드 전 타입 체크:**
```bash
cd apps/desktop
pnpm typecheck
```

---

## 환경 변수

| 변수 | 설명 | 기본값 |
|------|------|--------|
| `AIMASTER_PYTHON` | Python 인터프리터 절대 경로 | `python3` (PATH에서 탐색) |
| `LICENSE_HMAC_SECRET` | 라이선스 HMAC 서명 비밀키 (프로덕션 시 교체 필수) | `aimaster-local-secret-v1` |

---

## 프로젝트 구조

```
aimaster-desktop/
├── apps/desktop/               — Electron 앱
│   ├── esbuild.main.cjs        — Main + Preload 번들러 (빌드 시 모두 처리)
│   ├── electron-builder.yml    — 패키지 설정
│   ├── public/
│   │   └── entitlements.mac.plist  — macOS 하드닝 런타임 권한
│   └── src/
│       ├── main/               — Electron main process (Node.js)
│       │   ├── index.ts        — BrowserWindow 생성, IPC 등록
│       │   ├── ipc/            — audioHandlers, licenseHandlers, fileHandlers, settingsHandlers
│       │   └── utils/logger.ts — 파일 + stdout 이중 로거
│       ├── preload/index.ts    — contextBridge (electronAPI 노출)
│       └── renderer/           — React 18 UI (Vite + Tailwind)
│           ├── pages/          — HomePage, AnalysisPage, MasteringPage, ResultPage, QCPage, SettingsPage
│           └── stores/         — audioStore, licenseStore, appStore (Zustand)
├── packages/
│   ├── audio-engine/           — FFmpeg 래퍼, PythonBridge, AppError 10종
│   ├── license-core/           — LicenseService (HMAC 검증, free/pro 게이트)
│   └── shared-types/           — TypeScript 공유 인터페이스
├── services/python-audio/      — Python 오디오 엔진 (JSON-RPC over stdin/stdout)
│   ├── app/main.py             — JSON-RPC 디스패처 (analyze / master / qc_check)
│   ├── app/analyzers/          — ffprobe + soundfile 파형 분석
│   ├── app/mastering/          — 6단계 파이프라인 (EQ → 다이내믹스 → loudnorm 2-pass)
│   └── app/utils/
│       ├── ffmpeg_wrapper.py   — FFmpeg / FFprobe 래퍼 (loudnorm 파싱 포함)
│       └── logger.py           — stderr 구조화 로거
├── setup-python.sh             — Python 환경 자동 설정 스크립트
└── docs/
    ├── ARCHITECTURE.md
    ├── LICENSE_FLOW.md
    ├── MASTERING_SPEC.md
    ├── QA_CHECKLIST.md         — 수동 QA 체크리스트 (기능별 확인 방법)
    └── TEST_SCENARIOS.md       — E2E 테스트 시나리오 5개
```

---

## 구현 상태

> 이 표는 v3.2 시점 기준으로 작성되어 한동안 갱신되지 않았습니다.
> 아래 "모듈 스위트" 절이 현재 상태이며, 표에서 미구현으로 적힌 자동
> 업데이트 / 배치 저장 / 앱 아이콘은 이후 구현되었습니다.

### 🎛 모듈 스위트 (전체 목록 → `docs/redesign/loui-mastering-v2/module-suite/`)

체인은 20개 모듈이며, **실시간 프리뷰와 오프라인 익스포트가 동일한 Rust
엔진**(`dsp-core/crates/loui-dsp`)을 사용합니다. 설정은 하나의
`ChainConfigWire` 객체로 양쪽에 전달되므로 미리듣기와 결과물이 갈라지지
않습니다.

| 단계 | 모듈 |
|---|---|
| 복원 | De-click · De-hum · De-noise · De-esser |
| 보정 | Parametric EQ · Match EQ · Spectral Shaper · Stabilizer |
| 톤 | Vintage EQ · EQ · Dynamic EQ |
| 다이내믹스 | Multiband · Glue Comp · Vintage Comp · Impact · Low End Focus |
| 캐릭터 | Exciter · Tape |
| 출력 | Imager · Limiter / Maximizer |

- 모든 모듈은 중립 설정에서 **비트 단위로 투명**합니다 — 크로스오버조차
  타지 않으므로 CPU도 지연도 0입니다.
- STFT 기반 모듈(De-noise, 스펙트럴 3종)만 지연을 만들며, 그 값은 랙 하단에
  ms 단위로 표시됩니다.
- 리미터 실링 클램프는 어떤 설정에서도 무조건 적용됩니다.

**UI**: 홈 큐의 "스튜디오" 버튼 → 좌측 시그널 체인 랙, 우측 선택 모듈 패널.

```bash
# Rust DSP 테스트 (151개)
cd dsp-core && cargo test -p loui-dsp --release

# Rust를 수정했다면 WASM 3개 타깃을 반드시 다시 빌드 (아티팩트가 커밋되어 있음)
#   사전 준비: rustup target add wasm32-unknown-unknown
#             cargo install wasm-bindgen-cli --version 0.2.127
pnpm --filter @loui/dsp-wasm run build:all

# 데스크톱 셀프테스트 (122개 — 29개는 실제 WASM 엔진을 통과시켜 오디오를 측정)
pnpm --filter @aimaster/desktop test
```

### ✅ 완전히 동작하는 기능

| 기능 | 확인 방법 |
|------|-----------|
| 파일 드롭 / 파일 탐색기 열기 | HomePage에 WAV/FLAC/MP3 드롭 또는 버튼 클릭 |
| ffprobe 메타데이터 분석 | AnalysisPage에 샘플레이트·비트뎁스·채널·길이·파일크기 표시 |
| Integrated LUFS 측정 | AnalysisPage 라우드니스 카드 (QC 뱃지 포함) |
| True Peak 측정 | AnalysisPage 라우드니스 카드 |
| Loudness Range (LRA) 측정 | AnalysisPage 라우드니스 카드 |
| 묵음 구간 감지 | AnalysisPage 묵음 카드 (500ms 초과 시 표시) |
| AI 아티팩트 감지 | harshHighMid / boomyLowEnd / brickwall / 기타 6종 |
| 스타일 프리셋 선택 | AnalysisPage 프리셋 그리드 (Balanced / Warm / Bright / Punch) |
| 6단계 마스터링 파이프라인 | MasteringPage 진행률 + 단계 표시 |
| 2-pass loudnorm (-14 LUFS / -1 dBTP) | Python `ffmpeg_wrapper.py` |
| MP3 프리뷰 생성 (320kbps) | ResultPage 오디오 플레이어 |
| Before/After 라우드니스 비교 | ResultPage 비교 테이블 |
| MP3 저장 (파일 대화상자) | ResultPage "프리뷰 MP3 저장" 버튼 |
| WAV 저장 — Pro 전용 잠금 | ResultPage "마스터 WAV 저장" (Pro 시 활성화) |
| 무료 3회 체험 카운터 | 처리 완료마다 자동 차감, 소진 시 라이선스 모달 |
| 라이선스 키 활성화 (형식 검증) | SettingsPage 또는 잠금 모달 |
| HMAC-SHA256 위변조 감지 | 라이선스·트라이얼 레코드 서명 검증 |
| 10종 구조화 에러 처리 | 각 에러코드별 한국어 메시지 + 복구 버튼 |
| 에러 로그 파일 저장 | 날짜별 로그 파일 자동 생성 |
| QC 리포트 | QCPage 항목별 pass/warn/fail + 플랫폼 비교 |
| 출력 디렉토리 / 오디오 기본값 설정 | SettingsPage |
| 진행 중 에러 → 재시도 | MasteringPage ErrorCard + recoverable 분기 |

### ⚠️ 동작하지만 제한 있음

| 기능 | 제한 |
|------|------|
| AI 아티팩트 감지 정확도 | FFT 에너지 비율 기반 — 훈련된 ML 모델 대비 오탐 가능성 있음 |
| DC 오프셋 | 감지 후 경고만 표시, HPF 자동 제거 미구현 |
| 스테레오 이미징 | 불균형 감지는 되나 M/S 처리 없음 |

### ❌ 미구현 기능

| 기능 | 비고 |
|------|------|
| 서버 라이선스 검증 | `LocalValidator` (포맷 체크만) → `RemoteValidator`로 교체 필요 |
| 최근 파일 목록 | `file:get-recent` 핸들러가 `[]` 반환하는 스텁 |

---

## 에러 로그 위치

### Electron 메인 프로세스 로그 (날짜별)

```
macOS:   ~/Library/Application Support/AIMASTER/logs/YYYY-MM-DD.log
Linux:   ~/.config/AIMASTER/logs/YYYY-MM-DD.log
Windows: %APPDATA%\AIMASTER\logs\YYYY-MM-DD.log
```

앱 내에서 열기: **Settings → 정보 → 로그 폴더 열기**

```bash
# macOS 실시간 모니터링
tail -f ~/Library/Application\ Support/AIMASTER/logs/$(date +%Y-%m-%d).log

# 에러만 필터
grep '\[ERROR\]' ~/Library/Application\ Support/AIMASTER/logs/$(date +%Y-%m-%d).log

# Python 엔진 로그만 필터
grep '\[python\]' ~/Library/Application\ Support/AIMASTER/logs/$(date +%Y-%m-%d).log
```

### 개발 모드 실시간 로그

개발 모드에서는 stdout에도 동시 출력됩니다:

```bash
pnpm desktop 2>&1 | grep -E '\[ERROR\]|\[WARN\]|\[python\]'
```

### 로그 포맷

```
[2025-01-15T03:42:17.123Z] [INFO]  FFmpeg status {"available":true,"version":"6.1","ffprobeAvailable":true}
[2025-01-15T03:42:18.456Z] [INFO]  [python] AIMASTER Python audio engine started
[2025-01-15T03:42:19.789Z] [INFO]  [python] → analyze [a1b2c3d4]
[2025-01-15T03:42:20.001Z] [ERROR] [audio:master] error {"filePath":"/path/file.wav","err":"...","bridgeDied":false}
```
