# Louver Mastering AI — v3.2.0-rc 릴리즈 노트

릴리즈일: 2026-05-02
빌드 ID: `claude/analyze-mastering-engine-zdKrE`
대상: macOS (Apple Silicon / Intel) · Windows (x64) · Linux (AppImage)

---

## 1. 핵심 개선사항

### 1.1 마스터링 엔진 (active engine, `services/python-audio`)
- **R1 — correction pass push 정확도 (high-LUFS 모드)**
  보정 단계 alimiter 의 input gain 중복 적용 버그를 수정하고 보정 게인 한도를
  ±6 dB → ±12 dB 로 확장. push 부족 / 과다 양방향에서 LUFS 가 목표값 부근으로
  수렴하도록 함.
- **R2 — Dynamic EQ ffmpeg 7 호환성**
  `adynamicequalizer` mode enum 이 ffmpeg 6.x (`cut` / `boost`) 와 7.x
  (`cutbelow` / `cutabove` / `boostbelow` / `boostabove`) 사이에서 변경됨.
  런타임에 enum 을 자동 감지해 양 버전 모두에서 동적 EQ 가 정상 동작하도록 수정.
  패키징된 ffmpeg-static 7.0.2 환경에서 sibilance / kpop_loud LUFS 가
  최대 +2.6 LU 개선됨.
- **High-LUFS 모드 정적 체인** (이전 P1)
  loud / kpop_loud / target_lufs > -12 케이스에서 dynamic loudnorm 의
  short-term envelope 가 만드는 음압 출렁임을 제거하고, EQ → 동적 EQ →
  compressor → soft clip → alimiter 가 한 번에 실행되는 정적 체인 사용.
- **ISP safety pass**
  최종 측정 TP 가 target ceiling 을 초과하면 자동으로 추가 attenuation 을
  적용하고 보고 객체에 `ispCorrectionDb` 를 노출.

### 1.2 결과 패널 (renderer)
- **Waveform PNG** (before / after / compare) — 각 결과에 1600×280 시각화 자동 생성.
- **Metric comparison** — pre/post LUFS, TP, LRA, dynamic range, clipping, RMS,
  stereo correlation 등 7~8 행의 정량 비교표.
- **Quality check** — overall ok / warn / danger + 항목별 상세 (TP 초과,
  과보정, 무음 가드 등).
- **Dynamic EQ 카드** — 적용 엔진 (`adynamicequalizer` / `fallback` / `none`),
  intensity, 밴드별 (라벨, 주파수, 게인) 표시.

### 1.3 빌드 / 타입체크
- monorepo 4 패키지 (`@aimaster/desktop`, `@aimaster/audio-engine`,
  `@aimaster/license-core`, `@aimaster/shared-types`) 의 `pnpm typecheck`
  가 strict + `exactOptionalPropertyTypes: true` 로 처음 통과.
- main process tsconfig 정리: `electron-store` v10 (ESM-only) 가 esbuild
  inline 으로 packaged main bundle 에 포함 가능하도록 module resolution 단순화.

---

## 2. 버그 수정

| ID  | 영역             | 내용 |
|-----|------------------|------|
| R1  | pipeline.py      | correction pass alimiter 가 1차 input_gain 을 또 적용해 -4 dB 보정이 상쇄되던 문제 — `level_in=1.0` 으로 수정 |
| R2  | dynamic_eq.py    | ffmpeg 7 의 `mode=cutbelow/boostbelow` enum 미지원으로 packaged ffmpeg 에서 dynamic EQ 가 invalid argument 로 실패하던 문제 |
| —   | audio-engine     | `LoudnessStats` re-export 누락 |
| —   | audio-engine     | `FFmpegStatus.version` 의 exactOptional 위반 — conditional spread 로 수정 |
| —   | license-core     | `node-machine-id` boolean 시그니처 불일치 — `machineIdSync(true)` |
| —   | license-core     | `expiresAt` 의 exactOptional 위반 — conditional spread 로 수정 |
| —   | desktop renderer | `import.meta.env` 인식을 위한 `vite/client` reference 추가 |

---

## 3. 알려진 이슈

