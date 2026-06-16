# Google Play 내부 테스트 등록 가이드

`com.louver.mastering.mobile` (Loui Mastering) 을 Play Console **내부 테스트
(Internal testing)** 트랙에 올리는 순서. 빌드/서명 세부는
`ANDROID_BUILD_AND_DISTRIBUTION.md` 참조.

## 1. 사전 준비
- [ ] Google Play Console 개발자 계정($25 1회 등록비).
- [ ] **release keystore** 생성 + 안전 백업 (분실 시 동일 키 재서명 불가).
      → `ANDROID_BUILD_AND_DISTRIBUTION.md` §3.
- [ ] keystore를 base64로 GitHub Secret 등록:
      `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
- [ ] 서버 주소 주입(공개용): repo Variable `VITE_MASTERING_API_URL`(+Secret `VITE_MASTERING_API_KEY`).
- [ ] **개인정보처리방침 URL** (Play 필수, 음원 업로드) — `PRIVACY_AND_DATA_COLLECTION_NOTES.md`.

## 2. signed AAB 빌드 (CI)
워크플로 `.github/workflows/build-mobile-android.yml`:
- keystore secret이 있으면 자동으로 **`assembleRelease` + `bundleRelease` + 서명**
  → artifact **`app-release-signed`** (= `app-release-signed.apk` + `app-release.aab`).
- **버전 주입**: Actions → Run workflow(workflow_dispatch)에서
  `version_name`(예 `1.0.0`) / `version_code`(정수, 미지정 시 run number) 입력.
  → `app/build.gradle`의 versionCode/versionName이 빌드 직전 패치됨.
  > Play는 업로드마다 **versionCode가 증가**해야 함. run number 또는 수동 입력으로 보장.

수동(로컬) 대안:
```bash
pnpm --filter @aimaster/mobile build
cd apps/mobile && npx cap sync android && cd android
# 버전 설정
sed -i -E 's/versionCode .*/versionCode 1/' app/build.gradle
sed -i -E 's/versionName ".*"/versionName "1.0.0"/' app/build.gradle
./gradlew bundleRelease          # → app/build/outputs/bundle/release/app-release.aab
jarsigner -keystore <ks>.jks app/build/outputs/bundle/release/app-release.aab <alias>
```
> Play **App Signing**을 쓰면 업로드 키로만 서명하면 되고 Google이 배포 서명을 관리.
> 권장: Play App Signing 활성화(키 분실 위험 완화).

## 3. AAB 산출물 (debug APK 아님)
- 내부 테스트/배포는 **`app-release.aab`** 업로드(권장). `app-debug.apk`는 사이드로드 전용.
- CI artifact `app-release-signed` 에서 `.aab` 다운로드.

## 4. Android 권한 목록 (Play 선언용)
| 권한 | 용도 | 비고 |
|---|---|---|
| `android.permission.INTERNET` | 서버 API 호출(업로드/다운로드) | 유일한 선언 권한 |
| (파일 선택) | Storage Access Framework | **권한 불필요**(시스템 선택기) |
| (결과 저장) | Filesystem 공개 Downloads | API 30+ 권한 불필요; 구버전은 앱 저장소 폴백 |
- 위험 권한 없음. 위치/연락처/카메라/마이크 **미사용**.

## 5. Data Safety (Play 데이터 보안 양식) 요약
`PRIVACY_AND_DATA_COLLECTION_NOTES.md` 기준:
- 수집/전송: **오디오 파일**(마스터링 처리 목적, 서버 임시 보관 후 TTL 삭제),
  **오류 리포트**(앱버전/플랫폼/단계/에러코드/메시지 — 원본파일·키 제외),
  **요청 메타**(서버 로그).
- 계정/개인식별정보: **없음**(로그인/결제 없음).
- 데이터 암호화 전송: **예(HTTPS)**. 사용자 삭제 요청: 음원은 TTL 자동삭제.

## 6. 스토어 등록용 설명문 초안
**앱 이름**: Loui Mastering (Test)
**짧은 설명(80자)**:
> AI 오디오 마스터링 — 음원을 올리면 전문가급 라우드니스/밸런스로 마스터링.

**전체 설명(초안)**:
> Loui Mastering은 음원 파일을 선택해 서버에서 자동 마스터링하고, 결과(WAV)를
> 미리듣기·저장·공유할 수 있는 테스트 앱입니다.
> - 파일 선택 → 마스터링 → 결과 재생 → 저장/공유의 간단한 흐름
> - 스타일/목표 라우드니스(LUFS)/트루피크 설정
> - 빠른 처리(fast) 모드
> 본 버전은 내부 테스트용이며, 처리는 서버에서 수행됩니다. 업로드한 음원은 처리 후
> 일정 시간 뒤 자동 삭제됩니다.
**카테고리**: 음악/오디오 · **콘텐츠 등급**: 전체이용가(설문 응답 필요)
**연락처 이메일 / 개인정보처리방침 URL**: (등록 필요)

## 7. 내부 테스트 등록 순서
1. Play Console → 앱 만들기(이름 Loui Mastering, 무료, 앱 유형).
2. **앱 설정**: 데이터 보안(§5), 콘텐츠 등급 설문, 타깃층, 개인정보처리방침 URL, 광고 없음.
3. **App integrity / App Signing**: Play App Signing 활성화 권장.
4. **내부 테스트 트랙** → 새 버전 만들기 → **`app-release.aab`** 업로드.
5. 출시 노트 입력 → 검토 → 저장 → **버전 출시(롤아웃)**.
6. **테스터 추가**: 이메일 목록(또는 Google 그룹) → 옵트인 링크 공유.
7. 테스터가 링크로 옵트인 → Play에서 설치 → QA(`ANDROID_RELEASE_CANDIDATE_CHECKLIST.md`).
> 내부 테스트는 심사가 짧음(보통 수 분~수십 분). 공개(Production)는 정식 심사.

## 8. 빠른 대안 (Play 전)
- **Firebase App Distribution** 또는 **APK 사이드로드**로 1차 실기 → 안정화 후 Play 내부 테스트.
  (`ANDROID_BUILD_AND_DISTRIBUTION.md` §5)
