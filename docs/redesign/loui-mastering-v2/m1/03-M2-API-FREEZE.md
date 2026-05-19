# M1 → M2 인계 — API 동결 목록

> M2 (Rust dsp-core) 구현 전에 **반드시 고정**되어야 하는 API 면(surface).
> 이 목록은 M1 종료의 코드오너 리뷰 통과 항목이며, 이후 변경은 SemVer 메이저 bump 가 의무.

---

## 1. 동결 대상 (즉시 호환 보장)

### 1.1 EnginePreset JSON v1 스키마

**파일:** `aimaster-desktop/packages/shared-types/src/engine/preset.ts`, `modules.ts`, `validate.ts`
**식별자:** `$schema = "https://schemas.loui.studio/engine-preset/v1"`

동결되는 것:
- `EnginePreset` 최상위 형태 (`$schema / id / name / version / compatibility / meta / policies / output / chain`)
- 모든 모듈 type 문자열 (`source / gain-staging / adaptive-eq / dynamic-eq / multiband-eq / bus-comp / transient-protection / vocal-enhancer / saturator / stereo-imager / deesser / loudness-norm / soft-clip / limiter / isp-safety / dither / sink`)
- 각 모듈의 `params` 필드 이름과 단위
- `EnginePresetPolicies` 필드 (`vocalProtection / safeMode / aiCorrections / limiterStrength`)
- `EnginePresetOutput` 의 sample rate / bit depth / format enum
- `EnginePresetCompatibility.engineApiMin`

호환 정책:
- **추가** OK (모듈 추가, 모듈 옵션 필드 추가) — minor bump
- **삭제** = 메이저 bump + migration 함수 의무 (`@loui/preset-format` 패키지로)
- **의미 변경** = 메이저 bump 의무
- **이름 변경** = 금지 (alias 만 허용)

### 1.2 검증기 (validate)

- TS: `validateEnginePreset(input)` → `{ ok, errors[], preset? }`
- Python: `validate_preset(data)` → `list[{path, message}]`

양쪽이 **같은 입력에 같은 오류** 를 반환해야 함 (CI 회귀로 강제).

### 1.3 어댑터 보고서 (AdapterRunReport)

**파일:** `packages/shared-types/src/engine/preset.ts`

```ts
interface AdapterLogEntry {
  moduleId: string;
  moduleType: EngineModule['type'];
  status: 'applied' | 'noop' | 'clamped' | 'error';
  note?: string;
  clamps?: Array<{ field, from, to }>;
}

interface AdapterRunReport {
  presetId: string;
  presetVersion: string;
  adapter: 'python' | 'ts' | 'rust';   // M2 추가
  actualSampleRate: number;
  durationMs: number;
  entries: AdapterLogEntry[];
}
```

`adapter` 필드 enum 만 확장 가능 (`'rust'` 추가 — M2 에서).

### 1.4 Python 어댑터 호출 시그니처

**파일:** `services/python-audio/app/engine/adapter.py`

```python
def preset_to_kwargs(
    preset: EnginePreset,
    *,
    input_path: str,
    output_path: str,
) -> PresetKwargs
```

`PresetKwargs` 의 `pipeline_kwargs` dict 형태는 M2 까지 변경 가능 (현재 pipeline.py 가 살아있는 동안 임시).
M2 에서 Rust dsp-core 로 옮길 때 이 시그니처는 폐기되고 다음으로 대체:

### 1.5 TS 어댑터 호출 시그니처

**파일:** `apps/desktop/src/renderer/audio/preset/runPreset.ts`

```ts
function runPreset(input: AudioBufferLike, preset: EnginePreset): RunPresetResult;
interface RunPresetResult {
  buffer: AudioBufferLike;
  report: AdapterRunReport;
  internal: ModePipelineResult;        // 폐기 예정 (M2 에서 dsp-core 결과로 대체)
  durationMs: number;
}
```

**핵심**: M2 에서 `internal: ModePipelineResult` 는 사라지고 `internal: DspCoreResult` 로 대체됨. 그 외 시그니처는 그대로 유지.

### 1.6 등가성 보고서 v1

**파일:** `/tmp/aimaster-m1-metrics/equivalence-report.json`
**schema:** `loui.m1.equivalence-report.v1`

```json
{
  "schema": "loui.m1.equivalence-report.v1",
  "createdAt": "ISO",
  "fixture": "string",
  "aggregate": { "maxLufsDelta", "maxTpDelta", "maxRmsDelta", "maxSpectrumRmsDb", "maxSpectrumPeakDb" },
  "perPreset": [ { preset, lufsDelta, tpDelta, rmsDelta, crestDelta, spectrumRmsDeltaDb, spectrumMaxDeltaDb, pythonOnlyModules, tsOnlyModules, bothApplied } ]
}
```

M2 에서 `schema` 가 `loui.m2.equivalence-report.v1` 로 bump, `perPreset` 항목에 `rustDelta` 컬럼 추가.

### 1.7 측정 알고리즘 (cross-language 일관성 가드)

**파일:** `apps/desktop/scripts/lib/metrics.ts`, `services/python-audio/tests/test_engine_preset_render.py`

