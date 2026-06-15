# 계정 기반 인증 전환 계획 (Account-Based Auth Migration)

목표: **라이선스 키 기반 인증 → 계정 로그인 + 구독 entitlement** 로 전환.
키 공유 리스크 제거, 모바일/데스크톱/웹 **동일 계정**으로 권한 통합.

원칙(절대):
- 기존 라이선스 코드 **삭제 금지** — 신규 계정 시스템을 **병행(coexist)** 으로 먼저 구축.
- 결제/Export 로직 **변경 금지**(본 문서는 계획). Export 게이트 교체는 Phase C에서 **additive(entitlement || license)** 로만.
- 전 과정 **플래그 게이팅**(`ACCOUNT_AUTH_ENABLED`, 기본 OFF) → 한 번에 롤백 가능.

---

## 1. 현재 구조 분석 (코드 기준)

### 1.1 라이선스 코어 (`packages/license-core/src/index.ts`)
- `LicenseService`: `getLicenseState()`, `canProcess()`, `activateLicense(key)`, `revalidate()`, `decrementTrialUsage()`, `deactivate()`.
- 저장: `electron-store`(`name:'license'`, hardcoded `encryptionKey:'aimaster-enc-v1'`), 키 형식 `AIMASTER-XXXX-XXXX-XXXX`.
- 변조 방지: HMAC-SHA256(key|tier|activatedAt|machineId|expiresAt), `node-machine-id`.
- 검증기 교체형: `LocalValidator`(형식만) / `RemoteValidator`(Supabase `aimaster-validate` 호출). `LICENSE_API_URL`/`LICENSE_API_KEY` 빌드 주입.
- 무료: `TRIAL_MAX=3`(체험). pro = lifetime(만료없음)/monthly(`expiresAt` + 오프라인 grace).

### 1.2 IPC / 메인 (`apps/desktop/src/main/ipc/licenseHandlers.ts`, `main/index.ts`)
- 채널: `license:status` · `license:can-process` · `license:get-remaining` · `license:activate` · `license:deactivate` · `license:decrement-trial` · `license:revalidate`.
- `main/index.ts`: 핸들러 등록 + 시작 시 `licenseService.revalidate()`.
- preload allowlist(`preload/index.ts`)에 `license:*` 노출.

### 1.3 렌더러 (`stores/licenseStore.ts`, `components/LicenseModal.tsx`)
- `licenseStore`: `load()`(→`license:status`), `activate(key)`(→`license:activate`), `handleLicenseRequired(err)`(LICENSE_REQUIRED → 모달 오픈), `selectIsFree`/`selectRemainingTrials`.
- `LicenseModal`: 키 입력(자동 포맷) + 활성화 + `TrialBadge` + 구매 링크(`__PADDLE_CHECKOUT_URL__`). App.tsx에서 전역 렌더.

### 1.4 Export 권한 체크 위치 (`apps/desktop/src/main/ipc/fileHandlers.ts`)
- **메인 프로세스에서 강제**(우회 불가). `file:save-wav` / `file:save-audio` / `file:batch-save-wav`:
  - `isMasterExport(ext/format)` && `!isPaidNow()` → `throw 'LICENSE_REQUIRED: …'`.
  - `isPaidNow()` = `licenseService.canProcess().isPaid`.
- **MP3 프리뷰 저장 정책**: `FREE_EXPORT_EXTS = {mp3, ogg}` → 무료. 마스터(wav/flac/aiff) = 유료.

### 1.5 Paddle 결제/Webhook (Supabase edge `aimaster-paddle-webhook`)
- Paddle **Billing** 웹훅. 이벤트: `transaction.completed`(lifetime 키 발급), `subscription.created/updated/canceled`(monthly 만료 동기화).
- 서명 검증(`Paddle-Signature` HMAC, `PADDLE_WEBHOOK_SECRET`). 상품 매핑 env(`PADDLE_PRICE_LIFETIME/MONTHLY`). 키 생성 + `license_keys`/`subscriptions` upsert.

### 1.6 Supabase 백엔드 (project `tyrhbiwvwmdybwaydvto`, schema `aimaster`)
- 테이블: `license_keys`(license_key, tier, product, status, device_limit, expires_at, email, paddle_*), `devices`(license_key, machine_id, first/last_seen), `subscriptions`(paddle_subscription_id, license_key, status, current_period_end). RLS 잠금(service_role 전용).
- Edge fns: `aimaster-validate`(POST {key, machineId} → {valid, tier, expiresAt}), `aimaster-paddle-webhook`.