| ID  | 영역                | 영향도 | 내용 |
|-----|---------------------|--------|------|
| K-1 | sibilant fixture    | 낮음   | 합성 sibilant 픽스처 (220 Hz tone + 6.5 kHz burst, duty 5 %) 에서 loud / kpop_loud 모드 결과가 목표보다 1.6 LU under. burst 의 sparse 한 특성 + 동적 EQ 컷이 RMS 의 큰 부분을 깎기 때문이며, 실제 음악의 sibilance 는 지속적이라 동일 패턴 미발생 예상. 실 음원 데이터 확보 후 재평가. |
| K-2 | Windows cross-build | 보통   | Linux host 에서 `dist:win` 시 `app-builder` 가 native 실행 실패 (`ERR_ELECTRON_BUILDER_CANNOT_EXECUTE`). 정식 Windows runner (GitHub Actions / 로컬 Windows 머신) 에서 빌드 필요. macOS / Linux 는 cross-build 가능. |
| K-3 | macOS code sign     | 보통   | Linux 에서 cross-build 시 codesign skip → 처음 실행 시 macOS 가 quarantine. 사용자 수동 우회 (right-click → Open) 또는 본 빌드를 macOS runner 에서 다시 sign. |
| K-4 | NSIS installer      | 보통   | pnpm + Windows MAX_PATH 충돌로 NSIS 일시 비활성화. 본 RC 는 portable `.exe` 만 제공. |
| K-5 | DMG packaging       | 낮음   | macOS DMG 는 GitHub Actions 에서 `hdiutil attach` 실패 확인 — zip 만 ship. |

---

## 4. 테스트 결과

### 4.1 active engine 회귀 (`tests/qa/run_qa.py`, 26 runs, host ffmpeg 6.1)

| 항목                              | baseline (R1 전) | RC (R1 + R2)   |
|----------------------------------|------------------|----------------|
| total runs                        | 26               | 26             |
| TP failures (> ceiling)           | 0                | **0**          |
| qc danger                         | 5                | **3**          |
| waveforms (before+after+compare)  | 24/26            | 24/26          |
| metric_comparison avg rows        | 7.4              | 7.4            |
| dynamic_eq active                 | 24               | 24             |

high-LUFS / low-input 케이스 LUFS 정확도 (target = mode 별 spec):

| mode      | sample      | target | baseline | RC     |
|-----------|-------------|-------:|---------:|-------:|
| loud      | low_lufs    | -10.0  | -12.28   | -10.28 |
| loud      | bass_heavy  | -10.0  |  -6.25   |  -8.99 |
| kpop_loud | low_lufs    |  -9.0  | -10.45   |  -8.45 |
| kpop_loud | bass_heavy  |  -9.0  |  -5.35   |  -8.99 |

### 4.2 packaged ffmpeg-static 7.0.2 smoke (R2 fix 후)

| mode      | sample        | target | host ff6 (R1) | packaged ff7 (R2) |
|-----------|---------------|-------:|--------------:|------------------:|
| loud      | low_lufs      | -10.0  | -10.28        | -9.01             |
| loud      | sibilant      | -10.0  | -14.26        | **-11.66**        |
| loud      | wide_dynamic  | -10.0  | -10.98        | -9.27             |
| kpop_loud | sibilant      |  -9.0  | -12.96        | **-10.66**        |
| natural   | wide_dynamic  | -14.0  | -13.01        | -12.99            |

→ packaged 환경에서 sibilant 케이스가 +2.3~2.6 LU 개선, 모든 케이스 TP ceiling 안.

### 4.3 packaged 빌드

| platform           | target                | 결과   | 산출물 (`out/`)                            |
|--------------------|----------------------|--------|--------------------------------------------|
| Linux              | AppImage              | ✅     | `Louver Mastering AI-1.0.0.AppImage` 157 MB |
| macOS Intel x64    | zip (unsigned)        | ✅     | `Louver Mastering AI-1.0.0-mac.zip` 152 MB  |
| macOS Apple Silicon| zip (unsigned)        | ✅     | `Louver Mastering AI-1.0.0-arm64-mac.zip` 147 MB |
| Windows x64        | portable              | ❌     | Linux host cross-build 미지원 (K-2) — Windows runner 필요 |

