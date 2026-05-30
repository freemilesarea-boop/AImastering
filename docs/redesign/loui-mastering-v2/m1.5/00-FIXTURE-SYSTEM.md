# M1.5 — Fixture System

> 본 문서는 Loui 의 real-music benchmark fixture 인프라를 정의한다.
> 모든 fixture는 metadata JSON 으로 선언되며, WAV 는 결정적 합성 / CC0 다운로드 / 사용자 제공 중 하나로 materialise 된다.

---

## 1. 디자인 결정

| 결정 | 이유 |
|---|---|
| **WAV 는 절대 리포에 commit 하지 않는다** | 9개 fixture × 30s × stereo 24-bit ≈ 70 MB. 너무 큼. 또한 외부 소스 fixture 는 라이센스 이슈. |
| **합성은 결정적 (fixture id 로 seed)** | 같은 fixture id 는 항상 같은 WAV (SHA256 일치). 회귀 추적 가능. |
| **소스 타입 3가지** | `synthetic-recipe` (built-in, 항상 가용) / `external-cc0` (URL + sha256) / `user-supplied` ($LOUI_FIXTURE_DIR) |
| **Reference master WAV 는 M1.5 에서 미제공** | 우리 소유의 상용 마스터가 없음. "good" 의 정의는 `targetMetrics` 숫자 — 산업 표준 기반. WAV reference 는 M2+ 에 자체 dsp-core 출력으로 채울 예정. |
| **모든 측정은 산업 표준 도구** | LUFS / TP / LRA = FFmpeg `loudnorm` pass-1 (ITU R.128). RMS / spectrum = numpy. Cross-language 비교는 같은 도구로. |

---

## 2. 메타데이터 스키마 (v1)

전체 정의 위치: `packages/shared-types/src/fixtures/fixture.ts`, `services/python-audio/app/fixtures/schema.py`.

```jsonc
{
  "$schema": "https://schemas.loui.studio/fixture/v1",
  "id": "kpop-modern-01",                  // ULID or slug
  "category": "kpop",                       // 11가지 enum
  "name": "K-Pop Modern Female Vocal",
  "version": "1.0.0",
  "description": "...",
  "source": { ... },                        // 3가지 union (아래 §3)
  "characteristics": {
    "durationSec": 25,
    "sampleRate": 44100,
    "bitDepth": 24,
    "channels": 2,
    "preMasterLufsI": -20,                  // informational
    "tags": ["kpop", "modern", "vocal-forward"]
  },
  "referenceMaster": {
    "available": false,                     // M1.5: 항상 false
    "wavRelativePath": null,
    "targetMetrics": {                      // "good"의 숫자 정의
      "lufsI": -9.0,
      "tpMaxDb": -0.8,
      "lraMinLu": 3.0,
      "lraMaxLu": 6.0,
      "crestDb": 7.5,
      "rationale": "Korean streaming charts industry average."
    }
  },
  "recommendedPresetId": "builtin-kpop-loud",
  "policy": {
    "lufsToleranceLu": 0.7,                 // 허용 LUFS 오차
    "tpHardCeiling": true,                  // TP 초과는 HARD FAIL
    "spectrumMaxDeltaMaxDb": 8.0
  }
}
```

---

## 3. 소스 타입

### 3.1 `synthetic-recipe`

```json
{
  "type": "synthetic-recipe",
  "recipe": "multitrack-mix",               // generator handler id
  "params": {
    "durationSec": 25,
    "tracks": [
      { "kind": "kick", "freqHz": 55, "rateHz": 1.8, "gainDb": -10 },
      { "kind": "sub-bass", "noteHz": [55, 73], "gainDb": -12 },
      ...
    ],
    "preMasterTrimDb": -3.0
  }
}
```

**지원 recipe id:**
- `multitrack-mix` — N개 track 합성 후 평탄화 (genre fixture 의 표준)
- `ai-harsh-mix` — 의도된 결함 합성 (3-5kHz 피크 / sub rumble / phasey / brickwall)

**지원 track kind** (`multitrack-mix.tracks[].kind`):
`kick`, `sub-bass`, `lead-vocal`, `synth-pad`, `soft-snare`, `hi-hat`, `air-shimmer`, `guitar-pluck`, `guitar-body`, `vinyl-noise`, `string-pad`, `chest-resonance`, `vocal-sibilance`, `soft-piano`, `lead-synth`

각 kind 의 합성 로직: `services/python-audio/app/fixtures/generator.py`.

### 3.2 `external-cc0`

```json
{
  "type": "external-cc0",
  "url": "https://cdn.example.org/cc0/jazz-01.wav",
  "sha256": "abc123...",
  "license": "CC0",
  "attribution": "Author"
}
```

- 첫 사용 시 `urllib.request.urlretrieve` 로 다운로드.
- 다운로드 후 sha256 검증 (불일치 시 즉시 삭제 + 예외).
- 캐시 위치: `$LOUI_FIXTURE_CACHE` (기본 `/tmp/aimaster-fixtures/`).

### 3.3 `user-supplied`

```json
{
  "type": "user-supplied",
  "relativePath": "my-band/track-01.wav"
}
```

- `$LOUI_FIXTURE_DIR` 환경변수 필수 (사용자 디렉토리).
- 결합 경로: `${LOUI_FIXTURE_DIR}/${relativePath}`.
- 사용자 책임 — 저작권 / 형식 검증은 metadata 에 신뢰.

---

## 4. 카테고리 (11종)

