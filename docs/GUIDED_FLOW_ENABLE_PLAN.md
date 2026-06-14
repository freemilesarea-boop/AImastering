# Guided Flow 기본화(ON) 전환 계획

목적: Guided Flow("세 가지만 고르면 끝")를 **기본 Home UI**로 켜기 전에,
전환 조건 · 방식 · 롤백 · 배포 전후 검증 · Go/No-Go를 사업/기술 양쪽 기준으로 확정.

- 상태: 현재 플래그 기본 **OFF** (`renderer/audio/guided-flow-flag.ts`). 레거시 HomePage가 기본.
- 관련: `docs/GUIDED_FLOW_QA_CHECKLIST.md`, 브랜치 `claude/gifted-babbage-6bd4gc`(커밋 T1~T10).
- 본 문서는 **계획서** — 실제 전환(플래그 켜기)은 아래 조건 충족 후 별도 작업.

---

## 1. 전환 조건 (모두 충족해야 ON 검토)

- [ ] QA 체크리스트 기준 **P0 0건**
- [ ] **Import → Choose → Mastering → Result → Export** 실제 GUI 흐름 통과(2~5절)
- [ ] **License/Paywall** 검증 통과(6절: 무료 WAV 차단 / Pro 허용 / MP3 무료) — *dev 바이패스 OFF 상태에서*
- [ ] **Batch Mode 회귀** 통과(7절: 기존 큐/배치 기능 손실 0)
- [ ] **Flag OFF 레거시 회귀** 통과(8절: 기존 UI/흐름 보존)
- [ ] 크래시/화이트스크린 0건
- [ ] (권장) 실제 음원 3종 스모크 통과(4절)

> 위 중 하나라도 미충족 = **ON 보류**. 부분 ON(예: 내부 베타 채널)만 허용.

---

## 2. 전환 방식 — 두 가지 비교 후 권장

| | A. 코드 기본값 OFF→ON | B. 프로덕션 빌드 env 주입 |
|---|---|---|
| 변경 위치 | `guided-flow-flag.ts` 기본 반환값 1줄 | `build.yml` 빌드 스텝 `VITE_LOUI_GUIDED_FLOW=true` |
| 적용 범위 | dev·모든 빌드·모든 플랫폼 일괄 | 프로덕션 빌드만(원하는 플랫폼만) |
| dev 영향 | dev도 ON(개발자 혼란 가능) | dev는 OFF 유지(개발자 opt-in) |
| 롤백 속도 | 코드 revert + 재빌드/재배포 | **env 제거 후 재빌드**(코드 변경 0) |
| 단계적 출시 | 어려움(전부 ON) | 쉬움(플랫폼/채널별) |
| 실수 위험 | 낮음(한 곳) | 중간(빌드 경로마다 env 누락 주의) |

**권장: 1차 = B(프로덕션 env 주입). — 이미 배선됨.**
- 이유: 롤백이 **코드 변경 없이 env 토글**로 가능 → 사고 시 가장 빠르고 안전. dev는 영향 없음. 채널/플랫폼별 점진 ON 가능.
- **구현 상태**: `.github/workflows/build.yml`의 3개 플랫폼 빌드 스텝(linux/mac/win) `Build Electron app` env에 다음이 추가됨:
  ```yaml
  VITE_LOUI_GUIDED_FLOW: ${{ startsWith(github.ref, 'refs/tags/v') && 'true' || 'false' }}
  ```
  → **태그(`v*`) 푸시 = 프로덕션 릴리스 빌드에서만 ON**. 브랜치/`workflow_dispatch` 아티팩트는 OFF(레거시 Home). `AUTO_UPDATE_ENABLED`와 동일 조건. renderer(Vite)가 `import.meta.env.VITE_LOUI_GUIDED_FLOW`로 읽음.
- **로컬 dev**: 기본 OFF. ON 검증은 `VITE_LOUI_GUIDED_FLOW=true pnpm --filter @aimaster/desktop dev` 로만.
- **코드 기본값 불변**: `guided-flow-flag.ts`는 여전히 `return false`(기본 OFF). 코드 기본값 ON 변경 없음.
- **2차(안정화 후, 선택)**: 한 릴리스 주기 무사고 시 A(코드 기본값 ON)로 단순화 — 그때 env 주입 제거.

> 런타임 킬스위치: `window.__LOUI_GUIDED_FLOW__`가 최우선이라 디버그/지원 시 콘솔로 즉시 토글 가능(패키지 앱에선 DevTools 필요).

---

## 3. 롤백 방식 (빠른 순)

1. **(최속) 릴리스 빌드 OFF** — `build.yml`의 3개 `VITE_LOUI_GUIDED_FLOW` 값을 `'false'`로 바꾸거나 라인 제거 후 재태그/재빌드. (현재는 태그 시 자동 ON 구조이므로, 긴급 시엔 비-태그 핫픽스 빌드로 배포하면 OFF.) 코드 로직 변경 0.
2. **기본값 되돌림** — 방식 A로 켰다면 `guided-flow-flag.ts` 기본 `return false`로 1줄 revert.
3. **커밋 revert** — 문제 원인이 특정 티켓(T6 라우팅, T8 ResultPage, T9 MasteringPage)일 때 해당 커밋만 `git revert`(가산/조건 분기 구조라 부분 롤백 안전).
4. **Release hotfix** — 이미 배포된 설치본 대상: 패치 버전 태그 → 서명 빌드 → draft → publish → 자동 업데이트로 배포. (mac은 공증 전제 → 현재 Windows 우선.)

