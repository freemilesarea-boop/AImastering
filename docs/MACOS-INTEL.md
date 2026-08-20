# Louver Mastering AI v3.6.0 — 인텔 맥(Intel Mac) 빌드

이 릴리스는 **Intel(x86_64) 맥 전용** 빌드입니다.
DAW 기능이 들어가기 전, 마스터링/믹스까지만 있던 **v3.6.0 시점 그대로**입니다.

---

## 다운로드

| 파일 | 용도 |
|---|---|
| `Louver Mastering AI-3.6.0-x64.dmg` | 일반 설치용 (권장) — 열어서 Applications 로 드래그 |
| `Louver Mastering AI-3.6.0-mac-x64.zip` | 압축 해제 후 바로 실행 |

Apple Silicon(M1/M2/M3/M4) 맥을 쓰신다면 이 파일이 아니라 일반 릴리스의
`arm64` 빌드를 받으세요.

내 맥이 어느 쪽인지 모르겠다면 터미널에서:

```bash
uname -m
```

- `x86_64` → **이 릴리스(Intel)**
- `arm64` → Apple Silicon 빌드

---

## 설치 후 첫 실행 (중요)

이 앱은 아직 Apple 공증(notarization)을 받지 않았습니다. 인터넷에서 받은
파일에는 macOS 가 격리(quarantine) 표시를 붙이기 때문에, 그냥 더블클릭하면
**"손상되었기 때문에 열 수 없습니다"** 또는 **"확인되지 않은 개발자"** 경고가
나올 수 있습니다. 앱에 문제가 있어서가 아니라 서명이 없어서 뜨는 경고입니다.

Applications 로 옮긴 뒤 터미널에서 한 번만 실행하세요:

```bash
xattr -dr com.apple.quarantine "/Applications/Louver Mastering AI.app"
```

그 다음부터는 평소처럼 더블클릭으로 실행됩니다.

(터미널을 쓰고 싶지 않다면: Finder 에서 앱을 **우클릭 → 열기 → 열기**.
처음 한 번만 이렇게 열면 이후에는 그냥 열립니다.)

---

## v3.6.0 인텔 빌드가 실행되지 않던 이유

기존 v3.6.0 의 Intel 빌드는 Finder 에서 `종류: 응용 프로그램(Intel)` 로
표시되는데도 인텔 맥에서 실행되지 않았습니다. 원인은 Electron 본체가 아니라
**같이 들어가는 보조 실행 파일들**이었습니다.

CI 의 macOS 잡이 `macos-14`(Apple Silicon) 러너에서 돌면서
`electron-builder --mac dmg zip --x64 --arm64` 로 **두 아키텍처를 한 번에**
패키징했습니다. electron-builder 는 아키텍처별로 Electron 셸은 바꿔 넣지만,
`extraResources` 는 아키텍처를 구분하지 않고 그대로 복사합니다. 그런데 그
안에 들어가는 세 개의 바이너리는 전부 **러너에서 만들어진 arm64** 였습니다.

| 파일 | 출처 | 실제 아키텍처 |
|---|---|---|
| `Resources/bin/engine` | PyInstaller (러너에서 빌드) | arm64 |
| `Resources/bin/ffmpeg` | `require('ffmpeg-static')` | arm64 |
| `Resources/bin/ffprobe` | `@ffprobe-installer/ffprobe` | arm64 |

즉 **x64 셸 + arm64 내용물** 인 앱이 나온 겁니다. Rosetta 2 는 x64 를 arm64 로
번역해 주지만 그 반대는 불가능하므로, 인텔 맥에서는 저 셋 중 어느 것도 실행할
수 없습니다. 앱은 시작하자마자
`main/utils/ffmpegEnv.ts` → `Resources/bin/ffmpeg` 경로로 `checkFFmpeg()` 를
호출하는데 여기서 실패하면서 **창이 뜨기도 전에** 죽었습니다.

Finder 는 메인 실행 파일만 보기 때문에 `응용 프로그램(Intel)` 이라고 정직하게
표시했고, 그래서 실제 인텔 맥에서 켜보기 전까지는 아무 이상이 없어 보였습니다.

## 어떻게 고쳤나

가장 단순한 해법은 인텔 러너에서 빌드하는 것이지만, **무료 인텔 러너가
없어졌습니다.** 마지막 무료 GitHub 호스티드 인텔 이미지였던 `macos-13` 은
은퇴했고(요청하면 실패도 안 하고 큐에 영원히 남습니다), 남은 x86_64 macOS
라벨(`macos-15-intel`, `macos-26-intel`, `macos-*-large`)은 전부 유료
larger runner 입니다.

