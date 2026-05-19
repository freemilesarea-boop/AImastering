# M1 — Engine API + DSP Output Equivalence (Scope)

> 본 문서는 M1 마일스톤의 **확정 범위 / 비범위 / 진실** 을 정의한다.
> 임시 땜빵 금지. 상업 출시 등급의 테스트 가능한 구조 구축이 목표.

---

## 1. M1 의 진실 (Honest Premise)

코드를 깊이 읽고 확인한 결과:

> **현재 Python 오프라인 엔진과 TS 실시간 프리뷰는 "같은 DSP 의 두 구현" 이 아니다.
> 서로 다른 모듈 셋 / 다른 모드 분류 / 다른 알고리즘을 가진, 본질적으로 다른 두 체인이다.**

| | Python (오프라인 렌더) | TS (실시간 프리뷰) |
|---|---|---|
| 모드 분류 | `natural / balanced / bright / loud / kpop_loud / warm / punch` (7) | `CLEAN / BALANCED / LOUD` (3) |
| 모드 → LUFS 매핑 | natural=-14, balanced=-12, loud=-10, kpop_loud=-9, warm=-14, punch=-11 | CLEAN=-16, BALANCED=-12, LOUD=-8 |
| Adaptive EQ (5밴드 셸프/피크) | ✅ FFmpeg `equalizer` chain | ❌ 없음 |
| Dynamic EQ | ✅ FFmpeg `adynamicequalizer` (6밴드) | ❌ 없음 |
| Bus Compressor (Glue) | ✅ FFmpeg `acompressor` (스타일별 파라미터) | ❌ 없음 |
| Multiband EQ (참조 매칭) | ✅ 4밴드 (low/mid/vocal/high) | ❌ 없음 |
| Saturator | ✅ `compand` 곡선 | ❌ 없음 |
| Stereo Width | ✅ `extrastereo` | ❌ 없음 |
| De-Esser | ✅ `equalizer` -1.5 dB @ 6.5kHz | ❌ 없음 |
| Gain Staging (peak/RMS/LUFS 타겟) | ❌ (loudnorm 의 일부) | ✅ 자체 모듈 |
| Transient Protection | ❌ | ✅ 자체 모듈 |
| Vocal Enhancer (formant) | ❌ | ✅ 자체 모듈 |
| Soft Clip + Peak Limiter (TS 자체) | ❌ | ✅ `softClip` + `peakLimiter` |
| Loudness Normalization | ✅ FFmpeg `loudnorm` 2-pass 또는 static volume | ✅ `loudnessMaximizer` iterative |
| Brickwall Limiter | ✅ FFmpeg `alimiter` (ASC) | ✅ `peakLimiter` (lookahead) |
| ISP Safety (4× oversample 사후) | ✅ numpy | ❌ (4× oversample TP 측정만) |

**결론**: 동일 입력 + 동일 모드 명에서 두 출력이 동일하길 기대할 수 없다.
이것을 숨기지 말고 정량화해야 한다.

---

## 2. M1 의 목표 (재정의)

1. **단일 진실의 정규 스키마 (Canonical Engine Schema) 정의.**
   Python 의 풀체인을 **상위집합 (superset) 으로 채택** — 이것이 정본.
2. **양쪽 어댑터 구현.**
   - **Python adapter**: 스키마 → `run_pipeline()` 인자. **무손실** (Python 이 정본).
   - **TS adapter**: 스키마 → 기존 `processMasteringWithMode()`. **명시적 손실 매핑** (현재 TS 구현이 미구현인 모듈은 패스스루로 기록).
3. **JSON 프리셋 v1 실적용.** 현재 하드코드된 7개 모드를 `*.preset.json` 로 외부화. 둘 다 같은 파일에서 읽음.
4. **불일치 정량화.** 동일 픽스처 + 동일 프리셋에서 Python 과 TS 출력의 LUFS / TP / RMS / FFT bin-wise dB 차이를 측정하는 골든 테스트.
5. **M2 API 동결.** Rust dsp-core 가 만족해야 할 정확한 API 표면 + SemVer 정책.

---

## 3. M1 의 **비** 범위

다음은 명시적으로 M1 에서 하지 않는다:

- ❌ **UI 변경** (페이지/컴포넌트/스토어 형태 변경 금지)
- ❌ **Rust 구현**
- ❌ **새 DSP 알고리즘 추가** (현재 가진 것만 정규화)
- ❌ **FFmpeg 의존 제거**
- ❌ **Python ↔ TS 의 출력을 강제로 일치시키기** (불가능 — 두 체인이 다름)
- ❌ **새 모드 추가**
- ❌ **임시 패치** (e.g. "TS preview 에 가짜 EQ 슬라이더 추가" 같은 것 금지)

---

## 4. 핵심 아키텍처 결정 (M1 에서 확정)

### 4.1 정본은 Python 이다 (M2 까지)

이유:
- Python 은 **모듈 셋이 풍부** (7개 추가 모듈).
- Python 은 **이미 상업 출시 후보의 사운드** 를 만들고 있다 (v3.6 RC).
- TS preview 는 **사용자 청취용 근사** 로 명시 운영.

M2 에서 Rust dsp-core 가 정본을 인계받는다. 그때까지 TS preview 의 역할은:
> "최종 결과와 다를 수 있음 — 라우드니스 / 동작 감각만 미리듣기"

이 사실을 사용자에게 명시한다 (UI 텍스트는 M3 에서, 시스템은 지금부터).

### 4.2 스키마는 Python 의 풀체인을 표현한다

