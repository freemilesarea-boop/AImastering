# Guided Flow QA Checklist (플래그 ON 기본화 전)

대상: `VITE_LOUI_GUIDED_FLOW=true`에서 **Import → Choose → Mastering → Result → Export** 흐름이
기존 기능을 깨지 않는지 실제 Electron 앱으로 검증.

- 코드 수정 금지 — **QA 문서**. 실패 시 이슈로 기록만.
- 각 항목 `[ ]` 에 **PASS / FAIL / BLOCKED** 표기. BLOCKED = 선행 항목 실패로 검증 불가.
- 구현 근거: 브랜치 `claude/gifted-babbage-6bd4gc`, 커밋 T1~T10.

---

## 0. 사전 이해 (검증 전 필독)

- **플래그**: 기본 OFF. ON 방법 2가지 — (A) 빌드/실행 env `VITE_LOUI_GUIDED_FLOW=true` (B) DevTools 콘솔 `window.__LOUI_GUIDED_FLOW__ = true` 후 새로고침.
- **dev 라이선스 바이패스 주의**: license-core는 `NODE_ENV=development` 또는 `AIMASTER_DEV_LICENSE=1`이면 `canProcess()`가 항상 paid 처리 → **6절(페이월)이 안 잡힐 수 있음**. 6절은 바이패스 OFF 상태에서 검증(0-3 참조).
- **dev 검증기**: dev 빌드는 `LICENSE_API_URL` 미주입 → LocalValidator. 즉 **형식만 맞는 키(`AIMASTER-XXXX-XXXX-XXXX`)면 활성화** = Pro. 서버 검증은 별도(프로덕션 빌드 QA에서).

---

## 1. 실행 준비

| ID | 동작 | 기대 결과 | 결과 |
|---|---|---|---|
| 1-1 | `cd aimaster-desktop && pnpm install` (최초 1회) | 의존성 설치 성공 | [ ] |
| 1-2 | `VITE_LOUI_GUIDED_FLOW=true pnpm --filter @aimaster/desktop dev` 실행 | Vite(5173) + esbuild watch + Electron 창 기동 | [ ] |
| 1-3 | 앱 첫 화면 확인 | **가이드 Import 화면**("트랙을 올리면, 마스터가 됩니다." + 큰 드롭존)이 보임 (레거시 큐 UI 아님) | [ ] |
| 1-4 | (대안) 콘솔 `window.__LOUI_GUIDED_FLOW__=true` → 새로고침 | 동일하게 가이드 화면 노출 | [ ] |
| 1-5 | 0-3 바이패스 상태 확인: 콘솔 `await window.electronAPI.invoke('license:status')` | `tier`/`canSaveMasterWav` 확인. 6절 전 무료(`tier:'free'`)인지 점검 | [ ] |

> 6절(페이월) 검증 전, dev 바이패스가 켜져 있으면 끄고 재실행: `NODE_ENV`/`AIMASTER_DEV_LICENSE` 미설정으로 `pnpm dev`.

---

## 2. Import 검증

| ID | 동작 | 기대 결과 | 결과 |
|---|---|---|---|
| 2-1 | 드롭존 클릭 → 파일 선택 다이얼로그에서 WAV 선택 | Choose 화면으로 이동 | [ ] |
| 2-2 | 파일을 드롭존에 **드래그앤드롭**(wav/mp3/flac/m4a) | 드래그 중 테두리 하이라이트 → 드롭 시 Choose 이동 | [ ] |
| 2-3 | **잘못된 파일**(예: .txt) 드래그 | 무시됨(이동 안 함, 크래시 없음) | [ ] |
| 2-4 | Choose에서 "← 파일 다시 선택" | Import로 복귀 | [ ] |
| 2-5 | 파일 선택 후 앱 새로고침/재진입 | 파일이 있으면 Choose부터 시작(선택 유지) | [ ] |
| 2-6 | (해당 시) 파일명 표시 | Mastering/Result에서 올바른 파일명 노출 | [ ] |

---

## 3. Choose 검증