### 1.7 기기 인증 / 계정 로그인 현황
- **기기 인증**: `node-machine-id` 머신ID + `aimaster.devices`(키당 `device_limit`). **계정 개념 없음**(키↔머신 바인딩만).
- **계정 로그인**: **없음**. 사용자 식별 불가, 키만으로 권한.
- → 키 공유 시 device_limit 외 통제 수단 없음 = 본 전환의 핵심 동기.

---

## 2. 목표 구조

```
사용자 ── Supabase Auth(email/pw + OAuth) ──▶ access/refresh JWT
   │
   ├─ 결제: Paddle(Desktop/Web) · App Store IAP(iOS) · Play Billing(Android)
   │        → (RevenueCat 권장) → webhook → aimaster.entitlements (user_id 키)
   │
앱 ── 로그인 후 JWT + device_id ──▶ Edge: aimaster-entitlement
            └ 검증: plan/status/expires + 기기(≤2, revoked) → {canExport, plan, ...}
                     ▼ 메인 캐시(오프라인 grace) → Export 게이트가 참조
```
- **권한 출처 = 계정 entitlement**(키 아님). 동일 계정이면 모든 플랫폼에서 동일 권한.
- 기기 제한은 **user_id 기준 최대 2대**(키 기준 → 계정 기준으로 승격).

---

## 3. DB 스키마 초안 (schema `aimaster`, 기존 테이블은 유지)

### 3.1 사용자 = Supabase Auth (`auth.users`)
- 별도 users 테이블 불필요. 필요 시 `aimaster.profiles(user_id PK → auth.users, display_name, created_at)`.

### 3.2 `aimaster.entitlements` (신규)
| 컬럼 | 타입 | 비고 |
|---|---|---|
| id | uuid pk | |
| user_id | uuid → auth.users | unique(또는 provider별 1행) |
| plan | text | 'free' \| 'pro_monthly' \| 'pro_lifetime' |
| status | text | 'active' \| 'past_due' \| 'canceled' \| 'expired' \| 'refunded' |
| expires_at | timestamptz null | lifetime=null |
| provider | text | 'paddle' \| 'appstore' \| 'playstore' \| 'manual' |
| provider_customer_id | text null | |
| provider_subscription_id | text null | |
| updated_at | timestamptz | trigger |
- 파생 권한: `is_pro = plan!='free' AND status IN ('active','canceled'?) AND (expires_at IS NULL OR now()<expires_at)` (canceled는 기간말까지 사용 허용 — Paddle 정책 반영).

### 3.3 `aimaster.account_devices` (신규)
| 컬럼 | 타입 | 비고 |
|---|---|---|
| id | uuid pk | |
| user_id | uuid → auth.users | |
| device_id | text | 머신ID/설치ID(플랫폼별) |
| device_name | text | 사용자 표시명(호스트명 등) |
| platform | text | 'mac'\|'win'\|'ios'\|'android'\|'web' |
| last_seen | timestamptz | |
| revoked_at | timestamptz null | 해제 시 |
| unique(user_id, device_id) | | |
- 제한: `user_id`당 활성(미revoked) 기기 **≤ 2**.

### 3.4 기존 테이블 (유지, Phase E까지)
- `license_keys`/`devices`/`subscriptions` 그대로. **백필 매핑**: 사용자가 로그인 후 보유 키를 입력하면 `license_keys.user_id`(신규 컬럼) 또는 `entitlements`로 1회 이관.

---

## 4. 앱 내 권한 흐름

| 상태 | 화면/동작 |
|---|---|
| 미로그인 | **로그인 화면**(이메일/PW + OAuth). Export 시도 시 로그인 유도 |
| 로그인 + free | **결제 안내**(AccountPaywallModal) — 플랜/구매 |
| pro active | **WAV Export 허용** |
| expired/canceled(기간 후) | **Export 차단** + 갱신 안내 |
| device limit 초과 | **기기 관리 화면**(현재 기기 목록 + 해제) |
| 오프라인 | 마지막 검증 entitlement 캐시 + **grace 기간** 동안 허용 |

> MP3 프리뷰 저장은 **로그인/구독 무관 무료**(기존 정책 유지).

---

## 5. 기존 LicenseModal 대체 흐름
- `LicenseModal`(키 입력)을 **AccountPaywallModal**로 대체(Phase에서 점진):
  - 로그인/회원가입 → 구독 상태 표시 → 결제(체크아웃/IAP) → 기기 관리.
  - **라이선스 키 입력 제거**(단, Phase D까지 "기존 키 보유자 이관" 경로만 한시 유지).
- 트리거는 동일: Export 차단(`LICENSE_REQUIRED`/`AUTH_REQUIRED`) → 모달 오픈.

