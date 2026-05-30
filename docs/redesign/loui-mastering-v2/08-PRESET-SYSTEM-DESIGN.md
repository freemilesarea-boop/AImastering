# 08 — 프리셋 시스템 설계

> 프리셋은 사용자에게 "결과" 가 아니라 "출발점" 이다.
> 모든 프리셋은 모듈 그래프 + 파라미터 + 메타데이터 직렬화.

---

## 1. 사용 사례

| 사용자 | 시나리오 | 요구 |
|---|---|---|
| 입문 사용자 | "Pop / 발라드 / Hip-Hop 골라서 끝내기" | 빌트인 프리셋, 한 클릭 |
| 중급 사용자 | "프리셋에서 시작해서 EQ 두어 군데만 손보기" | 프리셋 → 수정 → 자기만의 프리셋 저장 |
| 프로 사용자 | "내 스튜디오 표준 체인 5개 + 클라이언트별" | 사용자 프리셋 폴더 / 빠른 호출 / 가져오기/내보내기 |
| 마켓플레이스 | "유명 엔지니어 프리셋 다운로드" | 서명된 프리셋 / 결제 |
| OEM 파트너 | "우리 브랜드 빌트인 프리셋 번들" | 빌드 시점 임베드 |

---

## 2. 프리셋 데이터 모델 (Preset JSON v1)

```jsonc
{
  "schema": "loui.preset.v1",
  "id": "preset_01HF1XYZ...",         // ULID
  "name": "K-Pop Modern Loud",
  "version": "1.0.0",
  "compatibility": {
    "louiMin": "2.0.0",
    "dspCoreMin": "1.0.0"
  },
  "meta": {
    "author":      { "id": "user_...", "name": "Loui Official" },
    "createdAt":   "2026-05-19T...",
    "updatedAt":   "2026-05-19T...",
    "tags":        ["k-pop", "loud", "modern", "vocal-forward"],
    "genre":       "k-pop",
    "targetLufs":  -8.0,
    "targetTp":    -1.0,
    "platform":    "streaming",
    "description": "Punchy low-mid, glassy air, vocal forward; suited to busy modern mixes.",
    "preview": { "audioUrl": "https://cdn.loui.studio/presets/.../preview.mp3", "durationSec": 8 }
  },
  "graph": {
    // 05-TARGET-ARCHITECTURE 의 그래프 형식과 동일
    "nodes": [ /* ... */ ],
    "edges": [ /* ... */ ]
  },
  "ai": {
    // 프리셋이 AI 추천을 "기준선"으로 사용할 수 있도록
    "policy": "as-template",   // "as-template" | "as-recommendation-source" | "frozen"
    "weights": { /* optional */ }
  },
  "thumbnail": "data:image/png;base64,...",   // 64x64 (정적 곡선 미리보기)
  "signature": "ed25519:...",                  // 마켓플레이스 프리셋의 서버 서명
  "marketplaceId": "mp_..."                    // 마켓플레이스 출처 식별
}
```

### 2.1 검증

- `@loui/preset-format` 패키지가 zod 스키마 + 서명 검증을 제공.
- 모든 임포트는 검증 통과 후 메모리에 로드.
- 알 수 없는 노드 타입 (`type`) 발견 시 → 경고 + 호환 모드 (해당 노드 패스스루) 옵션.

### 2.2 버전 마이그레이션

- `schema` 필드의 메이저 변경 시:
  - `@loui/preset-format` 에 마이그레이션 함수 등록 (`v1 → v2`).
  - 마이그레이션 실패 시 임포트 거부.
- 마이너 변경 (추가 필드) 은 무시 forward-compatible.

---

## 3. 프리셋 계층

```
1. 빌트인 프리셋    (앱 번들)        20~30개
       │
       ▼  사용자가 "이걸 시작점으로" 선택
2. 사용자 프리셋    (로컬 저장)      무제한
       │
       ▼  사용자가 "공유" / "마켓 업로드"
3. 마켓플레이스 프리셋 (서버)        커뮤니티 + 큐레이션
       │
       ▼
4. OEM / 스튜디오 프리셋 번들 (옵션, 빌드 임베드)
```

