# 전체 시스템 점검 · 기능표 · 업데이트 방향 보고서

**작성일**: 2026-06-09
**기준**: 브랜치 `claude/dazzling-darwin-eav8na`, monorepo `aimaster-desktop` **v3.6.0**, 최근 커밋 2026-06-08
**목표**: iZotope **Ozone 을 뛰어넘는** 마스터링 프로그램
**점검 방식**: Rust DSP 코어 / 렌더러 UI 와이어링 / Python 오프라인 엔진 / 문서·마일스톤·CI 4개 영역 코드 직접 점검

> 이 보고서는 기존 `docs/COMPLETE_FEATURE_REPORT.md`·`docs/ROADMAP_BEYOND_OZONE.md`(둘 다 2026-05-04, v3.5.0 기준)를
> **실제 현재 코드 상태로 갱신**한다. 그 이후 `aimaster-desktop` 모노레포 + Rust DSP 코어 + WASM + "Loui Mastering v2" 리디자인이
> 대거 진행되어 두 기존 문서는 구조·기능 모두 현실과 어긋나 있다.

---

## 0. 한 줄 요약

> **메트릭/분석/안정성은 Ozone 급에 근접했지만, "사운드를 만드는 DSP"와 "그 DSP를 실시간으로 만지는 UI"가 둘로 쪼개져 있고
> 핵심 마스터링 모듈(진짜 멀티밴드·새추레이션·트랜지언트·스펙트럴·스템분리)이 비어 있다.**
> Ozone 을 넘으려면 *기능을 더 늘리기 전에* **엔진을 하나로 합치고(preview=render), 멀티밴드 골격을 세우는 것**이 1순위다.

---

## 1. 실제 아키텍처 (문서가 아니라 코드 기준)

```
aimaster-desktop/ (v3.6.0, pnpm + turbo 모노레포)
├── apps/desktop/            Electron 28 + React18 + Zustand 렌더러 + main/preload
│   └── src/renderer/        페이지 흐름 + 실시간 분석기 + "Loui" Ozone풍 모듈 UI
├── dsp-core/  (Rust)        loui-dsp 코어 + wasm/node 바인딩  ← 실시간 프리뷰·실험적 오프라인
│   crates/loui-dsp/src/
│     mastering/{chain,eq,parametric_eq,dynamics,limiter,imager,gain,config}.rs
│     analyzer.rs lufs.rs true_peak.rs spectrum.rs stereo.rs oversample.rs k_weighting.rs biquad.rs
├── packages/                audio-engine(파이썬 브리지) / dsp-wasm / license-core / shared-types
└── services/python-audio/   ★ 실제 최종 렌더 엔진 (FFmpeg + NumPy, 6-stage)
python/                       ★ LEGACY (v3.1, 미사용) — 데드 트리
```

### 핵심 사실: **엔진이 둘이다 (이게 전략의 핵심 문제)**

| 경로 | 엔진 | 역할 | 성숙도 |
|------|------|------|--------|
| **최종 렌더(Export)** | **Python + FFmpeg + NumPy** (`services/python-audio`) | 실제 마스터 파일 생성 | 중급(견고하지만 FFmpeg 필터 한계) |
| **실시간 프리뷰** | **Rust WASM + WebAudio BiquadFilter** (`dsp-core`, ResultPage) | 들으면서 조절 | 기초(세이프 프리뷰 수준) |
| **레거시** | Python (`/python`) | 미사용, v3.1 | 데드코드 |

→ **프리뷰와 최종 렌더가 서로 다른 코드/다른 알고리즘.** 사용자가 프리뷰에서 들은 소리와 Export 결과가 일치한다는 보장이 없다.
   Ozone 의 가장 큰 신뢰 요소("들은 그대로 렌더된다")가 구조적으로 깨져 있다. (`dsp-core/.../mastering/mod.rs:14-23` 가 스스로 "SAFE preview chain, not an Ozone-grade suite"라고 명시)

---

## 2. 시스템별 점검 결과

