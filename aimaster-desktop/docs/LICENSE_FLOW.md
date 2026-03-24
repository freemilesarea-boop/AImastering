# License Flow

AIMASTER 라이선스 시스템의 정책, 활성화 흐름, 보안 구조, 확장 방향을 기술합니다.

---

## 목차

1. [무료/유료 정책](#무료유료-정책)
2. [키 형식](#키-형식)
3. [활성화 구조](#활성화-구조)
4. [저장 구조와 암호화](#저장-구조와-암호화)
5. [HMAC 변조 방지](#hmac-변조-방지)
6. [트라이얼 카운트 보호](#트라이얼-카운트-보호)
7. [추후 서버 검증 확장 방향](#추후-서버-검증-확장-방향)

---

## 무료/유료 정책

### 티어 비교

| 항목 | 무료 (Free) | 유료 (Pro) |
|------|-------------|------------|
| 처리 횟수 | 총 **3회** | **무제한** |
| MP3 프리뷰 저장 | ✓ (320 kbps) | ✓ |
| WAV 마스터 저장 | ✗ (잠김) | ✓ (24-bit PCM) |
| 스타일 프리셋 | Balanced만 사용 | 4종 전체 (Balanced / Warm / Bright / Punch) |
| 레포트 내보내기 | 보기 전용 | ✓ |

### 무료 티어 동작 방식

무료 사용자가 마스터링을 실행하면:

1. Python 파이프라인은 WAV 파일을 정상적으로 생성합니다
2. main 프로세스가 WAV 파일을 즉시 삭제합니다 (`fs.unlinkSync`)
3. `outputPath: ''` 를 반환하여 UI가 WAV 저장 버튼을 비활성화합니다
4. MP3 프리뷰는 별도 경로에 생성되어 정상 제공됩니다
5. 처리 성공 후 트라이얼 카운트를 1 증가시킵니다

```
[무료 사용자 마스터링 흐름]

음원 처리 완료
  │
  ├─ MP3 프리뷰 경로 → 반환 (재생 및 저장 가능)
  │
  ├─ WAV 파일 → 즉시 삭제 → outputPath = ''
  │
  └─ UI: "마스터 WAV 저장" 버튼 → 클릭 시 라이선스 모달 표시
```

3회 소진 후에는 마스터링 실행 자체가 차단됩니다 (`canProcess()` 가 `allowed: false` 반환).

### 유료 티어 검증 시점

라이선스 상태는 `audio:master` IPC 호출 시점에 실시간으로 확인합니다.
앱 재시작 없이 키 활성화 즉시 WAV 저장이 가능해집니다.

---

## 키 형식

```
AIMASTER-XXXX-XXXX-XXXX
```

- 각 `X` 는 `[A-Z0-9]` (대문자 알파벳 + 숫자)
- 정규식: `/^AIMASTER-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/`
- UI에서 입력 시 자동으로 대문자 변환 및 대시 삽입

**v1 현재 상태**: 형식이 올바른 키는 모두 Pro로 활성화됩니다 (`LocalValidator`).
서버 검증 도입 전 개발/테스트 목적의 동작입니다. [확장 방향](#추후-서버-검증-확장-방향) 참조.

---

## 활성화 구조

### 활성화 흐름

```
[사용자 입력] AIMASTER-XXXX-XXXX-XXXX
      │
      ▼
[1] 형식 검증 (정규식)
      │ 실패 → "올바른 라이선스 키 형식이 아닙니다" 에러 반환
      │
      ▼
[2] LicenseValidator.validate(key, machineId)
      │ (v1: LocalValidator — 형식 검사만)
      │ (v2: RemoteValidator — POST /api/license/activate)
      │ 실패 → 서버 에러 메시지 반환
      │
      ▼
[3] StoredLicense 객체 생성
      {
        key:         "AIMASTER-XXXX-XXXX-XXXX",
        tier:        "pro",
        activatedAt: "2024-01-15T10:30:00.000Z",
        expiresAt:   undefined,   // 영구 키의 경우
        machineId:   "<machine-id>",
        hmac:        "<HMAC-SHA256>",
      }
      │
      ▼
[4] electron-store에 AES-256 암호화하여 저장
      │
      ▼
[5] UI → Pro 상태로 즉시 전환
```

### 비활성화 (deactivate)

`licenseService.deactivate()` 를 호출하면 `electron-store` 에서 `license` 키를 삭제합니다.
트라이얼 카운트는 유지됩니다 (Pro → 무료 전환 시 남은 트라이얼 사용 가능).

---

## 저장 구조와 암호화

`electron-store` 의 AES-256-CBC 암호화를 사용합니다.
`encryptionKey: 'aimaster-enc-v1'` 로 설정되어 있으며,
파일은 OS의 userData 디렉토리 (`license.json`)에 저장됩니다.

```
macOS:   ~/Library/Application Support/AIMASTER/license.json
Windows: %APPDATA%\AIMASTER\license.json
Linux:   ~/.config/AIMASTER/license.json
```

### 저장되는 데이터 구조

**라이선스 레코드 (`license` 키):**
```json
{
  "key":         "AIMASTER-XXXX-XXXX-XXXX",
  "tier":        "pro",
  "activatedAt": "2024-01-15T10:30:00.000Z",
  "expiresAt":   null,
  "machineId":   "a1b2c3d4e5f6...",
  "hmac":        "a1b2c3d4..."
}
```

**트라이얼 레코드 (`trial` 키):**
```json
{
  "used":      2,
  "machineId": "a1b2c3d4e5f6...",
  "hmac":      "e7f8a9b0..."
}
```

두 레코드 모두 독립적인 HMAC으로 서명됩니다.

---

## HMAC 변조 방지

저장 파일을 직접 편집하거나 트라이얼 카운트를 조작하는 것을 방지하기 위해
모든 레코드에 **HMAC-SHA256** 서명을 포함합니다.

### 서명 방식

**라이선스 서명:**
```
HMAC-SHA256(
  key    = LICENSE_HMAC_SECRET (환경 변수),
  data   = "{key}|{tier}|{activatedAt}|{machineId}"
)
```

**트라이얼 서명:**
```
HMAC-SHA256(
  key    = LICENSE_HMAC_SECRET,
  data   = "trial|{used}|{machineId}"
)
```

### 검증 방식

앱 시작 시 및 처리 실행 직전에 `crypto.timingSafeEqual()` 로 HMAC을 재검증합니다.
**타이밍 공격**을 방지하기 위해 `===` 대신 `timingSafeEqual` 을 사용합니다.

| 검증 결과 | 조치 |
|-----------|------|
| 라이선스 HMAC 불일치 | 무료 티어로 강등, 개발자 로그 기록 |
| 트라이얼 HMAC 불일치 | 트라이얼 횟수 = TRIAL_MAX (처리 차단), 개발자 로그 기록 |
| machineId 불일치 | 트라이얼 횟수 = TRIAL_MAX, 로그 기록 |
| 카운트 이상값 (음수, TRIAL_MAX 초과) | TRIAL_MAX로 클램프, 로그 기록 |

변조 시 항상 **더 제한적인 방향**으로 동작합니다 (허용이 아닌 거부).

### HMAC_SECRET 관리

```bash
# .env (절대 커밋하지 말 것)
LICENSE_HMAC_SECRET=your-cryptographically-random-64-char-secret
```

기본값 `aimaster-local-secret-v1` 은 **개발 전용**입니다.
프로덕션 배포 시 최소 32바이트 이상의 무작위 값으로 교체해야 합니다.

---

## 트라이얼 카운트 보호

트라이얼 카운트 조작 시나리오와 대응:

| 공격 벡터 | 탐지 방법 | 대응 |
|-----------|-----------|------|
| JSON 파일 직접 편집 (`used: 0` 으로 초기화) | HMAC 불일치 | TRIAL_MAX 처리 |
| `used` 값을 음수로 설정 | `used < 0` 검사 | TRIAL_MAX 처리 |
| `used` 값을 매우 큰 수로 설정 | `used > TRIAL_MAX` 검사 | TRIAL_MAX 처리 |
| 파일 삭제 후 재생성 | 없음 (새 기기로 인식) | 0회에서 재시작 |
| machineId 변조 | machineId 불일치 검사 | TRIAL_MAX 처리 |
| 암호화 키 탈취 후 올바른 HMAC 재생성 | — | 환경 변수 보호에 의존 |

마지막 시나리오(암호화 키 탈취)는 `electron-store` 의 암호화 키가
코드에 하드코딩되어 있어 완전한 방어가 어렵습니다.
v2에서 서버 검증으로 전환하면 클라이언트 측 조작 자체를 무의미하게 만들 수 있습니다.

---

## 추후 서버 검증 확장 방향

현재 v1은 `LocalValidator` (형식 검사만)를 사용합니다.
서버 API 준비 시 아래 과정으로 교체합니다.

### 인터페이스 (이미 구현됨)

```typescript
// packages/license-core/src/index.ts
export interface LicenseValidator {
  validate(key: string, machineId: string): Promise<ValidatorResponse>;
}

export interface ValidatorResponse {
  valid:      boolean;
  tier:       LicenseTier;
  expiresAt?: string;
  reason?:    string;  // 거부 시 사용자에게 보여줄 메시지
}
```

### 교체 방법

`licenseHandlers.ts` 에서 `LicenseService` 생성자에 `RemoteValidator` 를 주입합니다.
`LicenseService` 코드를 전혀 변경할 필요가 없습니다.

```typescript
// apps/desktop/src/main/ipc/licenseHandlers.ts

// v1
export const licenseService = new LicenseService(store);

// v2 (서버 API 준비 후)
import { RemoteValidator } from '@aimaster/license-core';
export const licenseService = new LicenseService(
  store,
  new RemoteValidator('https://api.aimaster.io'),
);
```

### RemoteValidator 구현 예시

```typescript
export class RemoteValidator implements LicenseValidator {
  constructor(private readonly baseUrl: string) {}

  async validate(key: string, machineId: string): Promise<ValidatorResponse> {
    const response = await fetch(`${this.baseUrl}/v1/license/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, machineId }),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      return {
        valid:  false,
        tier:   'free',
        reason: body.message ?? '서버 연결 실패. 잠시 후 다시 시도해주세요.',
      };
    }

    return response.json();  // { valid, tier, expiresAt? }
  }
}
```

### 서버 API 엔드포인트 (예시)

```
POST /v1/license/activate
Body: { key: string, machineId: string }

200 OK:   { valid: true,  tier: "pro", expiresAt?: "2025-01-15T00:00:00Z" }
400 Bad:  { valid: false, tier: "free", message: "이미 다른 기기에 활성화된 키입니다." }
429 Rate: { valid: false, tier: "free", message: "너무 많은 활성화 시도입니다." }
```

### 오프라인 처리 (Grace Period)

구독형 Pro 키(`expiresAt` 있음)의 경우 오프라인 환경에서 7일 유예 기간을 제공합니다.

```
[앱 시작 시 확인 흐름]

저장된 라이선스 있음?
  ├─ Pro + expiresAt 있음
  │     서버 재검증 시도
  │       성공 → 정상 Pro
  │       실패 (오프라인) → 마지막 검증 시각 확인
  │           7일 이내 → 오프라인 유예 (Pro 유지)
  │           7일 초과 → 무료 강등
  │
  ├─ Pro + expiresAt 없음 (영구 키)
  │     HMAC 검증만 (서버 불필요)
  │
  └─ 없음 → 무료
```

영구 Pro 키는 서버 재검증이 불필요하므로 완전 오프라인에서도 동작합니다.

### 멀티 기기 정책 (참고)

서버 API 도입 시 기기 수 제한 정책을 서버에서 관리할 수 있습니다.
현재 v1은 `machineId` 를 HMAC에 포함시켜 **기기 이전 시 재활성화가 필요**하도록 설계되어 있습니다.
동일 키를 여러 기기에 사용하는 것을 허용할지 여부는 서버 정책으로 결정합니다.