동결되는 것:
- LUFS / TP / LRA 측정 = **FFmpeg `loudnorm` pass-1** (양쪽 동일 도구)
- RMS 계산 = `20·log10(sqrt(mean(x²)))` (모든 채널 평탄화)
- 1/3-octave centres = ANSI S1.11 (`25, 31.5, 40, ..., 16000, 20000`)
- 윈도우 = Hann
- FFT 정규화 = `mag / (sum(window) / 2)` (numpy `rfft` 관례와 일치)

이 알고리즘이 바뀌면 Python/TS 사이 비교가 깨지므로 변경 시 양쪽 동시 PR 의무.

---

## 2. 동결되지 않은 부분 (M2 에서 변경 가능)

| 영역 | 변경 가능성 | 이유 |
|---|---|---|
| `preset_to_kwargs.pipeline_kwargs` 내부 형식 | 자유 | Python pipeline 폐기 예정 |
| `runPreset` 의 `internal: ModePipelineResult` | 자유 | TS preview 도 dsp-core 로 교체 |
| `MasteringMode` ('CLEAN'/'BALANCED'/'LOUD') 매핑 | 자유 | 7-style 직접 구현 시 폐기 |
| Python `app/engine/adapter.py` 내부 drift 검출 | 자유 | M2 에서는 JSON 이 정본이라 drift 자체 무의미 |

---

## 3. M2 Rust dsp-core 가 구현해야 할 정확한 모듈 목록

M2 우선순위 (M1 mismatch 리포트 § 5 기반):

| Pri | 모듈 | 이유 |
|---|---|---|
| **P0** | `adaptive-eq` | 7/7 preset 에 있음, 스펙트럼 차이의 핵심 원인 |
| **P0** | `bus-comp` | 7/7 preset 에 있음, 다이내믹 / glue 정의 |
| **P0** | `loudness-norm` | 알고리즘 통일 필요 — Python loudnorm vs TS maximizer 갭이 16 LU |
| **P0** | `limiter` | 알고리즘 통일 필요 — alimiter vs peakLimiter |
| **P0** | `dither` | 양쪽 모두 미구현 (16비트 출력 차단) |
| P1 | `dynamic-eq` | 7/7 preset 에 있음 |
| P1 | `saturator` | 5/7 preset (natural/loud/kpop_loud 제외) |
| P1 | `stereo-imager` | 7/7 preset 에 있음 |
| P1 | `isp-safety` (TP 4× post-check) | 7/7 preset 에 있음 |
| P2 | `multiband-eq` | reference matching 용, 빌트인 미사용 |
| P2 | `deesser` | warm 만 사용 |
| P2 | `gain-staging` | TS preview-only — Python 폐기 후에야 의미 |
| P2 | `transient-protection` | TS preview-only |
| P2 | `vocal-enhancer` | TS preview-only |
| P2 | `soft-clip` | TS preview-only |

---

## 4. M2 종료 시 검증 (Done When)

M2 가 완료되었다고 선언하려면 다음 모두 ✅:

- [ ] Rust `dsp-core` 가 P0 + P1 모듈 (총 9개) 을 구현
- [ ] N-API + WASM 두 빌드 모두 동일 출력 (cross-build 검증)
- [ ] 7개 빌트인 프리셋 + 동일 fixture 로 `m2-equivalence-compare.ts` 실행
- [ ] 등가성 리포트의 `aggregate.maxLufsDelta` ≤ **0.5 LU**
- [ ] `aggregate.maxTpDelta` ≤ **0.3 dB**
- [ ] `aggregate.maxSpectrumRmsDb` ≤ **1.0 dB**
- [ ] Python adapter 가 dsp-core 로 위임 (Python pipeline.py 의 DSP 함수 호출 0회)
- [ ] TS adapter 가 dsp-core (WASM) 로 위임 (`masteringModes.ts` 의 DSP 함수 호출 0회)
- [ ] 본 문서 § 1 의 모든 API 가 메이저 bump 없이 유지됨

---

## 5. 변경 절차 (M1 종료 후)

본 문서 § 1 항목을 바꾸려면:

1. **issue 작성**: `[engine-api breaking] <항목>`, M2 일정에 미치는 영향 명시
2. **3인 리뷰**: 코드오너 1 + DSP 책임자 1 + 제품 책임자 1
3. **마이그레이션 함수 작성** (`@loui/preset-format` 에 `migrate_v1_v2()` 같은 형태)
4. **양쪽 어댑터 동시 PR** (Python + TS), 골든 회귀 통과
5. **버전 bump**: shared-types 메이저, dsp-core 메이저, preset $schema 버전 bump

---

## 6. M1 종료 체크리스트 (코드오너 사인오프 대상)

본 문서가 "동결되었다" 고 선언하려면:

- [x] EnginePreset v1 TS 스키마 작성 + typecheck 통과
- [x] EnginePreset v1 Python 스키마 작성 + import 가능
- [x] TS 검증기 + Python 검증기 동작 확인
- [x] 7개 빌트인 프리셋 JSON 작성 + 양쪽 어댑터 로드 OK
- [x] Python pytest 7개 prefab 통과
- [x] TS equivalence 스크립트 7개 prefab 처리
- [x] `equivalence-report.json` 생성
- [x] M1 mismatch 리포트 (`02-MISMATCH-REPORT.md`) 실측값 채워짐
- [ ] **본 문서 (03) 코드오너 리뷰 + 사인오프**
- [ ] M2 트랙 킥오프

마지막 두 항목은 본 PR 리뷰 시 처리.
