# iOS 빌드 / App Store Connect 업로드 런북 (로컬 macOS)

apps/mobile(Capacitor)에서 **iOS IPA**를 생성해 App Store Connect에 업로드하는 절차.
**macOS + Xcode 필수** — Linux/CI 컨테이너에서는 불가(IPA는 Xcode + Apple 서명 필요).

## 0. 사실 / 사전 조건
- **번들 ID**: iOS = **`com.louver.mastering.ios`** (Android `com.louver.mastering.mobile`와 분리).
- Apple Developer Program 가입 + App Store Connect 앱(위 번들 ID) 생성 완료.
- `ios/`는 `.gitignore` 대상 — Android처럼 **`cap add ios`로 매번 재생성**(미커밋).
- 필요한 macOS 도구: Xcode 15+, CocoaPods(`sudo gem install cocoapods` 또는 `brew install cocoapods`), Node 20, pnpm 9.
- 서명 자산(둘 중 하나):
  - **(권장) ASC API Key**: App Store Connect → Users and Access → Integrations → App Store Connect API → Key(.p8) + Key ID + Issuer ID. `xcodebuild`/Transporter 업로드에 사용, 인증서 자동 관리.
  - 또는 배포 인증서(.p12) + App Store 프로비저닝 프로파일(`com.louver.mastering.ios`) + Team ID.

> ⚠️ iOS는 **WKWebView(WebKit)** — Android(Chromium)와 다른 엔진. 온디바이스 WebAudio
> 마스터링/프리뷰의 iOS 동작은 **실기기에서 반드시 확인**(빌드와 별개). 결과 프리뷰가 문제 되면
> mac-shell처럼 플랫폼 분기 대응 검토(현재 iOS 분기는 없음 — 기본 `<audio>` 프리뷰 사용).

---

## 1. 웹 자산 빌드 (온디바이스, 서버 없음)
```bash
cd aimaster-desktop
pnpm install
pnpm --filter @aimaster/mobile build      # → apps/mobile/dist (Render env 없음)
```

## 2. Capacitor iOS 프로젝트 생성 + 번들 ID 설정
```bash
cd aimaster-desktop/apps/mobile
pnpm exec cap add ios                      # ios/ 생성 (gitignored)
node set-ios-bundle-id.cjs                 # PRODUCT_BUNDLE_IDENTIFIER → com.louver.mastering.ios
pnpm exec cap sync ios                     # 웹 자산 + 플러그인 동기화
```
- 확인: `grep PRODUCT_BUNDLE_IDENTIFIER ios/App/App.xcodeproj/project.pbxproj` → `com.louver.mastering.ios`.

## 3. CocoaPods
```bash
cd ios/App
pod install                                # App.xcworkspace 생성
cd ../..
```
- 이제 **`ios/App/App.xcworkspace` 존재** (Xcode는 .xcodeproj가 아니라 .xcworkspace로 열 것).

## 4. Xcode에서 서명 설정
```bash
pnpm exec cap open ios                     # 또는: open ios/App/App.xcworkspace
```
- Xcode → **App** 타깃 → **Signing & Capabilities**:
  - Team = 본인 Apple Developer 팀.
  - Bundle Identifier = `com.louver.mastering.ios` (자동 표시되어야 함).
  - "Automatically manage signing" 체크 → App Store 프로비저닝 자동 생성.
- 일반: Version(CFBundleShortVersionString)=`1.0.0`, Build(CFBundleVersion)=`1` 설정.

## 5. Archive 생성

### A) Xcode GUI (가장 간단)
- 상단 디바이스 타깃 = **Any iOS Device (arm64)**.
- 메뉴 **Product → Archive** → 완료되면 **Organizer**가 열림.

### B) CLI (재현 가능)
```bash
cd aimaster-desktop/apps/mobile
xcodebuild -workspace ios/App/App.xcworkspace -scheme App \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath build/App.xcarchive archive
```
- (서명 자산이 아직 없을 때 **컴파일 검증만**: `CODE_SIGNING_ALLOWED=NO` 추가 → IPA는 안 나오지만 프로젝트가 빌드되는지 확인.)

## 6. IPA Export
```bash
# ios-ExportOptions.plist 의 YOUR_TEAM_ID 를 본인 Team ID 로 교체 후:
cp ios-ExportOptions.plist /tmp/ExportOptions.plist   # 편집본 사용 권장
xcodebuild -exportArchive \
  -archivePath build/App.xcarchive \
  -exportOptionsPlist /tmp/ExportOptions.plist \
  -exportPath build/ipa \
  -allowProvisioningUpdates
# → build/ipa/App.ipa
```

## 7. App Store Connect 업로드 (3택 1)
1. **Xcode Organizer** → 해당 Archive → **Distribute App → App Store Connect → Upload** (자동 서명).
2. **Transporter.app**(App Store) 에 `build/ipa/App.ipa` 드래그 → Deliver.
3. **CLI (ASC API Key)**:
   ```bash
   xcrun altool --upload-app -f build/ipa/App.ipa -t ios \
     --apiKey <KEY_ID> --apiIssuer <ISSUER_ID>
   # (.p8 키는 ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8 에 위치)
   ```
- 업로드 후 App Store Connect → TestFlight 에서 처리 완료되면 내부 테스트 가능.

---

## 빠른 체크리스트
- [ ] `pnpm --filter @aimaster/mobile build` 성공
- [ ] `cap add ios` → `node set-ios-bundle-id.cjs` (번들 ID = com.louver.mastering.ios)
- [ ] `pod install` → `ios/App/App.xcworkspace` 존재
- [ ] Xcode Signing: Team + Automatic signing
- [ ] Product → Archive 성공
- [ ] ExportOptions(teamID 기입) → `App.ipa` 생성
- [ ] Transporter/Organizer/altool 로 업로드 → ASC 처리 성공
- [ ] (실기기) 30초 mp3 마스터링 → 결과/프리뷰/Export 동작 확인(WKWebView)

## 경계
- 본 작업은 `apps/mobile`(iOS) 한정. **Android 동작 불변**(번들 ID 분리, `@capacitor/ios`는
  추가 의존성일 뿐 Android 빌드 미영향 — frozen-lockfile + 빌드 검증 완료).
- Render/서버 의존 없음(온디바이스). `apps/desktop`/`mac-shell` 무관.
