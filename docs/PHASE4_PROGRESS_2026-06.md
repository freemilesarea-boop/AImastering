# Phase 4 진행 보고 — 야심 (서라운드/Atmos)

**작성일**: 2026-06-10
**브랜치**: `claude/dazzling-darwin-eav8na`
**스코프 결정**: 로드맵 Phase 4(DAW 플러그인 / 서라운드·Atmos / Cloud·Mobile) 중 **서라운드/Atmos** 선택.

## 정직한 스코프

- **가능(이번 작업)**: **채널 기반 서라운드(5.1/7.1) 폴드다운 마스터링** — 서라운드 소스를 표준 ITU-R BS.775 행렬로 스테레오 폴드다운한 뒤, 기존 스테레오 마스터링 체인으로 마스터. + BS.1770 채널 가중 라우드니스. 폴드다운/라우드니스 수학은 **순수·헤드리스 검증 가능**.
- **불가(범위 밖)**: 객체 기반 Atmos 오서링(ADM BWF, Dolby 인코더, 바이노럴 렌더), 멀티채널 출력 렌더. 단일 스테레오 체인 전제라 멀티채널 출력은 별도 대규모 작업.

## ✅ P4-1. 서라운드 폴드다운 마스터링

**커밋**: `feat(surround): channel-based 5.1/7.1 fold-down mastering (Phase 4)`

- **`surround.ts`**(메인, 순수): `LAYOUT_CHANNELS`(stereo/5.1/7.1 + FFmpeg 채널 순서·역할), `layoutForChannelCount`, `deinterleaveN`, `foldDownToStereo`(BS.775 계수 + 트림 — FL/FR 직통, FC −3dB 양쪽, 서라운드 −3dB 동측, LFE 기본 제외), `bs1770Weight`(프론트 0dB·서라운드 +1.5dB·LFE 제외) + `channelWeightedLoudnessDb`, sanitize.
- **렌더 연결**: `process-audio-file-rust`가 `surround.foldDownEnabled` 시 ffprobe로 채널 수 탐지 → 알려진 서라운드면 N채널 디코드 + 폴드다운, 아니면(스테레오/미지원) 기존 스테레오 디코드로 graceful fallback. `MasteringOptions.surround`(shared-types) · `audioHandlers` enabled 시만 전달.
- **렌더러**(`surround-config.ts` + audioStore 슬라이스 + `SurroundPanel`): 폴드다운 토글 + 센터/서라운드/LFE 트림. LFE 바닥값=제외 표시. 익스포트 전용(스테레오 소스 무영향).
- **검증**: surround(11 — 폴드다운 계수·LFE 제외·트림·7.1·BS.1770 가중·sanitize)+패널(5). **vitest 269/269**, typecheck 0(renderer+main+shared-types). 무회귀(기본 OFF).

### 정직성/한계
- **채널 기반** 서라운드 폴드다운이지 객체 기반 Atmos가 아님(문서·UI 명시).
- ffprobe 채널 탐지 + 멀티채널 디코드 wiring은 실제 멀티채널 파일/장치로만 종단 검증 가능 → 출시 전 QA. 단위테스트는 폴드다운·라우드니스 DSP 수학만 보장.
- 출력은 스테레오(폴드다운). 멀티채널 출력 렌더는 향후 작업.

## ✅ P4-2. 서라운드 멀티채널 출력 마스터 (채널 보존)

**커밋**: `feat(surround): multichannel output master — linked true-peak limiter (Phase 4)`

폴드다운(P4-1)의 짝 — 레이아웃을 접지 않고 보존한 채 마스터 게인 + **채널 링크드 트루피크 리미터**(공유 게인리덕션 → 채널 간 밸런스/이미징 보존)를 적용. 서라운드 딜리버리의 핵심 안전장치.

- **`surround-render.ts`**(메인, 순수): `multichannelPeakDb`, `applyLinkedGain`, `linkedLimiter`(채널 최대값 기반 룩어헤드 min-hold + 릴리즈, 전 채널 동일 게인 → 출력 ≤ 실링·이미징 보존), `masterSurroundOutput`(게인→리미터, 메트릭), `interleaveN`.
- **렌더 연결**: `surround.mode === 'multichannel'` 시 N채널 디코드 → `masterSurroundOutput` → **멀티채널 WAV 출력**. 동시에 마스터된 채널의 **스테레오 폴드다운**을 별도 작성(`analysisPath`) → 기존 스테레오 analyze/QC/preview 경로 그대로(멀티채널 분석 위험 회피). `audioHandlers`는 `analysisPath ?? outputPath`로 분석.
- **`SurroundOptions`**: `mode('foldDown'|'multichannel')` + `masterGainDb` + `ceilingDb`. `SurroundPanel`에 모드 토글 + (멀티채널) 마스터 게인/트루피크 실링.
- **검증**: surround-render(8 — 실링 초과 없음·채널 비율 보존·무리덕션·마스터 메트릭)+패널(6, 모드 토글). **vitest 278/278**, typecheck 0(renderer+main+shared-types). 무회귀(mode 기본 foldDown).

### P4-2b. 멀티채널 라우드니스 자동매칭 (BS.1770)

**커밋**: `feat(surround): BS.1770 multichannel loudness auto-match (Phase 4)`

멀티채널 출력이 **자체 라우드니스 정규화**를 갖도록 보강 — 더 이상 폴드다운 경로에만 의존하지 않음.

- **`surround-loudness.ts`**(메인, 순수): BS.1770-4 통합 라우드니스 — K-weighting(2단 biquad, **샘플레이트별 계수 산출**) → 채널 가중(프론트 0dB·서라운드 +1.5dB·LFE 제외) 400ms 블록 → 절대(−70 LUFS)+상대(−10 LU) 게이팅. `loudnessNormGainDb`(목표−측정, clamp).
- **렌더 연결**: 멀티채널 모드에서 `options.targetLufs`로 프로그램을 목표 LUFS 자동매칭 → 마스터 게인 트림 가산 → 링크드 리미터. `loudnessNormalized=true` 반영.
- **검증**: surround-loudness(6 — 무음 게이팅·**+6dB→+6LU**·서라운드 가중·LFE 제외·norm 게인 clamp). **vitest 284/284**, typecheck 0.

### 정직성/한계
- 멀티채널 모드는 **라우드니스 자동매칭(BS.1770) + 게인 트림 + 링크드 리미터**. 풀 체인 EQ/컴프는 여전히 채널별 미적용(서라운드 딜리버리는 라우드니스+TP 스펙 중심이라 우선순위 낮음).
- 멀티채널 WAV 인코딩(ffmpeg `-ac N`)·채널 마스크·플레이어 호환은 실제 서라운드 파일/장치로만 종단 검증 → 출시 전 QA. K-weighting 계수는 비-48k에서도 산출식 적용(정확). 단위테스트는 라우드니스/리미터/피크/폴드다운 DSP 수학만 보장.

## 🟡 Phase 4 남은 후보(대규모·범위 밖)

| 항목 | 비고 |
|------|------|
| 객체 기반 Atmos 오서링(ADM BWF/Dolby/바이노럴) | 전용 인코더·메타데이터 체인 필요 |
| 멀티채널 풀 체인(per-channel EQ/컴프) | Rust 체인 멀티채널화 대규모 |
| DAW 플러그인(VST3/AU, JUCE/nih-plug) | C++/플러그인 SDK·DAW 검증 필요 |
| Cloud / Mobile | 별도 플랫폼 |
