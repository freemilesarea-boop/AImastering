# Android 빌드 & 배포 가이드 (M4)

`apps/mobile`(Capacitor + Vite + React) Android 테스트 앱을 **로컬에서 빌드**하고
**APK 직접 설치** 또는 **Firebase App Distribution**으로 배포하는 절차.

> 범위: Android 테스트 앱 전용. iOS · 모바일 결제/계정 · 서버 기능 추가 · 데스크톱/
> python-audio 변경은 모두 범위 밖(건드리지 않음). M0(server) / M1(scaffold) /
> M3(flow) 구조는 그대로 유지.

핵심 사실:
- `android/` 네이티브 프로젝트는 **git에 커밋하지 않습니다**(`.gitignore`). `npx cap add
  android`로 **언제든 재생성**합니다. 따라서 CI/새 머신에서는 빌드 전에 항상 `cap add`가 필요.
- toolchain: **JDK 17**, Android Gradle Plugin **8.2.1**, Gradle **8.2.1**, `compileSdk 34`,
  `minSdk 22`, `applicationId com.louver.mastering.mobile`.
- 서버 주소/키는 빌드 시 **Vite env**로 주입: `VITE_MASTERING_API_URL`,
  `VITE_MASTERING_API_KEY`. (런타임 설정 화면에서 덮어쓰기도 가능)

---

## 1. 사전 준비 (로컬 머신)

1. **Node 20 + pnpm 9**
   ```bash
   corepack enable && corepack prepare pnpm@9.0.0 --activate
   node -v   # v20.x
   pnpm -v   # 9.x
   ```
2. **JDK 17** (Temurin 권장). `java -version` → 17.
3. **Android SDK** (Android Studio 설치가 가장 쉬움). 설치 후:
   - `ANDROID_HOME`(= `ANDROID_SDK_ROOT`) 환경변수 설정
     (예: macOS `~/Library/Android/sdk`, Linux `~/Android/Sdk`).
   - SDK Manager에서 **Android 34 Platform** + **Build-Tools 34.0.0** + **Platform-Tools** 설치.
   - `adb`, `sdkmanager`를 PATH에 추가.
4. **서버 env**: `apps/mobile/.env` 생성(`.env.example` 복사) 후 실제 값 입력
   ```bash
   cp apps/mobile/.env.example apps/mobile/.env
   # .env (gitignore 됨 — 커밋되지 않음)
   VITE_MASTERING_API_URL=https://your-app.onrender.com   # 반드시 https
   VITE_MASTERING_API_KEY=...                              # 서버에 키 설정 시
   ```
   > ⚠️ Android(targetSdk 34)는 **cleartext(http) 통신을 기본 차단**합니다. 서버는
   > 반드시 **HTTPS**여야 합니다(Render는 기본 https). 서버 CORS는 M0에서 이미 활성화됨.

---

## 2. Debug APK (서명 불필요 — 가장 빠른 실기 테스트)

```bash
# 1) 웹 자산 빌드 (env 주입)
pnpm --filter @aimaster/mobile build

# 2) android/ 생성(없으면) — 이미 있으면 생략 가능
cd apps/mobile
npx cap add android      # 최초 1회 (android/ 재생성)
npx cap sync android     # 웹 자산/플러그인 동기화

# 3) debug APK 빌드
cd android
./gradlew assembleDebug
# 결과: apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

설치:
```bash
# 실기기: 개발자 옵션 > USB 디버깅 ON, 케이블 연결
adb devices
adb install -r app/build/outputs/apk/debug/app-debug.apk

# 에뮬레이터: Android Studio에서 AVD 부팅 후 동일하게 adb install
# 또는 APK 파일을 기기로 전송해 파일 매니저로 직접 설치(사이드로드).
```

> debug APK는 디버그 키로 자동 서명되어 바로 설치/실행됩니다. 외부 배포(스토어/Play)에는
> 부적합하며, 사내/테스터 사이드로드·Firebase 용도로만 사용하세요.

---

## 3. Release Keystore 생성 (서명 배포용, 1회)

```bash
keytool -genkeypair -v \
  -keystore louver-mastering-release.jks \
  -alias louver-mastering \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass '＜STORE_PASSWORD＞' -keypass '＜KEY_PASSWORD＞' \
  -dname "CN=Louver Mastering, OU=Mobile, O=Louver, L=, S=, C=KR"
```

- **이 keystore와 비밀번호는 분실 시 동일 키로 재서명 불가** → 안전하게 백업하세요.
- **절대 커밋하지 마세요.** `.jks`/`keystore.properties`는 gitignore 대상으로 두고,
  CI에는 base64 인코딩하여 Secret으로만 보관:
  ```bash
  base64 -w0 louver-mastering-release.jks > keystore.b64   # macOS: base64 -i ... -o ...
  # keystore.b64 내용을 GitHub Secret ANDROID_KEYSTORE_BASE64 로 등록
  ```

---

## 4. Signed Release APK / AAB

### 로컬에서 가장 단순한 방법: 빌드 후 apksigner로 서명
```bash
pnpm --filter @aimaster/mobile build
cd apps/mobile && npx cap sync android && cd android

# 미서명 release 빌드
./gradlew assembleRelease   # → app/build/outputs/apk/release/app-release-unsigned.apk
./gradlew bundleRelease     # → app/build/outputs/bundle/release/app-release.aab

