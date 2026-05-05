# Beyond Ozone 12 — 전략 로드맵

**목표**: iZotope Ozone 12 보다 뛰어난 마스터링 프로그램을 만든다.
**기준 시점**: 2026-05-04, v3.5.0 commit `e180cba`
**문서 종류**: 전략 / 로드맵 — 코드 변경 없음, 분석 + 우선순위만

---

## 0. 솔직한 시작

이 문서는 **Ozone 12 의 모든 기능을 따라잡는 것** 이 목표가 아닙니다.
Ozone 은 20+ 년의 R&D, 수십 명의 DSP/ML 엔지니어, 수억 달러의 투자가
누적된 제품입니다.  feature-by-feature 모방은 비효율적이고, 우리가
질 수밖에 없는 게임입니다.

대신 이 문서는 다음을 제안합니다:

1. **Ozone 의 핵심 기능 중 우리가 *반드시* 갖춰야 할 것** (Tier 1)
2. **현실적으로 따라잡을 수 있는 것** (Tier 2)
3. **Ozone 에 *없는*, 우리만의 차별점** (Tier 3) — 여기서 승부
4. **냉정한 R&D 부족 분야** — 솔직히 인정하고 우회 전략

→ "Ozone 보다 뛰어나다" 는 의미를 **모든 영역의 합** 이 아니라
**대상 사용자가 가장 자주 마주하는 워크플로우에서의 우월성** 으로 재정의.

---

## 1. Ozone 12 핵심 기능 인벤토리

### 1A. Master Assistant (AI 어시스턴트) — **Ozone 핵심**

- 입력 분석 → 장르 자동 분류 → 처리 체인 자동 생성
- 사용자가 "Modern" / "Streaming" / "Loud" 선택 → 알고리즘이 EQ / comp /
  exciter / limiter 파라미터 자동 결정
- Reference track 로드 시 그쪽으로 spectral matching
- **사용자 "처음 사용 → 결과물" 까지 가장 짧은 path**

### 1B. 13 개 모듈 (각각 standalone plugin 가능)

| 모듈 | 역할 |
|------|------|
| Equalizer | 8-band parametric, Surgical / Mixing / Mastering / Vintage 모드, M/S |
| Dynamic EQ | 6-band threshold-driven EQ (우리 모듈과 유사) |
| Multiband Compressor | 4-band 진짜 multiband (acrossover) |
| Maximizer | 최종 limiter (10+ 가지 character) |
| Imager | stereo width + M/S, 4-band 별 width 조정 |
| Exciter | tube/tape/dual triode/warm 4 종 saturation, multiband |
| Spectral Shaper | dynamic spectral suppression (sibilance 등) |
| Stabilizer | 자동 spectral 안정화 (input → balanced reference curve) |
| Match EQ | reference vs source spectral matching (정밀) |
| Low End Focus | 60-200 Hz 영역 정리 (mono/punchy/smooth 모드) |
| Impact | transient designer (multiband attack 조정) |
| Vintage Tape | tape saturation emulation |
| Vintage Limiter / Compressor / EQ | 빈티지 회로 모델링 |
| **Master Rebalance** | **ML source separation** — vocal/bass/drums 개별 음량 조정 |
| **Stem Separation** | **ML** — 마스터에서 stem 분리 (ozone 11+) |

### 1C. Workflow / I/O

- VST3 / AU / AAX / Standalone (어떤 DAW 에든 인스턴스화)
- Real-time preview (DAW 안에서 즉시 청취)
- A/B comparison (8 snapshot)
- Reference track library (다중 reference)
- Codec preview (MP3 320 / AAC 256 / Opus / etc. 인코딩 후 즉시 비교)
- Streaming platform target (Spotify / Apple / YouTube / Tidal — LUFS 자동 매칭)
- Surround / Dolby Atmos (Ozone 11+)
- Track-specific preset save/load
- Project file (.ozn)
- Batch processing

### 1D. Visualizer / Metering

- Spectrum analyzer (real-time, 24/48/96 kHz)
- Vectorscope (M/S 분석)
- Waveform display
- True peak / LUFS 미터 (short-term, integrated, momentary)
- LRA / DR meter
- Frequency-by-frequency 표시

### 1E. AI / ML (Ozone 의 핵심 차별점)

- Master Assistant (장르 분류 + 처리 추천)
- Master Rebalance (source separation, vocal/bass/drums 분리)
- Stem Separation (full stem 분리)
- Vocal Track 자동 처리

### 1F. 가격 / 라이선스

- Ozone 12 Standard: ~$249 USD
- Ozone 12 Advanced: ~$499 USD
- Ozone 12 Elements (entry): ~$129 USD
- iLok / Machine Auth

---

## 2. 정직한 Feature-by-Feature 비교