---

## 6. 결제 구조 (멀티 플랫폼 → 단일 entitlement)
- **Desktop/Web**: Paddle(또는 Stripe). 기존 `aimaster-paddle-webhook` 확장 → `entitlements`(user_id) 기록. 체크아웃에 `custom_data.user_id` 또는 customer email↔Supabase user 매핑.
- **iOS**: App Store IAP(StoreKit) → 서버 영수증 검증 edge → entitlements.
- **Android**: Google Play Billing → 서버 검증 edge → entitlements.
- **권장**: **RevenueCat** 도입(app_user_id = Supabase user_id) → 3 스토어 + 영수증검증 추상화, webhook 1개로 entitlements 동기화.

---

## 7. 이행 전략 (Phase A→E, 전부 플래그 뒤)

| Phase | 내용 | 게이트 |
|---|---|---|
| **A** 계정 Auth 추가 | Supabase Auth(email/pw + OAuth) + 로그인 UI + 세션 저장(secure). **권한 변화 없음**(license가 계속 Export 게이트) | `ACCOUNT_AUTH_ENABLED` |
| **B** Entitlement 추가 | `entitlements`/`account_devices` 테이블 + `aimaster-entitlement` edge + 메인 `entitlementService`(캐시/grace). webhook이 entitlements 기록 | 〃 |
| **C** Export 게이트 교체(additive) | `fileHandlers` 게이트를 `entitlement.canExport || licenseService.canProcess().isPaid` 로. 플래그 OFF면 license-only(현행) | 〃 + `ENTITLEMENT_GATE` |
| **D** Fallback 병행 + 마이그레이션 | 기존 키 보유자 로그인 시 키→entitlement 이관 경로. 기기모델 user 기준 승격. 양 시스템 공존 | 〃 |
| **E** License 제거 | 채택률 임계 도달 후 LicenseModal/license-core 키 경로 제거. entitlement 단일화 | 별도 결정 |

---

## 8. 파일 단위 수정 계획 (신규 N / 수정 M) — 구현 시 참조

**Phase A (계정)**
- `packages/auth-core/`(N) 또는 renderer `lib/supabaseClient.ts`(N): supabase-js(anon) 초기화, PKCE OAuth.
- `renderer/stores/authStore.ts`(N): session/user, signIn/signUp/signOut/oauth.
- `renderer/components/auth/LoginScreen.tsx`(N), `AccountMenu.tsx`(N).
- `main/ipc/authHandlers.ts`(N): `auth:set-session`(렌더러→메인 토큰 전달), `auth:get-state`, `auth:sign-out`.
- `main/services/sessionStore.ts`(N): 토큰 secure 저장(safeStorage).
- `preload/index.ts`(M): `auth:*` 채널 allowlist 추가.

**Phase B (entitlement)**
- Supabase: `entitlements`/`account_devices` 마이그레이션 + `aimaster-entitlement` edge(N) + `aimaster-device-{list,revoke}` edge(N).
- `main/services/entitlementService.ts`(N): JWT+device_id로 edge 호출, 캐시 + 오프라인 grace(license 패턴 차용).
- `main/ipc/entitlementHandlers.ts`(N): `entitlement:status`, `entitlement:revalidate`, `device:list`, `device:revoke`.
- webhook(M): entitlements 기록 분기 추가(기존 license_keys 기록 유지).

**Phase C (게이트)**
- `main/ipc/fileHandlers.ts`(M): `isPaidNow()` → `isEntitledOrLicensed()`(entitlement OR license, 플래그 게이팅). **MP3/OGG 무료 정책 불변.**

**Phase D/E (UI 대체/정리)**
- `renderer/components/AccountPaywallModal.tsx`(N) → App.tsx에서 LicenseModal 대체(플래그).
- `renderer/components/devices/DeviceManager.tsx`(N).
- (E) LicenseModal/licenseStore/license-core 키 경로 제거.

> A~D 동안 `LicenseModal`/`license-core`/`fileHandlers` **삭제 없음**(coexist).

---

## 9. 단계별 구현 티켓 (요약)
- **AUTH-A1** supabase 클라이언트 + authStore. **A2** LoginScreen + OAuth(PKCE/deep-link). **A3** 메인 sessionStore + authHandlers + preload. **A4** App 라우팅: 플래그 ON + 미로그인 → 로그인(단 Export 외 흐름은 게스트 허용 가능).
- **ENT-B1** entitlements/account_devices 마이그레이션. **B2** aimaster-entitlement edge(JWT 검증 + 기기 등록/≤2 + 만료). **B3** entitlementService(캐시/grace) + IPC. **B4** webhook → entitlements.
- **GATE-C1** fileHandlers 게이트 additive 교체(플래그). **C2** AUTH_REQUIRED/ENTITLEMENT 에러 → 렌더러가 AccountPaywallModal 오픈.
- **MIG-D1** 키→계정 이관 UX. **D2** DeviceManager(목록/해제). **D3** 멀티플랫폼 결제(RevenueCat) 연동.
- **CLEAN-E1** license 키 경로 제거(채택률 후).

