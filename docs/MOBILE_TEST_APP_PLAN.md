# 모바일 테스트 앱 실행 계획 (Capacitor + 서버 마스터링, Android 우선)

확정: 서버 API 처리 · Capacitor · Android 테스트 먼저 · iOS는 이후 · **코드 수정 없이 계획만**.
원칙: React Native/Flutter 금지 · 온디바이스 Rust 금지 · 전체 리팩토링 금지 · 데스크톱 기능 삭제/파손 금지 · 결제/라이선스/계정제 작업 금지.

핵심 전략: **데스크톱 코드는 손대지 않고**, monorepo에 **신규 추가**만 한다 — ① 서버 마스터링 API(`services/mastering-api`), ② Capacitor 모바일 앱(`apps/mobile`). 모바일 앱은 **순수 UI 컴포넌트(전자 atoms/viz)만 재사용**하고, Electron IPC 대신 **`mobileApi` 어댑터**(Capacitor + 서버)로 흐름을 새로 배선한다.

---

## 1. 서버 마스터링 API 구조 (`services/mastering-api`, 신규)

**스택**: FastAPI + uvicorn (Python). 기존 `services/python-audio`를 **라이브러리로 import**.

**엔드포인트(테스트 MVP)**:
| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/v1/master` | multipart(audio 파일) + JSON options → `{ job_id }` (비동기) |
| GET | `/v1/jobs/{id}` | `{ status, percent, stage }` (진행률 폴링) |
| GET | `/v1/jobs/{id}/master` | 마스터 WAV 다운로드 |
| GET | `/v1/jobs/{id}/preview` | 프리뷰 MP3 다운로드 |
| GET | `/healthz` | 헬스체크 |

- 인증: `X-API-Key` 헤더(테스트용 공유키). **계정/결제 없음**(범위 외).
- 작업 모델: 업로드→temp 저장→백그라운드 워커가 `analyze_file`+`master_file` 실행→결과 파일 보관→폴링/다운로드. 진행률은 엔진 stdout JSON-RPC progress를 워커가 캡처해 job 상태에 반영.
- 보관/정리: job 결과는 임시(예: 1h TTL) 후 삭제.

**Dockerfile**: `python:3.11-slim` + **ffmpeg(데스크톱과 동일 버전 핀, 7.0.2)** + `pip install -r requirements.txt fastapi uvicorn python-multipart`.

## 2. 기존 python-audio 엔진 재사용 방식
- **0 변경**으로 import: `from app.analyzers.analyzer import analyze_file`, `from app.mastering.mastering import master_file`.
- 데스크톱 `main.py`의 `_handle_analyze`/`_handle_master`와 **동일 호출**(파일 경로 in → 출력 파일 out). API는 그 얇은 HTTP 래퍼일 뿐.
- options 매핑: 데스크톱 `audio:master` 파라미터(style, targetLufs, targetTp, sampleRate, bitDepth, limiterStrength, applyAiCorrections, preLoudness 등)를 그대로 JSON으로 받아 전달.
- → **마스터링 로직/음질 100% 동일**(같은 엔진, 같은 ffmpeg).

## 3. Capacitor 도입 범위 (`apps/mobile`, 신규)
- 신규 Vite+React 앱(데스크톱 `apps/desktop`과 별도).
- 의존성: `@capacitor/core`, `@capacitor/android`, `@capacitor/cli`, 플러그인 `@capawesome/capacitor-file-picker`(오디오 선택), `@capacitor/filesystem`, `@capacitor/share`, `@capacitor/preferences`(설정), fetch(업로드).
- `capacitor.config.ts`(appId `com.louver.mastering.mobile`, webDir=`dist`), `android/`는 `npx cap add android`로 생성.
- **재사용(순수 컴포넌트)**: `@aimaster/shared-types`, `theme/loui-tokens`, guided atoms(`StyleCard`/`SegToggle`/`TargetCard`/`CtaButton`), result viz(`AchievementHeader`/`LoudnessDeltaBars`/`BeforeAfterWaveform`/`MobilePreview`). 이들은 `window.electronAPI` 미사용 → 그대로 사용 가능.
- **신규(모바일 전용 컨테이너)**: ImportView/ChooseView/Mastering/Result의 **모바일판**(atoms 재사용, 배선만 `mobileApi`).

## 4. window.electronAPI 의존 제거 / 어댑터화 전략
- **데스크톱은 불변.** 모바일 앱은 Electron IPC를 쓰지 않고 `lib/mobileApi.ts`(신규) 한 곳으로 통일:
  | 데스크톱 IPC | 모바일 어댑터 |
  |---|---|
  | `file:open-dialog` | `FilePicker.pickFiles({types:['audio/*']})` |
  | `audio:analyze`+`audio:master` | `mobileApi.master(file, options, onProgress)` → 서버 POST+폴링+다운로드 |
  | `audio:progress`(on) | 폴링 콜백 `onProgress(percent, stage)` |
  | `audio:cancel` | job 취소 요청(선택) / 폴링 중단 |
  | `file:save-wav` / 저장 | `Share.share({url})` / `Filesystem.writeFile` |
  | license/entitlement/device/settings/support | **미사용(테스트 범위 제외)** |
- 원칙: 모바일 컨테이너는 `window.electronAPI`를 **절대 호출하지 않음**. (대안인 "electronAPI 셰임"은 `aimaster-local://`/`toFileUrl` 같은 Electron 전용 URL 문제로 비권장 → 모바일 전용 배선 채택.)

