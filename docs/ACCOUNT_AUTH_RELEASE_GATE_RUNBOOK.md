# 계정 기반 인증 — Release Gate 통합검증 런북 (Phase A~D2)

목적: 계정 로그인 → entitlement → license claim → 기기제한 → Export 게이트 전체를
실제 앱 런타임에서 검증하고, 출시 플래그를 결정한다.

대상 커밋: `claude/gifted-babbage-6bd4gc` (A~D2 반영).
관련: `docs/ACCOUNT_AUTH_FLAG_STRATEGY.md`, `docs/ACCOUNT_BASED_AUTH_MIGRATION_PLAN.md`.

---

## A. 이 환경에서 이미 검증된 항목 (정적/백엔드)

| 항목 | 결과 | 근거 |
|---|---|---|
| typecheck / full build (OFF/OFF) | ✅ | tsc + vite + esbuild |
| preload allowlist (license:*, entitlement:set, device:get-id) | ✅ | grep 확인 |
| main 핸들러 등록(license, entitlement/device) | ✅ | index.ts |
| Export 게이트 = `license \|\| getEntitlementPaid()` | ✅ | fileHandlers (무수정) |
| `getEntitlementPaid()` = entitlementPaid && deviceAllowed | ✅ | entitlementBridge |
| claim_license RPC: ok/already_claimed/멱등/not_found/expired/invalid_status | ✅ | 격리 DB 테스트(정리됨) |
| claim → entitlements active/pro_lifetime, B 미부여 | ✅ | 〃 |
| register_device: 2대 허용 / 3대 차단 / 해제 후 재등록 / revoked 제외 | ✅ | 격리 DB 테스트(정리됨) |
| RLS: entitlements select-own / 나머지 service_role 전용 | ✅ | pg_policies |
| 민감정보 로그 없음(paid/deviceAllowed bool만, JWT/email 미기록) | ✅ | 코드 grep |
| **P0 수정**: `aimaster` 스키마 PostgREST 노출(edge 도달 가능) | ✅ | pgrst.db_schemas |

> 아래 B는 디스플레이가 필요해 **MacBook GUI**에서 수행.

---

## B. MacBook GUI end-to-end 검증

### 0. 준비
```bash
cd ~/work/AImastering && git pull origin claude/gifted-babbage-6bd4gc
cd aimaster-desktop
export AIMASTER_PYTHON="$PWD/services/python-audio/.venv/bin/python"
export VITE_SUPABASE_URL="https://tyrhbiwvwmdybwaydvto.supabase.co"
export VITE_SUPABASE_ANON_KEY="<anon key: Supabase Settings→API>"
pnpm --filter @aimaster/desktop dev
```
- Supabase 대시보드: Auth→Providers→**Email 활성화**(테스트 편의로 Confirm email 끄기).
- 플래그(DevTools 콘솔 → `location.reload()`):
  ```js
  window.__LOUI_ACCOUNT_AUTH__ = true;      // 계정 UI
  window.__LOUI_ENTITLEMENT_GATE__ = true;  // entitlement 게이트
  location.reload();
  ```
- **dev 라이선스 바이패스 주의**: `NODE_ENV=development`/`AIMASTER_DEV_LICENSE=1`이면 `licensePaid`가 항상 true. "license 없음" 시나리오는 `unset` 후 실행하고 `await window.electronAPI.invoke('license:status')`로 `tier:'free'` 확인.
- 게이트 로그: `tail -f ~/Library/Logs/"Louver Mastering AI"/main.log` → `[export-gate] … source=…`, `[entitlement] gate set …`.
- entitlement 상태 조작(SQL): `update aimaster.entitlements set plan='pro_monthly',status='active',expires_at=now()+interval '31 days' where user_id='<id>';`

### 검증 시나리오

