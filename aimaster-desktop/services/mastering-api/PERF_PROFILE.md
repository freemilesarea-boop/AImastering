# 마스터링 속도 프로파일링 & 병목 분석 (운영 안정화)

테스트 앱 서버(M0)의 마스터링 처리시간을 측정·분석한 결과. **엔진 수정 없이**
서버 API에서 할 수 있는 것과, 실제 속도 레버(= CPU)를 구분한다.

## 측정 방법
- 합성 90초 스테레오 클립(+ 6ch EAC3 입력). 엔진을 직접 호출, **워밍업 1회 후** 측정
  (첫 호출의 일회성 import 비용 제거 — 이걸 빼지 않으면 가짜 30% 단축으로 보임).
- 서버 `[profile]` 로그가 단계별 소요시간을 출력(`stages={...}`).

## 단계별 프로파일 (90초 클립, 로컬 CPU)
한 번의 마스터링은 **풀파일 ffmpeg 패스 ~8회**를 순차 실행:

| 단계(%) | 작업 | 대략 비중 |
|---|---|---|
| 5 입력 확인 | ffprobe + 로드 | 중 |
| 10 스펙트럴 분석 | analyze_waveform(입력) | 중 |
| 30 라우드니스 측정(1/2) | **loudnorm pass1** (측정) | **최대** |
| 45–65 정규화(2/2)+리미터 | **loudnorm pass2 렌더 + 리미터** | 큼 |
| 78 출력 검증 | analyze_waveform(출력) | 중 |
| 84 보정 패스 | 라우드니스 타깃 보정(+리미터) | 큼 |
| 88 프리뷰 MP3 | libmp3lame 인코드 | 소 |
| 92 waveform PNG | (이제 **생략**) | ~0 |
| 96 품질 자동 검사 | 재측정 | 중 |

가장 큰 단일 병목: **loudnorm 측정/정규화 + 보정 패스**(각각 풀파일 패스).

## 3-way 비교 (90초, 워밍업 후) — 핵심 결과
| 모드 | 설정 | 시간 |
|---|---|---|
| legacy | waveforms ON + AI ON | **24.2s** |
| current | waveforms OFF | 24.0s (legacy 대비 **~1%**) |
| fast | waveforms OFF + 입력 preconvert | 24.1s (**~0%**, 1.00x) |
| 6ch EAC3(fast) | preconvert 후 처리 | 24.5s |

### 결론 (중요, 솔직하게)
- **서버 API만으로의 fast mode는 의미있는 단축이 없다(≈0%).** 초기 측정의 "30% 단축"은
  전부 **일회성 import 워밍업** 아티팩트였다.
- `generate_waveforms=False`는 ~0.2s만 절감(PNG는 저렴). 단, API가 안 쓰는 산출물이므로
  계속 끈다(낭비 제거).
- `apply_ai_corrections=False`는 **속도 0 이득**. "보정 패스(84%)"는 AI가 아니라
  **라우드니스 타깃 보정**이라 이 플래그와 무관하게 항상 실행됨 → 끄면 음질만 손해.
  그래서 **fast mode에서도 AI 보정은 켠 채로 유지**(음질 보존).
- 진짜 비용은 **엔진의 순차 풀파일 ffmpeg 패스 ~8회**. 서버에서 패스 수를 줄이지 않는 한
  단축 불가.

## 일반 입력 vs 비표준 입력 (요구사항 4)
- 일반 44.1k 스테레오 WAV/MP3: preconvert 비용 ≈ 0(이미 표준).
- **6ch EAC3**: preconvert가 스테레오 PCM으로 **다운믹스**해 안정 처리(24.5s, 정상 입력과 동급).
  → fast mode의 실질 가치는 **속도가 아니라 비표준 입력 호환/안정성**.

## Render Starter 0.5 CPU 한계 (요구사항 5) — 진짜 레버는 CPU
- Starter는 컨테이너가 **0.5 vCPU로 스로틀** → 모든 ffmpeg 패스가 ~2배 느림.
- loudnorm/compand 등은 단일 스레드라 **코어 수보다 코어 클럭/할당량**이 지배적.
- 로컬(빠른 CPU) 90초=24s → Render Starter(0.5 CPU)에서는 대략 ~80–120s로 추정.
  사용자 보고 "1곡 ~140초"(3–4분 곡)와 정합.

