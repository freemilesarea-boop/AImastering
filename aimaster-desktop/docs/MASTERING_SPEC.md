# Mastering Pipeline Specification

AIMASTER 오디오 마스터링 파이프라인의 기술 명세입니다.
각 단계의 목적, 파라미터, 설계 근거, 그리고 한계를 기술합니다.

---

## 목차

1. [−14 LUFS / −1.0 dBTP 정책](#-14-lufs--10-dbtp-정책)
2. [왜 2-pass loudnorm인가](#왜-2-pass-loudnorm인가)
3. [6단계 파이프라인 상세](#6단계-파이프라인-상세)
4. [스타일 프리셋 EQ 파라미터](#스타일-프리셋-eq-파라미터)
5. [AI 아티팩트 감지 알고리즘](#ai-아티팩트-감지-알고리즘)
6. [다이나믹 컨트롤](#다이나믹-컨트롤)
7. [사후 검증 (Post-Verification)](#사후-검증-post-verification)
8. [한계와 주의사항](#한계와-주의사항)

---

## −14 LUFS / −1.0 dBTP 정책

### 왜 −14 LUFS인가

스트리밍 플랫폼들은 업로드된 음원의 음량을 자체적으로 정규화합니다.
각 플랫폼의 기준 타깃은 다음과 같습니다.

| 플랫폼 | 통합 라우드니스 | 트루 피크 |
|--------|-----------------|-----------|
| Spotify | −14 LUFS | −1.0 dBTP |
| YouTube Music | −14 LUFS | −1.0 dBTP |
| Apple Music | −16 LUFS | −1.0 dBTP |
| Amazon Music | −14 LUFS | −2.0 dBTP |
| Tidal | −14 LUFS | −1.0 dBTP |

−14 LUFS는 대다수 플랫폼의 공통 타깃입니다.
이보다 **크게 제출하면** 플랫폼이 볼륨을 낮추어 다이나믹 손실이 발생합니다.
이보다 **작게 제출하면** 플랫폼이 볼륨을 올려 배경 잡음이 증폭됩니다.

−14 LUFS에 맞추면 플랫폼 정규화 처리가 최소화되어 **의도한 음색이 그대로 전달**됩니다.

### 왜 −1.0 dBTP인가

True Peak(트루 피크)는 디지털 신호를 DAC(디지털→아날로그 변환)로 재생할 때
샘플과 샘플 사이에서 발생하는 **오버슈팅**을 측정하는 지표입니다.
PCM 파형의 최대 샘플 값(0 dBFS)으로는 감지되지 않습니다.

트루 피크가 0 dBTP를 초과하면:
- 스피커/앰프에서 클리핑 왜곡이 발생
- MP3/AAC 인코딩 시 추가 왜곡 유발 (리-인코딩 패널티)
- 일부 플랫폼에서 자동 거부

−1.0 dBTP 헤드룸은 MP3/AAC 인코딩 과정의 오버슈팅을 흡수하기 위한 **안전 마진**입니다.
Apple Music은 −1.0 dBTP, Amazon Music은 −2.0 dBTP를 권고하지만,
−1.0 dBTP는 두 기준을 모두 충족하는 보수적인 선택입니다.

---

## 왜 2-pass loudnorm인가

FFmpeg의 `loudnorm` 필터는 1-pass 와 2-pass 두 가지 동작 방식이 있습니다.

### 1-pass (동적 정규화)

```
ffmpeg -i input.wav -af "loudnorm=I=-14:TP=-1:LRA=11" output.wav
```

파일을 앞에서부터 순차적으로 읽으면서 실시간으로 게인을 조절합니다.

**문제점:**
- 초반부와 후반부의 게인이 다를 수 있어 **음색 일관성이 깨집니다**
- 파일 끝에 가까워질수록 타깃에 가까워지는 수렴 현상이 발생
- 음악의 다이나믹 구조(조용한 인트로 → 폭발적 클라이맥스)를 왜곡

### 2-pass (선형 정규화)

**Pass 1 — 측정:**
```
ffmpeg -i input.wav \
  -af "loudnorm=I=-14:TP=-1:LRA=11:print_format=json" \
  -f null -
```

파일 전체를 분석하여 5개의 측정값을 추출합니다.

| 측정값 | 의미 |
|--------|------|
| `input_i` | 입력 통합 라우드니스 (LUFS) |
| `input_lra` | 라우드니스 레인지 (LU) |
| `input_tp` | 입력 트루 피크 (dBTP) |
| `input_thresh` | 라우드니스 게이트 임계값 |
| `target_offset` | 적용할 오프셋 (LU) |

**Pass 2 — 선형 적용:**
```
ffmpeg -i input.wav \
  -af "[eq,dyn,]loudnorm=I=-14:TP=-1:LRA=11:linear=true
       :measured_I=<input_i>
       :measured_LRA=<input_lra>
       :measured_TP=<input_tp>
       :measured_thresh=<input_thresh>
       :offset=<target_offset>
       :print_format=none" \
  -ar 44100 -acodec pcm_s24le output.wav
```

`linear=true` 모드에서는 전체 파일에 **단일 게인 값**을 적용합니다.
측정된 오프셋(`target_offset`)으로 계산한 고정 게인이므로 어느 지점에서든
음색의 비율이 그대로 유지됩니다.

**2-pass의 장점:**
- 파일 전체에 **동일한 게인 스케일** 적용 → 음색 일관성 보장
- 트루 피크 제한이 정확하게 작동
- EQ와 컴프레서를 먼저 적용한 뒤 최종 게인을 결정 가능

**trade-off:**
- 파일을 두 번 읽으므로 처리 시간이 약 2배 소요
- 극단적으로 다이나믹 레인지가 넓은 파일(오케스트라 등)은
  `linear=true` 만으로는 TP 제한이 어려울 수 있음

---

## 6단계 파이프라인 상세

```
입력 파일
  │
  ▼ Stage 1 — 입력 검증 (0–15%)
  │   ffprobe로 포맷/채널/샘플레이트/비트뎁스 확인
  │   loudnorm pass-1로 pre-master 라우드니스 측정
  │   soundfile + numpy로 파형 분석 (피크, DC, 무음, 클리핑)
  │
  ▼ Stage 2 — 전처리 경고 (15–28%)
  │   (처리는 하지 않고 경고만 수집)
  │   비권장 샘플레이트, 모노, DC 오프셋, 클리핑, 브릭월 LRA
  │
  ▼ Stage 3 — 톤 보정 EQ (28–40%, 필터 체인 구성)
  │   AI 아티팩트 보정 (먼저 적용)
  │   스타일별 EQ 필터 (나중에 적용)
  │
  ▼ Stage 4 — 다이나믹 컨트롤 (Stage 3과 합산)
  │   스타일별 acompressor 파라미터
  │   입력 피크 ≥ −0.5 dBFS 시 사전 게인 감쇄
  │
  ▼ Stage 5 — loudnorm pass-2 (40–75%)
  │   [EQ → Compressor → loudnorm linear=true]
  │   출력: PCM 24-bit, 44100 Hz WAV
  │
  ▼ Stage 6 — 사후 검증 (75–100%)
  │   출력 파일 재측정 (pass-1 재실행)
  │   LUFS 편차 > 1.5 dB → 경고
  │   True Peak > −1.0 dBTP → 경고
  │   출력 클리핑 감지
  │   320 kbps MP3 프리뷰 생성
  │
  ▼ 결과 반환
      outputPath, previewPath, loudnessBefore, loudnessAfter,
      appliedCorrections, pipelineWarnings, processingTimeSec
```

---

## 스타일 프리셋 EQ 파라미터

모든 EQ는 FFmpeg `equalizer` / `highshelf` / `lowshelf` 필터를 사용합니다.
필터는 loudnorm pass-2의 `pre_filter` 체인으로 주입됩니다.

### Balanced

```
(필터 없음)
```

원음을 최대한 보존합니다. loudnorm의 선형 게인 스케일만 적용됩니다.

### Warm

```
equalizer=f=3500:t=o:w=2.0:g=-2.0     # 3.5 kHz 거친 고역 완화 (−2 dB, 2옥타브)
equalizer=f=250:t=o:w=1.5:g=+0.5      # 250 Hz 온기 보존 (+0.5 dB)
highshelf=f=8000:t=h:g=-1.5            # 8 kHz 이상 공기감 부드럽게 (−1.5 dB)
```

### Bright

```
equalizer=f=300:t=o:w=1.0:g=-1.0      # 300 Hz 탁함 제거 (−1 dB)
equalizer=f=9000:t=o:w=2.0:g=+1.5     # 9 kHz 존재감/공기감 (+1.5 dB)
highshelf=f=12000:t=h:g=+1.0          # 12 kHz 이상 에어 (+1 dB)
equalizer=f=8000:t=o:w=1.0:g=-0.5     # 8 kHz 치찰음 가드 (−0.5 dB)
```

### Punch

```
equalizer=f=80:t=o:w=1.0:g=+1.5       # 80 Hz 킥/서브 바디 (+1.5 dB)
equalizer=f=350:t=o:w=1.0:g=-1.0      # 350 Hz 박스감 제거 (−1 dB)
equalizer=f=2000:t=o:w=1.5:g=+1.5     # 2 kHz 어택 존재감 (+1.5 dB)
```

### AI 아티팩트 보정 노치

스타일 EQ보다 **먼저** 적용되어 문제를 먼저 수정한 뒤 스타일을 입힙니다.

```
# 거친 고음역 (3–5 kHz 에너지 비율 > 28%)
equalizer=f=4000:t=o:w=2.0:g=-3.0

# 과도한 저역 (60–200 Hz 에너지 비율 > 45%)
equalizer=f=120:t=o:w=1.0:g=-4.0
```

---

## AI 아티팩트 감지 알고리즘

`soundfile` 로 파형을 로드하고 `numpy.fft.rfft` 로 주파수 도메인 분석을 수행합니다.

```python
fft_mag = np.abs(np.fft.rfft(mono_signal))
freqs   = np.fft.rfftfreq(len(mono_signal), d=1/sample_rate)

def band_energy(lo, hi):
    mask = (freqs >= lo) & (freqs < hi)
    return np.sum(fft_mag[mask] ** 2)

total_energy = band_energy(20, 20000)
```

| 감지 항목 | 판단 기준 | 처리 |
|-----------|-----------|------|
| `harshHighMid` | `band_energy(3000, 5000) / total > 0.28` | 4 kHz −3 dB |
| `boomyLowEnd` | `band_energy(60, 200) / total > 0.45` | 120 Hz −4 dB |
| `brickwall` | LRA < 2.5 LU | 경고만 (처리 없음) |
| `stereoImbalance` | `|20·log10(RMS_L/RMS_R)| > 3 dB` | 경고만 |
| `upsampleSuspect` | `band_energy(0.9·Nyquist, Nyquist) / total < 0.001` | 경고만 |

---

## 다이나믹 컨트롤

FFmpeg `acompressor` 를 사용합니다. 과도한 압축을 피하기 위해 파라미터를 보수적으로 설정했습니다.

| 스타일 | 임계값 | 비율 | 어택 | 릴리즈 | 메이크업 게인 상한 |
|--------|--------|------|------|--------|-------------------|
| Balanced | −18 dB | 2.5:1 | 20 ms | 250 ms | +3 dB |
| Warm | −20 dB | 2.0:1 | 30 ms | 300 ms | +3 dB |
| Bright | −16 dB | 3.0:1 | 15 ms | 200 ms | +3 dB |
| Punch | −14 dB | 4.0:1 | 10 ms | 150 ms | +3 dB |

**메이크업 게인 상한 +3 dB**: 과도한 볼륨 펌핑을 방지하기 위해 최대 +3 dB로 제한합니다.

**사전 게인 감쇄**: 입력 피크가 −0.5 dBFS 이상(거의 클리핑)인 경우,
컴프레서 전에 −3 dBFS 목표로 볼륨을 낮춥니다.
이를 통해 loudnorm pass-2의 true peak 제한 마진을 확보합니다.

---

## 사후 검증 (Post-Verification)

Stage 6에서 출력 파일에 loudnorm pass-1을 **재실행**하여 실제 수치를 검증합니다.

| 검증 항목 | 임계값 | 결과 |
|-----------|--------|------|
| LUFS 편차 | `|result − target| > 1.5 dB` | `LUFS_DEVIATION` 경고 |
| True Peak 초과 | `result > −1.0 dBTP` | `TRUE_PEAK_EXCEEDED` 경고 |
| 출력 클리핑 | 출력 파일 파형 분석 | `OUTPUT_CLIPPING` 경고 |
| 길이 불일치 | `|출력 길이 − 입력 길이| > 0.5s` | `DURATION_MISMATCH` 경고 |

경고는 `pipelineWarnings` 배열로 반환됩니다. 경고가 있어도 파일은 저장됩니다.
단, `TRUE_PEAK_EXCEEDED` 와 `OUTPUT_CLIPPING` 은 level=`error` 로 마킹됩니다.

---

## 한계와 주의사항

### 음질 관련

**loudnorm linear=true 의 한계**
`linear=true` 모드는 파일 전체에 단일 게인을 적용합니다.
매우 다이나믹 레인지가 넓은 파일(클래식 오케스트라, 앰비언트 등)에서는
클라이맥스 피크를 기준으로 게인이 결정되어 **전반적인 볼륨이 낮게** 느껴질 수 있습니다.
이 경우 `linear=false` (동적 모드)가 더 나은 결과를 줄 수 있으나
음색 왜곡 위험이 있습니다.

**이미 마스터링된 파일 재처리**
브릭월 리미팅이 적용된 파일(LRA < 2.5 LU)은 컴프레서가 추가 다이나믹을 만들어낼 수 없습니다.
파이프라인은 경고(`BRICKWALL_INPUT`)를 발생시키고 처리를 진행하지만,
원본보다 나은 결과를 보장하기 어렵습니다.
마스터링은 **믹스 파일**에 적용하는 것이 권장됩니다.

**모노 파일**
스테레오 변환은 수행하지 않습니다.
모노 입력은 모노 출력으로 처리됩니다.

**DC 오프셋**
DC 오프셋이 있는 파일은 loudnorm 측정에 영향을 줄 수 있습니다.
파이프라인은 경고를 발생시키지만 자동 DC 제거는 하지 않습니다.
DAW에서 DC 오프셋을 제거한 후 처리할 것을 권장합니다.

### 기술적 한계

**샘플레이트 변환**
출력은 항상 44,100 Hz로 변환됩니다(기본값). 48,000 Hz 출력이 필요한 경우
설정(`sampleRate`)으로 변경 가능하지만, 입력이 96 kHz인 경우 다운샘플링 필터가
적용됩니다. FFmpeg의 기본 리샘플러(`swr`)를 사용하므로 고품질 리샘플러가
필요한 경우 추가 설정이 필요합니다.

**처리 시간**
2-pass loudnorm 특성상 긴 파일(30분 이상)은 처리 시간이 상당히 소요됩니다.
타임아웃 기본값은 2분이므로 매우 긴 파일은 설정에서 타임아웃을 조정해야 합니다.

**MP3 입력의 진정한 피크**
MP3는 손실 압축 포맷이므로 디코딩 시 샘플 값이 원본과 다를 수 있습니다.
True Peak 측정은 디코딩된 PCM 기준이므로 실제 재생 시 클리핑과 차이가 있을 수 있습니다.

**스테레오 이미지**
현재 파이프라인은 스테레오 이미징(M-S 처리, 스테레오 폭 조절 등)을 적용하지 않습니다.
입력의 스테레오 필드가 그대로 출력됩니다.

**AI 아티팩트 감지의 정확도**
FFT 에너지 비율 기반 감지는 단순하고 빠르지만, 장르나 악기 구성에 따라
오탐지(false positive)가 발생할 수 있습니다.
예: 심벌 위주의 재즈 녹음은 고역 에너지 비율이 높아 `harshHighMid` 로 오탐지될 수 있습니다.
`applyAiCorrections: false` 설정으로 비활성화할 수 있습니다.