### 2A. Rust DSP 코어 (`dsp-core/crates/loui-dsp`) — 실시간 프리뷰용
- **품질**: 코드 자체는 깔끔, 테스트 있음, `unimplemented!`/스텁 없음, 리얼타임-세이프(무할당) 설계. 메트릭은 표준 준수.
- **메트릭/분석 (성숙 ✅)**: LUFS(momentary/short/integrated/LRA, BS.1770-4), True-Peak(4× 폴리페이즈 오버샘플, ITU 준수), 스펙트럼(1/3옥타브/log/lin), 스테레오 상관/MS비/width.
- **DSP 모듈 (기초 ⚠️)**:
  - EQ: 고정 5밴드 톤셰이핑(주파수/Q 조절 불가) + 별도 파라메트릭 EQ(최대16밴드 biquad, **M/S 없음, 다이내믹 없음, 리니어페이즈 없음**)
  - Dynamics: **싱글밴드** 글루 컴프(룩어헤드 없음, 캐릭터 선택 없음)
  - Limiter: 룩어헤드 + ISP 헤드룸 근사(리미터 경로 자체는 오버샘플 X), **캐릭터 1종, release 비노출**
  - Imager: **싱글밴드** M/S width + 저역 모노화
  - 없음: 새추레이션/엑사이터, 트랜지언트/임팩트, 스펙트럴 셰이퍼, 디에서, 다이내믹 EQ, **진짜 멀티밴드**

### 2B. 렌더러 UI (`apps/desktop/src/renderer`) — 의외의 강점 + 함정
- **강점 (FUNCTIONAL ✅, 실제 오디오로 구동)**: 페이지 흐름 전체, 실시간 스펙트럼 캔버스, 고니오미터(M/S 리사주), 네이티브 미터카드(RMS/peak/상관), GR 미터(없으면 정직하게 '—' 표시), BS.1770 라우드니스/FFT/스테레오스코프(WASM 백엔드), Pre/Post 듀얼 스펙트럼 비교, 리포트(TXT/JSON)·WAV/MP3 저장, 프리셋 브라우저.
- **함정 (PARTIAL/STUB ⚠️)** — *Ozone 처럼 "보이지만" 아직 소리에 연결 안 됨*:
  - `DraggableParametricEqEditor`: **시각화 전용** — 주석에 "audible audio is NOT affected (Phase 1)" 명시
  - EQ/Dynamics/Imager/Limiter **파라미터 패널**: UI만 있고 엔진 바인딩 미완 (`TODO M3-P-NEXT-5B`)
  - `mastering-chain.worklet.js` (Rust 풀체인 실시간): **프로토타입, 디바이스테스트 게이트로 OFF**
  - 커스텀 프리셋/스냅샷/리비전 스택: UI는 있으나 영속화 미확인
- **즉, ResultPage 의 네이티브 WebAudio BiquadFilter 체인만 실제로 들리고 조절된다.** 정작 "Ozone풍 모듈 편집기"는 데모 상태.

### 2C. Python 오프라인 엔진 (`services/python-audio`) — 실제 사운드의 주인
- **성숙 ✅**: 6-stage 파이프라인(입력분석→경고→적응형EQ+AI보정→글루컴프→라우드니스매칭→리미터→보정패스→ISP안전→파이널 토널가드), 2-pass loudnorm/정적체인, 레퍼런스 매칭(Ozone식 4밴드 반복 매칭, 3회), 룰기반 AI 아티팩트 감지(6종), 세이프모드 3종, 12항목 QC + 5개 스트리밍 플랫폼 비교, 게인스테이징 감사, 보컬보호 항상 ON, 의심구간 검출. RPC 9개.
- **방식**: 전부 **FFmpeg 필터 체인 + NumPy FFT** (ML 모델 없음 — torch/onnx/demucs/spleeter 전무).
- **기초/없음 ❌**: 새추레이션(하모닉 약식만), 디에서(6.5kHz 단일밴드), 다이내믹EQ(프리셋 컷 위주, 완전 파라메트릭 아님), **진짜 멀티밴드 컴프 없음**(다이내믹EQ로 흉내), 스펙트럴셰이퍼/엑사이터/빈티지/트랜지언트/스템분리/ML매칭 전부 없음.