| Feature | Ozone 12 | Louver v3.5.0 | 우리 위치 |
|---------|:--------:|:-------------:|:---------:|
| Master Assistant (AI 자동 처리) | ✅ ML 기반 | ⚠️ 7 style preset (룰 기반) | **30 %** |
| Genre detection | ✅ ML | ❌ | **0 %** |
| Reference matching | ✅ 정밀 spectral | ✅ 4-band iterative | **65 %** |
| 8+ band parametric EQ | ✅ | ⚠️ 5-band fixed | **40 %** |
| Dynamic EQ (6-band) | ✅ | ✅ 5-band | **80 %** |
| Multiband compressor (4-band) | ✅ acrossover | ❌ broadband only | **15 %** |
| Maximizer (10+ character) | ✅ | ⚠️ 1 character (alimiter) | **20 %** |
| Stereo Imager (4-band M/S) | ✅ | ⚠️ 1-band extrastereo | **25 %** |
| Exciter / Saturation (4 모드) | ✅ multiband | ⚠️ 흡수됨 (compressor knee) | **20 %** |
| Spectral Shaper | ✅ dynamic spectral | ❌ | **0 %** |
| Stabilizer (자동 EQ matching) | ✅ ML | ✅ T1 corrective EQ | **70 %** |
| Match EQ | ✅ 정밀 | ✅ 4-band | **50 %** |
| Low End Focus | ✅ | ⚠️ 90 Hz warmth + 100 Hz trim | **40 %** |
| Impact (transient) | ✅ multiband | ❌ | **0 %** |
| Vintage modules (Tape/Comp/EQ/Limiter) | ✅ | ❌ | **0 %** |
| **Master Rebalance (ML source sep)** | ✅ | ❌ | **0 %** ⚠️ |
| **Stem Separation (ML)** | ✅ | ❌ | **0 %** ⚠️ |
| Surround / Atmos | ✅ | ❌ | **0 %** |
| **DAW plugin (VST3/AU/AAX)** | ✅ | ❌ standalone only | **0 %** ⚠️ |
| Real-time preview | ✅ DAW 통합 | ❌ batch process | **0 %** |
| Codec preview (MP3/AAC) | ✅ | ⚠️ MP3 export 만 | **30 %** |
| Streaming platform target (4 서비스) | ✅ | ⚠️ LUFS 수동 설정 | **50 %** |
| A/B snapshot (8개) | ✅ | ⚠️ before/after 만 | **25 %** |
| Reference library | ✅ | ⚠️ 단일 reference | **30 %** |
| Spectrum analyzer (real-time) | ✅ | ❌ post-process PNG 만 | **20 %** |
| Vectorscope | ✅ | ❌ | **0 %** |
| Loudness meter (real-time) | ✅ | ⚠️ 결과 표시만 | **30 %** |
| Project file save/load | ✅ | ❌ | **0 %** |
| Batch processing | ✅ UI | ⚠️ backend만 (UI 부족) | **40 %** |
| Custom preset save/load | ✅ | ❌ | **0 %** |
| **Vocal Protection auto guard** | ⚠️ 부분 (Master Assistant 안에서) | ✅ always-on engine guard | **120 %** ✓ |
| **Telephone sound auto detection** | ❌ | ✅ | **120 %** ✓ |
| **Suspect segment 시간대별 검출** | ❌ | ✅ | **100 %** ✓ |
| **Tonal budget 추적** | ❌ | ✅ | **100 %** ✓ |
| **자동 모드 추천 (사후)** | ⚠️ 일부 | ✅ 5 가지 코드 | **100 %** ✓ |
| **한국 시장 특화 (KPOP Loud)** | ❌ | ✅ | **100 %** ✓ |
| **Debug bundle export (고객지원)** | ❌ | ✅ | **100 %** ✓ |
| **Open architecture / 한국어** | ❌ closed source | ✅ | **100 %** ✓ |

### 핵심 격차

**우리가 0 % 인 영역 (대형 격차)**:
1. Master Rebalance (ML source separation)
2. Stem Separation
3. DAW plugin (VST3/AU)
4. Vintage modules
5. Multiband compression (진짜)
6. Spectral Shaper
7. Impact / Transient designer
8. Surround / Atmos
9. Real-time preview
10. Spectrum analyzer / Vectorscope (real-time)
11. Project file
12. Custom preset save/load

**우리가 우월한 영역 (차별화 가능)**:
1. Always-on Vocal Protection
2. Telephone sound detection
3. Suspect segment 시간대별 검출
4. KPOP Loud 등 한국 시장 특화
5. Debug bundle
6. 한국어 UI / 한국 사용자 시나리오

---

## 3. Tier 1 — **반드시 추가** (8 개 항목, 9-15 개월)

> 이거 없으면 "마스터링 프로그램" 으로서 함량 미달.  Ozone 의 *기본기*.