| Category | Recommended preset | 용도 |
|---|---|---|
| `kpop`            | `builtin-kpop-loud` | K-Pop 차트 |
| `lofi`            | `builtin-natural`   | LoFi / chill |
| `edm`             | `builtin-loud`      | EDM / club |
| `hiphop`          | `builtin-punch`     | Hip-Hop / trap |
| `ballad`          | `builtin-warm`      | 발라드 |
| `acoustic`        | `builtin-natural`   | 어쿠스틱 / 라이브 |
| `female-vocal`    | `builtin-bright`    | 여성 보컬 강조 |
| `male-vocal`      | `builtin-balanced`  | 남성 보컬 |
| `ai-harsh-mix`    | `builtin-balanced`  | AI 결함 입력 (구조 테스트) |
| `reference-tone`  | n/a                 | sanity (M1 synthetic tone) |
| `broadcast-speech`| n/a (M2 추가)        | EBU -23 LUFS |

(`reference-tone`, `broadcast-speech` 는 M1.5 빌트인 recipe 에 미포함 — M2 에서 추가.)

---

## 5. 라이프사이클

```
                ┌─────────────────────────────────────────┐
                │  recipes/*.fixture.json (committed)     │
                │  schema + targetMetrics + recipe params │
                └────────────────────┬────────────────────┘
                                     │ load_builtin_fixture(name)
                                     ▼
                     ┌──────────────────────────────────┐
                     │  validate_fixture(data)          │
                     │  ↓ pass                          │
                     │  FixtureMetadata 객체             │
                     └────────────────┬─────────────────┘
                                      │ materialise_fixture(meta)
                                      ▼
        ┌─────────────────────────────────────────────────────────┐
        │  cache_path = $LOUI_FIXTURE_CACHE/<id>.wav              │
        │  if exists → return (cached=True)                       │
        │  else:                                                  │
        │    if synthetic-recipe → numpy synthesis → write WAV    │
        │    if external-cc0    → download + sha256 verify       │
        │    if user-supplied   → resolve $LOUI_FIXTURE_DIR + path│
        └────────────────────────────┬────────────────────────────┘
                                     │
                                     ▼
                              FixtureMaterialisationResult
                              { metadata, wavPath, sha256, cached }
                                     │
                                     ▼
                              tests / equivalence harness
```

---

## 6. 측정 / 정책 평가

각 fixture 가 자신의 정책을 갖는다 (`policy` 블록). 테스트 흐름:

```
fixture → materialise WAV → render via recommended preset → measure output
                                                              │
                                                              ▼
                                                  fixture.policy 평가:
                                                  ├─ TP ≤ targetMetrics.tpMaxDb ?  → HARD FAIL on overshoot
                                                  ├─ |measuredLufs - target.lufsI| ≤ tolerance?  → soft WARN
                                                  ├─ LRA in [lraMin, lraMax]?  → soft WARN
                                                  └─ 스펙트럼 ΔRMS / Δmax?  → soft WARN
                                                  │
                                                  ▼
                                                  metrics JSON 저장 +
                                                  warnings/hardErrors 기록
```

- **HARD FAIL**: 사용자에 실질 피해 가능한 위반 (TP 초과 → clip). 테스트 실패.
- **WARN**: 정책에서 벗어남 — 정량화된 데이터. 테스트 통과, 메트릭 JSON 에 기록.

**철학**: M1.5 는 갭을 측정하는 단계지 closing 하는 단계가 아니다. WARN 누적이 M2 의 작업 백로그.

---

## 7. 환경변수

| 변수 | 기본 | 용도 |
|---|---|---|
| `LOUI_FIXTURE_CACHE` | `/tmp/aimaster-fixtures` | 합성 WAV 캐시 디렉토리 |
| `LOUI_FIXTURE_DIR` | (none) | user-supplied fixture root |
| `LOUI_FULL_MATRIX` | `0` | `1` 시 9×7 전체 매트릭스, 0 시 9개 추천 페어 |

---

## 8. 새 fixture 추가 방법

1. **카테고리 결정** (위 § 4).
2. **`app/fixtures/recipes/<id>.fixture.json` 작성** — schema 따름.
   - target metrics 는 `01-DSP-POLICY-PHILOSOPHY.md` § 3 표 인용.
   - synthetic-recipe 이면 `tracks` 구성. external-cc0 이면 url + sha256.
3. **로드 검증**: `python3 -c "from app.fixtures import load_builtin_fixture; print(load_builtin_fixture('<id>'))"`
4. **합성 검증**: `python3 -c "from app.fixtures import *; print(materialise_fixture(load_builtin_fixture('<id>')).sha256)"`
5. **테스트 실행**: `pytest tests/test_engine_preset_realmusic.py::test_fixture_preset_render -k <id>`
6. **PR 의 commit message** 에 측정된 LUFS / TP / LRA 첨부.

---

## 9. M2+ 확장 계획

- **reference master WAV 가용화**: 자체 dsp-core (Rust) 가 안정되면 모든 fixture 에 대해 reference WAV 생성 → `referenceMaster.available = true` 변경.
- **categorical fixture 다양성**: 각 카테고리에 fixture 3개씩 (장르 내 variance 검증) — kpop-modern-01, kpop-ballad-01, kpop-dance-01 등.
- **broadcast-speech**: EBU -23 LUFS 정확도 검증용 보이스 fixture.
- **CC0 외부 소스**: ccMixter / Free Music Archive 큐레이션 후 sha256 lock.
- **사용자 fixture 갤러리**: 사용자 제출 → metadata 검증 → 마켓플레이스.

---

## 10. 디버깅

- 캐시 비우기: `rm -rf $LOUI_FIXTURE_CACHE`
- 결정성 확인: `materialise_fixture(meta).sha256` 가 같은 id 면 항상 같아야 함.
- 메트릭 확인: `/tmp/aimaster-m1.5-metrics/python-<fixture>__<preset>.json`
- 전체 매트릭스: `LOUI_FULL_MATRIX=1 pytest tests/test_engine_preset_realmusic.py -v`