### 3.1 저장 위치

| 계층 | 경로 |
|---|---|
| 빌트인 | `apps/desktop/public/presets/builtin/*.louipreset.json` (read-only) |
| 사용자 | `~/Library/Application Support/Loui Mastering/presets/` (macOS), `%APPDATA%\Loui Mastering\presets\` (Win), `~/.config/Loui Mastering/presets/` (Linux) |
| 마켓 캐시 | `<userData>/presets/marketplace/<id>.louipreset.json` |
| 프로젝트 임베드 | `.louiproj` 의 `graph` 필드에 인라인 |

### 3.2 파일 확장자

- 프리셋: `.louipreset.json` (사람이 읽을 수 있음)
- 패키지된 다중 프리셋: `.louipack.zip` (다중 + 서명 + 리드미)
- 프로젝트: `.louiproj.json`

---

## 4. UI

### 4.1 PresetBrowser (좌측 패널)

```
PRESETS
├─ ⭐ Recent
│  ├─ K-Pop Modern Loud
│  └─ Soft Acoustic
├─ 🎵 Builtin
│  ├─ Pop
│  │  ├─ Pop · Balanced
│  │  ├─ Pop · Modern Loud
│  │  └─ Pop · Warm
│  ├─ Hip-Hop
│  ├─ K-Pop
│  ├─ EDM
│  ├─ Rock
│  ├─ Acoustic
│  ├─ Vocal
│  └─ Broadcast (-23 / -27 LUFS)
├─ 👤 My presets
│  ├─ My Mix Standard
│  └─ Client X
└─ 🛒 Marketplace
   ├─ Browse
   └─ Installed
```

### 4.2 적용 / 미리보기

- 호버 시 8초 프리뷰 (CDN 호스팅 .mp3) — 사용자 트랙이 아닌 데모.
- 클릭 시 그래프 적용 + "AI 적용" 옵션 (프리셋 메타의 AI policy 에 따라).
- "Save as new preset" → 현재 그래프 + 메타 입력 모달.

### 4.3 Diff View

- 현재 그래프 vs 프리셋 비교 → 변경 모듈/파라미터 하이라이트.
- "Merge"   = 프리셋의 일부 모듈만 가져오기.

---

## 5. AI 추천과 프리셋의 관계

| AI policy | 의미 |
|---|---|
| `as-template`              | 프리셋은 기준 그래프만 제공, AI 는 거기서 추천. (기본) |
| `as-recommendation-source` | 프리셋 자체가 AI 가 학습한 "권장값" — 입력 분석 후 자동 fine-tune. |
| `frozen`                   | 프리셋 그대로 사용, AI 추천 표시 안 함. |

---

## 6. 마켓플레이스

### 6.1 라이프사이클

```
Author → "Submit" 모달 (사인 in Loui Cloud)
  → 자동 정적 검증 (스키마 / 안전 범위 / 라이선스 확인)
  → 휴먼 큐레이션 (큐레이션 큐)
  → 게시 / 가격 / 서명 (서버 ed25519)
  → CDN 배포
  → 다운로더가 가격 결제 (Stripe) → 다운로드 토큰 → 로컬 캐시
  → 클라이언트가 서명 검증 → 로드
