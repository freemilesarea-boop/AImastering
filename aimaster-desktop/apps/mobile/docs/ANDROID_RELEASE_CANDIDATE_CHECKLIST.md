# Android Release Candidate 체크리스트 (Play 내부 테스트 전)

대상: `apps/mobile`(Capacitor) Android 테스트 앱. **신규 기능/결제/계정/iOS/데스크톱
수정 없음.** 내부 테스트 등록 전 최적화·마감·QA.

## 0. 빌드/식별 (확인 완료)
- [x] package id (applicationId): **`com.louver.mastering.mobile`**
- [x] 앱 이름: **Loui Mastering** (`strings.xml` app_name)
- [x] 권한: **INTERNET 1개만** (파일선택=SAF, 저장=Filesystem 공개폴더, 추가 권한 선언 없음)
- [x] cleartext 비활성(기본 https) → 서버는 https 필수
- [x] 불필요 로그: 앱 소스에 `console.*` **없음**
- [x] versionCode/versionName: `android/`는 재생성되므로 **CI에서 주입**
      (`workflow_dispatch` 입력 `version_name`, `version_code`; 미지정 시 run number).
- [ ] **앱 아이콘/스플래시**: 현재 **Capacitor 기본 아이콘** → 내부 테스트는 OK,
      공개 전 브랜드 아이콘 교체 필요 (**P1**).

## 1. UI/UX 마감
- [x] 플로우 4단계: 서버 → 파일 → 마스터 → 결과 (분석탭 제거됨)
- [x] 서버 미설정 안내: 설정 화면 경고 + URL 형식 검증 + "계속" 비활성
- [x] 진행 메시지 단순화: 업로드 중 / 마스터링 중 N% / 결과 준비 중
- [x] 결과 파일명: `원본명_Mastering_YYYYMMDD.wav` / `원본명_Preview_YYYYMMDD.mp3`
- [x] 저장/공유 액션시트, fast mode 기본 ON
- [ ] **API URL/KEY 입력칸 노출**: 내부 테스트용 → **유지**(테스터가 서버 입력).
      Play 공개용 전환 시 → CI Secret/Variable로 `VITE_MASTERING_API_URL/KEY` 주입 후
      설정 화면을 읽기전용/숨김 처리 (별도 티켓, **P1**).

## 2. 안정성 QA — 입력 파일 매트릭스
각 항목: 선택→마스터링(fast)→결과 재생→저장→공유. **3회씩** 반복해 성공률 기록.

| 파일 | 길이 | 기대 | 성공/시도 | 비고 |
|---|---|---|---|---|
| MP3 | 30초 | 정상 완주 |  /3 |  |
| MP3 | 2분 | 정상 완주 |  /3 |  |
| MP3 | 3~4분 | 정상(느릴 수 있음) |  /3 |  |
| WAV | 2분 | 정상 |  /3 |  |
| M4A/AAC | 2분 | 정상(서버 디코드) |  /3 |  |
| FLAC | 2분 | 정상 |  /3 |  |
| 6ch/EAC3 | — | preconvert로 스테레오 처리 |  /3 |  |
| 손상/0바이트 | — | **오류 접수번호** 표시(크래시 X) |  /3 |  |
| 60MB 초과 | — | 413 → 접수번호 |  /3 |  |

판정: 정상 파일군 성공률 **≥ 90%**, 비표준/실패 파일은 **크래시 없이 접수번호**.

## 3. 성능 QA — 처리시간 기록 양식
| 파일/길이 | 모드 | 업로드(s) | 처리(s) | 총(s) | 서버 plan | 비고 |
|---|---|---|---|---|---|---|
| MP3 30s | fast |  |  |  | Starter/Standard |  |
| MP3 2m | fast |  |  |  |  |  |
| MP3 3~4m | fast |  |  |  |  |  |

- 목표: **30초~2분 = 60초 이내**, **3분 = 90초 이내**.
- 참고(프로파일): fast는 quality 대비 ~26% 단축. **Starter 0.5 CPU가 주 병목** →
  목표 미달 시 **Standard(1 vCPU, ~2x)** 권장(아래 4).