### 2D. 빌드 · 테스트 · CI
- Python pytest **120 케이스 통과**, Rust 유닛테스트 + 7개 TS 셀프테스트 존재. **렌더러 단위테스트 0개** (P1).
- CI: 3-플랫폼 빌드 + tag push 시 release-draft + electron-updater. **Win/Linux 자동업데이트 OK, macOS 서명/공증 미완**(P0).
- 데드코드: `/python` 레거시 트리, `iterative.py`/`multiband.py` 등 ~1,800 LoC.

---

## 3. 기능표 — Ozone 12 대비 현재 위치 (실측 기준)

> %는 "Ozone 대비 완성도"의 정성 추정. 🟢완비 / 🟡부분 / 🔴없음·미연결.

### 3-1. 핵심 DSP 모듈

| 기능 | Ozone | 현재 실제 상태 | 위치 | 비고 |
|------|:-----:|------|:----:|------|
| Parametric EQ (8밴드+) | ✅ | 렌더 Python 적응형 EQ + Rust 16밴드 biquad, **UI 편집기는 미연결** | 🟡 45% | 드래그 편집이 소리에 안 닿음 |
| EQ M/S · 리니어페이즈 | ✅ | 없음 | 🔴 0% | |
| Dynamic EQ | ✅ 6밴드 | Python 프리셋 컷, Rust 없음 | 🟡 55% | 완전 파라메트릭 아님 |
| **멀티밴드 컴프(진짜)** | ✅ 4밴드 acrossover | **없음**(다이내믹EQ 흉내) | 🔴 15% | **최우선 격차** |
| 글루/광대역 컴프 | ✅ | Python compand + Rust 싱글밴드 | 🟡 70% | 캐릭터 선택 없음 |
| Maximizer/Limiter | ✅ 10+ 캐릭터 | Python alimiter + Rust 룩어헤드 | 🟡 55% | 캐릭터 1종, ISP 근사 |
| **Stereo Imager(4밴드 M/S)** | ✅ | 싱글밴드 width만 | 🔴 25% | |
| **Exciter/Saturation** | ✅ 멀티밴드 4모드 | 하모닉 약식만 | 🔴 20% | |
| **Spectral Shaper** | ✅ | 없음 | 🔴 0% | |
| **Impact/Transient** | ✅ 멀티밴드 | 없음 | 🔴 0% | |
| De-esser | ✅ | 6.5kHz 단일밴드 | 🟡 35% | |
| Vintage(Tape/Comp/EQ/Limiter) | ✅ | 없음 | 🔴 0% | |
| **Master Rebalance(ML 소스분리)** | ✅ | 없음 | 🔴 0% | |
| **Stem Separation(ML)** | ✅ | 없음 | 🔴 0% | |
| Stabilizer(자동 스펙트럼 안정화) | ✅ ML | Python 토널가드/적응형EQ | 🟡 65% | |
| Match EQ / Reference matching | ✅ | Python 4밴드 반복 매칭(견고) | 🟢 70% | |
| 라우드니스 정규화(LUFS) | ✅ | Python 2-pass/정적체인 | 🟢 85% | |
| True-Peak / ISP 안전 | ✅ | Python+Rust 4× 오버샘플 | 🟢 85% | |

### 3-2. 분석 · 미터링 · 시각화 (← 현재의 강점)

| 기능 | Ozone | 현재 | 위치 |
|------|:-----:|------|:----:|
| 실시간 스펙트럼 | ✅ | 실오디오 구동 | 🟢 80% |
| 실시간 라우드니스 미터(M/S/I/LRA) | ✅ | BS.1770-4 WASM | 🟢 85% |
| 벡터스코프/고니오미터 | ✅ | M/S 리사주 실동작 | 🟢 80% |
| Gain Reduction 미터 | ✅ | 실 GR(없으면 정직 표시) | 🟡 60% |
| Pre/Post 비교 | ✅ | 듀얼 스펙트럼 | 🟢 75% |
| 곡 구간(섹션) 분석 | ⚠️ | 의심구간 검출 보유 | 🟢 90% |