### T1-A. 진짜 Multiband Compressor (4-band)

**현재**: broadband acompressor 만.  Dynamic EQ 가 multiband 흉내냄.
**필요**: ffmpeg `acrossover` + per-band acompressor + amix

```
input → acrossover (split=200,2000,5000)
  ├─ low band      → acompressor (slow attack, glue)
  ├─ low-mid band  → acompressor (transparent)
  ├─ vocal band    → acompressor (gentle, vocal-protection)
  └─ high band     → acompressor (fast attack, sibilance control)
  → amix → output
```

**작업량**: 2-3 주 (ffmpeg complex_filter 작성 + 위상 보상 + UI)
**왜 필수**: dynamic EQ 와 multiband comp 는 다른 도구.  multiband comp 가
진짜 마스터링 표준.

### T1-B. Real-time Spectrum Analyzer (Renderer)

**현재**: post-process PNG 만.  사용자가 처리 전 입력 spectrum 확인 불가.
**필요**: Web Audio API + AnalyserNode 로 실시간 FFT → canvas

**구현**:
- preload 가 OS file → ArrayBuffer → AudioBuffer 디코딩
- AudioContext + AnalyserNode (fftSize=4096~8192)
- requestAnimationFrame 으로 60 fps spectrum 그리기
- input + output 동시 비교 모드 (overlay)

**작업량**: 1-2 주
**왜 필수**: Ozone 의 핵심 UX 요소.  사용자가 "처리 전후 어디가 변했는지"
시각적 확인 못 하면 마스터링 도구가 아님.

### T1-C. Real-time Loudness Meter

**현재**: 결과 dict 의 LUFS 값만 표시.  BS.1770 short-term/momentary 미터링 부재.
**필요**: Web Audio API + ITU-R BS.1770-4 K-weighted RMS + Gating

```
input → K-weighting filter (high-shelf + high-pass)
  → RMS (400 ms momentary / 3 s short-term)
  → Integrated (LUFS-I)
  → Loudness Range (LRA, P10-P95)
  → Vertical bar meter (Renderer canvas)
```

**작업량**: 1-2 주 (ITU 알고리즘 구현 + canvas 렌더)
**왜 필수**: real-time 마스터링 모니터링은 industry standard.

### T1-D. Codec Preview (MP3 / AAC / Opus)

**현재**: MP3 320 출력만.  사용자가 lossy 인코딩 후 청감 비교 불가.
**필요**: 결과 WAV → MP3 256 / AAC 128 / Opus 96 등 encode → renderer 에서 즉시 청취

**구현**:
- ffmpeg encode chain (libmp3lame / libfdk_aac / libopus)
- 별도 IPC channel `audio:codec-preview`
- UI 토글 버튼 (Original / MP3 / AAC / Opus)

**작업량**: 1 주
**왜 필수**: 마스터가 streaming 으로 인코딩되면 톤이 변함.  미리듣기 없으면
plays-different-than-expected 사고.

### T1-E. Streaming Platform Target (자동 LUFS 매칭)

**현재**: 사용자가 target_lufs 직접 설정.
**필요**: 프리셋으로 Spotify (-14) / Apple (-16) / YouTube (-14) / Tidal (-14) /
SoundCloud (-8 ~ -10) / Bandcamp (custom) 한 번에 선택.

**구현**:
- mode 위에 별도 dropdown
- 선택 시 target_lufs / target_tp 자동 설정
- UI 옆에 "Spotify 권장" 식 배지

**작업량**: 3-5 일
**왜 필수**: Ozone 의 "Mastering Assistant 첫 화면" 이 이거.

### T1-F. Custom Preset Save / Load

**현재**: built-in 7 mode 만.  사용자가 자신의 설정 저장 불가.
**필요**: User preset 저장소 (electron-store) + UI

**구현**:
- "Save as preset…" 버튼 → 이름 입력 → JSON 저장
- 저장된 preset 들 dropdown 에 표시
- import / export (JSON 파일로 공유 가능)

**작업량**: 1 주
**왜 필수**: 프로 사용자는 자기 워크플로우 저장 필수.

### T1-G. Project File (.lvr — Louver Project)

**현재**: 매번 새로 시작.
**필요**: 입력 + reference + 모든 설정 + 적용된 corrections + 결과 metadata 를
하나의 zip (.lvr) 로 저장 / 복원

**구현**:
- save: 모든 상태 → JSON + 입력 path 참조 → zip
- load: zip 풀어 state 복원

**작업량**: 1-2 주
**왜 필수**: 작업 중간 저장 / 협업 / 복기 / 디버그 모두 필요.

### T1-H. Batch Processing UI

**현재**: backend (multi-file IPC) 는 있으나 UI 진입 부족.
**필요**: drag-drop 다중 파일 → 단일 preset 일괄 적용 → progress + 결과 표

