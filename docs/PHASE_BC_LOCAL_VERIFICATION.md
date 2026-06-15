# Phase B/C 로컬 검증 런북

목적: 계정 entitlement 조회 + additive Export 게이트가 런타임에서 안전하게 동작하는지 확인.
모든 항목 `[ ]` 에 **PASS / FAIL** 표기. (이 환경은 디스플레이가 없어 GUI 검증은 MacBook에서 수행)

이미 확정된 정적/백엔드 검증(이 문서 작성 시점):
- typecheck ✅ / full build ✅
- 게이트 3사이트(`save-wav`/`save-audio`/`batch-save-wav`) = `isMasterExport` + `paidStatus()`(license||entitlement) + source 로그 ✅
- 무료정책: `FREE_EXPORT_EXTS = {mp3, ogg}` ✅
- 백엔드: `aimaster.entitlements` plan(free/pro_monthly/pro_lifetime)·status(free/active/past_due/canceled/expired/refunded)·provider(paddle/app_store/play_billing/revenuecat/manual)·unique(user_id)·**RLS select-own only** ✅
- 엣지 `aimaster-entitlement` verify_jwt=true ✅
- **민감정보(email/JWT/token) 로깅 없음**, `entitlement:set` payload = `{paid,plan,status}`만 ✅

---

## 0. 사전 준비

```bash
cd ~/work/AImastering && git pull origin claude/gifted-babbage-6bd4gc
cd aimaster-desktop
```

`.env`(또는 셸 env)에 Supabase 주입 — 렌더러(Vite):
```bash
export VITE_SUPABASE_URL="https://tyrhbiwvwmdybwaydvto.supabase.co"
export VITE_SUPABASE_ANON_KEY="<프로젝트 anon key>"   # Supabase 대시보드 Settings→API
```
Supabase 대시보드에서 **Auth → Providers → Email 활성화**(+ 테스트 편의상 "Confirm email" 끄기), Google은 선택.

dev 실행:
```bash
export AIMASTER_PYTHON="$PWD/services/python-audio/.venv/bin/python"   # (엔진 venv, 기존 절차)
pnpm --filter @aimaster/desktop dev
```

### 플래그 토글 (DevTools 콘솔 → 새로고침)
```js
window.__LOUI_ACCOUNT_AUTH__   = true;   // 계정 auth
window.__LOUI_ENTITLEMENT_GATE__ = true; // entitlement 게이트
location.reload();
// 끄려면 각각 false 후 reload
```

### ⚠️ dev 라이선스 바이패스 (필수 인지)
`NODE_ENV=development` 또는 `AIMASTER_DEV_LICENSE=1`이면 `licensePaid()`가 **항상 true**(바이패스) → "license 없음" 시나리오(3,5,6) 검증 불가.
→ 해당 시나리오는 **바이패스 OFF**(`unset NODE_ENV AIMASTER_DEV_LICENSE`)로 재실행하고 `license:status`로 free 확인.
```js
await window.electronAPI.invoke('license:status')   // tier:'free' 확인
```

### 메인 프로세스 게이트 로그 보기
`[export-gate] …` / `[entitlement] …` 는 메인 로그(electron-log):
- macOS: `~/Library/Logs/Louver Mastering AI/main.log` (또는 dev 콘솔)
```bash
tail -f ~/Library/Logs/"Louver Mastering AI"/main.log
```

### entitlement 상태 세팅 (로그인 후, SQL)
로그인하면 `auth.users`에 사용자 생성 + 첫 조회 시 free entitlement 자동 생성.
상태를 바꾸려면(SQL Editor 또는 MCP):
```sql
-- 본인 user_id 찾기
select id, email from auth.users where email = 'YOU@example.com';

-- active pro_monthly 로 설정 (시나리오 4)
update aimaster.entitlements
set plan='pro_monthly', status='active', provider='manual',
    expires_at = now() + interval '31 days'
where user_id = '<USER_ID>';

-- 없음/free 로 되돌리기 (시나리오 3)
update aimaster.entitlements
set plan='free', status='free', expires_at=null where user_id='<USER_ID>';
```

