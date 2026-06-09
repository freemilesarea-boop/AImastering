# Louver Mastering AI — 배포 빌드 가이드

## 번들 구조

배포 패키지에 포함되는 내용:

```
Resources/
  bin/
    engine          ← Python 오디오 엔진 (PyInstaller 빌드, 인터프리터 내장)
    ffmpeg          ← FFmpeg 정적 바이너리 (libmp3lame 포함)
    ffprobe         ← FFprobe 정적 바이너리
  app.asar          ← Electron 렌더러 + 메인 프로세스 JS
```

Python 인터프리터, numpy, soundfile, FFmpeg 모두 내장 — 사용자 별도 설치 불필요.

---

## macOS 빌드 (.dmg)

### 환경 요구사항
| 항목 | 버전 |
|---|---|
| OS | macOS 12 Monterey 이상 |
| Xcode CLT | `xcode-select --install` |
| Node.js | ≥ 20 (`brew install node`) |
| pnpm | ≥ 9 (`npm i -g pnpm`) |
| Python | ≥ 3.10 (`brew install python@3.11`) |

### 빌드 명령

```bash
cd aimaster-desktop/apps/desktop
pnpm dist:mac
```

### 출력물

```
apps/desktop/out/
  Louver Mastering AI-1.0.0-arm64.dmg   # Apple Silicon (M1/M2/M3)
  Louver Mastering AI-1.0.0-x64.dmg     # Intel Mac
```

### 배포
1. `arm64.dmg` 파일 → Apple Silicon Mac 사용자에게 배포
2. `x64.dmg` 파일 → Intel Mac 사용자에게 배포
3. **공증(notarization)**이 필요한 경우 Apple Developer 계정 설정 필요

---

## Windows 빌드 (.exe 설치형)

### 환경 요구사항
| 항목 | 버전 |
|---|---|
| OS | Windows 10 / 11 (x64) |
| Node.js | ≥ 20 (https://nodejs.org) |
| pnpm | ≥ 9 (`npm i -g pnpm`) |
| Python | ≥ 3.10 (https://www.python.org/downloads/) |

### 빌드 명령

```bat
cd aimaster-desktop\apps\desktop
pnpm dist:win
```

### 출력물

```
apps\desktop\out\
  Louver Mastering AI Setup 1.0.0.exe   # NSIS 설치형 인스톨러
```

### 배포
`Setup.exe` 하나를 Windows 사용자에게 배포하면 됩니다.
설치 후 시작 메뉴와 바탕화면 단축키가 자동 생성됩니다.

---

## 사용자 실행 가이드

```
1. 다운로드
   Mac: .dmg 파일 다운로드 → 열기 → 앱을 Applications 폴더로 드래그
   Win: Setup.exe 다운로드 → 실행 → 설치 완료

2. 실행
   Mac: Applications → Louver Mastering AI 더블클릭
   Win: 시작 메뉴 또는 바탕화면 단축키 클릭

3. 사용
   파일 추가 (드래그 앤 드롭 또는 클릭) → 스타일 선택 → 마스터링 시작 → 저장
```

---

## 아이콘 교체 (브랜딩)

현재 `apps/desktop/public/icon.png`는 플레이스홀더(단색 배경)입니다.
실제 배포 전에 브랜드 아이콘으로 교체하세요:

```bash
# 1024×1024 PNG를 준비한 후 덮어쓰기
cp 실제아이콘.png apps/desktop/public/icon.png

# electron-builder가 빌드 시 자동으로 .icns / .ico 변환
```

---

## 빌드 단계 상세 설명

| 단계 | 설명 |
|---|---|
| **1. Python 가상환경** | `soundfile`, `numpy` 설치, `pyinstaller` 설치 |
| **2. PyInstaller** | Python 엔진 → 단일 실행 파일 (`engine` / `engine.exe`) |
| **3. FFmpeg 복사** | npm 패키지에서 플랫폼별 바이너리 → `public/bin/` |
| **4. pnpm install** | Node 의존성 설치 |
| **5. pnpm build** | Vite (렌더러) + esbuild (메인 프로세스) 빌드 |
| **6. electron-builder** | `.dmg` / `.exe` 패키징 |

---

## 트러블슈팅

### "engine binary not found" 오류
→ `apps/desktop/public/bin/engine` (Mac) 또는 `engine.exe` (Win)이 없습니다.  
→ PyInstaller 단계를 다시 실행하세요.

### "ffmpeg not found" 오류
→ `public/bin/ffmpeg`가 없습니다.  
→ `cd apps/desktop && node scripts/prebuild.cjs`를 실행하세요.

### Mac "앱이 손상되었습니다" 메시지
→ Gatekeeper 경고입니다. Terminal에서:  
```bash
xattr -cr "/Applications/Louver Mastering AI.app"
```

### Windows Defender 경고
→ PyInstaller 바이너리가 안티바이러스에 걸릴 수 있습니다.  
→ 코드 서명 인증서(Code Signing Certificate) 적용으로 해결됩니다.