**구현**:
- 별도 BatchPage.tsx
- drag-drop 영역 + 큐 표시
- preset 선택 → 일괄 처리 → 각 결과 quality_check 표시

**작업량**: 1 주
**왜 필수**: 앨범 단위 마스터링 (10+ 곡) 지원 없으면 프로 미사용.

**Tier 1 합계: 9-15 개월 (1 명 풀타임 기준)**

---

## 4. Tier 2 — **강력 추천** (Ozone 따라잡기, 12-18 개월)

### T2-A. Stereo Imager (4-band M/S)

**현재**: 1-band extrastereo (전 대역 동일 width).
**필요**: 4-band 별 width 조정 (low 거의 mono / mid 자연 / high 와이드)

**구현**:
- ffmpeg `pan` filter 로 M/S 분리 → 4-band crossover → per-band width
  → M/S 재합성

**작업량**: 2-3 주

### T2-B. Mid/Side EQ + Compression

**현재**: 모든 처리가 stereo.
**필요**: M/S 모드 토글 → mid 채널과 side 채널 독립 처리

**구현**:
- M/S split → 두 별개 처리 chain → 재합성
- UI 에 M/S 토글

**작업량**: 2-3 주

### T2-C. Vintage Modules (Tape / Comp / EQ)

**현재**: 깔끔한 디지털만.
**필요**: tape saturation emulation (TSP — tape saturation processor),
Vintage SSL/Pultec EQ 흉내, 1176-style limiter character

**구현**:
- ffmpeg waveshaper / compand transfer curve 로 비선형 분리
- 또는 LV2 / VST3 plugin 통합 (ladspa, calf 등)

**작업량**: 4-6 주

### T2-D. Impact (Transient Designer, multiband)

**현재**: 없음.
**필요**: 4-band attack/sustain 별 처리 (drum punch / transient enhance)

**구현**:
- envelope follower + attack/sustain gain 분리
- ffmpeg 의 `agate` 또는 custom DSP

**작업량**: 3-4 주

### T2-E. Vectorscope (M/S 시각화)

**필요**: M/S correlation + L/R lissajous

**구현**: Web Audio + canvas (T1-B 와 함께)

**작업량**: 1 주

### T2-F. A/B Snapshot (8개)

**현재**: before/after 만.
**필요**: 처리 중 임의 시점 8개 저장 → 즉시 toggle 비교

**구현**:
- 각 snapshot 은 (mastered WAV path + settings JSON)
- UI 슬롯 8개 + keyboard shortcut

**작업량**: 1 주

### T2-G. Reference Library (다중 reference)

**현재**: 단일 reference 한 번만.
**필요**: 사용자 즐겨찾기 reference 5-10 곡 저장 + 각 spectral profile 캐시

**구현**:
- electron-store + 별도 folder
- 진입 시 분석 + 캐시 (cold start 빨라짐)

**작업량**: 2 주

### T2-H. Auto Genre Detection (간단 ML)

**현재**: 사용자가 mode 직접 선택.
**필요**: 입력 spectral 특성 → 추천 mode 자동 제시

**옵션 A (간단, 룰 기반)**: low_to_mid / high_to_mid / LRA / crest 조합으로 룰 분류
**옵션 B (ML)**: 장르 분류 모델 (CNN on mel-spectrogram, ~5 MB)

**작업량**: 옵션 A 1 주 / 옵션 B 4-8 주 (데이터셋 + 학습)

**Tier 2 합계: 12-18 개월**

---

## 5. Tier 3 — **차별화** (Ozone 에 없는 기능, 6-12 개월) ← 여기서 승부

### T3-A. Stem-aware Mastering (한국 시장 특화)

**컨셉**: 마스터링 전 사용자가 vocal stem 따로 업로드 → vocal 만 별도 보호 처리.
**왜 차별화**: Ozone Master Rebalance 는 ML source separation (불완전).
우리는 사용자가 진짜 stem 을 주면 정확한 처리 가능.

**구현**:
- 입력 슬롯: master mix + vocal stem (선택)
- vocal stem 의 1.5-5 kHz 영역만 추출 → master 의 같은 영역과 비교
- vocal 손실 감지 시 master 의 vocal band 보강

**작업량**: 4-6 주

### T3-B. AI 생성곡 전용 모드 (Suno / Udio / Stable Audio 대응)

**컨셉**: AI 생성 음악은 특유의 artifact (harsh high-mid, 보컬 metallic 등)
가 있음.  이 artifact 를 자동 감지 + 완화하는 전용 모드.
**왜 차별화**: AI 음악 마스터링 시장 폭발 중 (2025-2026).  Ozone 은 없음.