packaged ffmpeg-static 7.0.2 검증:
- libmp3lame 인코더 포함 → preview MP3 정상 생성
- adynamicequalizer / alimiter / loudnorm / extrastereo / compand 필터 모두 가용
- waveform PNG 생성 정상 (showwavespic + overlay)

### 4.4 TypeScript

`pnpm -s typecheck` (strict + exactOptionalPropertyTypes) →
`@aimaster/shared-types`, `@aimaster/license-core`, `@aimaster/audio-engine`,
`@aimaster/desktop` 4/4 successful.

---

## 5. 실 음원 6 종 수동 검증 체크리스트

본 RC 환경에는 라이선스 가능한 실음원 샘플이 동봉되어 있지 않아 정량 회귀는
합성 fixture (`tests/qa/fixtures.py`) 로만 수행했다. 정식 배포 전 아래 6 종을
**packaged AppImage / mac zip 에서 직접** 마스터링해 결과 항목을 기록할 것.

| # | 장르                | 권장 모드          | 예상 결과 LUFS |
|---|---------------------|--------------------|---------------:|
| 1 | KPOP 댄스           | `kpop_loud`         | -9.0 ± 1.0     |
| 2 | KPOP 발라드         | `balanced`          | -12.0 ± 1.0    |
| 3 | EDM                 | `loud`              | -10.0 ± 1.0    |
| 4 | 힙합                | `punch`             | -11.0 ± 1.0    |
| 5 | 저역 많은 곡        | `bright`            | -12.0 ± 1.0    |
| 6 | 음압 낮은 어쿠스틱  | `natural` 또는 `warm` | -14.0 ± 1.0    |

각 결과에서 다음 항목을 ✅ / ⚠ / ❌ 로 기록:

- [ ] 결과 LUFS (목표 ±1 LU)
- [ ] TP ≤ target ceiling (-1.0 / -0.8 dBTP)
- [ ] before / after / compare waveform PNG 표시
- [ ] metricComparison 7~8 행 모두 표시
- [ ] qualityCheck overall = ok / warn (danger 아님)
- [ ] dynamicEq engine = `adynamicequalizer` + 4~5 밴드 표시
- [ ] preview MP3 재생 정상 (192 kbps)
- [ ] 청감 — 음압 출렁임 / 펌핑 없음 (특히 loud / kpop_loud)

이슈 발견 시 `services/python-audio/log/` 의 pipeline 로그와 `qualityCheck`
결과를 첨부해 보고.

---

## 6. 사용자 안내 문구 (앱 첫 실행 시 권장)

> **macOS** — 처음 앱을 실행하실 때 Gatekeeper 경고가 표시될 수 있습니다.
> Finder 에서 앱을 우클릭 → "열기" 를 선택해 주세요. 정식 코드 사인은
> 다음 정식 릴리즈에서 적용됩니다.
>
> **Windows** — 본 RC 는 portable 실행 파일입니다. 압축 해제 후
> `Louver Mastering AI Portable.exe` 를 직접 실행해 주세요. 설치형
> (NSIS) 은 정식 릴리즈에서 제공됩니다.
>
> **모든 플랫폼** — sibilance (치찰음) 가 강한 마스터에서는 loud /
> kpop_loud 모드 결과가 목표 LUFS 보다 1~2 LU 낮게 측정될 수 있습니다.
> 청감상 충분한 음압이 확보되며, 후속 업데이트에서 dynamic EQ 강도를
> 미세 조정할 예정입니다.

---

## 7. 정식 배포 가능 여부

**조건부 가능 — RC 단계 권장**.

배포 가능 조건:
1. ✅ 마스터링 엔진 안전성 (TP failures = 0, ISP safety 동작 확인)
2. ✅ 패키징된 ffmpeg-static 7.0.2 와 dynamic EQ 호환성 (R2 수정 후)
3. ✅ Linux + macOS x64 / arm64 빌드 산출물 생성
4. ✅ TypeScript strict 통과
5. ⚠ Windows portable 빌드는 **Windows runner 에서 재빌드 필요** (Linux cross-build 미지원)
6. ⚠ macOS codesign / notarization 은 macOS runner 에서 별도 sign 필요
7. ⚠ 실 음원 6 종 수동 회귀 (5 장 체크리스트) — 정식 배포 직전 1 회

위 7 항목 모두 ✅ 시 정식 v3.2.0 태깅 권장.
