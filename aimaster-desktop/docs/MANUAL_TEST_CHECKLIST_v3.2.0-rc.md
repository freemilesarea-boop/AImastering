# v3.2.0-rc — 실 음원 6종 수동 회귀 체크리스트

본 문서는 합성 fixture 회귀 (`tests/qa/run_qa.py`) 가 커버하지 못하는
실 음원 시나리오를 사용자가 직접 검증하기 위한 체크리스트다. 정식 v3.2.0
태깅 전 packaged 빌드 (AppImage / mac zip / Windows portable) 에서 1 회 이상
완수 권장.

## 사용 방법

1. v3.2.0-rc 빌드 다운로드 후 실행.
2. 6 장르 × 1 곡 (총 6 곡) 의 wav / flac / mp3 음원을 준비. 길이 30 초 이상,
   상업적으로 마스터링되지 않은 mix down 권장.
3. 각 곡을 표에 명시된 모드로 마스터링 후 결과 패널의 항목을 ✅ / ⚠ / ❌ 로
   기록.
4. ⚠ 또는 ❌ 항목 발견 시 본 문서에 메모 추가하고 GitHub Issue 등록.

## 환경 정보

| 항목                | 값                                              |
|---------------------|-------------------------------------------------|
| 빌드 버전           | v3.2.0-rc                                       |
| 다운로드 파일       | (예: `Louver-Mastering-AI-3.2.0-rc-mac-arm64.zip`) |
| OS / 버전           |                                                 |
| 테스터              |                                                 |
| 일시                |                                                 |

## 6 종 음원 + 모드 매핑

| #   | 장르                | 권장 모드          | target LUFS | target TP |
|-----|---------------------|--------------------|------------:|----------:|
| 1   | KPOP 댄스           | `kpop_loud`         | -9.0        | -0.8      |
| 2   | KPOP 발라드         | `balanced`          | -12.0       | -1.0      |
| 3   | EDM                 | `loud`              | -10.0       | -1.0      |
| 4   | 힙합                | `punch`             | -11.0       | -1.0      |
| 5   | 저역 많은 곡        | `bright`            | -12.0       | -1.0      |
| 6   | 어쿠스틱 (음압 낮음)| `natural` 또는 `warm` | -14.0       | -1.0      |

## 곡별 결과 기록

각 곡마다 동일한 8 개 항목을 기록한다. 셀에 측정값을 적고, 해당 칸 끝에
판정 (✅ tolerance 안 / ⚠ 경계 / ❌ tolerance 밖) 을 표기.

판정 기준:
- LUFS: 목표 ±1.0 → ✅, ±1.0~2.0 → ⚠, > ±2.0 → ❌
- TP: ≤ ceiling → ✅, > ceiling → ❌
- waveform / metric / qc / dyn EQ / preview: 표시되면 ✅, 누락 ❌
- 청감 출렁임: 거의 없음 ✅, 약간 ⚠, 명확함 ❌

### 1. KPOP 댄스 — `kpop_loud` (target -9.0 LUFS / -0.8 dBTP)

| # | 항목                                                | 값 / 판정 |
|---|-----------------------------------------------------|-----------|
| 1 | 결과 LUFS (목표 -9.0 ±1)                            |           |
| 2 | TP ≤ -0.8 dBTP                                       |           |
| 3 | before / after / compare waveform PNG 모두 표시      |           |
| 4 | metricComparison 7~8 행 모두 표시                    |           |
| 5 | qualityCheck overall = ok / warn (danger 아님)       |           |
| 6 | dynamicEq engine = `adynamicequalizer` + 4~5 밴드     |           |
| 7 | preview MP3 재생 (192 kbps)                          |           |
| 8 | 청감 — 음압 출렁임 / 펌핑 없음                       |           |

곡명 / 출처:
메모:

### 2. KPOP 발라드 — `balanced` (target -12.0 LUFS / -1.0 dBTP)

| # | 항목                                                | 값 / 판정 |
|---|-----------------------------------------------------|-----------|
| 1 | 결과 LUFS (목표 -12.0 ±1)                           |           |
| 2 | TP ≤ -1.0 dBTP                                       |           |
| 3 | before / after / compare waveform PNG 모두 표시      |           |
| 4 | metricComparison 7~8 행 모두 표시                    |           |
| 5 | qualityCheck overall = ok / warn                     |           |
| 6 | dynamicEq engine + 밴드 표시                         |           |
| 7 | preview MP3 재생                                     |           |
| 8 | 청감 — 보컬 sustain 자연, 압축감 없음                |           |

곡명 / 출처:
메모:

