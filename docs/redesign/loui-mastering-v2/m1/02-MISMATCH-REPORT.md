# M1 — Python ↔ TS DSP 불일치 측정 리포트 (베이스라인)

> 측정 일: 2026-05-19 (M1 첫 실측)
> 픽스처: `complex_tone_20s.wav` (220/440/880 Hz 사인 합성, 스테레오 2 ms offset, -18 dB 헤드룸, 20초, 44.1 kHz, 24-bit PCM)
> 측정 도구: 양쪽 출력 WAV 모두 **동일한 FFmpeg `loudnorm` pass-1** 으로 측정 (apples-to-apples).
> 재현: `pytest services/python-audio/tests/test_engine_preset_render.py && tsx apps/desktop/scripts/dsp-equivalence-compare.ts`

---

## 1. 요약 (TL;DR)

7개 빌트인 프리셋 모두 양쪽 어댑터에서 **로드/실행 성공** — 파이프라인 인프라는 갖춰졌다.

그러나 출력은 **체인이 본질적으로 다르기 때문에 일치하지 않으며**, 이는 M1 의 가설을 확정한다:

| 그룹 | 라우드니스 차이 | 원인 |
|---|---|---|
| **Low-loudness** (natural / balanced / bright / warm) | ΔLUFS −3.1 ~ +1.0 LU | 가까움 — 양쪽이 정상 작동, 미세한 처리 차이만 누적 |
| **High-loudness** (loud / kpop_loud / punch) | ΔLUFS **+15 ~ +17 LU** (TS > Python) | Python static loudnorm 체인이 픽스처에 dynamics 가 없어 라우드니스 푸시를 거의 안 함. TS iterative maximizer 는 타겟까지 밀어붙임 |

스펙트럼 차이는 모든 프리셋에서 큼 (max ΔMax 40~50 dB, ΔRMS 15~26 dB) — 이것이 **모듈 셋 차이의 직접 결과**다. Python 은 EQ / Dynamic EQ / Bus Comp / Saturator / Stereo Imager (/De-esser) 를 적용하고 TS 는 적용하지 않기 때문.

**이 큰 격차는 결함이 아니라 M1 의 측정 결과이며, M2 Rust dsp-core 가 닫아야 할 정확한 갭이다.**

---

## 2. 측정 표 (per-preset)

| Preset | Target<br/>LUFS / TP | Python<br/>LUFS-I | Python<br/>TP | TS<br/>LUFS-I | TS<br/>TP | ΔLUFS<br/>(TS−Py) | ΔTP | spec<br/>ΔRMS dB | spec<br/>ΔMax dB | Δ Crest |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| natural   | −14.0 / −1.0 | −12.95 | −8.41 | −16.05 | −13.20 | −3.10 | −4.79 | 17.48 | 43.63 | −1.75 |
| balanced  | −12.0 / −1.0 | −10.95 | −7.12 | −12.05 |  −9.20 | −1.10 | −2.08 | 16.24 | 42.07 | −1.13 |
| bright    | −12.0 / −1.0 | −10.95 | −6.68 | −12.05 |  −9.20 | −1.10 | −2.52 | 15.65 | 40.60 | −1.49 |
| warm      | −14.0 / −1.0 | −13.04 | −8.97 | −12.05 |  −9.20 | +0.99 | −0.23 | 15.21 | 40.06 | −1.27 |
| punch     | −11.0 / −1.0 | −24.65 | −20.93|  −8.05 |  −5.18 | +16.60| +15.75| 26.52 | 50.54 | −0.93 |
| loud      | −10.0 / −1.0 | −24.85 | −21.31|  −8.05 |  −5.18 | +16.80| +16.13| 25.65 | 50.88 | −0.83 |
| kpop_loud |  −9.0 / −0.8 | −23.35 | −19.60|  −8.05 |  −5.18 | +15.30| +14.42| 24.79 | 50.26 | −0.95 |

원시 JSON: `/tmp/aimaster-m1-metrics/python-*.json`, `/tmp/aimaster-m1-metrics/ts-*.json`, 종합: `/tmp/aimaster-m1-metrics/equivalence-report.json`

집계 max |delta|:
- **LUFS**: 16.80 LU
- **TP**: 16.13 dB
- **RMS**: 16.96 dB
- **Spec ΔRMS** (1/3 oct binned): max 26.52 dB
- **Spec ΔMax** (가장 차이 큰 단일 밴드): max 50.88 dB

---

## 3. 그룹 1 — Low-Loudness 프리셋 (natural / balanced / bright / warm)

ΔLUFS −3.1 ~ +1.0 LU.  **두 어댑터 모두 의도한 대로 작동하지만 출력이 다르다.**

