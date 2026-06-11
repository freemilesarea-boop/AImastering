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

### P4-2c. 베드별 풀 체인 (per-bed EQ/컴프/새추레이션)

**커밋**: `feat(surround): per-bed full chain for multichannel (Phase 4)`

멀티채널 모드에 **베드별 풀 체인**(옵션) 추가 — 검증된 Rust 스테레오 체인을 처리 단위별로 재사용(DSP 중복 없음).

- **`surroundProcessingUnits(layout)`**(순수): 레이아웃→처리 단위(L/R 서라운드 페어=stereo, 센터=mono, LFE=passthrough). 5.1/7.1/stereo 그룹핑 테스트.
- **렌더 연결**: `surround.perChannelChain` 시 각 단위를 `renderStereoBuffer`(리미터 바이패스·출력게인 0 = tone-only config)로 통과 → EQ/컴프/새추레이션/이미저 적용. 이후 전역 링크드 라우드니스매칭+TP 리미터가 피크/라우드니스를 채널 횡단 처리. LFE는 미가공(대역 제한).
- **`SurroundOptions.perChannelChain`**(기본 false) + `SurroundPanel` 토글.
- **검증**: surroundProcessingUnits(3). **vitest 287/287**, typecheck 0.

### P4-2d. 베드별 개별 톤/레벨 설정

**커밋**: `feat(surround): per-bed distinct tone/level offsets (Phase 4)`

베드(프론트/센터/서라운드/LFE)마다 **다른 톤/레벨**을 줄 수 있도록 — 공유 체인 위에 베드별 오프셋을 접어 넣음.

- **`surround-beds.ts`**(메인, 순수, 타입 전용 의존): `bedForRole`(역할→베드), `bedAdjustedConfig`(게인→inputGain, 저역셸프→eqLowShelfDb, 고역셸프→eqAirDb, 셸프 있으면 EQ 언바이패스), sanitize/neutral.
- **렌더 연결**: per-bed 루프가 유닛의 베드를 판정해 `bedAdjustedConfig`로 베드별 config 생성 후 `renderStereoBuffer`. LFE는 게인만(톤/다이내믹스 없음).
- **`SurroundOptions.beds`**(기본 neutral) + 스토어 `updateSurroundBed`/`updateSurroundLfeGain` + `SurroundPanel` 베드별 에디터(프론트/센터/서라운드: 게인·저역·고역, LFE: 게인).
- **검증**: surround-beds(7 — 역할 매핑·sanitize·neutral·config 합성). **vitest 294/294**, typecheck 0.

### P4-2e. 멀티채널 WAV 채널 마스크 — 헤드리스 검증

**커밋**: `feat(surround): correct WAV channel mask + headless encode selftest (Phase 4)`

"WAV 인코딩·채널 마스크"를 device-QA에서 **CI 검증**으로 이동.

- **`ffmpegLayoutName`**(순수): 레이아웃→ffmpeg 표준 레이아웃명(`5.1`/`7.1`). ffmpeg `-layouts`와 정확히 일치(5.1=FL+FR+FC+LFE+BL+BR, 7.1=…+SL+SR) → 우리 `LAYOUT_CHANNELS`와 동일 검증.
- **`encodeWavN`**: 출력측 `-ch_layout`(ffmpeg 7) 지정 → WAV가 **WAVE_FORMAT_EXTENSIBLE + 올바른 dwChannelMask** 기록.
- **`test:surround-encode`** 셀프테스트(번들 ffmpeg 실행): 5.1/7.1 인코딩 → WAV fmt 청크 파싱 → formatTag=0xFFFE·channels·mask(5.1→0x3f, 7.1→0x63f) 단언. **실제 ffmpeg로 종단 검증 통과**.
- **검증**: surround(ffmpegLayoutName 1) + 셀프테스트(실 ffmpeg 마스크). **vitest 295/295**, typecheck 0.

### 정직성/한계
- 멀티채널 모드: **(옵션)베드별 풀 체인 + 베드별 톤/레벨 → 라우드니스 자동매칭(BS.1770) → 게인 트림 → 링크드 TP 리미터**. EQ/컴프는 검증된 Rust 엔진을 베드별 재사용(중복 없음).
- 베드별 톤은 게인 + 저/고역 셸프(공유 체인 위 오프셋). 베드별 완전 독립 체인은 향후. LFE는 게인만.
- **WAV 채널 마스크/채널수는 이제 번들 ffmpeg로 헤드리스 검증됨**(`test:surround-encode`).

### P4-2f. 비표준 소스 레이아웃 안전 처리

**커밋**: `feat(surround): map source layout from ffprobe, reject unmappable variants (Phase 4)`

채널 수만으로 추측하지 않고 **실제 레이아웃을 ffprobe로 읽어** 매핑 — 잘못 매핑될 변형은 스테레오 폴백.

- **`surroundLayoutFromFfmpeg(layoutStr, channels)`**(순수): `5.1`/`5.1(side)`→`5.1`(서라운드는 백/사이드 동일 슬롯·동일 취급이라 안전), `7.1`→`7.1`. **`7.1(wide)`(슬롯 6/7=FLC/FRC 프론트)·`6.1`·`quad`·`hexagonal` 등 역할 불일치 변형 → null → 스테레오 폴백**. 무태그('unknown') → 카운트 기반 best-effort.
- **`probeAudioStream`**: ffprobe로 채널수 **+ channel_layout** 동시 조회. `decodeSurroundChannels`가 카운트 대신 실제 레이아웃으로 판정.
- **검증**: surroundLayoutFromFfmpeg(4 — 5.1 변형·역할 불일치 거부·스테레오/모노·무태그 best-effort). **vitest 299/299**, typecheck 0, 인코드 셀프테스트 그린.

