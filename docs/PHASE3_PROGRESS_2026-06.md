# Phase 3 진행 보고 — 차별화 (Ozone에 없는 기능)

**작성일**: 2026-06-10
**브랜치**: `claude/dazzling-darwin-eav8na`
**목표**: Ozone이 약하거나 없는 영역에서 우위 — "여기서 이긴다".

---

## ✅ Phase 3 완료 (전부)

| # | 기능 | 검증 |
|---|------|------|
| P3-1 | AI 생성곡 전용 모드 (감지 + 원클릭 보정) | ✅ headless |
| P3-2 | AI 음악 감지 스펙트럴 정밀화 | ✅ headless |
| P3-3 | 자동 장르 감지 + 아시아 레퍼런스 라이브러리 | ✅ headless |
| P3-4 | 스템 리밸런스 (근사 라이브 + 정밀 티어 스켈레톤) | ✅ headless |
| P3-5 | 정밀 스템 분리 런타임 (ONNX Demucs WOLA + 모델 매니저) | ✅ headless (모델 핀 전 게이트 OFF) |
| P3-6 | 매니페스트 핀 인프라 (사이드카 + pin:stem-model) | ✅ headless |
| P3-7 | 마스터링 이력 (durable, 세션간) | ✅ headless |
| P3-8 | 구간별 마스터링 (per-section 게인, export) | ✅ headless |
| P3-9 | 멀티-보컬 → 보컬 라이딩 (센터 M/S, export) | ✅ headless |

**전체 검증**: vitest **252/252** 그린 · typecheck 0 (renderer + main + shared-types) · 모든 기능 기본 OFF/무변경 → **무회귀**.

**출시 전(헤드리스 불가) 잔여**:
- 정밀 스템 티어 ON — 스위치 3개(① 모델 export·호스팅·매니페스트 핀 ② `onnxruntime-node` 번들 ③ `PRECISE_AVAILABLE=true`). 런타임/툴링 완료, `docs/STEM_SEPARATION_PLAN.md`.
- 청취 품질 QA — 구간 경계 자연스러움·보컬 라이딩 펌핑·정밀 분리 품질은 실 오디오/장치 A/B 필요.
- → 이후 **Phase 4 / 출시 준비**(프리뷰 플래그 ON + 디바이스 QA, macOS 공증 + Windows EV 서명 = 결제 단계).

---

## ✅ P3-1. AI 생성곡 전용 모드

**커밋**: `feat(ai-music): AI-generated music mode — detect + one-click correct (Phase 3)`

AI 음악(Suno/Udio/Stable Audio) 마스터링 시장이 폭발 중이고 Ozone엔 전용 대응이 없다. 룰기반으로 **AI 특유 아티팩트를 감지 → Phase 2 모듈로 원클릭 보정**.

- **`audio/ai-music.ts`** (순수): `buildAiMusicFeatures(analysis)` + `detectAiMusic(features)`.
  - 감지: 금속성 고중역 / 고역 브리틀·에일리어싱 / 원본 과압축(LRA↓) / 저역 부밍 / 위상·스테레오 이상.
  - 각 아티팩트 → 보정 매핑: 다이내믹EQ DownCut 밴드, 디에서, 트랜지언트 펀치 복원, 이미저 저역 모노. 6종 모듈 보정 번들 반환(다이내믹EQ 6밴드 cap).
- **`audioStore.applyAiMusicCorrection`**: 6종 슬라이스 일괄 세팅.
- **`AiMusicPanel`**(ResultPage): 입력 분석 기반 아티팩트 검출 + 심각도 표시 + 원클릭 '보정 적용'.
- **검증**: ai-music(9) + 패널(3). **vitest 128/128**, 전체 pnpm test 그린(ALL FRESH 포함), typecheck 0.
- ML 불필요 · 기존 aiDetection + Phase 2 모듈 재사용 · 클릭 전엔 무변경(무회귀).

