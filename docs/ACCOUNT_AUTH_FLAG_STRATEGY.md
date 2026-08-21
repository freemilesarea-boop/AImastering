# 계정 기반 인증 — 플래그 전략

두 플래그로 계정/entitlement 도입을 단계적으로 제어한다. **둘 다 기본 OFF.**

| 플래그 | 의미 | 런타임 토글 | 빌드 env |
|---|---|---|---|
| `ACCOUNT_AUTH_ENABLED` | 계정 로그인 UI + 세션 + entitlement/기기 조회 | `window.__LOUI_ACCOUNT_AUTH__` | `VITE_LOUI_ACCOUNT_AUTH=true` |
| `ENTITLEMENT_GATE_ENABLED` | entitlement(+기기)를 Export 게이트에 **additive** 포함 | `window.__LOUI_ENTITLEMENT_GATE__` | `VITE_LOUI_ENTITLEMENT_GATE=true` |

게이트 공식: **`paid = licensePaid || (entitlementPaid && deviceAllowed)`**
- `entitlementPaid`/`deviceAllowed`는 렌더러가 **두 플래그 ON일 때만** true로 push. 그 외(OFF/실패/세션없음) → false.
- license는 항상 우선 → 계정/entitlement 장애가 라이선스 사용자를 절대 막지 않음.

---

## 조합별 동작 / 용도

| ACCOUNT_AUTH | ENTITLEMENT_GATE | 계정 UI | Export 판정 | 용도 |
|---|---|---|---|---|
| **OFF** | **OFF** | 없음 | **license only**(현행) | **Production GA(권장)** |
| ON | OFF | 있음(로그인/구독표시/claim/기기) | **license only**(entitlement 무시) | 계정 UI 베타(내부 QA) |
| ON | ON | 있음 | **license \|\| (entitlement&&device)** | entitlement 정식(내부 QA → 후 GA) |
| OFF | ON | 없음 | license only(렌더러가 push 안 함 → 무효) | 비권장(무의미) |

> `OFF/ON`은 ACCOUNT_AUTH가 꺼져 push 자체가 없어 entitlement 기여가 항상 false → 사실상 license-only. 의미 없으므로 사용하지 않음.

---

## 주입 방법

### 런타임(테스트, 빌드 불필요)
```js
window.__LOUI_ACCOUNT_AUTH__ = true;
window.__LOUI_ENTITLEMENT_GATE__ = true;
location.reload();
```

### 빌드(QA 빌드에서만)
```bash
VITE_LOUI_ACCOUNT_AUTH=true VITE_LOUI_ENTITLEMENT_GATE=true \
VITE_SUPABASE_URL=... VITE_SUPABASE_ANON_KEY=... \
pnpm --filter @aimaster/desktop build
```
- 계정 ON 빌드는 **반드시** `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`도 주입(없으면 모달이 "인증 서버 미설정").

### CI(GitHub Actions)
- **프로덕션 릴리스 빌드에는 계정 플래그를 주입하지 않는다 → OFF/OFF.**
- 내부 QA 빌드가 필요하면 별도 워크플로/`workflow_dispatch`에서만 위 VITE_ env를 주입(태그 릴리스에는 넣지 않음).

---

## 출시 전략 (단계)

1. **지금 GA**: OFF/OFF — 현행 라이선스/Paddle/Export 그대로 출시.
2. **내부 QA(계정 UI 베타)**: `AUTH=ON / GATE=OFF` 빌드로 로그인·claim·기기 UX 검증(Export는 여전히 license).
3. **내부 QA(entitlement 정식)**: `AUTH=ON / GATE=ON`으로 게이트·source·기기제한 검증(Release Gate 런북 B 전 항목 PASS).
4. **계정 entitlement GA**: 아래 선결 후 별도 결정으로 ON 빌드 배포.

### 계정 entitlement GA 선결 조건
- P1-1 Google OAuth 데스크톱 딥링크 완성(또는 Google 버튼 제거).
- P1-2 주기적 entitlement/기기 재검증(staleness 제거).
- 키→계정 이관(claim) 안내/채택 + 개인정보 처리방침 갱신.
- (모바일 동시 출시 시) Apple Sign-in + 계정 삭제 기능(스토어 요건).

---

## 롤백
- 가장 빠름: 계정 ON 빌드 회수 + **OFF/OFF 빌드 재배포**(코드 변경 0).
- 런타임: `window.__LOUI_*__=false` + reload.
- 게이트는 additive(`license || …`)라 entitlement 측 OFF로 되돌려도 라이선스 사용자 영향 없음.

## 권장값 (현재)
**Production = OFF/OFF.** 계정제는 **내부 QA 빌드에서만 ON.**