- 모든 모듈을 타입화 (`AdaptiveEqModule`, `DynamicEqModule`, `BusCompModule` 등).
- TS 가 미구현한 모듈은 스키마에 그대로 두되, TS 어댑터가 **로그를 남기며 패스스루** 한다.
- 이로써 M2 Rust 구현이 어디까지 채워야 하는지 명확해진다.

### 4.3 모드 명 통일

- 둘 다 Python 의 7-style 명을 정본으로 채택 (`natural/balanced/bright/loud/kpop_loud/warm/punch`).
- TS 의 `CLEAN/BALANCED/LOUD` 는 폐기 예정 (TS adapter 가 7-style → 3-mode 매핑 테이블 적용).

| Python style | TS 매핑 모드 | 이유 |
|---|---|---|
| natural | CLEAN | 가장 보수적 |
| balanced | BALANCED | 일치 |
| bright | BALANCED | TP/limiter 비슷 |
| warm | BALANCED | TP/limiter 비슷 |
| loud | LOUD | 일치 |
| kpop_loud | LOUD | TP -0.8 는 추후 별 모드 |
| punch | LOUD | limiter 강도 일치 |

이 매핑은 TS adapter 의 동작 정의일 뿐이며, M2 에서 Rust 가 정확한 7가지 모두 구현하면 폐기.

---

## 5. 산출물

| # | 산출물 | 위치 |
|---|---|---|
| 1 | M1 스코프 (본 문서) | `docs/redesign/loui-mastering-v2/m1/00-M1-SCOPE.md` |
| 2 | DSP 모듈/파라미터 매핑표 | `docs/redesign/loui-mastering-v2/m1/01-DSP-MAPPING.md` |
| 3 | TS Engine Schema (`shared-types/engine/*`) | `aimaster-desktop/packages/shared-types/src/engine/` |
| 4 | 7개 빌트인 프리셋 JSON | `aimaster-desktop/services/python-audio/app/engine/builtin/*.preset.json` |
| 5 | Python adapter (schema → pipeline) | `aimaster-desktop/services/python-audio/app/engine/` |
| 6 | TS schema-aware runner | `aimaster-desktop/apps/desktop/src/renderer/audio/preset/` |
| 7 | 골든 픽스처 + 비교 테스트 (Python) | `aimaster-desktop/services/python-audio/tests/test_engine_preset_render.py` |
| 8 | 크로스 언어 비교 스크립트 | `aimaster-desktop/apps/desktop/scripts/dsp-equivalence-compare.ts` |
| 9 | 불일치 리포트 | `docs/redesign/loui-mastering-v2/m1/02-MISMATCH-REPORT.md` |
| 10 | M2 API 동결 목록 | `docs/redesign/loui-mastering-v2/m1/03-M2-API-FREEZE.md` |

---

## 6. 허용 오차 정책 (제안)

M1 은 **측정만 한다 — 강제 일치 시키지 않는다.** 대신 M1 종료 시점의 측정값을 그대로 베이스라인으로 기록하고, M2 Rust 구현이 어디까지 좁혀야 하는지를 명시한다.

| 지표 | M1 베이스라인 (예상) | M2 목표 | M3 목표 (GA) |
|---|---|---|---|
| LUFS-I 차이 | ±2.0 LU (체인 다름) | ±0.5 LU | **±0.1 LU** |
| True-Peak 차이 | ±1.5 dBTP | ±0.3 dBTP | **±0.2 dBTP** |
| RMS 차이 (avg dB) | ±2.0 dB | ±0.5 dB | **±0.2 dB** |
| FFT 차이 (1/3 oct binned, RMS dB) | ±3.0 dB | ±1.0 dB | **±0.3 dB** |
| Crest factor 차이 | ±2.0 dB | ±0.5 dB | **±0.3 dB** |

**위 수치는 측정 후 조정한다.** 02-MISMATCH-REPORT.md 에 실측값이 기록되면 그때 확정.

---

## 7. 게이트 / 종료 조건

M1 완료 = 다음 모두 ✅:

- [ ] 7개 빌트인 프리셋 JSON 이 `EnginePreset` 스키마 (zod 검증) 통과
- [ ] Python adapter 가 7개 프리셋 모두 로드 → `run_pipeline()` 호출 → 출력 WAV 생성 (회귀 없음)
- [ ] TS adapter 가 7개 프리셋 모두 로드 → `processMasteringWithMode()` 호출 → 출력 buffer 생성
- [ ] 골든 픽스처 (≥3 종류: 사인, 핑크 노이즈, 복합 톤) 가 양쪽에서 처리됨
- [ ] 비교 테스트가 LUFS / TP / RMS / FFT 차이를 JSON 리포트로 출력
- [ ] 불일치 리포트 (02) 가 실측값으로 채워짐
- [ ] M2 API 동결 목록 (03) 이 코드오너 리뷰 통과
- [ ] `pytest services/python-audio/tests/test_engine_preset_render.py` 통과
- [ ] `tsx apps/desktop/scripts/dsp-equivalence-compare.ts` 정상 실행
- [ ] 기존 v3.6 RC 의 IPC 경로 회귀 없음 (`master` 핸들러 그대로 동작)

---

## 8. M2 로의 인계

M1 종료 시점에서 동결되는 API:

- `EnginePreset` JSON 스키마 (preset v1)
- `ModuleChain` 직렬화 형식
- 모든 모듈 타입의 `params` 필드 (각 모듈별 인터페이스)
- Python `engine.adapter.run_preset()` 시그니처
- TS `runPreset(buf, preset)` 시그니처
- IPC 채널 `engine:render` (신규, `audio:master` 와 병행 운영)

M2 의 Rust dsp-core 는 이 API 들을 **그대로 구현**한다. Python pipeline 은 점진적으로 폐기.
