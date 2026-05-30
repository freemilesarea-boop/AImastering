# 02 — 문제점 전수 리스트

> 우선순위:
> - **P0** = 상업 출시 차단 (배포 시 사용자/법무/품질 실제 피해)
> - **P1** = 출시 후 짧은 시간 내 클레임 / 환불 사유
> - **P2** = 품질·UX 격차 (경쟁사 대비)
> - **P3** = 기술 부채 / 향후 확장 차단

---

## A. 구조적 문제

| ID | 우선순위 | 항목 | 위치 | 영향 |
|---|---|---|---|---|
| A1 | **P0** | Python 오프라인 엔진과 TS 런타임 DSP 의 **출력 동일성 미보장** | `services/python-audio/app/mastering/` vs `apps/desktop/src/renderer/audio/` | 사용자가 미리듣기에서 들은 소리 ≠ 최종 마스터. 환불 사유. |
| A2 | P0 | DSP 가 FFmpeg 서브프로세스 7~9회 spawn 에 의존 | `pipeline.py` 전반, `audio-engine/ffmpeg/runner.ts` | 1곡 10~40초 처리. 실시간 미리듣기 불가. CPU/디스크 부하. |
| A3 | P0 | Python 서비스가 **시스템 Python 의존** | `setup-python.sh`, 번들에 미포함 | 사용자가 Python/pip 환경 직접 구성. 설치 실패 다수. |
| A4 | P1 | shared-types 1개 파일 800줄 — 모든 도메인 혼재 | `packages/shared-types/src/index.ts` | 변경 시 전 영역 재빌드. 도메인별 분리 필요. |
| A5 | P1 | `appStore.currentPage` 가 라우터 대체 — 깊은 네비/딥링크 불가 | `apps/desktop/src/renderer/store/appStore.ts` | 결과 페이지 공유/북마크 불가. 미래 웹 버전 어려움. |
| A6 | P2 | 리포 루트와 `aimaster-desktop/` 가 공존 (legacy + active) | 루트 `src/`, `python/` | 신규 기여자 혼란. legacy import 사고 가능. |
| A7 | P2 | 브랜드 문자열 하드코드 (`AIMASTER`, `루베르`) | 8+ 위치 | Loui Mastering 리브랜드 시 일괄 처리 필요. 단일 토큰 부재. |
| A8 | P3 | 별도 E2E (Playwright) 없음 | — | UI 회귀 자동 검출 불가. |
| A9 | P3 | DSP 회귀 테스트 (참조 출력 매칭) 없음 | — | DSP 변경의 음질 영향 자동 검출 불가. |

---

## B. DSP / 오디오 품질 문제

| ID | 우선순위 | 항목 | 위치 | 영향 |
|---|---|---|---|---|
| B1 | **P0** | **dither 미구현** (16비트 출력 시) | (검색 안 잡힘) | 16-bit WAV 마스터에서 양자화 노이즈 가청 — 상업 마스터 품질 미달 |
| B2 | **P0** | **oversampling 미구현** (True-Peak 측정/제어) | `truePeak.ts`, ISP 측은 사후 검사만 | True-Peak 정확도 ITU-R BS.1770-4 기준 미달. -1 dBTP 보장 약함 |
| B3 | **P0** | `loud` / `kpop_loud` 모드는 **loudnorm 2-pass 우회**, 정적 volume + alimiter | `pipeline.py` Stage 5 | LUFS 목표 정확도 ±0.5 LU 보장 안 됨 |
| B4 | P1 | Iterative reference matching 종료조건 90% 일치 / max 3회 — **수렴 보장 없음** | `iterative.py` | 일부 입력에서 매칭 결과 비결정적 |
| B5 | P1 | EQ / Comp / Limiter 가 모두 **FFmpeg 필터 문자열로 적용** — 정밀 IIR 계수 미노출 | `pipeline.py`, `dynamics.py` | 같은 입력 다른 FFmpeg 빌드 = 다른 출력. 재현성 약함 |
| B6 | P1 | Vocal protection 이 **하드 클램프** (ratio<=2.0, attack>=25ms) | `vocal_protection.py` | 모드별 의도와 충돌 가능 (`loud` 모드에서도 같은 한도 적용) |
| B7 | P2 | 풀버퍼 메모리 로드 (`soundfile.read` 전체) | `audio_io.py` | 10분 이상 트랙에서 RAM 1GB 초과 가능 |
| B8 | P2 | 샘플레이트 변환 시 **명시적 SRC 알고리즘 미지정** | FFmpeg 기본 `swr` | 음질 변동 가능 (특히 비표준 SR → 44.1k) |
| B9 | P2 | TS DSP `transientProtection`, `softClip`, `vocalEnhancer` 등은 작성됐으나 **UI에서 모드 선택만으로 일괄 적용** | `masteringModes.ts` | 사용자 수동 조절 불가능 (Ozone 격차) |
| B10 | P3 | LUFS 측정의 **gating** 구현 명시성 부족 (FFmpeg `loudnorm` 의존) | — | BS.1770-4 의 -70 LUFS / -10 LU relative gate 구현체 확인 필요 |
| B11 | P3 | Stereo 처리 / 모노 처리 분기에 **mid-side EQ 부재** | `multiband.py` | 현대 마스터링 필수 기능 누락 |