```

### 6.2 결제 / 라이선스

- 1회 구매 / 정기구독 / 무료 — 3가지 모드
- 마켓 프리셋은 사용자에 묶임 (라이선스 키 + 머신 바인딩 동일 정책)
- 환불 정책 / 라이선스 취소 시 클라이언트의 다음 가동 시 자동 비활성

### 6.3 안전

- 모든 마켓 프리셋은 ed25519 서명. 공개키는 빌드 임베드.
- 서명 실패 → 로드 거부.
- 로컬 사용자 프리셋은 서명 없음 (자기 책임).

---

## 7. 빌트인 프리셋 정책

- 매 메이저 릴리즈에서 검토.
- 다음 7개 장르 × 3개 변형 (Balanced/Loud/Warm) = 21개 기본.
- LUFS 타겟:
  - Streaming (Pop/Hip-Hop/EDM/K-Pop): -14 / -10 / -8
  - Acoustic / Vocal: -16 / -14
  - Broadcast (TV/Podcast): -23 / -27
- 모든 빌트인 프리셋은 골든 회귀 셋에 포함되어 DSP 변경 시 검증.

---

## 8. 프로젝트 vs 프리셋

| | 프리셋 | 프로젝트 |
|---|---|---|
| 입력 파일 참조 | 없음 | 있음 (해시 + path) |
| 적용 가능 곡 | 모든 곡 | 1곡 |
| 히스토리 / Undo | 없음 | 있음 |
| AI 추천 데이터 | 옵션 (policy) | 캐시 |
| 사이즈 | 작음 (10~50KB) | 큼 (히스토리 포함) |
| 확장자 | `.louipreset.json` | `.louiproj.json` |

---

## 9. 마이그레이션 / 호환성

### 9.1 v1 → v2 (장래 변경 시)

- `@loui/preset-format` 에 `migrate(v1Json): v2Json` 함수 추가.
- 모든 임포트 코드가 이 함수를 강제로 통과.
- 마이그레이션 실패 시:
  - 사용자에게 "이 프리셋은 더 새로운 Loui 가 필요합니다" 표시
  - 또는 호환 모드 (없는 모듈은 빈 노드로 대체)

### 9.2 dsp-core 변경 호환

- 모듈 파라미터 추가는 OK (디폴트값 적용).
- 모듈 파라미터 의미 변경은 메이저 bump.
- 모듈 삭제는 마이그레이션 함수에 강제 대체 노드 지정.

---

## 10. 성능 / UX 보장

- 프리셋 적용 후 첫 미리듣기까지 < 200ms (그래프 검증 + 새 runtime 초기화 + 5초 슬라이스 처리).
- 프리셋 목록 (1000개 이상) 가상 스크롤 (react-window).
- 프리뷰 audio 캐시 (마지막 N개).
- 마켓플레이스 fetch 는 background, 오프라인 시 캐시 사용.

---

## 11. 비공개 / 보안

- 마켓 프리셋 다운로드는 사용자 동의 (`settings.allowMarketplace=true`) 후만.
- 사용자가 업로드 시 PII (파일명, 경로) 제거 자동 처리.
- 빌트인 프리셋도 텔레메트리 (어떤 프리셋이 자주 쓰이는지) 는 opt-in.

---

## 12. 개발 도구

- `tools/preset-validator` — JSON → schema + 안전범위 검증 CLI.
- `tools/preset-render` — 프리셋 × 골든 입력으로 미리듣기 mp3 생성 CLI (마켓플레이스 등록 보조).
- `tools/preset-pack` — 다중 프리셋 zip 패키징 + 사이닝.

---

## 13. v3 (현재) → v2 매핑

현재의 7개 모드 (Natural/Balanced/Bright/Loud/KPop-Loud/Warm/Punch) 는 다음과 같이 빌트인 프리셋으로 변환:

| v3 모드 | v2 빌트인 프리셋 |
|---|---|
| Natural          | Broadcast · Natural (-16 LUFS) |
| Balanced         | Pop · Balanced (-14 LUFS) |
| Bright           | Pop · Bright (-14 LUFS) |
| Loud             | Pop · Modern Loud (-10 LUFS) |
| KPop-Loud        | K-Pop · Modern Loud (-8 LUFS) |
| Warm             | Pop · Warm (-14 LUFS) |
| Punch            | Hip-Hop · Punch (-12 LUFS) |

이 매핑은 마이그레이션 코드에 박혀, 기존 사용자의 모드 선호도가 v2 첫 실행 시 동일 프리셋으로 이어진다.
