# License Flow

## Key Format
```
AIMASTER-XXXX-XXXX-XXXX
```
Where `X` is `[A-Z0-9]` (regex: `/^AIMASTER-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/`).

## Tiers

| Tier | Processing | Output      | Presets   | Reports  |
|------|-----------|-------------|-----------|----------|
| Free | 3 total   | MP3 preview | Balanced  | View only|
| Pro  | Unlimited | WAV master  | All 4     | Export   |

## Activation Sequence

```
User enters key
  → format validation (regex)
  → [future] POST /api/license/activate { key, machineId }
  → 200 OK { tier, expiresAt }
  → store encrypted: { key, tier, activatedAt, expiresAt, machineId, hmac }
  → UI updates to Pro
```

## HMAC Tamper Detection

```typescript
hmac = HMAC-SHA256(
  secret = process.env.LICENSE_HMAC_SECRET,
  data   = `${key}|${tier}|${activatedAt}|${machineId}`
)
```

On each startup: recompute and `crypto.timingSafeEqual(stored_hmac, computed_hmac)`.
If mismatch → treat as free.

## Offline Grace Period
- Subscriptions with `expiresAt` get **7 days** offline grace.
- After grace expires → downgrade to free until next online verification.
- Perpetual Pro keys have no `expiresAt` → no grace needed.