**구현**:
- AI artifact detection 강화 (현재 6 종 → 12+ 종)
  - boomyLowEnd / harshHighMid (있음)
  - + metallicVocal / brittleAttack / over-compressed-source / phasiness /
    aliasing artifact / ringing
- 각 artifact 별 corrective filter 자동 적용

**작업량**: 6-8 주

### T3-C. Continuous Quality Improvement (사용자 피드백 루프)

**컨셉**: 사용자가 "이번 마스터링 만족 / 불만" 클릭 → 익명 텔레메트리
→ 우리가 모델 / 룰 개선 → 다음 release 에 반영
**왜 차별화**: Ozone 은 closed-source, feedback loop 없음.  우리는 open
+ 빠른 iteration.

**구현**:
- 결과 페이지에 "👍 만족 / 👎 불만 (어떤 부분?)" 위젯
- 익명 텔레메트리 (opt-in) → 서버 저장
- 월 단위 분석 → preset 미세조정 → release

**작업량**: 4 주 (서버 + UI + privacy 정책)

### T3-D. Korean Pop / J-Pop / K-Hiphop 전용 reference library

**컨셉**: 우리가 직접 큐레이팅한 한국 음악 reference 50+ 곡 (저작권 OK 한
fingerprint 만, 오디오 X).
**왜 차별화**: Ozone 은 generic reference.  한국 음악 특유의 톤 (강한 베이스,
밝은 vocal, 좁은 stereo) 을 정확히 매칭하기 어려움.

**구현**:
- analyze_reference 만 실행한 fingerprint JSON 50+ 개 번들
- 사용자가 "BTS 같은 톤", "NewJeans 같은 톤" 같은 vibe 검색
- (저작권 안전 — 오디오 미포함, fingerprint 만)

**작업량**: 2-3 주 (curation 시간 별도)

### T3-E. Multi-segment Section-aware Mastering

**컨셉**: verse / chorus / bridge 등 곡 구간별로 다른 처리.
**왜 차별화**: 모든 마스터링 도구는 곡 전체를 단일 처리.  Verse 와 chorus 의
volume 차이를 자동 감지 → 별도 LUFS 적용.

**구현**:
- segment_analysis 의 시간대별 RMS → section detection (간단 ML)
- 각 section 별 별도 master 처리 → crossfade 합성

**작업량**: 8-12 주 (실험적)

### T3-F. Real-time Web 버전 (브라우저 기반 마스터링)

**컨셉**: Ozone 은 desktop only.  우리는 Web Audio + WASM ffmpeg 으로
브라우저에서 실행 가능.
**왜 차별화**: 인스톨 없는 시연 / 비전공자 / 모바일 접근.

**구현**:
- ffmpeg.wasm 사용 (이미 존재)
- 동일 마스터링 로직을 web worker 에서 실행
- 결과를 브라우저에서 즉시 다운로드

**작업량**: 8-12 주 (큰 변경)
**제약**: WASM 성능 한계 (real-time 어려움)

### T3-G. Multi-vocal Layer 처리 (가성 + 진성 분리)

**컨셉**: K-pop 의 멀티-vocal 트랙 (메인 + 화음 + 가성) 톤 분리 + 개별 보호.
**왜 차별화**: K-pop 특유 워크플로우.  Ozone 은 일반 vocal 만 인식.

**작업량**: 6-8 주

### T3-H. Mastering 이력 / 버전 관리

**컨셉**: 한 곡에 대한 마스터링 시도 5-10 회 자동 저장 → 비교 + 롤백.
**왜 차별화**: project file 보다 자동.  사용자가 명시적으로 save 안 해도 모든 시도 보존.

**작업량**: 2-3 주

### T3-I. Open-source 일부 + 커뮤니티 preset

**컨셉**: 핵심 엔진은 closed-source 유지하되, preset / reference / safe-mode
정의는 open + 사용자 공유 가능.
**왜 차별화**: Ozone 은 100% closed.  우리는 community-driven preset
ecosystem 구축.

**구현**:
- GitHub 또는 Discord 에 preset registry
- 앱 안에서 "Community presets" tab → 다운로드 → 적용

**작업량**: 4 주

**Tier 3 합계: 6-12 개월**

---

## 6. AI / ML 영역 (가장 큰 격차)

Ozone 의 핵심 차별점은 ML 기반 기능들.  솔직히 우리가 가장 부족한 영역.

### 6A. 단기 (룰 기반 → 단순 ML, 3-6 개월)

| 항목 | 구현 난이도 | 작업량 |
|------|:----------:|:------:|
| 장르 자동 감지 (rule-based) | 낮음 | 1 주 |
| AI artifact detection 강화 | 낮음 | 2 주 |
| 보컬 분리 정확도 향상 (band-limited) | 중간 | 4 주 |
| Reference matching ML 보강 | 중간 | 6-8 주 |

### 6B. 중기 (간단 ML 모델 직접 학습, 6-12 개월)

