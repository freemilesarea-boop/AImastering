# M1.75 — Feature Extraction Design

> 본 문서는 `app/profiling/extract.py` 의 알고리즘적 결정과 그 근거를 정리한다.

---

## 1. 입력 → 출력 계약

```
입력:  WAV/FLAC 파일 경로 (PCM 또는 float)
출력:  ReferenceProfile (스키마 검증 통과 보장)
부작용: 없음 — audio buffer 는 함수 종료 직전 명시적 del
```

extractor 가 **저장하는 외부 상태**:
- 호출자에게 반환하는 ReferenceProfile (메모리)
- 선택적: cache 키 sha256 (호출자가 옵션으로 활성화)

**저장하지 않는 것**:
- audio sample buffer
- spectrogram (time × freq)
- 시간 시계열 (LUFS history, RMS history)
- phase 정보
- 식별 가능한 hash

---

## 2. 단계별 알고리즘

### 2.1 디코딩

```python
samples, sr = sf.read(path, always_2d=True)   # planar float32 (N, C)
n         = samples.shape[0]
channels  = samples.shape[1]
duration  = n / sr
```

**메모리 정책**: `samples` 는 함수 내부 지역변수. 모든 처리 후 `del samples` 명시.
함수 종료 시 GC.

### 2.2 LUFS / TP / LRA

```python
loud = loudnorm_pass1_via_ffmpeg(path)
# → {lufsI, tpDb, lra}
```

산업 표준 동기성을 위해 FFmpeg `loudnorm` pass-1 사용 (M1 / M1.5 와 동일 도구).
fallback (ffmpeg 미가용 시): pure-numpy K-weighted block RMS 의 median.

### 2.3 K-weighted block LUFS percentiles

```python
def _block_lufs(samples, sr, window_sec):
    mono = mean(samples, axis=1)
    weighted = _k_weight_filter(mono, sr)   # ITU R.128 BS.1770-4
    blocks   = reshape into non-overlapping windows
    ms       = mean(block² )
    return -0.691 + 10·log10(ms)            # array of one value per block

# 3-sec windows (short-term proxy):
short_blocks = _block_lufs(samples, sr, 3.0)
st = Percentiles(p10, p50, p90 from numpy.percentile)
# 400-ms windows (momentary proxy):
mom_blocks = _block_lufs(samples, sr, 0.4)
mom = Percentiles(...)
# ★ short_blocks / mom_blocks arrays 는 percentile 계산 후 GC
```

**근거**: 풀 시간축 LUFS 곡선은 fingerprint 위험. percentile 3개로 분포 요약 → 시간축 X.

### 2.4 Crest

```python
peak = max(abs(samples))
rms  = sqrt(mean(samples²))
crest_db = 20·log10(peak / rms)
```

단일 scalar.

### 2.5 Transient density

```python
mono = mean(samples, axis=1)
diff = abs(diff(mono))
env  = smoothed(diff, 5ms moving avg)
median_floor = median(env)
threshold    = 6 × median_floor
above        = env > threshold
# 30 ms 빈으로 묶어 중복 onset 제거
binned       = above reshape to (n_bins, gap)
any_above    = any(binned, axis=1)
onsets       = count of rising edges
density      = onsets / duration_min
```

**근거**: 정확한 onset 시각이 아니라 **밀도 (rate)** 만 저장. 시각 정보는 폐기.

### 2.6 1/3-oct 스펙트럼

```python
mono = mean(samples, axis=1)
win  = hanning(sr)                          # 1초 윈도우
accum = {cf: 0 for cf in THIRD_OCT_CENTRES}
for start in range(0, n − sr, sr):          # 비중첩
    x   = mono[start:start+sr] * win
    X   = np.fft.rfft(x)
    mag = |X| / (sum(win)/2)
    for cf in centres:
        lo = cf / 2^(1/6)
        hi = cf · 2^(1/6)
        accum[cf] += mean(mag² where freq in [lo, hi))
    win_count += 1

spectrum_db[cf] = 10·log10(accum[cf] / win_count)
# ★ 윈도우별 데이터는 GC
```