**롤백 트리거 기준**: P0 발생(아래 6절) 또는 핵심 지표 급락(아래 5절 임계) 시 즉시 1번 실행.

---

## 4. 배포 전 검증

| 단계 | 절차 | 기대 |
|---|---|---|
| typecheck | `pnpm --filter @aimaster/desktop typecheck` | 0 에러 |
| build (OFF/ON 양쪽) | `build` / `VITE_LOUI_GUIDED_FLOW=true build` | 둘 다 성공 |
| Windows NSIS 생성 | 태그 푸시 또는 workflow_dispatch → `build-win` | `*-Setup-*.exe` + `latest.yml` 산출 |
| 설치 후 실행 | 깨끗한 Windows 10/11에서 설치→실행 | SmartScreen 후 정상 기동, 첫 화면=가이드 Import |
| **실음원 3종 스모크** | 아래 3곡으로 Import→Choose→Mastering→Result→Export | 각 PASS |

실음원 3종(필수):
- **일반 발라드** → Style=Balanced, Target=Spotify: +LU 합리적(과압축 없음), LUFS≈−14, 보컬 또렷, WAV 저장(Pro) OK
- **AI 음악**(생성형) → Balanced/Loud: 아티팩트 악화 없음, 클립 0, Result 정상
- **KPOP Loud 대상 곡** → Style=KPOP Loud, Strong: LUFS≈−9, True Peak 안전(−0.8 이내), 보컬 살아있음, "KPOP LOUD 완성" 노출

> 3곡 중 1곡이라도 Result/Export 실패 또는 명백한 음질 파탄 = **No-Go**.

---

## 5. 배포 후 모니터링

> ⚠️ **현 상태: 퍼널 텔레메트리 미계측.** 앱에는 `electron-log` + `failureLog`(지원 번들)만 있고, 사용자 행동 분석(이탈/도달/클릭율)은 수집 안 됨. Sentry(MCP 연결 가능)도 앱 미연동.
> → ON 기본화의 **선행 또는 병행 P1**: 경량·옵트인 텔레메트리(또는 Sentry breadcrumb)로 아래 이벤트만이라도 계측. 미계측 시 **정성 베타 피드백 + 크래시/실패 로그**로 대체 판단.

추적 대상 이벤트 / 지표 / 경보 임계(가이드값):

| 지표 | 정의 | 경보(롤백 검토) 임계 |
|---|---|---|
| 첫 화면 이탈율 | Import에서 아무 동작 없이 종료 | 베이스라인 대비 +10%p↑ |
| Import 실패율 | 파일 선택/드롭 후 Choose 미도달 | > 5% |
| Mastering 실패율 | `audio:master` 에러/타임아웃 | > 3% (기존 대비 상승 시) |
| Result 도달율 | Mastering 시작→Result 진입 | < 90% |
| Export 클릭율 | Result에서 저장 버튼 클릭 | 베이스라인 하회 시 점검 |
| Paywall 도달율 | 무료에서 WAV 저장 차단 발생 | 정상 범위(전환 퍼널 지표) |
| 크래시율 | render-process-gone/uncaught | > 0.5% 세션 |

대체 신호(텔레메트리 전): failureLog 코드 분포, 지원 번들 수신, 스토어/리뷰 피드백, 베타 채널 수동 관찰.

---

## 6. 최종 Go / No-Go 기준

### ✅ Go (기본 ON 승인)
- 1절 전환 조건 전부 충족 + P0 0건
- 배포 전 검증(4절) 전 항목 PASS, 실음원 3종 PASS
- 롤백 레버(env OFF) 동작 확인됨
- (텔레메트리 있으면) 베이스라인 대비 핵심 지표 비악화

### ⛔ No-Go (ON 불가 / 즉시 롤백)
- 가이드 흐름 크래시/화이트스크린
- Mastering 미완료 또는 Result 미도달(4-8)
- 페이월 무력화(무료에서 마스터 WAV 저장됨)
- Batch/Flag-OFF 회귀 깨짐
- 실음원 3종 중 Result/Export 실패 또는 음질 파탄
- (배포 후) 5절 경보 임계 초과

### 처리 기준
- **P0**: Go 차단 / 발생 시 즉시 3절-1 롤백 후 원인 수정 → 재검증.
- **P1**: ON 가능하나 차기 패치 필수(시각 불일치, 텔레메트리 부재, 잘못된 파일 안내 등).
- **P2**: 출시 후 개선(디자인 폴리시, 햅틱/사운드, 데모 트랙, 파형 PNG 실데이터).

---

## 권장 전환 시퀀스 (요약)
1. QA 체크리스트로 P0 0건 확인(+실음원 3종).
2. (P1) 경량 텔레메트리/ Sentry breadcrumb 최소 계측 추가 — 가능하면 ON 전.
3. **방식 B (배선 완료)**: 태그(`v*`) 푸시 → 3개 플랫폼 릴리스 빌드가 자동으로 `VITE_LOUI_GUIDED_FLOW=true` → 서명/배포. (별도 작업 불필요, 태그만 푸시.)
4. 배포 후 5절 모니터링. 임계 초과 시 **3절-1 롤백**.
5. 한 릴리스 주기 무사고 → **방식 A**(코드 기본값 ON)로 단순화, env 정리.

**판정 양식**: ☐ Go(기본 ON) / ☐ No-Go(보류) / ☐ 조건부(베타 채널만)
**결정자 / 일자 / 빌드 커밋 / 근거**: __________
