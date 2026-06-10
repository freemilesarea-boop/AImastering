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

## 🟡 Phase 4 남은 후보(대규모·범위 밖)

| 항목 | 비고 |
|------|------|
| 객체 기반 Atmos 오서링(ADM BWF/Dolby/바이노럴) | 전용 인코더·멀티채널 출력 체인 필요 |
| 멀티채널 출력 렌더(5.1/7.1 그대로) | Rust 체인 멀티채널화 + ffmpeg I/O 대규모 |
| DAW 플러그인(VST3/AU, JUCE/nih-plug) | C++/플러그인 SDK·DAW 검증 필요 |
| Cloud / Mobile | 별도 플랫폼 |