### 정직성/한계
- 감지는 기존 룰기반 aiDetection(6 boolean) + 라우드니스 + (선택) 스펙트럴 밸런스 기반. boolean 임계 의존이라 정밀도 한계 → 향후 스펙트럴 피처 강화(렌더러 WASM 스펙트럼) 가능.
- 보정은 "완화/복원" 위주(원본 과압축은 되돌릴 수 없음 → 추가 압축 회피 + 트랜지언트로 펀치 복원).

---

## ✅ P3-2. AI 음악 감지 스펙트럴 정밀화

**커밋**: `feat(ai-music): precise spectral features from the renderer FFT (Phase 3)`

- **`ai-music-spectral.ts`**(순수): FFT 매그니튜드 스펙트럼 → `bandPowerDb` + **metallicScore**(3–5kHz 집중) · **harshnessScore**(5–9kHz) · **aliasingScore**(Nyquist 근처 비롤오프 에너지) · 틸트. `isUsableSpectrum` 가드.
- `detectAiMusic`이 스코어를 사용(boolean보다 정밀) + 심각도로 보정 range 스케일. `refineWithSpectrum`(live FFT 병합, 무신호 시 no-op).
- `shared-audio-graph.getActiveSpectrumSnapshot()`(active 메인 AnalyserNode dB/bin), `AiMusicPanel`이 라이브 스펙트럼으로 정밀화('스펙트럼 정밀' 배지 + '정밀 재검사' 버튼).
- **검증**: spectral(8 — 합성 metallic/aliased/harsh/natural) + score 규칙 + refine(5). **vitest 140/140**, 전체 그린(ALL FRESH), typecheck 0. 순수·boolean 경로 보존(무회귀).

## ✅ P3-3. 자동 장르 감지 + 아시아 레퍼런스 라이브러리

**커밋**: `feat(genre+ref): auto genre detection + Asian reference library (Phase 3)`

- **`ai-music-spectral`**: `spectralBandsDb`(7대역) + `tonalTilt`(mid 기준 상대 dB) — 두 기능 공유 피처.
- **`genre-detect.ts`**: 라우드니스 + 톤 틸트 센트로이드 룰분류 → top 장르 + 신뢰도 + 후보3 + 추천 `MasteringStyle` + 타겟 LUFS/LRA. 스펙트럼 없으면 라우드니스만으로 동작.
- **`reference-library.ts`**: 저작권 안전 아시아 fingerprint 10종(숫자 톤/라우드니스만 · 오디오·곡명 없음) KR/JP/ASIA×장르. `matchReferences`(최근접 랭킹 + region/genre 필터).
- **`GenreReferencePanel`**(ResultPage): 추정 장르·후보 표시 + 원클릭 '추천 모드 적용'(style+타겟 LUFS) + 가까운 레퍼런스 행 + per-ref '타겟 적용'. 라이브 FFT로 정밀화.
- **검증**: genre(5)+reference(4, 저작권안전 형태 포함)+패널(3). **vitest 152/152**, 전체 그린(ALL FRESH), typecheck 0. 순수·적용 전 무변경.

## ✅ P3-4. 스템 리밸런스 (근사 즉시 · Demucs/ONNX 정밀 추후)

**커밋**: `feat(rebalance): two-tier stem rebalance — live M/S approximation + ONNX-local skeleton (Phase 3)`

iZotope "Master Rebalance"를 대체하는 **2-티어** 스템 컨트롤. 백엔드(ONNX 로컬)는 사용자 결정.

- **근사 티어(지금 동작, ML 불필요)** — `rebalance-config.ts`(순수) + `rebalance-chain.ts`(WebAudio M/S):
  - `M=½(L+R), S=½(L−R)` → 미드 버스에 보컬 피킹(~1.6kHz)·베이스 로우셸프(120Hz), 사이드 폭 `sidePct/100`. unity(보컬0·베이스0·폭100%)에서 정확 패스스루 → idle 시 무착색(graph에서 splice-out).
  - `shared-audio-graph` rerouteBus에 `rebalance` 스테이지 prepend(rebalance→multiband→saturation→imagerMS) + `setRebalanceConfig`. `audioStore` rebalance 슬라이스 + ResultPage 네이티브 프리뷰 effect.
