# M5 — 실기 End-to-End 런북 (Android)

목표: 실제 Android 기기에 `app-debug.apk`를 설치하고, **오디오 선택 → 서버 마스터링
→ 결과 재생/공유**까지 1회 성공시킨다.

> 역할 분담(중요): 아래 체크 중 **서버 계약(5–11, 13)** 은 이 저장소에서 headless
> E2E로 이미 **PASS**(10/10) 확인됨. **물리적 단계(1·2·3·12·15)** 와 **Render 배포**
> 는 사용자 기기/계정에서만 가능하므로 이 런북대로 수행한다.

---

## A. APK 확보 (CI 산출물)
1. GitHub → Actions → **Build Mobile Android (test app)** → run **#27530292076**
   (또는 최신 성공 run).
2. 하단 **Artifacts → `app-debug-apk`** 다운로드(zip ~3.45 MB).
3. 압축 해제 → **`app-debug.apk`** 확보.
   - CLI 대안: `gh run download 27530292076 -n app-debug-apk -R freemilesarea-boop/AImastering`

## B. 서버(M0) 배포 — Render
앱은 **HTTPS** 서버가 필요(Android cleartext 차단). CORS는 이미 활성화됨.
1. 최신 브랜치로 Render 재배포(루트 `render.yaml` Blueprint 사용).
   - `services/mastering-api`의 **CORS 포함 최신 `server.py`** 가 배포되는지 확인.
2. Render 대시보드에서 `MASTERING_API_KEY`(강한 랜덤) 설정.
3. 배포 후 `https://<app>.onrender.com/healthz` → `{"ok":true,...}` 확인.
   - 무료 플랜은 콜드스타트(최초 요청 수십 초) 있음 → 앱에서 첫 호출이 느릴 수 있음.

## C. 설치
- 기기: 설정 → 개발자 옵션 → **USB 디버깅 ON**, 케이블 연결.
- `adb devices` → 기기 보이면 `adb install -r app-debug.apk`.
- 또는 APK를 기기로 전송해 파일 매니저로 사이드로드(출처 불명 앱 허용 필요).
- 에뮬레이터: AVD 부팅 후 동일 `adb install`.

---

## D. 실기 검증 체크리스트 (탭 QA)
| # | 항목 | 방법 / 기대 | 사전 실증 |
|---|---|---|---|
| 1 | 설치 가능 | `adb install -r` 성공(Success) | 기기 필요 |
| 2 | 실행 가능 | 앱 아이콘 탭 → 크래시 없이 "서버 설정" 화면 | 기기 필요 |
| 3 | 서버 URL/KEY 입력 | URL(https) 입력 → "계속" 활성, KEY 마스킹 | 기기 필요 |
| 4 | 파일 선택 | "파일 선택" → 문서 선택기 → wav/mp3 선택, 파일카드 표시 | 기기 필요 |
| 5 | Analyze 성공 | "분석 실행" → key/value 결과 | ✅ 서버 E2E PASS |
| 6 | Master job 생성 | "마스터링 시작" → 업로드 → job 생성 | ✅ PASS |
| 7 | 진행률 표시 | 진행률 바 % + 단계 텍스트(스펙트럴/라우드니스/보정) 갱신 | ✅ PASS (10→45→84→100) |
| 8 | Master 완료 | 자동으로 "결과" 화면 이동 | ✅ PASS |
| 9 | Preview 재생 | 프리뷰(MP3) 플레이어 재생 | ✅ 다운로드 PASS (audio/mpeg) |
| 10 | Master 다운로드 | 마스터(WAV) 플레이어 로드 | ✅ PASS (audio/wav, 1.59MB) |
| 11 | 공유/저장 | "저장/공유" → 네이티브 공유 시트 | 기기 필요(파일 blob 확보 PASS) |
| 12 | 재실행 후 재테스트 | 앱 종료 후 재실행 → "새 파일로 다시" 정상 | 기기 필요 |
| 13 | 실패 시 에러 메시지 | 잘못된 KEY/URL → 명확한 에러 + 재시도 | ✅ 401/404 PASS, UI 메시지 매핑 |
| 14 | Render 서버 로그 | 아래 E 참고 | — |
| 15 | logcat (필요 시) | 아래 E 참고 | — |

성공 기준: **#1–#12를 한 번에 통과**(오디오 선택 → 서버 마스터링 → 재생/공유).

---

## E. 로그 확인 (디버깅)
- **Render 로그**: 대시보드 → 서비스 → **Logs**. 업로드/`master`/progress/다운로드 라인,
  500/타임아웃 확인. (콜드스타트 지연도 여기서 보임)
- **Android logcat** (WebView/JS 에러):
  ```bash
  adb logcat | grep -iE "Capacitor|chromium|Console|louver|mastering"
  # 또는 chrome://inspect (USB) 로 WebView devtools 열어 Network/Console 확인
  ```

## F. 실패 시 분류 (런타임 문제 ≠ APK 빌드 문제)
APK 빌드는 CI에서 성공(아티팩트 존재). 실기 실패는 **런타임**으로 분류하고 막힌 지점 기록:
| 증상 | 1차 원인 | 조치(P0/P1만) |
|---|---|---|
| "서버에 연결할 수 없습니다" | http(cleartext)/서버 다운/CORS | URL **https** 확인, `/healthz`, Render Logs |
| 401 | KEY 불일치 | 앱 KEY = `MASTERING_API_KEY` |
| 파일 선택 후 업로드 실패 | content:// 읽기/대용량 | 60MB 이하, 다른 파일, logcat |
| 다운로드/재생 안 됨 | convertFileSrc/포맷 | logcat Network, 프리뷰(MP3) 우선 |
| 공유 시트 안 뜸 | Filesystem/Share 권한 | logcat, Documents 쓰기 확인 |

> 서버 계약은 이미 검증됨 → 실기 실패는 거의 **네트워크(https/CORS)·파일권한·
> WebView 재생** 중 하나. 해당 지점만 P0/P1로 최소 수정.
