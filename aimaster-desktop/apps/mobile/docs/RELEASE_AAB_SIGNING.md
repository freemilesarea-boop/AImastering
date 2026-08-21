# Android Release AAB 서명 (왜 debug APK만 나오는가 + 해결)

## 진단 (증거 기반)

### 워크플로 조건 (`.github/workflows/build-mobile-android.yml`)
- `Build debug APK` → **항상 실행** → artifact **`app-debug-apk`** (secret 불필요).
- 서명 release(APK+AAB)는 **`secrets.ANDROID_KEYSTORE_BASE64`가 있을 때만**:
  ```yaml
  - name: Detect optional secrets
    run: echo "sign=${{ secrets.ANDROID_KEYSTORE_BASE64 != '' }}" >> "$GITHUB_OUTPUT"
  - name: Decode keystore
    if: steps.flags.outputs.sign == 'true'
  - name: Build & sign release (APK + AAB)   # assembleRelease bundleRelease → app-release.aab
    if: steps.flags.outputs.sign == 'true'
  - name: Upload signed release artifacts     # artifact: app-release-signed (.apk + .aab)
    if: steps.flags.outputs.sign == 'true'
  ```
- 즉 **AAB 생성 여부는 오직 keystore secret 유무**에 달림. **`build_type=release`는 무관**
  (그건 `VITE_RELEASE_MODE`로 설정 화면만 숨김).

### Actions 로그 증거 (run 27666123593, workflow_dispatch, sha 481993e)
| step | 결과 |
|---|---|
| Build debug APK | ✅ success |
| Upload debug APK | ✅ success |
| Detect optional secrets | ✅ success(실행됨) |
| Decode keystore | ⏭️ **skipped** |
| **Build & sign release (APK + AAB)** | ⏭️ **skipped** |
| Upload signed release artifacts | ⏭️ **skipped** |
- 해당 run **artifacts: `app-debug-apk` 1개뿐** (no `app-release-signed`).

### 결론 (확정)
서명 step들이 `if: sign == 'true'`에서 **skipped** → `secrets.ANDROID_KEYSTORE_BASE64 != ''`
가 **false** → **`ANDROID_KEYSTORE_BASE64` secret이 등록되어 있지 않음**. 그래서 AAB가
생성되지 않고 debug APK만 나옴. (서명 4-secret은 함께 필요)

---

## 해결 — 단계별

### 1) Release keystore 생성 (로컬, 1회)
> ⚠️ 이 keystore와 비밀번호는 **분실 시 동일 키 재서명 불가** → 안전 백업. **절대 커밋 금지.**
```bash
keytool -genkeypair -v \
  -keystore louver-mastering-release.jks \
  -alias louver-mastering \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass '＜STORE_PASSWORD＞' -keypass '＜KEY_PASSWORD＞' \
  -dname "CN=Louver Mastering, OU=Mobile, O=Louver, C=KR"
```
- alias = `louver-mastering`, storepass/keypass = 정한 값(같아도 됨).

### 2) GitHub Secrets 4개 등록
base64 인코딩:
```bash
base64 -w0 louver-mastering-release.jks > keystore.b64     # macOS: base64 -i louver-mastering-release.jks -o keystore.b64
```
GitHub → repo **Settings → Secrets and variables → Actions → New repository secret** 로 4개:
| Secret 이름 | 값 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `keystore.b64` 파일 내용 전체 |
| `ANDROID_KEYSTORE_PASSWORD` | ＜STORE_PASSWORD＞ |
| `ANDROID_KEY_ALIAS` | `louver-mastering` |
| `ANDROID_KEY_PASSWORD` | ＜KEY_PASSWORD＞ |
> (release 앱에 서버 키도 박으려면 `VITE_MASTERING_API_KEY` secret도 함께 등록 — AAB 서명과는 별개)

### 3) Release AAB 빌드 실행
Actions → **Build Mobile Android (test app)** → **Run workflow**:
- Branch: `claude/gifted-babbage-6bd4gc`
- `build_type` = **release**
- `version_name` = `1.0.0`, `version_code` 비우면 run number(자동 증가, Play 요구사항 충족)

gh CLI 대안:
```bash
gh workflow run build-mobile-android.yml --ref claude/gifted-babbage-6bd4gc \
  -f build_type=release -f version_name=1.0.0
```
→ secret이 있으면 이제 `Build & sign release` step이 실행되어 artifact
**`app-release-signed`** 에 `app-release.aab`(+ `app-release-signed.apk`) 생성.

### 4) 확인
- run 완료 후 Artifacts에 **`app-release-signed`** 존재 → 내려받아 `app-release.aab`를 Play Console
  내부 테스트 트랙에 업로드.
- (선택) Play **App Signing** 사용 권장 — 업로드 키 분실 위험 완화.

> 패키지명: **`com.louver.mastering.mobile`** (Play 등록 후 고정).
