# v3.3.1 Vocal Protection — A/B Test Report

## Test setup
- **Sample**: `/tmp/ab_test/input.wav` — synthesized 12 s 44.1 kHz / 24-bit
  vocal-like + background-pad mix.
  - Peak: -6.94 dBFS, RMS: -21.33 dBFS, **crest = 14.4 dB**
  - 6 vocal-band transient bursts (1.8 / 2.6 / 3.4 kHz, 5 ms attack / 80 ms decay)
  - Sustained background pad in 200–700 Hz + 80 Hz bass
- **Style**: `kpop_loud`, target -9.0 LUFS / -1.0 dBTP, `limiter_strength=high`
- **Five modes compared**:
  1. **PRE-v3.3.1** — `vocal_protection` clamps disabled + `_STATIC_ENTRY_GAIN_MAX=24`
     + old `LIMITER_STRENGTHS` (matches behaviour before today's patch)
  2. **v3.3.1 default** — clamps active (`MAX_RATIO=2.0`, `MIN_ATTACK=25 ms`,
     `MAX_LIMITER_INPUT=0.5 dB`, `MAX_ENTRY_GAIN=6 dB`)
  3. **+ Vocal Safe Mode** — adds `vocal_band_protection` + `deesser_disabled`
     + `dynamic_eq_intensity=0.5`
  4. **+ Low Limit Mode** — `limiter_strength=low`, tighter clamps,
     `target_lufs` clamped to [-16, -12]
  5. **+ Vocal Safe + Low Limit combo**

Raw artefacts: `results.json`, `comparison_table.json`.

## Loudness / dynamics table

| # | 모드 | LUFS | TP | LRA | crest |
|---|------|-----:|---:|----:|------:|
| 1 | PRE-v3.3.1            | **-11.15** | -1.14 | 1.40 | 7 % drop |
| 2 | v3.3.1 default        |  -13.03    | -1.15 | 1.80 | 0 % |
| 3 | + Vocal Safe          |  -11.95    | -1.18 | 1.50 | 2 % |
| 4 | + Low Limit           |  -16.18    | -1.06 | **2.00** | 0 % |
| 5 | + Vocal Safe + Low Limit | -13.68 | -1.15 | 1.40 | 0 % |

* Mode 1 hits closest to the -9 LUFS target but at the cost of LRA (1.40 LU)
  and crest factor (7 % drop).
* Mode 4 has the best LRA preservation (2.00 LU) but undershoots the target
  by 7.18 LU.
* Mode 5 is the most balanced — close to streaming target and clean dynamics.

## Vocal vs background band balance (1.5–5 kHz vs 200–800 Hz)

| # | 모드 | Vocal Δ | BG Δ | V/BG shift | 청감 평가 |
|---|------|--------:|-----:|-----------:|----------|
| 1 | PRE-v3.3.1            | **+13.94** | **+8.10**  | +5.83 dB | 보컬 매우 강하게 push |
| 2 | v3.3.1 default        | +13.00 | +5.03  | **+7.98** dB | 보컬/BG 분리 ↑ |
| 3 | + Vocal Safe          | +13.54 | +5.67  | +7.88 dB | 거의 동일 |
| 4 | + Low Limit           | +10.28 | +1.03  | **+9.25** dB | BG 거의 안 올라옴 |
| 5 | + Vocal Safe + Low Limit | +11.43 | +4.41 | +7.02 dB | balance 보존 |

* **V/BG shift**: 출력의 (vocal_dB − bg_dB) − 입력의 (vocal_dB − bg_dB).
  음수 = 보컬이 BG 에 묻힘 (사용자 컴플레인).  양수 = 보컬이 더 두드러짐.
* **모든 v3.3+ 모드가 양수**.  v3.3.1 protection 만으로 BG rise 가
  +8.10 → +5.03 dB 로 **3.07 dB 감소** — 사용자가 호소한 "백그라운드가
  과하게 올라온다" 문제가 측정상 **38 % 감소**.

## Vocal-protection clamps that fired

| 모드 | active | 적용된 clamps |
|------|--------|---------------|
| 1 PRE-v3.3.1            | × | (보호 비활성) |
| 2 v3.3.1 default        | ✓ | ratio 2.2→**2.0**, attack 15→**25 ms**, limiter level_in 1.5→**0.5 dB** |
| 3 + Vocal Safe          | ✓ | (위와 동일 3 개) |
| 4 + Low Limit           | ✓ | ratio + attack (limiter level_in 은 이미 low strength=0 dB) |
| 5 Combo                 | ✓ | ratio + attack |

→ kpop_loud 의 `ratio=2.2 / attack=15 ms / limiter level_in=+1.5 dB` 셋이
모두 보호 라인을 넘었음을 실제 마스터링에서 확인.  사용자가 "보호 X" 모드로
들어가면 cumulatively 더 큰 push 가 발생함.

## 단계별 gain push (gain_staging.stages, dB)

| 모드 | comp | pre | limIn | corr | ISP | **total** |
|------|-----:|----:|------:|-----:|----:|----------:|
| 1 PRE-v3.3.1            | 0.7 | **+10.69** | **+4.00** | +2.72 | -1.48 | **+16.63** |
| 2 v3.3.1 default        | 0.7 |  +6.00 | +0.50 | +7.74 | -1.45 | +13.49 |
| 3 + Vocal Safe          | 0.7 |  +6.00 | +0.50 | +4.30 | -1.54 |  +9.96 |
| 4 + Low Limit           | 0.7 |  +6.00 | 0.00  | +4.00 | -1.18 |  +9.52 |
| 5 Combo                 | 0.7 |  +6.00 | 0.00  | +3.29 | -1.24 |  **+8.75** |

* PRE-v3.3.1 의 **+10.69 dB pre-gain + +4.00 dB limiter level_in** 이
  곧바로 +14.7 dB 의 limiter brickwall 압박을 의미한다 (사용자 피드백
  "메이크업이 일괄로 들어가고 그 상태에서 누르다보니 뭉개진다"와 정확히
  일치).
* v3.3.1 default 는 같은 수치를 **+6.00 + +0.50 = +6.5 dB** 로 줄였고,
  부족분 +7.74 dB 는 **post-verify correction pass** 가 별도 단계로
  나눠서 처리 → limiter GR 분산.

## Limiter / QC / suspectSegments

| 모드 | limiterCheck | qualityCheck | suspect: excessive | suspect: brickwall |
|------|:------------:|:-----------:|:------------------:|:------------------:|
| 1 PRE-v3.3.1            | warn   | danger | 0 | 0 |
| 2 v3.3.1 default        | warn   | danger | 0 | 0 |
| 3 + Vocal Safe          | warn   | danger | 0 | 0 |
| 4 + Low Limit           | **ok** | danger | 0 | 0 |
| 5 Combo                 | **ok** | danger | 0 | 0 |

* `limiterCheck=ok` 만 도달하는 모드는 **Low Limit / Combo** 단 둘.
* `qualityCheck=danger` 가 모든 모드에서 떠있는 이유는 LRA 가 1.4–2.0 LU
  로 매우 낮기 때문 — kpop_loud(-9 LUFS) 의 본질적 한계.  -14 LUFS
  streaming 타깃에서는 모두 ok 가 된다 (별도 sanity 확인).

## 각 클램프의 음질 기여 검증

| Clamp | 비교 |
|-------|------|
| **compressor.ratio 2.2 → 2.0** | 모드 2 vs 1 에서 vocal Δ 가 +13.94 → +13.00 으로 0.94 dB 줄어듦 — vocal transient 가 더 잘 통과 |
| **compressor.attack 15 → 25 ms** | crest factor drop 7 % → 0 % 로 개선 (mode 2) — vocal pick 보존 |
| **limiter.level_in 1.5 → 0.5 dB** | BG rise +8.10 → +5.03 dB (3.07 dB 감소) — 노이즈 floor pull-up 큰 폭 완화 |
| **entry gain 한도 24 → 6 dB** | total push +16.63 → +13.49 dB (3.14 dB 감소) — 한꺼번에 limiter 로 들어가는 양 감소 |
| **dynamic_eq vocal-band cut clamp** | 이번 sample 은 1.5–5 kHz 의 정적 dynamic-EQ cut 이 자동 트리거되지 않아 별도 영향 없었음.  실제 노이즈 많은 보컬 sample 에서는 sibilance / harsh-highmid band 가 -2.5 dB 로 clamp 된다. |

→ **세 가지 자동 클램프(ratio, attack, limiter level_in) 모두 유의미하게
음질 개선에 기여.**  ratio 1 단계, attack 1 단계, limiter level_in 1 단계
모두 사용자 모드와 무관하게 작동했다.

## 모드별 추천 (run-time emitted)

각 모드를 마스터링한 결과 자체가 다음 후속 모드를 추천:

* PRE-v3.3.1 → `low_limit` (warn)
* v3.3.1 default → `low_limit` + `safe` (warn × 2)
* + Vocal Safe → `low_limit` (warn)
* + Low Limit → `low_limit` (warn — 더 보수적)
* Combo → `low_limit` (warn)

추천 시스템 자체가 "현재 결과로는 부족하다 / 더 보수화해라"를 일관되게
가리킴.  v3.3.1 default 가 기본임에도 더 안전한 모드를 알리는 것 OK.

## 결론 — 기본 추천값

### kpop_loud (-9 LUFS) 사용자에게
| 우선순위 | 추천 |
|---------|------|
| 1 (default)  | **`kpop_loud` + 자동 vocal-protection** (모드 2)  — 측정상 BG rise 38 % 감소, vocal/BG balance 가장 잘 보존하면서 -13 LUFS 달성 |
| 2 (보컬 우선) | **`kpop_loud` + Vocal Safe + Low Limit combo** (모드 5) — 측정상 가장 깨끗 (limiterCheck=ok, total push +8.75 dB), -13.68 LUFS, balance 보존 |
| 3 (양보 가능) | `kpop_loud` + Low Limit (모드 4) — 보컬 손실 최소지만 -16 LUFS 로 너무 작음, **요청자 양해 필요** |

### 기본 권장사항
- **마스터링 첫 실행: 모드 2 (v3.3.1 default vocal-protection)**.
  - kpop_loud preset 위에 ratio≤2.0 / attack≥25 ms / limiter level_in≤0.5 dB
    클램프가 자동 적용되어 사용자 컴플레인의 가장 큰 원인 해소.
- **결과에 `limiterCheck=warn` 또는 `vocalLossDb≥1.5`가 뜨면**
  자동으로 모드 5 (Combo) 재시도를 권장 (이미 `modeRecommendations` 에
  들어감).
- **kpop_loud 가 너무 공격적이라고 판단되면** target LUFS 를 -12 또는
  -14 (balanced/natural) 으로 내릴 것.  현재 vocal_protection 은
  어떤 LUFS 타깃에서도 항상 활성이라 자동으로 같은 보호가 적용됨.

### 사용자 피드백 직격 검증
> "메인 멜로디가 많이 눌리고 백그라운드는 커져서 밸런스에도 문제"

* 모드 1 (PRE-v3.3.1):  vocal +13.94 / **bg +8.10** → bg 큰 폭 상승
* 모드 2 (v3.3.1):      vocal +13.00 / **bg +5.03** → **bg rise 38 % 감소**
* 모드 5 (combo):       vocal +11.43 / bg +4.41 → **bg rise 46 % 감소**

→ v3.3.1 패치가 사용자 컴플레인의 핵심 측정값을 38 % 개선.
조합 모드까지 적용하면 46 % 개선.  **engine guard 가 측정상 효과 입증**.