- **정밀 티어(opt-in, export, 추후)** — 백엔드-무관 `StemSeparator` 인터페이스 + `OnnxStemSeparator` 스켈레톤(`main/offline/stem-separation.ts`, 모델 없으면 `getStemSeparator()`→null → 근사로 graceful fallback). 순수 `remixStems`(0dB 합 = 원본 재구성, per-stem dB).
- **`StemRebalancePanel`**(ResultPage): 근사 슬라이더(보컬/베이스/공간, 라이브) + 정밀 per-stem 게인(`PRECISE_AVAILABLE=false`로 gate, "모델 필요" 배지).
- **설계 문서**: `docs/STEM_SEPARATION_PLAN.md` — ONNX 로컬(onnxruntime-node optionalDep · HT-Demucs ONNX · 다운로드-온-퍼스트유즈 · WOLA 윈도 추론) 아키텍처/체크리스트.
- **검증**: rebalance-config(7 — remix 가산성/sanitize/unity)+rebalance-chain(5 — M/S 매핑·정밀 비활성·dispose)+패널(3). **vitest 167/167**, typecheck 0(renderer+main). 적용 전 무변경(무회귀).

### 정직성/한계
- 근사 티어는 진짜 스템 분리가 아님(M/S 근사). 진짜 4스템 분리는 정밀 티어(ONNX Demucs)이며 모델 번들/다운로드·런타임 검증은 출시 전 청취 QA에서 확정(헤드리스 불가).
- 스켈레톤은 native 의존성 미포함 — import-safe, `isReady()`는 항상 false.

## ✅ P3-5. 스템 분리 정밀 티어 런타임 (ONNX Demucs)

**커밋**: `feat(rebalance): precise stem separation runtime — ONNX Demucs WOLA + model manager (Phase 3)`

정밀 티어의 **실제 런타임**을 전부 구현(헤드리스 검증 가능 부분 단위 테스트). 3개의 스위치만 OFF로 남기고 게이트.

- **`stem-inference.ts`**(순수): `planSegments`(오버랩 세그먼트), `hannWindow`, `overlapAddWeighted`(가중 WOLA — partition-of-unity 정확 재구성), `resampleLinear`. Demucs식 세그먼트 추론의 결정적 코어.
- **`stem-model-manager.ts`**: 핀 매니페스트(url+sha256+bytes·modelSampleRate) + userData 캐시 경로 + **download-on-first-use**(체크섬·크기 검증, 손상 시 거부). 모든 부수효과(fs/crypto/fetch) 주입형 → 헤드리스 테스트. 현재 매니페스트 placeholder(sha256 빈값) → `isModelConfigured()=false`.
- **`stem-separation.ts`**: 실제 `OnnxStemSeparator` — `onnxruntime-node` lazy `import`(런타임 조립 specifier, 부재 시 graceful), 세그먼트별 `[1,2,len]` 텐서 추론 → `[1,4,2,len]` 4스템 분해 → 스템·채널별 WOLA. `getStemSeparator()`는 매니페스트 미핀 시 null.
- **`precise-rebalance.ts`**: `applyPreciseRebalance` — 분리 → 모델레이트→렌더레이트 리샘플 → per-stem dB 재합. 비활성/모델없음 시 입력 그대로(applied=false, graceful fallback). separator 주입형.
- **연결**: `process-audio-file-rust`가 체인 직전에 정밀 리밸런스 적용 · `MasteringOptions.rebalance`(shared-types) · `audioHandlers`가 `app.getPath('userData')` 주입 · `MasteringPage`가 `isPreciseRebalanceActive`일 때만 옵션 첨부(아니면 옵션 무변경).
- **ON 스위치 3개**(전부 OFF): ① 매니페스트 핀(sha256), ② `onnxruntime-node` optionalDep+번들, ③ `PRECISE_AVAILABLE=true`. 상세 `docs/STEM_SEPARATION_PLAN.md`.
- **검증**: stem-inference(10)+model-manager(8)+separation(3)+precise-rebalance(5 — 0dB 원본재구성·+6dB 2배·리샘플·fallback). **vitest 193/193**, typecheck 0(renderer+main+shared-types). 무회귀(게이트 OFF·옵션 무변경).