**근거**: time-averaged spectrum 만 저장. 시간축 spectrogram (재구성 가능) 없음.
1/3-oct (30 bin) 해상도 — fingerprinting 위험 영역 아래.

### 2.7 Derived tonal descriptors

```python
spectral_tilt   = polyfit_slope(log2(centres), spectrum_db)        # dB/oct
sub_ratio       = sum_linear(spectrum_db in [20, 100]) / total_linear
low_mid_db      = bandSumDb([100, 500]) − totalDb
vocal_db        = bandSumDb([1000, 4000]) − totalDb
air_db          = bandSumDb([10000, 22000]) − totalDb
harshness_index = harshLinear / mean(neighbourLinear), clamp [0, 20]
  harshBand  = [2000, 5000]
  neighbours = [700, 1500] + [6000, 10000]
```

모두 단일 scalar — 시간축 X.

### 2.8 Stereo

```python
L = samples[:, 0]; R = samples[:, 1]
# 1초 블록별 Pearson correlation → 평균
corr_mean = mean(per_block_corr)
# 전체 신호에서 MS 에너지 비
M = (L + R) / 2; S = (L − R) / 2
ms_ratio_db = 10·log10(mean(M²) / mean(S²))
# Width index — derived
raw_width = 2 · mean(S²) / (mean(M²) + mean(S²))
width_idx = clamp(raw_width · 2, 0, 4)
```

블록별 corr 배열은 평균 산출 후 폐기.

### 2.9 Fingerprint of features (NOT audio)

```python
canon = json.dumps(features.to_dict(), sort_keys=True, separators=(",",":"))
feature_fingerprint = sha256(canon.encode("utf-8"))
```

**의도**: feature 정의가 바뀌면 (e.g. spectrum bin 추가) fingerprint 도 바뀌어 캐시 무효화 신호.
**비의도**: audio 식별 불가 — 같은 audio 도 buffer 가 다르면 LUFS 가 미세 다를 수 있고 fingerprint 도 다름.

### 2.10 종료

```python
del samples       # 명시적 해제
# 함수 반환 → 모든 중간 배열은 GC
return profile
```

---

## 3. 성능 (실측)

| Fixture (25s @ 44.1k stereo 24-bit) | extract 시간 |
|---|---:|
| acoustic-fingerpick-01 | 2451 ms |
| ai-harsh-mix-01        | 2112 ms |
| ballad-piano-01        | 2645 ms |
| edm-festival-01        | 2041 ms |
| female-vocal-01        | 1974 ms |
| hiphop-trap-01         | 1976 ms |
| kpop-modern-01         | 1985 ms |
| lofi-chill-01          | 2445 ms |
| male-vocal-01          | 1993 ms |

**병목**: K-weighting biquad의 Python 루프. M2 에서 Rust dsp-core 가 이 영역을 인계받으면 ~50× 빨라질 예정.

3분 곡 (180s) 예상: 약 14~18초 (선형 스케일링 가정). 사용자 대기 가능 범위.

---

## 4. 결정성 (Determinism)

같은 입력 WAV → 같은 ReferenceProfile (단 FFmpeg 버전이 같다면).

`featureFingerprint` 비결정성 원천:
- FFmpeg loudnorm 의 부동소수 미세 차이 (희소)
- numpy 의 platform-specific reduction order

M2 에서 Rust dsp-core 도입 시 cross-platform 비트 동일성 보장 (`09-RUST-CPP-MIGRATION-PLAN.md` 의 결정성 절 참조).

---

## 5. 미구현 / 후속 개선

| 항목 | 우선순위 | 비고 |
|---|---|---|
| Mel-spectrum 옵션 (1/3-oct 의 perceptual 대안) | P3 | bin 수 cap 동일 유지 |
| Tempo / rhythm scalar 추가 | P3 | events/min 외 BPM 추정 |
| Genre classifier output 추가 | P3 | M3+ 의 AI 추천 모듈에 통합 |
| Reference profile 다중 평균 (앨범 전체) | P2 | M2+ |
| 실시간 partial extract (스트리밍) | P2 | M2+ — UI 미리듣기용 |