---

## C. UI / UX 문제

| ID | 우선순위 | 항목 | 위치 | 영향 |
|---|---|---|---|---|
| C1 | **P0** | UI 가 **블랙박스** (5개 프리셋만 선택) | 모든 페이지 | "Ozone 스타일 모듈형" 목표와 정반대 |
| C2 | **P0** | 실시간 **스펙트럼 / FFT** 시각화 부재 (`AnalyserNode` 미사용) | `apps/desktop/src/renderer/audio/` | 모듈형 마스터링의 기본 시각화 부재 |
| C3 | P1 | **GR (gain reduction) 표시** 부재 | — | 컴프/리미터 동작 가시화 안 됨 — 신뢰 형성 어려움 |
| C4 | P1 | **EQ 곡선 에디터** 부재 | — | 수동 EQ 조작 UI 없음 |
| C5 | P1 | 파형이 **정적 PNG** (Python `showwavespic`) — 줌/스크럽/마커 불가 | `waveform_image.py`, ResultPage | 상용 UX 미달 |
| C6 | P1 | **사용자 추가 입력** (vocal track 별도 업로드 / 사이드체인) 부재 | — | 마스터링 디테일 부족 |
| C7 | P2 | LicenseModal / SmartRecommendation / AIArtifactWarning 이 **사문/스텁** | dead code | UI 코드 노이즈 |
| C8 | P2 | **단축키** (스페이스=재생, A/B=비교) 외 미구현 | `abPlayer.ts` | 프로 워크플로 미흡 |
| C9 | P2 | **언두/리두** 부재 (파라미터 변경 히스토리 없음) | — | 시도-비교 워크플로 어려움 |
| C10 | P2 | 한국어/영어 i18n 부재 (한국어 하드코드) | 전체 UI | 해외 시장 진입 차단 |
| C11 | P3 | 다크/라이트 테마 분리 부재 (다크만) | tailwind config | 사용자 선택권 없음 |
| C12 | P3 | 접근성 (a11y) 미검증 — 키보드 포커스, ARIA, 명도 대비 | 전반 | — |

---

## D. 비동작 / 미완성 기능

| ID | 우선순위 | 항목 | 위치 | 상태 |
|---|---|---|---|---|
| D1 | **P0** | 라이선스 게이트 비활성화 (`v3.6 RC field test`) | `src/main/index.ts:11` | 출시 시 반드시 재활성 |
| D2 | **P0** | RemoteValidator (서버 검증) 미구현 — 인터페이스만 | `packages/license-core/` | 키 도용/공유 방어 불가 |
| D3 | P1 | `tonal_budget.py` (148줄) — 파이프라인 호출 경로 미확인 | `app/mastering/tonal_budget.py` | dead code 가능성 |
| D4 | P1 | `voice_clarity.py` — README/spec 에 언급되나 코드 검색 안 잡힘 | — | 문서 ↔ 코드 불일치 |
| D5 | P1 | Phase-D 필드 (SectionAnalysis, AIArtifactCheck, VocalIntelligence, TranslationCheck, ModeSuggestion) — `MasteringResult.optional` | `shared-types/index.ts` | 일부만 생성/소비. 일관성 없음 |
| D6 | P2 | SmartRecommendationPanel 스텁 | UI | 표시되어도 의미 없음 |
| D7 | P2 | UpdateToast / electron-updater 가 macOS 사이닝 없이 작동 안 함 | `main/index.ts`, `electron-builder.yml` | macOS 사용자 업데이트 불가 |
| D8 | P3 | Phase-D 의 ModeSuggestion 이 현재 모드 ≠ 추천 시에만 표시 — UX 불일치 가능 | `SectionAnalysisPanel.tsx` | 사용자 피드백 분기 부족 |

---

## E. 상업 출시 차단 / 운영