## 5. 모바일 파일 선택
- `@capawesome/capacitor-file-picker`로 오디오 선택 → `content://` URI. Android는 직접 읽기 제약 있어 **임시 캐시로 복사**(Filesystem) 후 업로드. wav/mp3/flac/m4a 허용.

## 6. 서버 업로드 / 진행률 / 다운로드
- 업로드: `fetch(API/v1/master, { method:POST, body:FormData(audio+options), headers:{'X-API-Key'} })` → `{job_id}`.
- 진행률: `GET /v1/jobs/{id}` 폴링(1~2s) → `onProgress(percent, stage)` → MasteringPage 링/단계 갱신.
- 완료: `GET .../master`(WAV), `.../preview`(MP3) 다운로드 → Filesystem 저장 → `Capacitor.convertFileSrc(localUri)`로 `<audio>` 재생/MobilePreview A/B.
- 네트워크: 타임아웃/재시도, 업로드 크기 제한(예: ≤50MB) 안내.

## 7. 모바일 저장 / 공유
- "저장": `Share.share({ url: localMasterUri, title })`(공유 시트) 또는 `Filesystem.writeFile`(Documents). 데스크톱의 파일시스템 저장 대신 **공유 시트**가 기본.
- MP3 프리뷰 저장도 동일 공유. (무료/유료 게이트는 테스트 범위 제외.)

## 8. Android 배포 (APK / Firebase / Play 내부테스트)
- 빌드: `pnpm --filter @aimaster/mobile build && npx cap sync android && (cd android && ./gradlew assembleRelease|bundleRelease)`.
- 서명: keystore 생성(`keytool`) → `android/keystore.properties`(gitignore) / CI secret.
- **가장 빠른 테스트**: ① **Firebase App Distribution**(APK 업로드→테스터 링크, 심사 0) 또는 ② **APK 직접 사이드로드**. 
- **Play 내부 테스트**: Play Console($25 1회)→내부 테스트 트랙에 AAB 업로드→테스터 등록(심사 짧음).
- 권장 순서: Firebase/APK로 실기 1차 → 안정화 후 Play 내부 테스트.

## 9. 필요한 env / secrets
- 서버: `MASTERING_API_KEY`(공유키), `PORT`, ffmpeg 경로(컨테이너 내장). 호스팅(예: Fly.io/Render/VM).
- 모바일 빌드: `VITE_MASTERING_API_URL`, `VITE_MASTERING_API_KEY`.
- Android 서명: `ANDROID_KEYSTORE`(base64), `ANDROID_KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`.
- Firebase: 서비스 계정 JSON(App Distribution) — 또는 수동 업로드.