| ID | 동작 | 기대 결과 | 결과 |
|---|---|---|---|
| 3-1 | Style 미선택 상태 | Start 버튼 비활성("스타일을 선택하세요") | [ ] |
| 3-2 | **Balanced** 선택 | 카드 선택 표시, Start 활성, 라벤더 액센트 | [ ] |
| 3-3 | **Loud** 선택 | 선택 전환 | [ ] |
| 3-4 | **KPOP Loud** 선택 | 시그니처 그라데이션/뱃지, Start 버튼이 **KPOP 액센트**로 전환 | [ ] |
| 3-5 | Intensity **Standard/Strong** 토글 | 선택 시각화 전환 | [ ] |
| 3-6 | Target **Universal/Spotify/YouTube/Apple** 선택 | 선택 전환, 각 LUFS 캡션 표시(−14/−14/−14/−16) | [ ] |
| 3-7 | **options 매핑 확인**(콘솔: `useAudioStore`나 마스터 후 결과로 추정) — Balanced+Standard+Spotify | `targetLufs=-14, limiterStrength='medium'` | [ ] |
| 3-8 | Balanced + **Strong** + Apple | `targetLufs=-15`(−16 +1), `limiterStrength='high'` | [ ] |
| 3-9 | **KPOP Loud + Strong** | `targetLufs=-9`(불변), `targetTp=-0.8`, `limiterStrength='high'` | [ ] |
| 3-10 | Loud + Standard | `targetLufs=-10`, `targetTp=-1.0`, `medium` | [ ] |
| 3-11 | Start 클릭 | Mastering 화면으로 이동 | [ ] |

> 매핑 검증 팁: Result 화면의 "마스터 LUFS"가 위 targetLufs 근처로 수렴하는지로 간접 확인 가능.

---

## 4. Mastering 검증

| ID | 동작 | 기대 결과 | 결과 |
|---|---|---|---|
| 4-1 | Start 직후 | 진행률 링 0%→증가, `%` 숫자 표시 | [ ] |
| 4-2 | 진행 중 단계 텍스트 | 분석 → 톤 보정 → 음압 강화 → 트루피크 보호 순으로 전환 | [ ] |
| 4-3 | KPOP Loud로 진입 시 | 링/게이지/뱃지가 **KPOP 시그니처 액센트** | [ ] |
| 4-4 | LUFS 목표 게이지 | 진행에 따라 채워지고 목표선(틱) 보임 | [ ] |
| 4-5 | **취소** 버튼 | 처리 중단, 이전 화면 복귀(크래시 없음) | [ ] |
| 4-6 | **실패 유도**(예: 손상/0바이트 파일) | ErrorCard + 코드/힌트 표시, "다시 시도" 노출 | [ ] |
| 4-7 | "다시 시도" | 재처리 시작 | [ ] |
| 4-8 | 정상 완료 | 자동으로 **Result 화면 이동** | [ ] |
| 4-9 | (회귀) 실제 `audio:master` 호출 동작 | 기존과 동일하게 Python 엔진 처리 성공(로직 불변) | [ ] |

---

## 5. Result 검증

| ID | 동작 | 기대 결과 | 결과 |
|---|---|---|---|
| 5-1 | 상단 성취 헤더 | **+X.X LU** 카운트업(= 마스터−원본 실측치) | [ ] |
| 5-2 | KPOP Loud 결과 | "KPOP LOUD 완성" 뱃지/문구 + 시그니처 색 | [ ] |
| 5-3 | Loudness 카드 | 원본/마스터 **LUFS 바 애니메이션** + 목표 점선, 실수치 표시 | [ ] |
| 5-4 | Waveform 카드 | 원본(얇음)→마스터(꽉 참) 막대 애니메이션, 트루피크 라인 | [ ] |
| 5-5 | **A/B 비교**(기존 SaveButtons/플레이어 영역) | 원본/마스터 비교·재생 동작 | [ ] |
| 5-6 | "다시 마스터링" | 기존 동작대로 동작(reset/재처리) | [ ] |
| 5-7 | "새 파일"/홈 복귀 | Import로 복귀, 상태 초기화 | [ ] |
| 5-8 | 중복 표시 없음 | 가이드 헤더가 있을 때 레거시 "마스터링 완료" 배너는 숨김 | [ ] |

---

## 6. License / Paywall 검증 (dev 바이패스 OFF 상태)