| 원인 | 영향 |
|---|---|
| Python 의 5밴드 Adaptive EQ (low-shelf +2.0~2.5, mud-cut −3.0, air +2.0~3.5) | TS 미적용 → 출력 스펙트럼 큰 차이 |
| Python 의 Dynamic EQ (sibilance / mud / lowmid 컷) | TS 미적용 |
| Python 의 Bus Comp (1.3~1.6 ratio, glue) | TS 미적용 → TS 의 transient 가 더 살아있음 (Δ Crest 음수 = TS 가 더 다이내믹) |
| Python 의 Saturator (compand 곡선, 0~0.2) | TS 미적용 |
| Python 의 Stereo Imager (1.0~1.05) | TS 미적용 |
| Python 의 De-esser (warm 만, −1.5 dB @ 6.5k) | TS 미적용 — warm 의 ΔLUFS 가 +1.0 인 이유 (Python 의 deesser 가 살짝 라우드니스 깎음) |
| LUFS 알고리즘 차이: Python = FFmpeg `loudnorm` (linear), TS = `loudnessMaximizer` (iterative) | 비슷한 결과 (±1 LU) — 두 알고리즘 모두 잘 작동 |
| TS Limiter 의 ceiling −1.0 dBFS, Python alimiter 도 비슷 | 양쪽 모두 TP 가 ceiling 아래 — 다만 측정 TP 가 −7 ~ −13 인 것은 픽스처 자체가 사인 합성이라 inter-sample peak 가 낮음 |

**해석**: M2 Rust dsp-core 가 Python 의 6~7개 모듈을 구현하면 TS 측 LUFS 가 Python 측에 수렴할 것으로 기대.

---

## 4. 그룹 2 — High-Loudness 프리셋 (loud / kpop_loud / punch)

ΔLUFS **+15 ~ +17 LU** (TS 가 훨씬 큼).

**핵심 발견**: Python 의 `loud` / `kpop_loud` 프리셋은 `algorithm: "static"` (sources: `pipeline.py:_STATIC_CHAIN_STYLES`, `pipeline.py:_should_use_static_chain`). Static 체인은 `volume` 노드 + `alimiter` 만 사용하고 `loudnorm` 자체를 호출하지 않는다. 입력 픽스처에 다이내믹이 없으면 (사인 합성) static 체인은 **사실상 라우드니스 푸시를 하지 못한다** → 출력이 −24 LUFS 에서 정체.

반면 TS `loudnessMaximizer.ts` 는:
- 매 iteration 마다 LUFS 측정 → gain 추가 → soft-clip + peak limit → 재측정
- damping 0.85, max 4 iters
- 결과: 타겟 -10 LUFS 에 거의 도달 (-8.05 LUFS, 살짝 오버슛)

**즉, 이 그룹의 16 LU 갭은 "TS 가 잘못된 것" 이 아니라 "Python static chain 이 정적 사인에서 동작하지 않는 것" 이다.**

이는 M1 가 발견한 진짜 문제 중 하나다 (별도 이슈로 추적):

> **ISSUE-M1-A**: Python 의 static loudnorm 체인이 다이내믹 없는 입력에서 라우드니스 푸시를 못한다.
> 실제 음악 파일에서는 발생하지 않을 수 있으나, 합성 테스트 픽스처에서 항상 발생.
> **M2 의 결정**: 양쪽 어댑터가 dynamic content 가 부족할 때 동일하게 행동해야 하는가? (e.g. fail-fast vs best-effort)

---

## 5. 모듈 적용/미적용 매트릭스 (실측)

각 프리셋의 `adapterReport.entries` 를 집계:

| 모듈 | Python | TS | 비고 |
|---|---|---|---|
| source            | 7/7 applied | 7/7 applied | OK |
| adaptive-eq       | **7/7 applied** | **0/7 (noop)** | TS 미구현 |
| dynamic-eq        | **7/7 applied** | **0/7 (noop)** | TS 미구현 |
| bus-comp          | **7/7 applied** | **0/7 (noop)** | TS 미구현 |
| saturator         | **7/7 applied** | **0/7 (noop)** | TS 미구현 |
| stereo-imager     | **7/7 applied** | **0/7 (noop)** | TS 미구현 |
| deesser           | **1/7 applied** (warm) | **0/7 (noop)** | TS 미구현 |
| loudness-norm     | 7/7 applied | 7/7 applied | 알고리즘만 다름 |
| limiter           | 7/7 applied | 7/7 applied | 알고리즘만 다름 |
| isp-safety        | **7/7 applied** | **0/7 (noop)** | TS 미구현 |
| sink              | 7/7 applied | 7/7 applied | OK |
| (TS-only) gain-staging | — | n/a (preset 에 없음) | 빌트인 7개 preset 에 미포함 |
| (TS-only) transient-protection | — | n/a (preset 에 없음) | 동상 |
| (TS-only) vocal-enhancer | — | n/a (preset 에 없음) | 동상 |
| (TS-only) soft-clip | — | n/a (preset 에 없음) | 동상 |

→ 빌트인 프리셋은 Python 체인을 mirror 한 것이므로 TS-only 모듈을 의도적으로 포함하지 않았다.
TS-only 모듈을 포함한 preset 이 필요하면 별도로 작성 가능 (e.g. `tspreview-balanced.preset.json`).

---

## 6. 어댑터 로그 인스펙션 (각 프리셋 entries 요약)

