# Architecture

AIMASTER Desktop의 전체 구조, 각 레이어의 역할, 모듈 구성, 데이터 흐름을 기술합니다.

---

## 목차

1. [전체 구조 개요](#전체-구조-개요)
2. [레이어별 역할](#레이어별-역할)
3. [모노레포 레이아웃](#모노레포-레이아웃)
4. [모듈 상세](#모듈-상세)
5. [데이터 흐름](#데이터-흐름)
6. [IPC 채널 명세](#ipc-채널-명세)
7. [Python JSON-RPC 프로토콜](#python-json-rpc-프로토콜)
8. [보안 경계](#보안-경계)
9. [에러 흐름](#에러-흐름)

---

## 전체 구조 개요

```
┌──────────────────────────────────────────────────────────────┐
│                       Electron 앱                            │
│                                                              │
│  ┌─────────────────┐          ┌──────────────────────────┐  │
│  │   Renderer      │  IPC     │      Main Process        │  │
│  │  (React + TS)   │◄────────►│   (Node.js + Electron)   │  │
│  │                 │  (안전)  │                          │  │
│  │  Zustand 상태   │          │  IPC 핸들러               │  │
│  │  Tailwind UI    │          │  audio-engine (Node)     │  │
│  │  HTML5 오디오   │          │  license-core            │  │
│  └─────────────────┘          │  electron-store          │  │
│          ▲                    └──────────┬───────────────┘  │
│          │  contextBridge                │ JSON-RPC         │
│          │  (화이트리스트 IPC)           │ stdin/stdout     │
│          └─── Preload 스크립트 ──────────┘                  │
│                                          │                  │
└──────────────────────────────────────────┼──────────────────┘
                                           │
                         ┌─────────────────▼──────────────┐
                         │       Python 오디오 서비스       │
                         │   services/python-audio/         │
                         │                                  │
                         │   JSON-RPC 디스패처 (main.py)    │
                         │   분석기 (ffprobe + numpy + fft) │
                         │   마스터링 파이프라인 (FFmpeg)   │
                         │   QC 체커                        │
                         └────────────────────────────────--┘
```

---

## 레이어별 역할

### Renderer (React + TypeScript)

**담당**: 사용자 인터페이스와 상태 관리

- **할 수 있는 것**: DOM 조작, 이벤트 처리, Zustand 상태 읽기/쓰기, `window.electronAPI` 호출
- **할 수 없는 것**: 파일시스템 직접 접근, Node.js API 사용, native 모듈 로드

렌더러는 보안 격리된 환경(sandbox)에서 실행됩니다.
`window.electronAPI` 를 통해서만 main 프로세스와 통신합니다.

### Preload 스크립트

**담당**: 렌더러와 main 프로세스 사이의 **안전한 브릿지**

```typescript
// 화이트리스트에 없는 채널은 자동 차단
contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel, ...args) => {
    if (!INVOKE_CHANNELS.includes(channel)) throw new Error('Blocked');
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel, listener) => {
    if (!LISTEN_CHANNELS.includes(channel)) throw new Error('Blocked');
    // ...
  },
});
```

렌더러는 허용된 채널 목록(`INVOKE_CHANNELS`, `LISTEN_CHANNELS`) 외의 IPC를 호출할 수 없습니다.

### Main Process (Node.js + Electron)

**담당**: 시스템 리소스 접근, 비즈니스 로직, Python 서비스 관리

- 파일 다이얼로그, 파일시스템 읽기/쓰기
- `audio-engine` 을 통한 Python 브릿지 관리
- `license-core` 를 통한 라이선스 상태 관리
- `electron-store` 로 암호화된 설정/라이선스 저장
- 임시 파일 생성 및 정리

### audio-engine 패키지

**담당**: Node.js ↔ Python 브릿지 + FFmpeg 유틸리티

- `PythonBridge`: Python 프로세스를 spawn하고 JSON-RPC로 통신하는 클래스
- `analyzeFile`, `masterFile`, `runQC`: 고수준 API (bridge를 감싸는 함수)
- `FFmpegRunner`: 시스템 FFmpeg 바이너리를 직접 호출하는 함수들 (분리된 빠른 경로)
- `AppError`: 10가지 에러 코드를 가진 구조화된 에러 타입

### license-core 패키지

**담당**: 라이선스 검증 및 트라이얼 관리

main 프로세스에서만 사용됩니다. 렌더러는 IPC를 통해 간접 접근합니다.

### Python 오디오 서비스

**담당**: 실제 오디오 처리 (FFmpeg 파이프라인 실행, 파형 분석)

- `main.py`: JSON-RPC 요청을 수신하고 적절한 핸들러로 라우팅
- `analyzers/`: FFprobe + numpy FFT 분석
- `mastering/`: EQ, 다이나믹스, loudnorm 2-pass 파이프라인
- `qc/`: QC 체크 (12개 항목)
- `utils/ffmpeg_wrapper.py`: FFmpeg subprocess 래퍼

---

## 모노레포 레이아웃

```
aimaster-desktop/
│
├── apps/
│   └── desktop/                         # @aimaster/desktop
│       ├── src/
│       │   ├── main/                    # Electron main process (Node.js)
│       │   │   ├── index.ts             # BrowserWindow 생성, 앱 수명 주기
│       │   │   ├── ipc/
│       │   │   │   ├── audioHandlers.ts # audio:* 채널 — PythonBridge 호출
│       │   │   │   ├── licenseHandlers.ts # license:* 채널 — LicenseService
│       │   │   │   ├── fileHandlers.ts  # file:* 채널 — 파일 다이얼로그/복사
│       │   │   │   └── settingsHandlers.ts # settings:* 채널
│       │   │   └── utils/
│       │   │       └── logger.ts        # 파일 + 콘솔 로거
│       │   ├── preload/
│       │   │   └── index.ts             # contextBridge 화이트리스트
│       │   └── renderer/                # React SPA
│       │       ├── App.tsx              # 루트, 페이지 라우터 (단순 Record 맵)
│       │       ├── pages/
│       │       │   ├── HomePage.tsx     # 파일 업로드 (react-dropzone)
│       │       │   ├── AnalysisPage.tsx # 분석 결과 + 스타일 선택
│       │       │   ├── MasteringPage.tsx # 진행 상황 + 에러 카드
│       │       │   ├── ResultPage.tsx   # 비교 + 플레이어 + 저장
│       │       │   ├── QCPage.tsx       # QC 상세
│       │       │   └── SettingsPage.tsx # 설정
│       │       ├── stores/
│       │       │   ├── appStore.ts      # 현재 페이지, 토스트 알림
│       │       │   ├── audioStore.ts    # 파일/분석/마스터링 상태 + StructuredError
│       │       │   └── licenseStore.ts  # 라이선스 상태 (IPC 미러)
│       │       └── components/
│       │           ├── TopBar.tsx       # 드래그 영역, 라이선스 뱃지
│       │           └── LicenseModal.tsx # 키 입력 모달
│       ├── electron-builder.yml         # 패키징 설정
│       ├── vite.config.ts               # Vite (렌더러 빌드)
│       └── tailwind.config.js           # Tailwind CSS 설정
│
├── packages/
│   ├── audio-engine/                    # @aimaster/audio-engine
│   │   └── src/
│   │       ├── errors.ts                # AppError 클래스, 10개 에러 코드
│   │       ├── utils/
│   │       │   └── pythonBridge.ts      # PythonBridge (EventEmitter + JSON-RPC)
│   │       ├── analyzers/index.ts       # analyzeFile() 고수준 API
│   │       ├── mastering/index.ts       # masterFile() 고수준 API
│   │       ├── qc/index.ts              # runQC() 고수준 API
│   │       ├── ffmpeg/
│   │       │   ├── resolver.ts          # OS별 바이너리 경로 탐색
│   │       │   ├── runner.ts            # FFmpeg/FFprobe subprocess 실행
│   │       │   └── check.ts             # 시작 시 FFmpeg 상태 확인
│   │       └── index.ts                 # 패키지 공개 API
│   │
│   ├── license-core/                    # @aimaster/license-core
│   │   └── src/index.ts                 # LicenseService, LocalValidator, HMAC
│   │
│   └── shared-types/                    # @aimaster/shared-types
│       └── src/index.ts                 # AudioAnalysisResult, MasteringResult, etc.
│
├── services/
│   └── python-audio/                    # Python 오디오 서비스 (JSON-RPC 서버)
│       ├── app/
│       │   ├── main.py                  # JSON-RPC 디스패처 (stdin/stdout)
│       │   ├── analyzers/analyzer.py    # 입력 분석
│       │   ├── mastering/
│       │   │   ├── pipeline.py          # 6단계 파이프라인 오케스트레이터
│       │   │   ├── eq.py                # 스타일별 EQ 필터 체인
│       │   │   └── dynamics.py          # acompressor 파라미터
│       │   ├── qc/qc_checker.py         # QC 체크 (12항목)
│       │   └── utils/
│       │       ├── ffmpeg_wrapper.py    # FFmpeg/FFprobe subprocess 래퍼
│       │       ├── audio_io.py          # soundfile + numpy 파형 분석
│       │       └── logger.py            # stderr 전용 로거
│       └── requirements.txt
│
└── scripts/
    └── setup-python.sh                  # venv 생성 + pip install
```

---

## 모듈 상세

### `PythonBridge` (audio-engine/src/utils/pythonBridge.ts)

Python 프로세스와 통신하는 핵심 클래스입니다.

```
Node.js (PythonBridge)                     Python (main.py)
       │                                         │
       │──── spawn(python3, main.py) ────────────►│
       │                                         │ (대기)
       │──── JSON-RPC 요청 (stdin) ─────────────►│
       │     {"id":"uuid","method":"analyze",    │
       │      "params":{"file_path":"..."}}       │
       │                                         │ 처리 중...
       │                                         │──── progress 이벤트 ────►
       │◄──── stdout (progress 라인) ────────────│
       │      {"type":"progress","percent":50}    │
       │                                         │ 완료
       │◄──── stdout (response 라인) ────────────│
       │      {"id":"uuid","result":{...}}        │
```

- 각 요청은 UUID로 식별되며 Promise로 래핑됩니다
- `progress` 이벤트는 `result` 와 별개 라인으로 수신
- Python 프로세스는 앱 수명 동안 재사용됩니다 (lazy init, 오류 시 재시작)

### `AppError` (audio-engine/src/errors.ts)

10가지 에러 코드를 가진 구조화된 에러 타입입니다.

```typescript
class AppError extends Error {
  code:        AppErrorCode;   // 'FFMPEG_NOT_FOUND' | 'FILE_CORRUPTED' | ...
  userMessage: string;         // 한국어 (UI 표시용)
  devDetail:   string;         // 영어 (로그 기록용)
  recoverable: boolean;        // true → 재시도 버튼 표시
}
```

에러는 main 프로세스에서 `toJSON()` 으로 직렬화되어 IPC를 통해 renderer로 전달되고,
renderer에서 `toStructuredError()` 로 역직렬화됩니다.

### `LicenseService` (license-core/src/index.ts)

```typescript
class LicenseService {
  getLicenseState():   LicenseInfo          // 현재 상태 조회
  activateLicense(key): Promise<LicenseInfo> // 키 활성화
  canProcess():        CanProcessResult     // 처리 가능 여부
  decrementTrialUsage(): void               // 트라이얼 소모
  getRemainingTrials(): number              // 남은 횟수
  deactivate():        LicenseInfo          // 라이선스 제거
}
```

생성자에 `LicenseValidator` 를 주입받아 v1(LocalValidator) → v2(RemoteValidator) 교체가 가능합니다.

---

## 데이터 흐름

### 1. 파일 업로드 → 분석

```
[Renderer] HomePage
  └─ 파일 드롭/선택 → audioStore.setFile(path)
  └─ window.electronAPI.invoke('audio:analyze', filePath)
         │
[Preload] 채널 화이트리스트 확인 → ipcRenderer.invoke
         │
[Main]    audioHandlers.ts
  └─ getBridge() → PythonBridge 인스턴스 (lazy init)
  └─ analyzeFile(bridge, filePath)
         │
[Python]  analyzers/analyzer.py
  └─ ffprobe_info(filePath)         → 포맷/스펙
  └─ loudnorm_pass1(filePath)       → 라우드니스 측정
  └─ analyze_waveform(filePath)     → 파형 통계
  └─ AI artifact detection (FFT)
  └─ 반환: AudioAnalysisResult (JSON)
         │
[Main]    결과 반환 → ipcMain.handle 완료
         │
[Renderer] audioStore.setAnalysis(result)
           setPage('analysis')
```

### 2. 마스터링 실행

```
[Renderer] AnalysisPage
  └─ 스타일 선택 → audioStore.setStyle(style)
  └─ "마스터링 시작" 클릭
  └─ window.electronAPI.on('audio:progress', callback) 리스너 등록
  └─ window.electronAPI.invoke('audio:master', filePath, '', options)
         │
[Main]    audioHandlers.ts
  ├─ licenseService.canProcess()         # 라이선스 게이트
  ├─ assertTmpWritable()                 # 쓰기 권한 확인
  └─ masterFile(bridge, filePath, wavTempPath, options)
         │
[Python]  mastering/pipeline.py (6단계)
  ├─ Stage 1: ffprobe + loudnorm pass-1
  ├─ Stage 2: 경고 수집
  ├─ Stage 3+4: EQ + 다이나믹스 필터 체인 구성
  ├─ Stage 5: loudnorm pass-2 (FFmpeg 실행)
  └─ Stage 6: 사후 검증 + MP3 프리뷰 생성
  └─ 진행 중: {"type":"progress","percent":N,"stage":"..."} 전송
         │
[Main]    progress → win.webContents.send('audio:progress', msg)
         │
[Renderer] audioStore.setProgress(percent, stage) → MasteringPage UI 업데이트
         │
[Main]    (완료 후)
  ├─ isPaid: WAV 경로 반환
  └─ !isPaid: WAV 삭제 → outputPath: '' 반환
  └─ licenseService.decrementTrialUsage()
         │
[Renderer] audioStore.setMasteringResult(result)
           setPage('result')
```

### 3. 저장 (ResultPage)

```
[Renderer] ResultPage → "WAV 저장" 클릭
  └─ window.electronAPI.invoke('file:save-wav', masteringResult.outputPath)
         │
[Main]    fileHandlers.ts
  └─ dialog.showSaveDialog(win, {...})   # OS 파일 저장 다이얼로그
  └─ fs.copyFileSync(srcPath, destPath) # 임시 파일 → 사용자 선택 위치 복사
  └─ destPath 반환
         │
[Renderer] notify('WAV 저장 완료', 'success')
```

---

## IPC 채널 명세

### Invoke 채널 (renderer → main, 응답 있음)

| 채널 | 파라미터 | 반환값 | 설명 |
|------|----------|--------|------|
| `audio:analyze` | `filePath: string` | `AudioAnalysisResult` | 파일 분석 |
| `audio:master` | `filePath, outputPath, options` | `MasteringResult` | 마스터링 |
| `audio:qc` | `filePath, targetLufs, targetTp` | `QCResult` | QC 체크 |
| `file:open-dialog` | — | `string \| null` | 파일 열기 다이얼로그 |
| `file:save-dialog` | `defaultName: string` | `string \| null` | 저장 경로 선택 |
| `file:save-wav` | `srcPath: string` | `string \| null` | 파일 복사 저장 |
| `file:get-info` | `filePath: string` | `{name, sizeBytes}` | 파일 정보 |
| `file:open-in-finder` | `filePath: string` | `void` | Finder/탐색기에서 열기 |
| `file:get-recent` | — | `string[]` | 최근 파일 (v1: 빈 배열) |
| `license:status` | — | `LicenseInfo` | 라이선스 상태 |
| `license:can-process` | — | `CanProcessResult` | 처리 가능 여부 |
| `license:get-remaining` | — | `number` | 남은 트라이얼 수 |
| `license:activate` | `key: string` | `LicenseInfo` | 키 활성화 |
| `license:deactivate` | — | `LicenseInfo` | 라이선스 제거 |
| `license:decrement-trial` | — | `void` | 트라이얼 소모 |
| `settings:get` | `key: string` | `unknown` | 설정 읽기 |
| `settings:set` | `key, value` | `void` | 설정 쓰기 |
| `settings:choose-output-dir` | — | `string \| null` | 출력 폴더 선택 |
| `system:ffmpeg-status` | — | `{ok, version}` | FFmpeg 상태 확인 |

### Listen 채널 (main → renderer, 단방향 스트림)

| 채널 | 페이로드 | 설명 |
|------|----------|------|
| `audio:progress` | `{percent: number, stage: string}` | 마스터링 진행 상황 |

---

## Python JSON-RPC 프로토콜

Python 서비스는 `stdin` 에서 한 줄씩 JSON을 읽고 `stdout` 으로 응답합니다.

### 요청 형식

```json
{
  "id": "uuid-v4",
  "method": "analyze | master | qc_check",
  "params": {
    "file_path": "/path/to/audio.wav",
    "...": "..."
  }
}
```

### 성공 응답

```json
{
  "id": "uuid-v4",
  "result": { "...": "..." }
}
```

### 에러 응답

```json
{
  "id": "uuid-v4",
  "error": {
    "code": -32000,
    "message": "파이프라인 처리 중 오류: ..."
  }
}
```

| JSON-RPC 코드 | 의미 |
|---------------|------|
| `-32700` | JSON 파싱 실패 |
| `-32601` | 알 수 없는 메서드 |
| `-32602` | 잘못된 파라미터 |
| `-32000` | 애플리케이션 에러 (파이프라인 실패 등) |

### 진행 상황 이벤트 (stdout, 응답과 별개)

```json
{
  "type": "progress",
  "jobId": "uuid-v4",
  "percent": 50,
  "stage": "라우드니스 정규화 중 (2/2)"
}
```

진행 이벤트는 JSON-RPC 응답 라인과 같은 stdout 스트림으로 전송되지만,
`"type": "progress"` 로 식별하여 `PythonBridge` 가 분리 처리합니다.

---

## 보안 경계

### 렌더러 격리

Electron의 `contextIsolation: true` 와 `sandbox: true` 를 통해
렌더러가 Node.js API에 직접 접근하지 못합니다.
`window.electronAPI` 만이 main 프로세스와의 유일한 통신 채널입니다.

### 채널 화이트리스트

Preload 스크립트에서 허용된 채널만 통과시킵니다.
렌더러가 임의의 IPC 채널을 호출하면 즉시 예외가 발생합니다.

```typescript
// 허용되지 않은 채널 호출 시
throw new Error(`Blocked IPC channel: ${channel}`);
```

### 파일 경로 안전성

FFmpeg와 Python subprocess 호출 시 모든 파일 경로는 `spawn(bin, args[])` 형태로 전달됩니다.
쉘 문자열 연결(`exec("ffmpeg -i " + filePath)`)을 절대 사용하지 않습니다.
이를 통해 경로에 공백, 한글, 특수문자가 포함되어도 안전합니다.

### 라이선스 데이터 보호

- `electron-store` AES-256-CBC 암호화로 저장 (at-rest)
- HMAC-SHA256으로 변조 감지 (integrity)
- `crypto.timingSafeEqual` 로 타이밍 공격 방지

---

## 에러 흐름

에러는 발생 지점에서 분류되어 구조화된 형태로 UI까지 전달됩니다.

```
[Python] FFmpegError("파일을 읽을 수 없습니다")
  │
  ▼ JSON-RPC error { code: -32000, message: "..." }
  │
[Node/audio-engine] PythonBridge → classifyFFmpegError()
  │                 또는 audioHandlers.toAppError()
  │
  ▼ AppError {
  │   code:        'FILE_CORRUPTED',
  │   userMessage: '오디오 파일을 읽을 수 없습니다...',
  │   devDetail:   'ffmpeg exit 1: Invalid data found...',
  │   recoverable: false
  │ }
  │
[Main] log.error('[audio:master] error', {...})
  │     IPC 핸들러에서 throw AppError
  │
  ▼ IPC serialization: AppError.toJSON()
  │
[Renderer] catch(err) → toStructuredError(err)
  │        audioStore.setError(structured)
  │
  ▼ MasteringPage
      ErrorCard {
        message: "오디오 파일을 읽을 수 없습니다..."
        hint:    "다른 파일로 시도하거나 파일을 다시 내보내주세요."
        [retry button: 숨김 — recoverable=false]
        code:    FILE_CORRUPTED (소형 텍스트)
      }
```

에러 코드 전체 목록: [packages/audio-engine/src/errors.ts](../packages/audio-engine/src/errors.ts)