---

## 1~11. 검증 시나리오

| # | 조건 | 동작 | 기대 결과 / 로그 | 결과 |
|---|---|---|---|---|
| 1 | **OFF/OFF**(기본) | WAV 저장(미결제) | 기존과 동일: 차단→LicenseModal, `source=none`. 결제(라이선스)면 저장, `source=license` | [ ] |
| 2 | ACCOUNT_AUTH **ON** / GATE **OFF** | WAV 저장 | 1과 **완전 동일**(entitlement 무시). `source=license`/`none` | [ ] |
| 3 | 둘 **ON** / entitlement 없음(free) + **license 없음** | WAV 저장 | **차단** + LicenseModal. `paid=false source=none` | [ ] |
| 4 | 둘 **ON** / entitlement **active pro_monthly** | WAV·FLAC·AIFF 저장 | **저장 성공**. `paid=true source=entitlement` | [ ] |
| 5 | entitlement **API 실패**(예: 네트워크 차단/로그아웃) + **license paid** | WAV 저장 | **저장 성공**. `source=license` (entitlement=false라도 무관) | [ ] |
| 6 | entitlement **API 실패** + **license 없음** | WAV 저장 | **차단**. `paid=false source=none` | [ ] |
| 7 | 모든 상태 | **MP3/OGG 저장** | **항상 무료 저장**(게이트 없음, 로그 없음) | [ ] |
| 8 | 위 과정 | 로그 source 확인 | `license` / `entitlement` / `license+entitlement`(둘 다 paid) / `none` 모두 관측 | [ ] |
| 9 | 위 과정 | 로그 점검 | `[export-gate]`/`[entitlement]`에 **email/JWT/token 없음** | [ ] |
| 10 | 둘 ON / 로그인+active 상태 | **앱 재시작** | 재시작 후 세션 복원(우상단 계정), entitlement 재조회 → 다시 `source=entitlement` 가능 | [ ] |
| 11 | — | `pnpm --filter @aimaster/desktop typecheck && pnpm … build` | 통과 | [ ] |

### 시나리오 5 "entitlement API 실패" 만드는 법
- 로그인 상태에서 DevTools **Network → Offline** 토글 후 새로고침(entitlement refresh 실패 → `entStatus='error'` → 게이트 false), 또는 로그아웃(세션 없음 → false). license는 별도로 활성화해 둔 상태.

### 시나리오 8 "license+entitlement" 만드는 법
- license 활성화(유료) + entitlement active 동시 → WAV 저장 시 `source=license+entitlement`.

---

## 빠른 기대값 매트릭스 (게이트 공식 `paid = licensePaid || entitlementPaid`)

| ACCOUNT_AUTH | GATE | licensePaid | entitlement(active pro) | paid | source |
|---|---|---|---|---|---|
| OFF | OFF | F | (무시) | F | none |
| OFF | OFF | T | (무시) | T | license |
| ON | OFF | F | (무시) | F | none |
| ON | ON | F | F/실패 | F | none |
| ON | ON | T | F | T | license |
| ON | ON | F | T | T | entitlement |
| ON | ON | T | T | T | license+entitlement |

> MP3/OGG는 표와 무관하게 항상 저장 가능(게이트 미적용).

---

## 알려진 한계 (Phase D 항목, 본 검증 범위 아님)
- 앱을 장시간 켠 채 **서버측에서 구독이 취소**되면, 렌더러가 entitlement를 재조회하기 전까지 게이트는 마지막 push(true)를 유지할 수 있음(라이선스 오프라인 grace와 동일 성격). → Phase D에서 **주기적 `entitlement:revalidate`** 추가 예정. (단, 게이트 OFF 기본 출시에는 영향 없음.)

## 판정란
- 검증자/일자: __________
- 1~11 결과: __________
- 최종: ☐ Phase B/C 통과 → Phase D 진행 가능 / ☐ P0/P1 발견(내용:______)