# APK 서명 (build-tools의 apksigner)
"$ANDROID_HOME/build-tools/34.0.0/apksigner" sign \
  --ks ../../louver-mastering-release.jks \
  --ks-key-alias louver-mastering \
  --out app/build/outputs/apk/release/app-release.apk \
  app/build/outputs/apk/release/app-release-unsigned.apk

# APK 서명 검증
"$ANDROID_HOME/build-tools/34.0.0/apksigner" verify --verbose \
  app/build/outputs/apk/release/app-release.apk

# AAB 서명 (jarsigner) — Play 업로드용
jarsigner -keystore ../../louver-mastering-release.jks \
  app/build/outputs/bundle/release/app-release.aab louver-mastering
```

### 대안: gradle signingConfig
`android/`는 재생성되므로 build.gradle 직접 수정은 비권장입니다. CI/로컬 모두 위처럼
**빌드 후 외부 서명**(apksigner/jarsigner) 방식을 권장합니다.

---

## 5. Firebase App Distribution (심사 0, 테스터 링크)

가장 빠른 외부 배포. APK/AAB 모두 업로드 가능.

### 준비
1. Firebase 콘솔 → 프로젝트 생성/선택 → **App Distribution** 활성화.
2. Android 앱 등록(패키지명 `com.louver.mastering.mobile`) → **App ID** 확보
   (형식 `1:1234567890:android:abcdef...`).
3. 배포 권한 서비스 계정 JSON 발급
   (IAM에서 `Firebase App Distribution Admin` 역할) → JSON 내용 확보.
4. 테스터 그룹 생성(예: `testers`)에 테스터 이메일 등록.

### 로컬 CLI 배포
```bash
npm i -g firebase-tools
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
firebase appdistribution:distribute \
  apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk \
  --app "1:1234567890:android:abcdef..." \
  --groups "testers" \
  --release-notes "M4 test build"
```
테스터는 메일 링크 → (최초 1회 기기 등록) → APK 설치.

### Play 내부 테스트(선택)
- Play Console($25 1회) → 내부 테스트 트랙에 **AAB** 업로드 → 테스터 등록(짧은 심사).
- 권장 순서: **Firebase/APK 사이드로드로 1차 실기 → 안정화 후 Play 내부 테스트**.

---

## 6. GitHub Actions 워크플로

파일: `.github/workflows/build-mobile-android.yml` (이 저장소에 포함).

동작:
- **항상**: 웹 빌드 → `cap add/sync android` → `assembleDebug` → **debug APK artifact 업로드**.
  (secret 불필요 — 누구나 PR/푸시로 APK 산출물 확인 가능)
- **secret 있을 때만(optional)**:
  - `ANDROID_KEYSTORE_BASE64` 등 → release `assembleRelease`/`bundleRelease` + **서명** → signed APK/AAB artifact.
  - `FIREBASE_APP_ID` + `FIREBASE_SERVICE_ACCOUNT` → **Firebase App Distribution** 자동 배포.

### 필요한 GitHub Secrets/Variables
| 이름 | 종류 | 용도 |
|---|---|---|
| `VITE_MASTERING_API_URL` | Variable 또는 Secret | 빌드에 주입할 서버 URL(https) |
| `VITE_MASTERING_API_KEY` | Secret | 서버 API 키(선택) |
| `ANDROID_KEYSTORE_BASE64` | Secret | keystore(.jks)의 base64 |
| `ANDROID_KEYSTORE_PASSWORD` | Secret | keystore 비밀번호 |
| `ANDROID_KEY_ALIAS` | Secret | 키 alias |
| `ANDROID_KEY_PASSWORD` | Secret | 키 비밀번호 |
| `FIREBASE_APP_ID` | Secret | Firebase Android App ID |
| `FIREBASE_SERVICE_ACCOUNT` | Secret | 서비스 계정 JSON 전체 내용 |
| `FIREBASE_TESTER_GROUPS` | Variable(선택) | 배포 그룹(기본 `testers`) |

> secret이 없으면 release/Firebase step은 **자동으로 건너뜁니다**(if 가드). debug APK
> 빌드와 artifact 업로드는 secret 없이도 항상 동작합니다.

### 수동 실행
Actions 탭 → "Build Mobile Android (test app)" → **Run workflow**(workflow_dispatch).

### 산출물 받기
워크플로 실행 페이지 하단 **Artifacts**에서 `app-debug-apk`(및 secret 설정 시
`app-release-signed`) 다운로드 → `adb install` 또는 사이드로드.

---

## 7. 트러블슈팅
| 증상 | 원인/해결 |
|---|---|
| `SDK location not found` | `ANDROID_HOME`/`local.properties` 미설정. SDK 설치 후 env 지정. |
| `Failed to install ... INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 서로 다른 키로 서명된 동일 패키지. 기존 앱 제거 후 재설치. |
| 앱에서 "서버에 연결할 수 없습니다" | 서버가 http(cleartext)거나 다운/CORS 문제. **HTTPS** 확인, `/healthz` 확인. |
| `cap sync` 시 plugin 누락 | `pnpm install` 후 재시도. (`@capacitor/filesystem`,`share`,`@capawesome/...` 3종) |
| gradle JDK 오류 | JDK 17 사용 확인(`java -version`). 17이 아니면 빌드 실패. |
| `android/`가 없음 | 정상(gitignore). `npx cap add android`로 재생성. |