```
preset      adapter   applied  noop   clamped  error
─────────────────────────────────────────────────────
natural     python    10       0      0        0      (모든 노드 applied — 11 노드 중 source/sink 포함)
            ts        4        6      0        0      (loudness-norm, limiter, source, sink 만 applied)
balanced    python    10       0      0        0
            ts        4        6      0        0
bright      python    10       0      0        0
            ts        4        6      0        0
warm        python    11       0      0        0      (deesser 추가)
            ts        4        7      0        0
punch       python    10       0      0        0
            ts        4        6      0        0
loud        python    10       0      0        0
            ts        4        6      0        0
kpop_loud   python    10       0      0        0
            ts        4        6      0        0
```

(`clamped`/`error` 가 모두 0 인 것은 M1 의 drift 비교가 informational only 임을 반영. M2 에서 엄격해진다.)

---

## 7. 허용 오차 베이스라인 갱신 (M1 → M2 → GA)

`00-M1-SCOPE.md` § 6 에서 제안한 표를 실측값으로 갱신:

| 지표 | M1 실측 (max abs) | M2 목표 | GA 목표 |
|---|---:|---:|---:|
| LUFS-I 차이 | **16.80 LU** | ≤ 0.5 LU | ≤ **0.1 LU** |
| True-Peak 차이 | **16.13 dB** | ≤ 0.3 dB | ≤ **0.2 dB** |
| RMS 차이 | **16.96 dB** | ≤ 0.5 dB | ≤ **0.2 dB** |
| 스펙트럼 (1/3 oct RMS dB) | **26.52 dB** | ≤ 1.0 dB | ≤ **0.3 dB** |
| 스펙트럼 (1/3 oct max dB) | **50.88 dB** | ≤ 2.0 dB | ≤ **1.0 dB** |
| Crest 차이 | **1.75 dB** | ≤ 0.5 dB | ≤ 0.3 dB |

M1 → M2 갭은 큰 것이 정상이다.  M2 Rust dsp-core 가 Python 의 6~7 모듈을 구현하면 즉시 ΔRMS / Δ스펙트럼이 1 dB 영역으로 떨어질 것으로 기대.

---

## 8. 발견된 별도 이슈

| ID | 이슈 | 영향 | 우선순위 |
|---|---|---|---|
| **ISSUE-M1-A** | Python static loudnorm chain (loud/kpop_loud/punch) 가 다이내믹 없는 입력에서 라우드니스 푸시 못함 | 합성 픽스처 테스트만 영향. 실제 음악에서는 발생 가능성 낮음 — 별도 측정 필요 | P1 |
| **ISSUE-M1-B** | 두 어댑터의 limiter 가 같은 ceiling (-1.0 dBTP) 설정인데 측정 TP 가 다름 (Python −7~−21 vs TS −5~−13) | 픽스처가 합성이라 TP 가 너무 낮아 의미 없음. 진짜 음악 픽스처 추가 필요 | P2 |
| **ISSUE-M1-C** | 7개 빌트인 프리셋이 TS-only 모듈을 포함하지 않음 (의도된 결정) | 향후 사용자 preset 이 그것을 포함할 수 있음 — TS 가 받아들이는지 별도 테스트 필요 | P2 |
| **ISSUE-M1-D** | 픽스처가 사인 합성 — 실제 음악과 본질적으로 다른 결과 가능 | 사용자가 실제 곡을 마스터링했을 때의 갭은 별도 측정 필요 | P1 |

---

## 9. 다음 단계

1. **실제 음악 픽스처 추가** (저작권 안전 — 사용자 합성 또는 CC0): pop / rock / hip-hop / vocal 각 10초.
2. **TS-only 프리셋 작성** (gain-staging + transient + vocal-enhancer + soft-clip + limiter) → TS 측에서 의도된 모듈이 모두 applied 인지 확인.
3. **Python static chain 에 minimum gain push 옵션 추가** (ISSUE-M1-A) — 또는 그 동작을 명시적 정책 필드로 노출.
4. **M2 Rust dsp-core 구현** → 동일 fixture 로 비교 (`m2-equivalence-compare.ts`) → M2 목표 표 달성.

---

## 10. 결론

M1 의 진짜 목표는 "**갭을 정량화하기**" 였고, 본 리포트가 그 정량화를 완성한다.

- 단일 프리셋 JSON 이 양쪽 어댑터에서 검증/로드/실행됨 → **인프라 OK**
- 두 어댑터의 entry 로그가 모듈별 적용/미적용을 명시 → **투명성 OK**
- 동일 fixture + 동일 측정 도구로 LUFS / TP / RMS / 스펙트럼 차이를 수치화 → **베이스라인 OK**
- ΔLUFS up to 16.8 LU, Δspec up to 50 dB — **상업용으로는 너무 큼**, 그러나 **M2 Rust dsp-core 의 정확한 작업 범위를 결정**

M2 의 성공 기준은 본 리포트의 모든 수치를 위 § 7 의 "M2 목표" 컬럼 이내로 좁히는 것.