### 정직성/한계
- 분리 **품질·실시간 동작**은 모델+onnxruntime-node+오디오 장치 필요 → 출시 전 청취 QA(헤드리스 불가). 단위 테스트는 파이프라인 정확성(가산 재구성·게인·리샘플·WOLA·캐시/체크섬)만 보장.
- 리샘플은 선형(1차) — 추후 폴리페이즈 업그레이드 가능(인터페이스 불변).
- 모델 미핀 상태라 현재 정밀 분리는 동작하지 않음(설계대로 근사 티어로 폴백).

## ✅ P3-6. 매니페스트 핀 인프라 + GitHub Release 경로

**커밋**: `feat(rebalance): pin-by-sidecar + ONNX export script + injectable runtime (Phase 3)`

핀을 "코드 수정 없는 1-command"로 만들고, GitHub Release 호스팅 경로 확정. **실제 sha256/bytes는 실 바이트에서 계산**(조작 불가).

- **사이드카 매니페스트**: `userData/models/stem-model.manifest.json`이 placeholder를 런타임 오버라이드. `parseManifest`(타입·64-hex·경로traversal·rate 검증, 빈 sha256=미핀 허용), 문제 시 폴백(나쁜 사이드카가 앱을 안 깨뜨림). `getStemSeparator`가 사이드카 resolve → 리빌드 없이 활성화.
- **`pnpm pin:stem-model`**(`pin-stem-model.mjs`): 로컬 .onnx 해시 또는 URL 다운로드+해시 → sha256/bytes/segmentSamples 기록한 사이드카 작성. 스모크 테스트(해시=sha256sum 일치).
- **고정 세그먼트 지원**: 매니페스트 `segmentSamples`(Demucs 기본=고정). 런타임이 세그먼트를 zero-pad → 출력 crop. **주입형 런타임(OnnxDeps)**으로 fake ort 기반 **추론 루프 전체(세그먼트·패딩·scatter·crop·WOLA)를 헤드리스 검증** — fake 모델이 mix/4×4스템 반환 → 가산 합이 원본 mix 재구성.
- **`export-demucs-onnx.py`**: 메인테이너용 HT-Demucs→ONNX export(torch+demucs 필요, CI 미실행·앱 비import). `mix[1,2,seg]→stems[1,4,2,seg]` 계약·`segment_samples` 출력.
- **GitHub Release 경로 확정**: 태그 `stem-model-v1` 자산 → 결정적 URL. export→`gh release upload`→`pin:stem-model`→publish 런북(`docs/STEM_SEPARATION_PLAN.md`).
- **검증**: +18(model-manager 사이드카 7·separation 추론루프 4·기존). **vitest 204/204**, typecheck 0.

### 정직성/한계 (추가)
- 이 환경에선 Demucs 가중치 호스트(HuggingFace·`dl.fbaipublicfiles.com`) **HTTP 403 차단** + torch 미설치 → 실제 .onnx export/획득 불가. 그래서 sha256/url을 지어내지 않고 **핀 도구**로 전환(가중치 접근 가능한 머신에서 1-command).
- GitHub MCP에 release 생성 도구 없음 + `gh`/API 미가용 → **Release 생성은 메인테이너 수동**(런북 제공).

## ✅ P3-7 (P2-a). 마스터링 이력 (durable · 세션간 영속)