| ID | 동작 | 기대 결과 | 결과 |
|---|---|---|---|
| 6-1 | 무료(`tier:free`)에서 **마스터 WAV 저장** 시도 | 저장 차단 → **LicenseModal 오픈** + 경고 토스트 | [ ] |
| 6-2 | **프리뷰 MP3 저장** 시도 | **무료로 저장 성공**(차단 안 됨) | [ ] |
| 6-3 | LicenseModal에 형식 맞는 키 입력(`AIMASTER-AAAA-BBBB-CCCC`) → 활성화 | Pro 전환, 모달 닫힘 | [ ] |
| 6-4 | 활성화 후 **마스터 WAV 저장** | **저장 성공** | [ ] |
| 6-5 | (회귀) 페이월은 메인 프로세스에서 강제 | 콘솔/저장 경로 우회 시도해도 WAV 차단 유지 | [ ] |

> 6-1이 안 잡히면 dev 바이패스(NODE_ENV/AIMASTER_DEV_LICENSE) 확인 → OFF 후 재검증. (BLOCKED 처리)

---

## 7. Batch Mode 회귀 검증

| ID | 동작 | 기대 결과 | 결과 |
|---|---|---|---|
| 7-1 | Import 하단 "배치 모드" 링크 클릭 | 기존 **HomePage(큐/배치 UI)** 진입 | [ ] |
| 7-2 | "← 가이드 모드" 버튼 | 가이드 Import로 복귀 | [ ] |
| 7-3 | 배치에서 여러 파일 추가(드래그/선택, 최대 20) | 큐에 정상 추가 | [ ] |
| 7-4 | 배치 처리 실행 | 기존대로 분석/마스터링/저장 동작(깨짐 없음) | [ ] |
| 7-5 | 배치 저장 페이월 | 마스터 WAV는 무료 차단/Pro 허용 동일 적용 | [ ] |

---

## 8. 플래그 OFF 회귀 검증

| ID | 동작 | 기대 결과 | 결과 |
|---|---|---|---|
| 8-1 | env 없이 `pnpm --filter @aimaster/desktop dev`(또는 `window.__LOUI_GUIDED_FLOW__=false`) | 첫 화면이 **레거시 HomePage**(기존 UI) | [ ] |
| 8-2 | 기존 Import→Mastering→Result 흐름 | 변화 없이 정상 | [ ] |
| 8-3 | Mastering 화면 | 기존 **5단계 리스트 + 진행바**(링 아님) | [ ] |
| 8-4 | Result 화면 | 기존 레이아웃("마스터링 완료" 배너 등) 그대로 | [ ] |
| 8-5 | 저장/페이월/Tweak/QC/Settings | 전부 기존대로 | [ ] |

---

## 9. 최종 판정 기준

### 플래그 기본 ON 가능 조건 (모두 충족 시)
- [ ] 2~5절 **전 항목 PASS** (가이드 흐름 정상)
- [ ] 6절 페이월 PASS (무료 WAV 차단 / Pro 허용 / MP3 무료)
- [ ] 7절 배치 회귀 PASS (기능 손실 0)
- [ ] 8절 OFF 회귀 PASS (롤백 안전)
- [ ] 크래시/화이트스크린 0건

### P0 — 실패 시 ON 불가 (배포 차단)
- 가이드 흐름 중 크래시/화이트스크린
- Mastering 미완료/Result 미이동(4-8)
- 페이월 미작동: 무료에서 마스터 WAV 저장됨(6-1)
- 배치 모드 또는 OFF 회귀 깨짐(7,8)
- options 매핑 오류로 의도와 다른 음압(3-7~3-10)

### P1 — 수정 권장 (ON 가능하나 빠른 후속)
- 단계 텍스트/액센트 등 시각 불일치
- A/B·카운트업·애니메이션 미세 버그
- 잘못된 파일 처리 시 안내 부재(무시는 OK, 토스트 권장)

### P2 — 출시 후 개선
- 디자인 미세 폴리시, 햅틱/사운드, 데모 트랙, 파형 PNG 실데이터 연결

---

## 기록 양식 (요약)

| 절 | PASS | FAIL | BLOCKED | 비고 |
|---|---|---|---|---|
| 1 실행 | | | | |
| 2 Import | | | | |
| 3 Choose | | | | |
| 4 Mastering | | | | |
| 5 Result | | | | |
| 6 Paywall | | | | |
| 7 Batch | | | | |
| 8 OFF 회귀 | | | | |

**최종 판정**: ☐ ON 기본화 승인 / ☐ P0 수정 필요 / ☐ 재검증 필요
**검증자 / 일자 / 빌드 커밋**: __________