### 정직성/한계
- 멀티채널 모드: **(옵션)베드별 풀 체인 + 베드별 톤/레벨 → 라우드니스 자동매칭(BS.1770) → 게인 트림 → 링크드 TP 리미터**. EQ/컴프는 검증된 Rust 엔진을 베드별 재사용(중복 없음).
- 베드별 톤은 게인 + 저/고역 셸프(공유 체인 위 오프셋). 베드별 완전 독립 체인은 향후. LFE는 게인만.
- WAV 채널 마스크·채널수·소스 레이아웃 매핑은 헤드리스 검증됨. 남은 device-QA: 실제 플레이어/DAW 재생·청취 품질(마스크는 맞지만 실제 사운드 체감).
- 멀티채널 WAV 인코딩(ffmpeg `-ac N`)·채널 마스크·플레이어 호환은 실제 서라운드 파일/장치로만 종단 검증 → 출시 전 QA. K-weighting 계수는 비-48k에서도 산출식 적용(정확). 단위테스트는 라우드니스/리미터/피크/폴드다운 DSP 수학만 보장.

## ✅ P4-3. ADM BWF 오서링 (객체 Atmos — 베드 기반)

**커밋**: `feat(surround): ADM BWF (chna + axml) bed authoring (Phase 4)`

객체 기반 Atmos 오서링의 표준 산출물인 **ADM BWF**(베드 기반) 생성. 멀티채널 WAV에 `chna`+`axml`(ADM XML) 청크를 붙여 Atmos/ADM 도구가 인제스트 가능하게.

- **`adm.ts`**(메인, 순수): `buildAdmXml(layout)`(DirectSpeakers 베드 — 채널별 표준 방위/고도 position, LFE는 lowPass frequency, audioProgramme→Content→Object→PackFormat→ChannelFormat/Stream/Track/UID 계층), `buildChnaPayload`(BWF chna: 트랙→UID/track/pack, 40바이트 레코드), `wrapAdmBwf`(WAV에 chna+axml append + RIFF 크기 보정).
- **렌더 연결**: 멀티채널 + `surround.admBwf` 시 인코드 후 WAV를 ADM BWF로 래핑(best-effort, 실패 시 평범한 WAV 유지). `SurroundOptions.admBwf` + `SurroundPanel` 체크박스.
- **검증**: adm(6 — XML well-formed·채널수·LFE lowPass·chna 크기/인덱스·wrap RIFF 보정·non-RIFF 거부). **vitest 305/305**, typecheck 0.

### 정직성/한계
- **베드 기반** ADM(채널을 DirectSpeakers 베드로 기술). **동적 객체(위치 자동화)·바이노럴 렌더·Dolby 인코딩은 범위 밖** — 자체 정의(common definitions 미참조)라 ADM 도구 인제스트는 되지만, 실제 Atmos 렌더러 호환은 도구 검증 필요(출시 전 QA). XML 스키마 완전 검증(XSD)은 미수행.

## ✅ P4-4. Dolby 코덱 출력 (AC-3 / E-AC-3 / TrueHD)

**커밋**: `feat(surround): Dolby AC-3/E-AC-3/TrueHD export + headless selftest (Phase 4)`

번들 ffmpeg에 `ac3`·`eac3`·`truehd` 인코더가 있어 멀티채널 출력을 **실제 Dolby 코덱**으로 내보냄. (Dolby ATMOS=E-AC-3+JOC 객체 메타데이터는 Dolby 독점 인코더 필요 → 범위 밖; ADM BWF가 오픈 오서링 경로.)

- **`dolby.ts`**(메인, 순수): `dolbyEncodeArgs`(ac3 640k·eac3 448k·truehd lossless[experimental]) `dolbyExt`·`dolbyLabel`·`isDolbyEnabled`.
- **렌더 연결**: 멀티채널 + `surround.dolbyCodec`!=none 시 WAV → Dolby 사이드카(`.ac3`/`.eac3`/`.thd`) 인코드(best-effort), `dolbyPath` 반환. `SurroundPanel` 코덱 셀렉터.
- **검증**: dolby 순수(4) + `test:dolby-encode` 셀프테스트(**번들 ffmpeg로 5.1→AC-3/E-AC-3/TrueHD 인코드 후 ffprobe로 codec·채널 검증, 3종 모두 통과**). **vitest 309/309**, typecheck 0.

### 정직성/한계
- 표준 Dolby 코덱(AC-3/E-AC-3/TrueHD)만. **Dolby Atmos(JOC) 인코딩은 Dolby 독점 인코더 필요 → 범위 밖**. TrueHD는 ffmpeg 실험 인코더(`-strict experimental`).
- AC-3는 5.1 max(7.1 소스는 다운믹스). 사이드카 파일을 사용자 저장 폴더로 노출하는 save-flow 연결은 후속(현재 temp 옆에 생성·`dolbyPath` 반환).

## 🟡 Phase 4 남은 후보(대규모·범위 밖)

| 항목 | 비고 |
|------|------|
| ADM 동적 객체(위치 자동화)·바이노럴 HRTF 렌더 | 전용 렌더러/HRTF 데이터셋 필요 |
| Dolby Atmos(JOC) 인코딩 | Dolby 독점 인코더 |
| ~~Dolby 코덱(AC-3/E-AC-3/TrueHD)~~ | ✅ P4-4 |
| ~~ADM BWF 베드 오서링~~ | ✅ P4-3 |
| ~~멀티채널 풀 체인(per-bed EQ/컴프)~~ | ✅ P4-2c/d |
| DAW 플러그인(VST3/AU, JUCE/nih-plug) | C++/플러그인 SDK·DAW 검증 필요 |
| Cloud / Mobile | 별도 플랫폼 |