**커밋**: `feat(history): durable cross-session mastering history (P2)`

메모리에만 있던 revisions를 넘어, 과거 마스터(설정 스냅샷+측정값)를 **재시작 후에도** 보존하는 영속 라이브러리.

- **`mastering-history.ts`**(순수): `MasteringHistory{version,entries}` + `HistoryEntry`(옵션 스냅샷·LUFS/TP/LRA·소스·시각·즐겨찾기). `addEntry`(prepend), `pruneHistory`(HISTORY_MAX=100 cap, **즐겨찾기는 cap 넘겨도 보존**), remove/rename/toggleFavorite(불변), `serialize`/`deserialize`(버전드·검증 — 잘못된 버전/엔트리 드롭, 손상 blob→빈 이력, 앱 안 깨짐).
- **메인 영속**(`historyHandlers.ts`): electron-store `mastering-history`. 렌더러가 스키마 소유, 메인은 **검증된 바운디드 blob 저장소**(plain object·JSON 직렬화·2MB cap). `history:get`/`history:set` IPC + preload 화이트리스트.
- **렌더러**: audioStore `history` 슬라이스 — `hydrateHistory`(App 마운트 1회 로드), `pushHistoryEntry`(마스터 완료 시 자동 기록 + write-through), remove/rename/toggleFavorite/`restoreHistoryEntry`(설정 스냅샷→활성 옵션). 영속은 best-effort(throw 안 함, jsdom/무API 안전).
- **연결**: MasteringPage 마스터 완료 시점에 자동 기록(소스·옵션·측정값·포맷).
- **`MasteringHistoryPanel`**(ResultPage): 최신순+즐겨찾기 상단, 행별 측정값·설정 요약·`설정 복원`·★·이름변경·삭제.
- **검증**: history(8 — prune 즐겨찾기 보존·직렬화 라운드트립·손상 폴백)+패널(5 — 복원/즐겨찾기/삭제). **vitest 217/217**, typecheck 0(renderer+main+shared-types). 무회귀(추가적·기록 전 무변경).

### 정직성/한계
- 마스터 WAV/MP3는 temp(세션간 purge)라 **오디오는 보관 안 함** — 이력은 "무엇을 했는지 + 설정 복원해 재마스터". 엔트리는 파일 존재에 의존하지 않음.
- 영속은 best-effort(디스크/IPC 실패 시 무시) — UX 보조이지 손실 불가 데이터 아님.

## ✅ P3-8 (P2-b). 구간별 마스터링 (per-section 게인 자동화)

**커밋**: `feat(section): per-section gain automation on export (P2)`

"코러스 올리고 브릿지 누르기" — 구간 타임라인(벌스/코러스…)별 게인을 익스포트 시 **시변 게인 엔벨로프**로 적용.

- **`section-mastering.ts`**(메인, 순수): `synthesizeGainEnvelope`(구간 시간범위→per-sample 선형 게인, 경계는 **raised-cosine 크로스페이드**로 연속, 구간 밖은 unity), `applyGainEnvelope`(샘플별 곱), `applySectionPlan`(unity면 no-op), `sanitizeSectionPlan`/`isSectionPlanUnity`. 완전 헤드리스 테스트.
- **렌더 연결**: `process-audio-file-rust`가 체인 **직전**에 적용(컴프/리미터/loudnorm이 구간을 자연 결합) · `MasteringOptions.sectionPlan`(shared-types) · `audioHandlers`가 enabled일 때만 전달.
- **렌더러 모델**(`section-plan.ts`): `buildSectionPlanFromAnalysis`(검출 구간→0dB 게인, **기존 게인 보존**), `setSectionGain`(±12dB clamp), sanitize/isUnity.
- **`SectionMasteringPanel`**(ResultPage): `masteringResult.sectionAnalysis.sections` 미러 → 구간별 게인 슬라이더 + 사용 토글. 정밀 티어처럼 **익스포트 전용**(라이브 프리뷰 무변경).
- **MasteringPage**: `isSectionPlanUnity` 아닐 때만 옵션 첨부(아니면 무변경).
- **검증**: section-mastering(10 — 엔벨로프 연속성·경계 ramp·적용·sanitize)+section-plan(8)+패널(4). **vitest 239/239**, typecheck 0(renderer+main+shared-types). 무회귀.