### 3-3. 워크플로우 · I/O · 기타

| 기능 | Ozone | 현재 | 위치 |
|------|:-----:|------|:----:|
| **실시간 프리뷰=최종렌더 일치** | ✅ | **프리뷰≠렌더(엔진 분리)** | 🔴 30% ⚠️ |
| 모듈 체인 편집(드래그 순서·바이패스) | ✅ | 모듈 스트립 UI 일부, 미바인딩 | 🟡 35% |
| 프리셋(빌트인) | ✅ | 7 스타일 + 8 장르 레퍼런스 | 🟢 75% |
| 커스텀 프리셋 저장/공유 | ✅ | UI 있음, 영속화 미확인 | 🟡 40% |
| A/B 스냅샷(8) | ✅ | before/after + 스냅샷 UI | 🟡 45% |
| 스트리밍 타겟(Spotify/Apple…) | ✅ | QC 5개 플랫폼 비교 | 🟡 60% |
| Codec 프리뷰(MP3/AAC) | ✅ | MP3 export, 프리뷰 미흡 | 🟡 35% |
| 배치 처리 UI | ✅ | 백엔드만 | 🟡 40% |
| 프로젝트 파일 저장/복원 | ✅ | 없음 | 🔴 0% |
| **DAW 플러그인(VST3/AU)** | ✅ | 없음(스탠드얼론) | 🔴 0% |
| Surround/Atmos | ✅ | 없음 | 🔴 0% |
| 자동 장르감지(ML) | ✅ | 없음(룰 일부) | 🔴 10% |
| 자동 업데이트 | ✅ | Win/Linux OK, mac 미서명 | 🟡 70% |
| 한국어 UX / 보컬보호 항상ON / 디버그번들 | ❌(Ozone엔 없음) | ✅ | 🟢 120% (차별점) |

---

## 4. 점검 중 발견한 주요 리스크/불일치 (수정 권고)

1. **🔴 P0 — 프리뷰↔렌더 엔진 이원화**: 들은 소리와 결과물이 다를 수 있음. Ozone 대비 신뢰성 최대 약점.
2. **🟠 P1 — "Ozone풍 모듈 UI"가 데모 상태**: 드래그 EQ·파라미터 패널이 소리에 미연결(`TODO M3-P-NEXT-5B`). 사용자가 만져도 안 바뀌는 컨트롤 = 신뢰 훼손.
3. **🟠 P1 — Rust 오프라인 렌더 미완**: loudness-norm 단계 부재로 Python 과 결과 불일치, 기본 OFF.
4. **🟡 P2 — 렌더러 단위테스트 0**, 레거시 `/python` + ~1,800 LoC 데드코드.
5. **🟡 P2 — macOS 서명/공증 미완**(정식 배포 불가), Windows EV 서명 미완(SmartScreen 경고).
6. **🟡 — 문서 부채**: 두 핵심 문서가 v3.5.0 기준으로 현실과 어긋남(본 보고서로 일부 해소).

---

## 5. 업데이트 방향 (Ozone 를 넘기 위한 우선순위)

### 전략 원칙
1. **모든 영역에서 Ozone 따라잡기 = 비현실적**(인력 격차). → **"엔진 일원화 + 멀티밴드 골격 + 아시아/AI음악 특화"** 세 축에 집중.
2. **기능 추가보다 "신뢰의 토대"를 먼저**: preview=render 일치, 만지는 컨트롤은 반드시 소리에 연결.