| ID | 우선순위 | 항목 | 위치 | 영향 |
|---|---|---|---|---|
| E1 | **P0** | macOS 코드 사이닝 / 노타라이즈 미완 | `electron-builder.yml` | macOS Gatekeeper 차단. 사용자 설치 실패 |
| E2 | **P0** | Windows EV 코드 사이닝 미구성 | — | SmartScreen 경고 |
| E3 | **P0** | Python 미번들 → 사용자 설치 마찰 (Python 설치 / pip / venv) | `setup-python.sh` | 비기술 사용자 차단 |
| E4 | **P0** | 라이선스 키 발급/검증/취소 서버 인프라 부재 | — | 결제 후 키 관리 불가 |
| E5 | P1 | 결제 시스템 (Stripe / Paddle) 통합 부재 | — | 영업 불가 |
| E6 | P1 | 약관 / 개인정보 / 환불 정책 / EULA 부재 | — | 법무 리스크 |
| E7 | P1 | 에러 텔레메트리 / 크래시 리포트 (Sentry 등) 부재 | — | 사후 문제 추적 불가 |
| E8 | P1 | 사용 통계 (옵트인) 부재 | — | 어떤 모드/장르가 쓰이는지 미관측 |
| E9 | P2 | 자동 업데이트 채널 분리 (stable/beta) 부재 | `electron-builder.yml` | 점진 배포 불가 |
| E10 | P2 | 다국어 (영/일/한) 패키지 부재 | UI 전반 | 해외 출시 차단 |
| E11 | P3 | CHANGELOG / SemVer 정책 문서화 부족 | docs | 사용자 변경 추적 불가 |
| E12 | P3 | 지원 (이메일 / FAQ / 디버그 번들 업로드) 채널 부재 | `export_debug_bundle` 만 존재 | 사용자 자체 송부에 의존 |

---

## F. 성능 / 자원

| ID | 우선순위 | 항목 | 위치 | 영향 |
|---|---|---|---|---|
| F1 | P1 | 1곡 처리 10~40초 (3분 트랙 기준) | `pipeline.py` | 배치 20곡 = 5~13분. 경쟁사 (Ozone 등 오프라인 모드) 대비 2~5배 |
| F2 | P1 | 메모리 풀버퍼 로드 | `audio_io.py` | 10분+ 트랙에서 1GB+ RAM |
| F3 | P2 | TS DSP 미리듣기와 Python 최종 렌더 사이 **재작업** (preset 변경 시) | UI 흐름 | UX 지연 |
| F4 | P3 | Iterative matching 시 디스크 임시 파일 다수 생성 | `iterative.py` | SSD 마모 / 디스크 풀 위험 |

---

## G. 보안 / 안정성

| ID | 우선순위 | 항목 | 위치 | 영향 |
|---|---|---|---|---|
| G1 | P1 | 임시 파일이 OS temp 에 평문 저장 | Python pipeline 전반 | 미사용자 PC 에서 마스터 사본 잔존 가능 |
| G2 | P1 | FFmpeg subprocess 입력 경로 escape 검증 — 사용자 입력 경로 직접 전달 | `ffmpeg/runner.ts`, `ffmpeg_wrapper.py` | 경로에 공백/특수문자 시 실패. 인젝션 표면 (낮음) |
| G3 | P2 | electron-store (license) 의 암호화 키가 빌드 시점에 박힘 | `license-core` | 단일 빌드 키 노출 시 모든 사용자 영향 |
| G4 | P2 | Auto-update 가 GitHub Releases 직접 다운로드 — 사설 배포 시 토큰 관리 필요 | `main/index.ts` | 배포 채널 유연성 ↓ |
| G5 | P3 | preload `contextIsolation` / `nodeIntegration` 설정 검증 필요 | `main/index.ts` | Electron 보안 베스트프랙티스 확인 |

---

## H. 문서 / 진실성

| ID | 우선순위 | 항목 | 위치 | 영향 |
|---|---|---|---|---|
| H1 | P1 | README 에 표기된 "Pro 무제한" 기능과 실제 코드의 license 게이트 비활성 상태 불일치 | `README.md` vs `licenseHandlers.ts` | 사용자 기대 misalignment |
| H2 | P1 | MASTERING_SPEC.md / ARCHITECTURE.md 가 코드와 부분 불일치 (예: voice_clarity 언급) | docs | 신규 기여자 혼란 |
| H3 | P2 | ROADMAP_BEYOND_OZONE.md 가 v3.4 시점 기록 — 현재 격차 미반영 | `docs/ROADMAP_BEYOND_OZONE.md` | 의사결정 자료로 부적합 |
| H4 | P3 | 한국어/영어 문서 혼재 | docs | — |

---

## 종합

| 우선순위 | 항목 수 |
|---|---|
| **P0 (출시 차단)** | **13** |
| P1 | 21 |
| P2 | 19 |
| P3 | 14 |

**P0 13건 중 진짜로 "치명적" 인 9건**은 `10-RELEASE-BLOCKERS.md` 에 추출됨.