| 항목 | 구현 난이도 | 작업량 |
|------|:----------:|:------:|
| Genre classification CNN (mel-spec 입력) | 중간 | 4-6 주 |
| Vocal presence detector (segment 별) | 중간 | 6 주 |
| Master quality regression model | 높음 | 8-12 주 |

### 6C. 장기 (Source separation 등 대형 ML, 12-24 개월)

| 항목 | 구현 난이도 | 작업량 |
|------|:----------:|:------:|
| **Master Rebalance equivalent** (vocal/bass/drums separation) | **매우 높음** | 6+ 개월 |
| **Stem separation** | **매우 높음** | 6-12 개월 |

→ Source separation 는 **Demucs / Spleeter** 같은 open-source 모델
사용으로 단축 가능 (이미 잘 작동).  단, 모델 사이즈 (~500 MB-1 GB) 가
배포 부담.

### 6D. 현실적 ML 전략

1. **Spleeter / Demucs 통합** (오픈소스 사용) — Master Rebalance 흉내
   - 4-stem (vocal / drums / bass / other) 분리
   - 각 stem 별 -3 ~ +3 dB 조정 → 재합성
   - **이걸로 Ozone 의 핵심 기능 1 개 따라잡음**
2. **장르 detection 은 Tier 2 의 옵션 A (rule-based) 로 시작** — 80% 정확도
   로 충분
3. **Master quality scoring 은 추후 데이터 모이면**

---

## 7. Architecture / Infrastructure 변화

### 7A. DAW Plugin (VST3 / AU) — **가장 큰 도전**

**문제**: 현재 Electron desktop app.  DAW plugin 은 native C++ 필요.
**해결책**:
- Plan A: 핵심 마스터링 로직을 C++ DSP 로 재작성 → JUCE 프레임워크로 plugin
  → **6-12 개월 풀타임 + DSP 엔지니어 1-2 명**
- Plan B: Plugin 형태는 standalone host 로 두되, UI 만 plugin host 안에서
  rendering (예: Web view) → 변형된 plugin
- Plan C: 포기.  Standalone 으로 충분 + 무료/저렴 가격으로 차별화

**현실적 평가**: Plan A 는 우리 자원에서 매우 어려움.  Plan C 가 합리적.

### 7B. Cloud / SaaS 모델

**컨셉**: 서버에서 마스터링 처리 → 클라이언트는 가벼운 UI 만
**장점**:
- 큰 ML 모델 호스팅 가능 (GPU 사용)
- 모든 OS 동일 작동 (Web)
- 사용량 기반 과금 가능
**단점**:
- 서버 비용
- 인터넷 의존
- privacy 우려 (사용자 음원 업로드)

**작업량**: 인프라 6-8 주 + ongoing 운영

### 7C. Mobile (iOS / Android)

**컨셉**: 모바일에서 간단 마스터링
**현실**: Electron 으로 안 되고 React Native 또는 Native 앱 필요.
**Phase 4+ 로 미루기**.

---

## 8. UX / Visualizer 종합

Ozone 사용자가 "Ozone 답다" 고 느끼는 핵심:

1. **Real-time spectrum** (T1-B)
2. **Real-time loudness meter** (T1-C)
3. **Vectorscope** (T2-E)
4. **Module chain editor** (drag-drop 으로 처리 순서 조정) — **신규 작업 필요**
5. **Module bypass toggle** (각 stage 별 ON/OFF + before/after 즉시 비교)
6. **Knob / slider 직접 조작** (preset 외에도 fine-tune)

→ 이것들 없으면 "프로페셔널" 느낌 안 남.  **Tier 1 + Tier 2 에 포함**.

---

## 9. 시장 / 가격 전략

### 9A. 가격 모델 옵션

| 모델 | 장점 | 단점 |
|------|------|------|
| **무료 + open-source** | 빠른 사용자 확보 | 수익 X |
| **Free tier + Pro ($49/year)** | 중간 | 적당한 수익 |
| **One-time $99-149** | Ozone 대비 저렴 | 한국 시장은 구독 선호 안 함 |
| **Subscription $9.99/month** | 지속 수익 | 사용자 저항 |
| **Freemium (Free 3곡/월 + Pro 무제한)** | conversion 좋음 | 복잡 |

### 9B. 추천: **Freemium**

- **Free**: 1곡/주, basic preset 4개, 자동 업데이트, 한국어 풀 지원
- **Pro ($79 일시 + $19/year 업데이트)**: 무제한, 모든 preset, custom preset 저장,
  reference library, batch processing, codec preview
- **Pro+ ($199 일시)**: + Master Rebalance (Demucs) + DAW plugin (v3.7+)

### 9C. 한국 시장 우선 + 글로벌 확장