그래서 **무료 arm64 러너에서 크로스 빌드하되, 아키텍처가 걸린 조각을 전부
명시적으로 x86_64 로 조달**하도록 했습니다.

1. **아키텍처별 조각을 하나씩 x86_64 로 지정했습니다.**

   | 조각 | 어떻게 x86_64 를 얻나 |
   |---|---|
   | Electron 셸 | `--x64` 플래그만으로 electron-builder 가 darwin-x64 배포판을 직접 내려받음 (호스트와 무관) |
   | `ffmpeg` | `npm_config_arch=x64` — ffmpeg-static 의 install 스크립트가 `os.arch()` 보다 이 값을 먼저 읽음 |
   | `ffprobe` | `@ffprobe-installer/darwin-x64` 를 pnpm-lock 이 고정한 버전 그대로 직접 설치 |
   | `engine` | PyInstaller 는 크로스 컴파일이 안 되므로, uv 로 진짜 x86_64 CPython 3.11 을 받아 Rosetta 2 위에서 freeze |

   기존 `build.yml` 의 mac 잡은 `--arm64` 전용이 되어 더 이상 깨진 Intel
   산출물을 만들지 않습니다.

2. **전제를 먼저 확인합니다.**
   Rosetta 2 로 x86_64 실행이 되는지, uv 가 준 인터프리터가 정말 x86_64
   인지(`platform.machine()`), 받아온 ffmpeg/ffprobe 가 x86_64 인지를
   각각 확인하고 아니면 즉시 중단합니다.

3. **번들 전체를 검사하는 게이트를 넣었습니다.**
   `scripts/verify-mac-arch.cjs` 가 패키징된 `.app` 안의 **모든** Mach-O
   파일(Electron 셸, 헬퍼, 프레임워크, 그리고 `Resources/bin` 의 보조
   바이너리)을 `lipo` 로 확인해서, x86_64 슬라이스가 없는 파일이 하나라도
   있거나 보조 바이너리가 빠져 있으면 빌드를 실패시킵니다. 크로스 빌드가
   안전한 이유가 바로 이겁니다 — 위 조달 과정 중 하나라도 조용히 arm64 를
   내놓으면, 앱이 나가는 게 아니라 빌드가 빨갛게 실패합니다.

4. **ad-hoc 코드 서명을 추가했습니다.**
   `scripts/mac-adhoc-sign.cjs` (electron-builder `afterPack` 훅) 이 번들에
   ad-hoc 서명을 넣어, 서명이 아예 없을 때 뜨는 "손상되었습니다" 오류 대신
   사용자가 넘길 수 있는 "확인되지 않은 개발자" 안내가 뜨도록 했습니다.
   Apple 공증을 대체하지는 않으므로 위의 `xattr` 안내는 그대로 유효합니다.

---

## 이 빌드에 포함되지 않은 것

DAW 관련 작업(멀티트랙 편집, 피아노 롤, 스텝 시퀀서, 스펙트럴 리페어,
LOUI Intelligence Layer, Riff Machine 등 `d3abe69` 이후 커밋 전부)은
**포함되어 있지 않습니다.** 이 브랜치는 DAW 전환 직전 커밋인
`407dc58` 에서 갈라져 나왔고, 위의 macOS Intel 빌드 수정만 얹혀 있습니다.

---

## 직접 빌드하려면

인텔 맥에서:

```bash
cd aimaster-desktop
pnpm install
cd apps/desktop
AIMASTER_TARGET_ARCH=x64 node scripts/prebuild.cjs   # ffmpeg/ffprobe 복사 + arch 검증
pnpm build
pnpm exec electron-builder --mac dmg zip --x64
node scripts/verify-mac-arch.cjs "out/mac/Louver Mastering AI.app" x64
```

`Resources/bin/engine` (Python 엔진)은 별도로 PyInstaller 로 만들어
`apps/desktop/public/bin/engine` 에 두어야 합니다 — 명령은
`.github/workflows/build-mac-intel.yml` 의 *Build Python engine* 스텝과
동일합니다.

Apple Silicon 맥에서 빌드한다면 `FFMPEG_BINARY` / `FFPROBE_BINARY` 로 x86_64
바이너리를 직접 지정해야 합니다. 그냥 `--x64` 만 주면 `prebuild.cjs` 가
아키텍처 불일치를 잡아내고 빌드를 세웁니다 — 의도된 동작입니다.