- **120초 초과 시 안내**: 처리 화면에 "경과 Ns" 타이머 + "큰 파일은 시간이 걸릴 수
  있어요" 문구 노출 중. (개선안: 90초 경과 시 추가 안내 문구 — 선택, P2)
- **progress polling**: 1.5초 간격. 과도하지 않음(분당 ~40회). 유지.

### Render plan 비교 (성능)
| plan | vCPU | 2분 MP3(추정) | 3~4분(추정) | 목표 적합 |
|---|---|---|---|---|
| Starter | 0.5 | ~70–110s | ~100–140s | 짧은 파일 경계 |
| **Standard** | 1.0 | **~40–60s** | ~70–90s | **목표 충족 근접** |

## 4. 오류 접수 QA — 각 상황에서 접수번호 표시 확인
| 상황 | 유발 방법 | 기대 |
|---|---|---|
| 잘못된 API KEY | 설정에 틀린 키 | 생성 실패 → **접수번호** + 일반 메시지 |
| 네트워크 끊김 | 와이파이 OFF 후 마스터링 | 일반 메시지(+가능 시 접수번호) |
| 서버 500/502 | 서버 중지/과부하 | 접수번호 |
| job timeout | 초대형 파일 | 접수번호(폴링 타임아웃) |
| 저장 실패 | (드묾) 권한/용량 | 접수번호 |
| 공유 실패 | 공유 취소 외 실패 | 접수번호 |
- 확인 포인트: 사용자에게 **원문(502 HTML/traceback/invalid_api_key) 미노출**,
  서버 로그 `[error-report] receipt_id=…` 생성, (webhook 설정 시) 관리자 알림.

## 5. 회귀 (개발자, 매 빌드)
- [x] `pnpm --filter @aimaster/mobile build`
- [x] `npx cap sync android` (plugin 3종)
- [x] `pnpm --filter @aimaster/desktop typecheck` (데스크톱 무영향)
- [ ] CI: debug APK 빌드 + (secret 시) signed AAB — GitHub Actions 확인

## 6. 알려진 리스크 / 운영 메모
- **긴 작업 중 화면 꺼짐/백그라운드 전환**: keep-awake 플러그인 미추가(신규기능 금지).
  WebView가 백그라운드로 가면 폴링/타이머가 지연될 수 있음. job은 **서버에서 계속
  진행**되며, 앱 복귀 시 폴링 재개로 결과 수신 가능(run-id 가드). 테스터 안내:
  "마스터링 중 화면을 켜두고 앱을 전면에 유지하세요." (문서화로 갈음, 코드변경 없음)
- 오래된 Android(<10)에서 공개 Downloads 직접 쓰기 제한 시 앱 저장소로 **폴백**(경로 표시).

## 7. P0/P1/P2 목록
- **P0 (출시 차단)**: 없음. (빌드/서명/AAB/권한/https/오류접수 준비됨)
- **P1 (공개 전 권장)**:
  1. 브랜드 **앱 아이콘/스플래시** 교체(현재 Capacitor 기본).
  2. **개인정보처리방침 URL**(음원 업로드 → Play 필수). `PRIVACY_AND_DATA_COLLECTION_NOTES.md` 참조.
  3. 공개용 전환 시 **API URL/KEY env 주입 + 입력칸 숨김**.
- **P2 (선택)**:
  1. 90~120초 경과 시 추가 안내 문구.
  2. fast/quality 토글 설명 보강.

## 8. 출시 가능 여부 (점수)
| 항목 | 상태 |
|---|---|
| 내부 테스트(Internal Testing) 등록 | ✅ 가능 (P0 없음) |
| 공개(Production) | ⏳ P1 3건 선행 필요 |

**내부 테스트 준비도: 8.5 / 10** — 빌드·서명·AAB·권한·오류접수·플로우 완비.
공개는 아이콘·개인정보처리방침·키 주입 완료 시 9.5+/10.