1. **Phase 1**: 한국 시장 KPOP / J-pop 마스터링 사용자
2. **Phase 2**: 일본 + 동남아
3. **Phase 3**: 영문화 + 글로벌

→ Ozone 의 영문 글로벌 시장 vs 우리의 한국/아시아 특화 = 차별화 완성.

---

## 10. 우선순위 + Roadmap

### v3.5.x (1-2 개월) — 안정화

- P1 이슈 5건 해결 (legacy renderer 통합, 단위 테스트, tempfile cleanup,
  tonal_budget enforcement, analyzer Phase 2 호환)
- macOS notarization 준비

### v3.6.x (3-4 개월) — Ozone 핵심 기본기

- T1-A Multiband Compressor (4-band 진짜)
- T1-B Real-time Spectrum Analyzer
- T1-C Real-time Loudness Meter
- T1-D Codec Preview
- T1-E Streaming Platform Target
- T1-F Custom Preset Save/Load
- macOS 정식 배포 (signing + notarization)

### v3.7.x (5-7 개월) — Project + Visualizer

- T1-G Project File (.lvr)
- T1-H Batch Processing UI
- T2-A Stereo Imager (4-band M/S)
- T2-E Vectorscope
- T2-F A/B Snapshot
- T2-G Reference Library

### v4.0.x (8-12 개월) — 차별화

- T3-A Stem-aware Mastering
- T3-B AI 생성곡 전용 모드
- T3-D 한국 음악 reference library
- T2-H Auto Genre Detection (rule-based)
- ML: Spleeter 통합 → Master Rebalance equivalent

### v4.5.x (12-18 개월) — Vintage + 고급

- T2-B Mid/Side EQ + Compression
- T2-C Vintage modules
- T2-D Impact (Transient Designer)
- T3-C 사용자 피드백 루프
- T3-E Section-aware Mastering (실험)

### v5.0.x (18-24 개월) — 완성도

- T3-G Multi-vocal Layer
- T3-H Mastering 이력 / 버전 관리
- T3-I Open community preset
- (옵션) T3-F Web 버전

### v6.0.x+ (24+ 개월) — 야심

- DAW plugin (VST3 / AU) — DSP 엔지니어 채용 후
- Surround / Atmos 지원
- Cloud SaaS 모델
- Mobile

---

## 11. 현실적 평가

### 11A. 우리 자원 (추정)

- 엔지니어 1-2 명 (full-time 이라 가정)
- DSP 전문 엔지니어 0-1 명
- ML 엔지니어 0 명
- 디자이너 0-1 명

### 11B. Ozone 12 자원 (추정)

- 엔지니어 30-50 명
- DSP 전문 5-10 명
- ML 전문 5-10 명
- 20+ 년 노하우

→ **모든 영역에서 따라잡는 것은 비현실적**.

### 11C. 현실적 차별화 전략 — 선택 + 집중

**우리가 이길 수 있는 영역**:

1. ✅ **한국 / 아시아 시장 특화** — Ozone 은 generic
2. ✅ **AI 생성곡 마스터링** — 시장 폭발, Ozone 늦음
3. ✅ **자동화 (Master Assistant 보다 더 자동)** — 룰 + 가벼운 ML
4. ✅ **가격 / 접근성** — 무료/저렴
5. ✅ **한국어 사용자 경험** — 모든 메시지 / 문서 / 지원
6. ✅ **Always-on Vocal Protection** — Ozone 은 사용자가 켜야 함
7. ✅ **빠른 iteration** — 공개 issue tracker, 사용자 피드백 직접 반영
8. ✅ **고객 지원 도구 (Debug bundle)** — 문제 재현 즉시

**우리가 절대 못 이기는 영역** (인정 + 우회):

1. ❌ DAW plugin 생태계 → Phase 4+ 또는 포기
2. ❌ 빈티지 회로 모델링 정확도 → ladspa/calf 통합으로 대체
3. ❌ Surround / Atmos → 시장 작음, 우선순위 낮음
4. ❌ 정확한 source separation → Demucs/Spleeter 사용

### 11D. "Ozone 보다 뛰어나다" 의 재정의

**달성 가능한 정의**: "한국 KPOP / J-pop / AI 생성곡 마스터링 워크플로우에서
Ozone 보다 빠르고 정확하고 안정적이며, 가격이 1/5 이고 한국어 지원이
완벽한 도구."

**달성 불가능한 정의**: "Ozone 의 모든 기능 + 더 많은 기능."

→ 전자를 목표로 잡으면 **24 개월 안에 가능**.

---

## 12. 즉시 시작 (3 개월) Quick Wins

다음 6 개는 즉시 시작해서 큰 visual impact:

| 항목 | 작업량 | impact |
|------|:------:|:------:|
| **Real-time Spectrum Analyzer** (T1-B) | 1-2 주 | ⭐⭐⭐⭐⭐ |
| **Real-time Loudness Meter** (T1-C) | 1-2 주 | ⭐⭐⭐⭐⭐ |
| **Streaming Platform Target** (T1-E) | 3-5 일 | ⭐⭐⭐⭐ |
| **Custom Preset Save/Load** (T1-F) | 1 주 | ⭐⭐⭐⭐ |
| **Codec Preview** (T1-D) | 1 주 | ⭐⭐⭐ |
| **legacy renderer 트리 통합** (P1-2) | 2-3 일 | ⭐⭐⭐⭐ |

→ **3 개월 내 v3.6.0 release** 가능.  사용자가 "Ozone 같다" 고 느끼는 임계
넘어감.

---

## 13. ML / AI 영역 솔직한 평가

### 13A. 우리가 갖고 있는 ML

- **AI artifact detection** (FFT 기반 룰)
- **Reference iterative matching** (룰 + 수치 최적화)
- **Adaptive EQ** (입력 spectral 특성 → EQ 자동 결정)

→ 모두 **rule-based**.  "AI" 라는 단어는 마케팅용.  실제 ML 모델 없음.

### 13B. ML 역량 격차

| 영역 | Ozone | 우리 | 격차 |
|------|:-----:|:----:|------|
| 장르 분류 | CNN | 룰 | -10 년 |
| Source separation | proprietary ML | 없음 | -5 년 |
| Mastering style learning | ML | 룰 | -5 년 |

### 13C. 우리 ML 전략

1. **Open-source ML 통합**: Demucs (source separation), Whisper (vocal detection),
   pretrained CNN (genre classification)
2. **자체 ML 학습 X** (자원 부족) — 통합으로 대체
3. **rule-based 가 충분한 영역은 그대로** — 더 빠르고 디버그 쉬움
4. **장기적으로**: 사용자 피드백 데이터 수집 → small model 학습 (3-5 년)

---

## 14. 예상 비용

### 14A. 인건비 (24 개월, 단순 추정)

- 엔지니어 1 명 × 24 개월 = ?
- DSP 엔지니어 0.5 명 × 12 개월 (Vintage / Multiband) = ?
- 디자이너 0.5 명 × 12 개월 = ?
- ML 엔지니어 0.3 명 × 6 개월 (Demucs 통합) = ?

(구체 금액은 시장 / 지역 / 회사 상황에 따라 — 본 문서는 작업량만 제시)

### 14B. 인프라

- macOS Apple Developer: $99/year
- Windows EV Code Signing: $300-500/year
- GitHub Actions (현재 free for public)
- (옵션) Cloud SaaS: AWS GPU instance ~$0.5-1/hour
- (옵션) Sentry: $26/month

### 14C. 라이선스

- Demucs: MIT (free)
- ffmpeg: LGPL/GPL (사용 OK)
- Electron: MIT
- Apple Developer cert
- Windows code sign cert

---

## 15. 결론

### 15A. "Ozone 12 보다 뛰어난 프로그램" — 가능한가?

**Yes — 단, 정의를 좁혀야 한다.**

✅ "한국 KPOP / 아시아 시장 / AI 생성곡 마스터링 + 가격/UX/접근성" 에서
Ozone 보다 우월: **24 개월에 가능**.

❌ "Ozone 의 모든 기능 + 그 이상": 5+ 년 + 수백억 원 투자 필요.

### 15B. 권장 전략

1. **단기 (3 개월)**: Tier 1 의 시각화 / 미터링 / preset 시스템 추가 →
   "Ozone 같다" 임계 돌파
2. **중기 (12 개월)**: Tier 2 의 multiband / M/S / vintage 추가 + ML 통합
   (Demucs)
3. **장기 (24 개월)**: Tier 3 의 차별화 기능 + 한국 시장 reference library +
   AI artifact 마스터링 → **틈새 시장에서 Ozone 압도**

### 15C. 가장 위험한 함정

- ❌ "Ozone 의 모든 기능 따라잡기" — 자원 부족, 늦음
- ❌ DSP 직접 작성 (vintage 모듈 등) — DSP 엔지니어 없으면 절대 못 함
- ❌ 너무 많은 모드 / 옵션 — 결정 피로
- ✅ 좁은 시장 + 깊이 + 빠른 iteration

### 15D. 다음 액션 (사용자 결정 필요)

1. 본 로드맵 검토 후 **v3.6 우선순위 선택**
2. **자원 / 인력 계획** 결정
3. **시장 검증** (실 사용자 인터뷰 5-10 명)
4. **가격 / 비즈니스 모델** 결정
5. **인증서 발급** 시작 (시간 걸림)

---

**📌 본 문서는 *전략 / 우선순위* 만 제시합니다.  코드 변경은 사용자 승인 후
phase 별로 진행합니다.**