### Phase 1 — 토대 (지금~3개월) · *기능 늘리기 전에 반드시*
- **[P0] 단일 엔진화**: Rust `loui-dsp` 를 **오프라인 렌더의 정답 엔진**으로 승격(loudness-norm/보정/ISP 포팅) → 프리뷰 worklet과 동일 코드. Python 은 분석/QC/레퍼런스로 한정하거나 단계적 대체.
- **[P0] 파라미터 패널·드래그 EQ → 엔진 바인딩**(M3-P-NEXT-5B 완료): 모든 UI 컨트롤이 실제 소리를 바꾸게.
- **[P1] mastering-chain worklet 게이트 해제**(디바이스테스트 통과) → 진짜 실시간 풀체인 프리뷰.
- **[P1] 렌더러 단위테스트 도입 + `/python` 레거시·데드코드 제거.**
- **[P1] macOS 공증 / Windows EV 서명** → 정식 배포.

### Phase 2 — Ozone 기본기 메우기 (3~9개월)
- **[P0] 진짜 멀티밴드 컴프(4밴드 crossover)** — 가장 큰 DSP 격차.
- **[P1] 멀티밴드 Stereo Imager(4밴드 M/S) + M/S EQ.**
- **[P1] Saturation/Exciter(멀티밴드, 2~4 캐릭터) + 트랜지언트/임팩트.**
- **[P1] 다이내믹 EQ 완전 파라메트릭화(Rust) + De-esser 적응형.**
- **[P2] 커스텀 프리셋 영속화·공유, A/B 8 스냅샷, Codec 프리뷰, 배치 UI, 프로젝트 파일(.lvr), 모듈 체인 드래그 편집.**

### Phase 3 — 차별화로 추월 (9~24개월) · *여기서 이긴다*
- **[P0] 스템/소스 분리**: Demucs 등 오픈소스 통합 → Master Rebalance 대체(보컬/베이스/드럼 개별 조정).
- **[P1] AI 생성곡 전용 모드**: AI 음악 특유 아티팩트(metallic vocal/aliasing/ringing 등) 감지·완화 강화 (현 6종 → 12+종).
- **[P1] 한국/아시아 레퍼런스 라이브러리**(fingerprint만, 저작권 안전) + 자동 장르감지(룰→경량 CNN).
- **[P2] 섹션별(verse/chorus) 마스터링, 멀티-보컬 레이어 보호, 마스터링 이력/버전관리, 커뮤니티 프리셋.**

### Phase 4 — 야심 (24개월+)
- DAW 플러그인(VST3/AU, JUCE) — 단일 Rust 엔진이 전제되어야 현실성 생김. / Surround·Atmos / Cloud·Mobile.

### "Ozone 를 넘는다"의 달성가능한 정의
> *한국·아시아·AI생성곡 마스터링 워크플로우에서 더 빠르고·안정적이며·프리뷰가 결과와 일치하고·가격/한국어 지원이 우월한 도구.*
> 단일 엔진 + 멀티밴드 + 스템분리 3개를 확보하면 **타깃 시장에서 Ozone 압도가 24개월 내 가능**. "모든 기능 추월"은 비현실적.

---

## 6. 결론 / 다음 액션 (사용자 결정 필요)

현재 제품은 **"미터·분석·안정성은 프로급, 사운드 엔진과 편집 UI는 미완"** 상태다. 가장 큰 위험은 *기능 수*가 아니라
**엔진 이원화로 인한 프리뷰-렌더 불일치**와 **소리에 안 닿는 컨트롤**이다. 따라서 다음을 권고한다:

1. **엔진 일원화(Rust)** 를 v3.7의 최우선 과제로 확정할지 결정.
2. Phase 2의 **멀티밴드 컴프 / 멀티밴드 이미저 / 새추레이션** 중 착수 순서 결정.
3. 스템분리(Demucs) 통합을 Phase 3 핵심으로 채택할지 결정(번들 용량 ~수백MB 트레이드오프).
4. macOS 공증 / Windows EV 인증서 발급 착수(리드타임 김).

> 본 보고서는 분석·우선순위만 제시한다. 코드 변경은 위 결정 후 Phase 별로 진행.