각 티켓: typecheck/build + 플래그 OFF 회귀 확인.

---

## 10. 롤백 전략
- **마스터 플래그 `ACCOUNT_AUTH_ENABLED`(기본 OFF)** + 하위 `ENTITLEMENT_GATE`. OFF → **현행 license 동작 100%**(Export 게이트 license-only, LicenseModal 그대로).
- Phase C 게이트는 **additive**(entitlement OR license) → entitlement 장애 시에도 license로 Export 가능 → 사용자 차단 회피.
- 티켓 단위 커밋/revert. 신규 테이블/edge는 기존과 독립(삭제 안전).
- Supabase entitlement edge 장애 → 메인 캐시 + grace로 버팀(오프라인 정책과 동일).

---

## 11. 리스크 & 대응
| 리스크 | 대응 |
|---|---|
| **기존 키 사용자 마이그레이션** | 로그인 후 보유 키 입력 → entitlement 이관(Phase D). 미이관 사용자는 license fallback로 계속 동작(무중단) |
| **오프라인 사용** | entitlement 캐시 + grace(예: monthly=expires까지, 검증실패 N일 허용). JWT 만료는 refresh token + grace로 처리 |
| **환불/구독 취소 반영** | webhook → entitlements status 갱신 + 앱 시작 `entitlement:revalidate`(온라인 시 즉시 차단). canceled는 기간말까지 허용 정책 명시 |
| **기기 해제 UX** | DeviceManager(현재 기기 강조 + 1탭 해제). limit 초과 시 모달에서 바로 해제 유도 |
| **개인정보/스토어 심사** | 계정/이메일 수집 → 개인정보 처리방침 갱신. Apple: 타 OAuth 제공 시 **Sign in with Apple 필수**, **계정 삭제 기능 필수**. 데이터 최소수집 |
| **이중 권한 충돌** | additive 규칙 + 단일 source 우선순위(entitlement > license) 명문화. 동일 사용자 다중 entitlement 행 방지(unique) |

---

## 12. 출시 전 필수 검증 시나리오
1. **회원가입/로그인**: email/pw + OAuth(Google/Apple) 성공, 세션 지속/갱신.
2. **free → 결제 안내**: 로그인 free 사용자가 WAV 저장 시 AccountPaywallModal.
3. **pro active → Export**: 구독/구매 후 WAV 저장 성공(데스크톱/모바일 동일 계정).
4. **expired/canceled → 차단**: 만료/환불 후 다음 온라인 revalidate에서 Export 차단.
5. **기기 제한(≤2)**: 3번째 기기 로그인 시 기기 관리 유도, 해제 후 정상.
6. **오프라인 grace**: 네트워크 차단 상태에서 pro 사용자 Export 허용(기간 내), grace 초과 시 차단.
7. **MP3 프리뷰 저장**: 로그인/구독 무관 항상 무료.
8. **license fallback(Phase C/D)**: 기존 키 보유자(미이관) WAV 저장 정상.
9. **멀티플랫폼 entitlement**: 같은 계정 desktop↔mobile 권한 일치.
10. **플래그 OFF 회귀**: `ACCOUNT_AUTH_ENABLED=false` → 현행 license UX/게이트 100% 동일.
11. **계정 삭제/데이터 처리**: 삭제 요청 시 계정·entitlement·device 정리(스토어 요건).

---

## 부록 — 설계 결정 요약
- **Auth = Supabase Auth**(이미 Supabase 백엔드 사용 중 → 추가 인프라 0). email/pw + OAuth(Google, Apple). 데스크톱 OAuth는 PKCE + 커스텀 스킴 딥링크.
- **권한 source = entitlement(계정)**; license는 Phase A~D fallback, Phase E 제거.
- **결제 통합 = RevenueCat 권장**(3 스토어 + 영수증검증 → entitlements 단일화).
- **기기 제한 = 계정당 ≤2**(키 기준에서 승격).
- **게이트 위치 불변**(메인 프로세스 `fileHandlers`) — 우회 불가 강점 유지, 판정 입력만 license→entitlement(additive)로 교체.