## 10. Phase별 티켓
**M0 — 서버 API** (`services/mastering-api/` 신규)
- M0-1 FastAPI 앱 + `/v1/master`,`/jobs/{id}`,`/healthz` + 백그라운드 워커.
- M0-2 python-audio import 래핑(analyze+master), options 매핑.
- M0-3 Dockerfile(ffmpeg 7.0.2 핀) + API key 미들웨어 + TTL 정리.
- M0-4 호스팅 배포 + healthz 확인.

**M1 — Capacitor 스캐폴드** (`apps/mobile/` 신규)
- M1-1 Vite+React 앱 + `@capacitor/*` + `capacitor.config.ts`.
- M1-2 `npx cap add android` → `android/` 생성, 아이콘/스플래시/권한.

**M2 — mobileApi 어댑터** (`apps/mobile/src/lib/mobileApi.ts`)
- M2-1 pickAudioFile(FilePicker+캐시 복사).
- M2-2 master(upload+poll+download) + onProgress.
- M2-3 share/save(Share/Filesystem) + convertFileSrc 재생.

**M3 — 모바일 흐름 UI**(atoms 재사용)
- M3-1 Import/Choose(기존 atoms) → M3-2 Mastering(폴링 진행률) → M3-3 Result(viz+MobilePreview+공유).

**M4 — Android 테스트 배포**
- M4-1 서명/keystore → assembleRelease(APK).
- M4-2 Firebase App Distribution(또는 Play 내부테스트) 업로드 + 테스터.

**M5 — 검증**(아래 12).

## 11. 예상 리스크
| 리스크 | 대응 |
|---|---|
| 서버 ffmpeg 버전 불일치로 음질/필터 차이 | 데스크톱과 **동일 ffmpeg(7.0.2) 핀** |
| Android `content://` 읽기 제약 | 선택 즉시 캐시 복사 후 업로드 |
| 대용량 업로드 타임아웃/모바일망 | 크기 제한 + 재시도 + 진행률 |
| 서버 비용/가용성(테스트) | 단일 작은 인스턴스 + TTL 정리 |
| 프리뷰 재생(WebView) | MP3로 통일, `convertFileSrc` |
| 엔진 함수 시그니처 변동 | `_handle_master` 동일 파라미터 미러, 회귀 테스트 |
| 데스크톱 영향 | **신규 디렉토리만 추가**(apps/mobile, services/mastering-api), desktop 빌드/코드 0 변경 |

## 12. 검증 방법
- **서버**: `curl -F audio=@test.wav -F options=... -H 'X-API-Key' .../v1/master` → 폴링 → master/preview 다운로드 → 데스크톱 출력과 비교(LUFS/TP 근사).
- **모바일(실기 Android)**: 파일 선택 → 마스터(진행률) → MobilePreview A/B 재생 → 공유 저장. KPOP Loud/Strong/YouTube 조합 1회 완주.
- **배포**: Firebase/APK 설치 → 콜드스타트/크래시 없음.
- **데스크톱 회귀**: `pnpm --filter @aimaster/desktop typecheck && build` 통과(모바일 추가가 데스크톱 무영향) + Electron 앱 정상.

## 13. 데스크톱과의 경계 (금지사항 준수)
- `apps/desktop`, `packages/*`, `services/python-audio`, Electron `build.yml` **수정 0**.
- 신규: `services/mastering-api/`, `apps/mobile/`(+`android/`). monorepo에 워크스페이스 2개 추가(루트 pnpm-workspace에 glob 포함 시 1줄 추가 가능 — 데스크톱 빌드 무영향).
- 결제/라이선스/계정제/Rust/RN/Flutter **미착수**.

## 14. 예상 일정 (1인)
M0 ~1주 · M1 ~3일 · M2 ~1주 · M3 ~1주 · M4 ~3일 → **첫 Android 테스트 빌드 ≈ 3.5~4주**.

---

## 착수 전 확인 1가지
- **서버 호스팅 위치**(Fly.io / Render / 자체 VM 등) — 비용/리전. 미정 시 가장 빠른 **Fly.io 또는 Render** 권장. 정해주시면 M0부터 파일 단위로 착수합니다(승인 시).