### 플랜 비교 (권장: Standard로 약 2배)
| 플랜 | vCPU | 90초 클립(추정) | 3–4분 곡(추정) | 비고 |
|---|---|---|---|---|
| Starter | 0.5 | ~80–120s | ~140s | 현재. 스로틀로 느림 |
| **Standard** | **1.0** | **~45–65s** | ~70–90s | **2x. 테스트 목표(30–60s)에 근접** |
| Pro | 2.0+ | ~40–55s | ~60–80s | 단일 패스는 1코어만 사용 → 이득 한계 |

> 30–60초 목표(짧은 테스트 파일)는 **Standard(1 vCPU)** 로 거의 달성 가능. 풀곡까지
> 30–60초로 줄이려면 **엔진 패스 축소**(아래)가 추가로 필요.

## 더 큰 단축은 엔진 변경 필요 (현재 범위 밖)
"엔진 전체 리팩토링 금지" 원칙상 미적용. 향후 **최소 추가 파라미터**로 가능한 후보:
1. `pre_loudness` 전달 → **loudnorm pass1(측정) 생략**(~20%). analyze에서 잰 값 재사용 필요.
2. `generate_preview` 파라미터 추가 → 프리뷰 MP3를 **결과 화면 진입 후 백그라운드**로.
3. 품질 자동 검사(96%) 스킵 옵션.
4. 보정 패스를 pass2에 합치기(렌더-측정 통합).
→ 각각 엔진에 작은 additive 파라미터가 필요(데스크톱 기본동작 불변). 별도 티켓 권장.

## 적용된 서버 변경 (엔진 무수정)
- `generate_waveforms=False` 항상(낭비 제거).
- `mode=fast`: 입력을 **44.1k 스테레오 24-bit PCM으로 preconvert**(6ch/EAC3 호환).
- `[profile]` 단계별 타이밍 로그(상시).
- 음질 영향 없음(AI 보정 유지, 다운믹스는 비표준 입력에만 실질 영향).

---

## v2 — 엔진 최소 파라미터 fast mode (이후 추가, 측정 갱신)
"엔진 최소 파라미터 추가 허용" 결정에 따라, **하위호환(default=False → 데스크톱 경로
바이트 동일)** 인 skip 플래그 3종을 엔진에 추가:
| 플래그 | 효과 | 제거 패스 |
|---|---|---|
| `skip_preview` | 프리뷰 MP3 생략(결과는 WAV만) | preview 인코드 |
| `skip_correction` | 라우드니스 보정 패스 생략(속도>음질) | 보정 풀패스 |
| `skip_post_analysis` | metrics/품질검사/limiter검사/segment/gain-staging 생략 | 다수 재디코드 패스 |

`mode=fast`는 위 3종 + `generate_waveforms=False` + preconvert를 적용.

### 측정 (90초 클립, 워밍업 후, 동일 런)
| 모드 | 시간 | master |
|---|---|---|
| quality (skip 없음) | 30.5s | preview 포함, loudnessAfter 정확 |
| **fast (3 skip)** | **22.4s** | WAV만(preview 없음), loudnessAfter=-12.5 |
→ **1.36x, −26% (−8s)**. 제거된 건 correction(~3.8s)+preview(~2s)+post-analysis(~수초).

### 불가/미적용 (조사 결과)
- `skip_loudnorm_second_pass`: pass2가 **실제 정규화 출력**을 생성 → 생략 불가.
- `use_single_pass_limiter`: 리미터는 **이미 단일 패스**. 중복은 correction 패스였고
  `skip_correction`이 그걸 제거함.
- `pre_loudness`(pass1 측정 생략, ~20%): 측정값을 재사용할 곳이 필요. 모바일이 analyze를
  더 이상 호출하지 않으므로(분석탭 제거) 무료 재사용처 없음 → 미적용.

### 데스크톱/품질 안전성
- 모든 skip은 default False → 데스크톱(master_file에 플래그 미전달)은 **동일 코드 경로**.
- 회귀 확인: quality 모드 master에 **preview 생성·loudnessAfter 정확·full result** 유지.

### 목표 대비 (요구사항 3)
- fast(−26%) + **Render Standard(1 vCPU, ~2x)** 조합:
  - 30초~2분 파일: Starter fast ~70–90s → **Standard fast ~40–60s** (목표 60초 이내 근접/달성)
  - 3분 곡: Standard fast ~70–90s (목표 90초 이내 근접)
- 추가 단축은 pass1(측정) 생략 등 더 깊은 엔진 변경 필요(별도 티켓).
