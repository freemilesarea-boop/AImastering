# 상용 라이선스/결제 설정 가이드 (v3.6)

AImastering 상용 출시를 위한 라이선스·결제 백엔드 운영 설정. 코드는 이미
구현되어 있고, 이 문서의 **설정값만 채우면** 유료 판매가 동작합니다.

## 아키텍처

```
구매자 ── Paddle Checkout ──▶ Paddle Billing
                                   │ webhook (transaction.completed / subscription.*)
                                   ▼
                    Supabase Edge Fn: aimaster-paddle-webhook
                                   │  (라이선스 키 발급 / 구독 만료 동기화)
                                   ▼
              Supabase (schema: aimaster) license_keys / devices / subscriptions
                                   ▲
                                   │ {key, machineId}  →  {valid, tier, expiresAt}
데스크톱 앱 ── 활성화/시작시 ──▶ Edge Fn: aimaster-validate
```

- **티어 모델**: `pro` 단일 티어. Lifetime = 만료 없음, Monthly = `expires_at`(구독 기간 종료) 자기만료.
- **무료 vs 유료**: MP3 프리뷰 저장은 무료, 마스터 음원(WAV/FLAC/AIFF) 저장은 라이선스 필요. 페이월은 **메인 프로세스**(`fileHandlers.ts`)에서 강제 — 렌더러 우회 불가.
- **오프라인**: 시작 시 `revalidate()`로 서버 재검증(갱신·환불·기기해제 반영). 네트워크 실패 시 캐시된 라이선스 유지(Monthly는 `expires_at`까지).

## Supabase 리소스 (이미 배포됨)

- 프로젝트: `tyrhbiwvwmdybwaydvto` (freemilesarea-boop's Org)
- 스키마: `aimaster` (RLS 잠금, service_role 전용)
- Edge Functions:
  - 검증: `https://tyrhbiwvwmdybwaydvto.supabase.co/functions/v1/aimaster-validate`
  - 웹훅: `https://tyrhbiwvwmdybwaydvto.supabase.co/functions/v1/aimaster-paddle-webhook`

## 1. GitHub Actions 시크릿 (프로덕션 빌드 주입)

`Settings → Secrets and variables → Actions`에 등록 후, `build.yml`의 빌드
스텝 env로 전달 (esbuild가 빌드타임에 베이크):

| 시크릿 | 값 |
|---|---|
| `LICENSE_API_URL` | `https://tyrhbiwvwmdybwaydvto.supabase.co` |
| `LICENSE_API_KEY` | Supabase anon/publishable 키 |
| `LICENSE_HMAC_SECRET` | 16자 이상 강력한 랜덤 문자열 (로컬 바인딩 변조 방지) |

> 미주입 시 dev 모드(LocalValidator)로 폴백 — 어떤 형식 맞는 키든 활성화되어 **보호 없음**. 프로덕션 빌드에서는 반드시 주입.

## 2. Supabase 함수 시크릿 (Paddle 웹훅용)

`supabase secrets set` 또는 대시보드 Edge Functions → Secrets:

| 시크릿 | 설명 |
|---|---|
| `PADDLE_WEBHOOK_SECRET` | Paddle 알림 대상(notification destination) 서명 시크릿 (`pdl_ntfset_...`) |
| `PADDLE_PRICE_LIFETIME` | Lifetime(₩390,000) 상품의 price id (`pri_...`) |
| `PADDLE_PRICE_MONTHLY` | Monthly(₩29,900) 구독의 price id (`pri_...`) |

## 3. Paddle Billing 설정

1. 상품 2개 생성: Lifetime(일회성 ₩390,000), Monthly(구독 ₩29,900). price id를 위 시크릿에 등록.
2. Notifications → 새 destination(웹훅) 추가:
   - URL: `.../functions/v1/aimaster-paddle-webhook`
   - 이벤트: `transaction.completed`, `subscription.created`, `subscription.updated`, `subscription.canceled`
   - 서명 시크릿을 `PADDLE_WEBHOOK_SECRET`에 등록.
3. 앱의 구매 링크(`LicenseModal.tsx`)를 Paddle 체크아웃 URL로 교체.

## 4. 키 전달 (남은 작업)

현재 웹훅은 키를 **발급·저장**만 합니다. 구매자에게 전달은 아직 수동:
- 단기: `aimaster.license_keys`에서 이메일로 키 조회 후 수동 발송.
- 권장(후속): 웹훅에 이메일 발송(Resend 등) 추가 또는 구매 성공 페이지에서 transaction id로 키 조회.

## 5. 수동 키 발급 (테스트/초기 판매)

```sql
insert into aimaster.license_keys (license_key, product, status, device_limit, email)
values ('AIMASTER-A1B2-C3D4-E5F6', 'lifetime', 'active', 2, 'buyer@example.com');
-- monthly 예시: product 'monthly', expires_at = (now() + interval '31 days')
```

## 6. 코드서명/공증 (배포 차단 해소)

- macOS: `CSC_LINK`/`CSC_KEY_PASSWORD` + Apple `notarytool`(`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`). 미설정 시 Gatekeeper가 실행 차단·자동업데이트 실패.
- Windows: OV/EV 코드서명 인증서. 미설정 시 SmartScreen 경고(실행은 가능).
- `electron-builder.yml`의 TODO(v3.5) 위치에 연결.

## 검증 절차

1. Dev: `pnpm dev` → 형식 맞는 키로 활성화 → WAV 저장 잠금 해제 확인.
2. 서버: 위 SQL로 키 삽입 → `LICENSE_API_URL/KEY` 주입 빌드 → 활성화 → 기기 2대 초과 시 거부 확인.
3. 결제: Paddle sandbox 결제 → 웹훅이 `license_keys`에 row 생성 확인 → 그 키로 활성화.
4. 환불/취소: Paddle에서 구독 취소 → 다음 앱 시작 `revalidate()`가 만료/차단 반영 확인.