| # | 동작 | 기대 | 결과 |
|---|---|---|---|
| 1 | 우상단 "로그인" → email/pw 회원가입 → 로그인 | 로그인됨, 모달에 이메일/구독상태 | [ ] |
| 2 | 앱 재시작 | 세션 복원(우상단 계정 표시), entitlement 재조회 | [ ] |
| 3 | (모달) 구독 상태 표시 | `aimaster-entitlement` 조회 → free/Pro 표시 | [ ] |
| 4 | "기존 라이선스 연결"에 유효 키 입력 | 성공 메시지, 구독 active 전환 | [ ] |
| 4b | 이미 연결된 키를 다른 계정에서 입력 | "이미 다른 계정에 연결된 키" | [ ] |
| 4c | 없는/만료/환불 키 | 각각 명확한 실패 메시지 | [ ] |
| 5 | (자동) 로그인 시 현재 기기 등록 + 목록에 "(현재 기기)" | 1대 등록 | [ ] |
| 6 | 두 번째 기기 로그인 | 2대까지 정상 | [ ] |
| 7 | 세 번째 기기 로그인 | 기기 한도 초과 안내, entitlement Export 차단 | [ ] |
| 8 | 다른 기기 "해제" | 목록에서 제거, 현재 기기 재등록 | [ ] |
| 9 | GATE ON + entitlement active + 기기 OK → WAV/FLAC/AIFF 저장 | 저장 성공, 로그 `source=entitlement` | [ ] |
| 10 | license 활성(바이패스 OFF에서 키 활성화) + entitlement 없음 → WAV 저장 | 저장 성공, `source=license` | [ ] |
| 11 | license + entitlement 둘 다 → WAV 저장 | 저장 성공, `source=license+entitlement` | [ ] |
| 12 | 둘 다 없음 → WAV 저장 | 차단 + LicenseModal, `source=none` | [ ] |
| 13 | 3대째(entitlement 차단) + license 활성 | **license로 저장 성공** | [ ] |
| 14 | entitlement API 실패(Network Offline) + license 활성 | 저장 성공(`source=license`) | [ ] |
| 15 | entitlement API 실패 + license 없음 | 차단(`source=none`) | [ ] |
| 16 | MP3 / OGG 저장(모든 상태) | 항상 무료 저장(게이트 없음) | [ ] |
| 17 | 로그 점검 | source 4종 관측 + email/JWT/token **미노출** | [ ] |
| 18 | OFF/OFF로 토글(`window.__LOUI_ACCOUNT_AUTH__=false`,`__LOUI_ENTITLEMENT_GATE__=false`,reload) | 계정 UI 없음, 기존 license Export 100% 동일 | [ ] |

---

## C. 발견된 P0 / P1 / P2

### P0 (출시 차단) — **없음**
- 기본 OFF/OFF는 현행 license 동작과 동일(정적/빌드 검증). 백엔드 RPC/RLS 검증 통과.
- (Phase D1에서 잡은 P0 — aimaster 스키마 미노출 — 이미 수정됨.)

### P1 (계정제 GA 전 해결 권장 / OFF-OFF 출시는 비차단)
- **P1-1 Google OAuth 데스크톱 리다이렉트 미완성**: email/pw는 동작. Google은 `signInWithOAuth` 호출까지만 — Electron 외부 브라우저 복귀(딥링크) 핸들러 미구현 → 데스크톱에서 Google 로그인 완료 안 됨. (계정 ON GA 전 딥링크 구현 또는 Google 버튼 일시 숨김.)
- **P1-2 장시간 세션 staleness**: 앱 장시간 켠 채 서버측 구독 취소/기기 변경 시, 재조회 전까지 게이트가 마지막 push 유지(라이선스 오프라인 grace와 동일 성격). GATE ON에서만 의미. → 주기적 `entitlement:revalidate`/기기 재확인(Phase E)로 해소. license fallback이 과차단은 막음.

### P2 (출시 후 개선)
- supabase-js가 OFF 빌드에도 번들됨(용량 경고) → lazy-import 최적화 가능.
- AUTH ON / GATE OFF 베타에서 3대째 로그인 시 "기기 한도 초과" 문구가 보이지만 Export에는 영향 없음(베타 한정 UX 혼동).

---

## D. 출시 가능 플래그 권장값
- **Production GA(현재 권장)**: `ACCOUNT_AUTH_ENABLED=OFF`, `ENTITLEMENT_GATE_ENABLED=OFF` → **현행 라이선스 출시**.
- **내부 QA 빌드**: `AUTH=ON / GATE=OFF`(계정 UI 베타) → 통과 후 `AUTH=ON / GATE=ON`(entitlement 정식)로 QA.
- **계정 entitlement GA**는 P1-1/P1-2 해결 + 키→계정 이관 채택률 확보 후 별도 결정.

---

## E. CI(Actions) 빌드
- 본 변경은 renderer/main + 신규 의존성(`@supabase/supabase-js`)만. `build.yml` 변경 없음.
- 로컬 `pnpm build` 통과 = 동일 빌드 경로. **권장**: `workflow_dispatch`로 1회 빌드 돌려 Windows NSIS 산출 확인(아티팩트 다운로드).
- 계정 플래그는 **CI에 주입하지 않음**(기본 OFF) → 릴리스 빌드는 OFF/OFF.

## 판정란
- 검증자/일자: ______ / B 결과: ______ / 추가 P0·P1: ______
- 최종: ☐ OFF/OFF GA 승인 / ☐ QA에서 ON 계속 / ☐ 차단(사유:____)