### 3. EDM — `loud` (target -10.0 LUFS / -1.0 dBTP)

| # | 항목                                                | 값 / 판정 |
|---|-----------------------------------------------------|-----------|
| 1 | 결과 LUFS (목표 -10.0 ±1)                           |           |
| 2 | TP ≤ -1.0 dBTP                                       |           |
| 3 | before / after / compare waveform PNG 모두 표시      |           |
| 4 | metricComparison 7~8 행 모두 표시                    |           |
| 5 | qualityCheck overall = ok / warn                     |           |
| 6 | dynamicEq engine + 밴드 표시                         |           |
| 7 | preview MP3 재생                                     |           |
| 8 | 청감 — drop / kick 펀치 유지, 출렁임 없음           |           |

곡명 / 출처:
메모:

### 4. 힙합 — `punch` (target -11.0 LUFS / -1.0 dBTP)

| # | 항목                                                | 값 / 판정 |
|---|-----------------------------------------------------|-----------|
| 1 | 결과 LUFS (목표 -11.0 ±1)                           |           |
| 2 | TP ≤ -1.0 dBTP                                       |           |
| 3 | before / after / compare waveform PNG 모두 표시      |           |
| 4 | metricComparison 7~8 행 모두 표시                    |           |
| 5 | qualityCheck overall = ok / warn                     |           |
| 6 | dynamicEq engine + 밴드 표시                         |           |
| 7 | preview MP3 재생                                     |           |
| 8 | 청감 — kick / 808 펀치, sibilance / harshness 없음  |           |

곡명 / 출처:
메모:

### 5. 저역 많은 곡 — `bright` (target -12.0 LUFS / -1.0 dBTP)

> "bright" 는 고역 부스트 + 저역 정리 — 베이스 과다 곡에서 muddy_lowmid /
> boomy_low 의 동적 컷 효과 검증.

| # | 항목                                                | 값 / 판정 |
|---|-----------------------------------------------------|-----------|
| 1 | 결과 LUFS (목표 -12.0 ±1)                           |           |
| 2 | TP ≤ -1.0 dBTP                                       |           |
| 3 | before / after / compare waveform PNG 모두 표시      |           |
| 4 | metricComparison 7~8 행 모두 표시                    |           |
| 5 | qualityCheck overall = ok / warn                     |           |
| 6 | dynamicEq engine + boomy_low / muddy_lowmid 밴드 포함 |           |
| 7 | preview MP3 재생                                     |           |
| 8 | 청감 — 저역 부풀음 정리, 자연스러움                 |           |

곡명 / 출처:
메모:

### 6. 어쿠스틱 (음압 낮음) — `natural` 또는 `warm` (target -14.0 LUFS / -1.0 dBTP)

| # | 항목                                                | 값 / 판정 |
|---|-----------------------------------------------------|-----------|
| 1 | 결과 LUFS (목표 -14.0 ±1)                           |           |
| 2 | TP ≤ -1.0 dBTP                                       |           |
| 3 | before / after / compare waveform PNG 모두 표시      |           |
| 4 | metricComparison 7~8 행 모두 표시                    |           |
| 5 | qualityCheck overall = ok                            |           |
| 6 | dynamicEq engine + 밴드 표시                         |           |
| 7 | preview MP3 재생                                     |           |
| 8 | 청감 — 다이내믹 보존, 압축 인상 없음                |           |

곡명 / 출처:
메모:

## 종합 판정

| 영역                              | 결과    |
|-----------------------------------|---------|
| 6 곡 × 8 항목 = 48 항목 전체 ✅ 비율 |   /48   |
| ❌ 발생 곡 / 항목                  |         |
| 정식 v3.2.0 태깅 권장 여부         | ☐ Yes / ☐ No |

## 자주 보는 이슈 (참고)

- **결과 LUFS 가 목표보다 1 LU 이상 under** — sibilance 가 강한 마스터에서
  발생 가능 (Known issue K-1). 후속 dynamic EQ 강도 미세 조정 예정.
- **dynamicEq engine = `none` 또는 `fallback`** — packaged ffmpeg 가 정상
  복사되지 않은 경우. 재설치 또는 `apps/desktop/public/bin/` 확인.
- **preview 재생 무음** — libmp3lame 인코더 누락 의심. 사용 ffmpeg 빌드의
  `-encoders` 출력에 `libmp3lame` 가 있는지 확인.
- **waveform 미표시** — `aimaster-local://` 보호 프로토콜의 file path 변환
  실패 가능. `View → Toggle DevTools` 콘솔에서 404 / preload 메시지 확인.