### 정직성/한계
- **게인 자동화**이지 풀 체인의 per-section 재마스터가 아님(체인 내부 stateful 다이내믹스는 구간 분할 불가). 가장 tractable·결정적·헤드리스 검증 가능한 코어.
- 익스포트 전용(라이브 프리뷰엔 미반영) — 정밀 리밸런스 정밀 티어와 동일 패턴.
- 청취 품질(경계 자연스러움)은 실 오디오/장치 필요 → 출시 전 QA. 단위테스트는 엔벨로프 수학(연속성·게인·경계)만 보장.

## ✅ P3-9 (P2-c). 멀티-보컬 → 보컬 라이딩

**커밋**: `feat(vocal): automatic vocal level riding on export (P2)`

멀티-보컬 스코프를 단일 스테레오 마스터에 맞게 **보컬 라이딩**(센터 보컬 레벨 자동 라이딩)으로 확정·구현. 익스포트 전용·M/S 센터만.

- **`vocal-riding.ts`**(메인, 순수): `vocalBandEnvelope`(센터의 프레즌스 대역 ~200–5kHz를 one-pole 밴드패스+정류+스무딩 → 레벨 엔벨로프), `computeRidingGain`(트랙 중앙값 기준 레벨로 끌어올리는 per-sample 게인, `amount` 스케일·±maxBoost/Cut clamp·responseMs 스무딩, 무음은 unity로), `applyVocalRiding`(M/S 분해 → 미드만 라이딩 → 재합, **사이드 정확 보존** L′−R′=L−R), sanitize/isUnity.
- **렌더 연결**: `process-audio-file-rust`가 구간 게인 다음·체인 직전 적용 · `MasteringOptions.vocalRiding`(shared-types) · `audioHandlers` enabled 시만 전달.
- **렌더러**(`vocal-riding-config.ts` + audioStore 슬라이스 + `VocalRidingPanel`): 강도/최대부스트/최대컷/반응 슬라이더 + 사용 토글. 익스포트 전용(라이브 프리뷰 무변경). MasteringPage는 non-unity일 때만 첨부.
- **검증**: vocal-riding(9 — 인밴드 엔벨로프>서브베이스·부스트/컷 방향·clamp·게인 스무딩·**사이드 보존**·레벨 평준화·sanitize)+패널(4). **vitest 252/252**, typecheck 0(renderer+main+shared-types). 무회귀.

### 정직성/한계
- **센터 대역 레벨 라이더**이지 분리된 보컬 처리(=게이트된 ONNX 보컬 스템)가 아님. 센터에 보컬이 지배적이라는 가정 — 센터의 비보컬(킥/스네어)도 일부 영향. 가장 tractable·결정적·헤드리스 검증 가능.
- 익스포트 전용. 라이딩 자연스러움/펌핑 여부는 실 오디오/장치 QA 필요 → 단위테스트는 DSP 수학(방향·clamp·연속성·M/S 보존)만 보장.

## 🟡 남은 Phase 3 후보

| 항목 | 우선순위 | 비고 |
|------|:--------:|------|
| 정밀 티어 ON(모델 export·핀·번들) | 출시 전 | 런타임 완료 → 스위치 3개만 남음 |
| ~~마스터링 이력 / 구간별 / 멀티-보컬~~ | ✅ | P3-7/8/9 완료 — **P2 전부 완료** |
| ~~마스터링 이력~~ | ✅ | P3-7 (durable) |
| ~~구간별 마스터링~~ | ✅ | P3-8 (per-section 게인, export) |
