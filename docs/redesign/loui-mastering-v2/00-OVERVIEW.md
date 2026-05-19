# Loui Mastering v2 — 재설계 마스터 문서

> 본 문서는 현재 `AImastering v3.6.0-rc.1` 코드베이스 전수 감사에 기반하여
> **상업용 출시 등급의 Ozone 스타일 모듈형 마스터링 시스템** 재설계 계획을 정리한다.
> 임시 패치/리팩터링이 아닌 **구조적 재설계 (v2)** 를 전제로 작성됨.

---

## 결론 요약 (TL;DR)

| 항목 | 현재 (v3.6 RC) | 재설계 (v2 / Loui Mastering) |
|---|---|---|
| 브랜드 | AImastering / 루베르 워터마크 | **Loui Mastering** (통합 브랜드 토큰) |
| 처리 모델 | Python 오프라인 일괄 처리 (Electron 서브프로세스) | **실시간 코어 (TS DSP)** + 오프라인 렌더 (네이티브 코어) 듀얼 |
| UI 모델 | 5개 프리셋 블랙박스 | **모듈형** (EQ / Dynamics / Limiter / Imager / Reference) + 프리셋 |
| 시각화 | 정적 PNG 파형 + LUFS 미터 | **실시간 스펙트럼 + GR 표시 + 동적 EQ 곡선 + AB 즉시 비교** |
| DSP 위치 | Python (FFmpeg 서브프로세스 7~9회/곡) + TS DSP 3,641줄 (분리/미노출) | 단일 DSP 코어 1세트 (Rust/C++) 를 WASM + 네이티브로 공유 |
| 라우드니스 정확도 | FFmpeg `loudnorm` (2-pass) | 사내 BS.1770-4 분석기 + ISP True-Peak (실시간 / 오프라인 일치) |
| 프리셋 | 하드코드 7종 | **DSP State JSON v1** — 모듈 그래프 직렬화 + 버저닝 + 사용자/스튜디오/마켓플레이스 계층 |
| 라이선스 | LocalValidator 만 동작 / `--no-gate` | 서버 검증 + 머신 바인딩 + HMAC 서명 키 |
| Critical 출시 차단 항목 | **9건** (10번 문서 참조) | — |

---

## 핵심 발견 (Critical Findings)

1. **이중 DSP 시스템이 이미 존재한다.**
   - Python 엔진 (`services/python-audio/app/`, 4,799줄) — 최종 렌더용
   - TypeScript DSP 런타임 (`apps/desktop/src/renderer/audio/`, 3,641줄) — 미리듣기/AB/메터링용
   - **두 시스템의 출력이 같다는 보장이 없다** (검증 테스트 부재). 이것이 v2 의 최우선 통합 대상.

2. **UI 가 블랙박스다.**
   - 사용자는 5개 모드 (Clean/Balanced/Loud/Warm/Bright) 중 하나를 고를 뿐, 어느 모듈도 노출되지 않음.
   - 그러나 백엔드에는 EQ, Dynamic EQ, Multiband, Glue Comp, 3-stage Limiter, ISP, Vocal Protection, Reference Matching 이 모두 구현되어 있음.
   - → **이미 구현된 모듈을 노출시키는 것이 v2 의 절반.**

3. **FFmpeg 서브프로세스 의존이 너무 깊다.**
   - 한 곡 처리당 FFmpeg 7~9회 spawn (loudnorm pass1, EQ chain, comp chain, loudnorm pass2, limiter, ISP, preview MP3 등)
   - 각 spawn 500ms~2s — 짧은 트랙도 5~15초 소요, **실시간/근실시간 미리듣기 불가**.
   - 이 부분이 Rust/C++ 마이그레이션의 최우선 타깃.

4. **상업용 차단 항목이 명확히 존재한다.**
   - macOS 노타라이즈 미완료 (auto-update 불가)
   - 라이선스 게이트 비활성화 (`v3.6 RC field test`)
   - dither / oversampling 미구현 (16비트 마스터 품질 한계)
   - Python 서비스가 PyInstaller 번들이 아니라 시스템 Python 의존
   - 상세 → `10-RELEASE-BLOCKERS.md`

---

## 문서 구성

| # | 파일 | 내용 |
|---|---|---|
| 00 | `00-OVERVIEW.md` | 본 문서 — 마스터 인덱스 |
| 01 | `01-CURRENT-ARCHITECTURE.md` | 현재 구조 정밀 분석 (전체 / 엔진 / DSP 흐름 / CPU) |
| 02 | `02-PROBLEM-INVENTORY.md` | 문제점 전수 리스트 (동작/품질/UX/구조/상업적) |
| 03 | `03-DSP-ARCHITECTURE.md` | DSP 구조도 (현재 → 목표) |
| 04 | `04-UI-ARCHITECTURE.md` | UI 구조도 (현재 → 목표) |
| 05 | `05-TARGET-ARCHITECTURE.md` | 추천 아키텍처 (Loui Mastering v2) |
| 06 | `06-MODULE-SEPARATION-PLAN.md` | 모듈 분리 계획 (코어/UI/엔진/라이선스/플러그인) |
| 07 | `07-REALTIME-ANALYSIS-DESIGN.md` | 실시간 분석 시스템 설계 |
| 08 | `08-PRESET-SYSTEM-DESIGN.md` | 프리셋 시스템 설계 (DSP State JSON v1) |
| 09 | `09-RUST-CPP-MIGRATION-PLAN.md` | Rust/C++ 전환 필요 영역 분석 |
| 10 | `10-RELEASE-BLOCKERS.md` | 상업용 출시 전 반드시 해결해야 하는 치명적 문제 |

---

## 분석 범위 / 비범위

**범위:**
- `/home/user/AImastering/aimaster-desktop/` (활성 코드베이스 전체)
- `/home/user/AImastering/docs/` (기존 설계 문서)
- 최근 3개월 git 활동 (Phase-D / Phase-E / v3.6 RC)

**비범위:**
- `/home/user/AImastering/src/`, `/home/user/AImastering/python/` (legacy, `python/LEGACY.md` 기준 freeze)
- 외부 마스터링 알고리즘 비교 (별도 R&D 트랙)

---

## 작성자 노트

본 문서들은 **실제 코드를 읽고** 작성된 감사 결과이며, README/PRD/MASTERING_SPEC 의 기존 진술과 코드 사이의 불일치도 함께 지적한다.
임시 수정 (e.g. "그냥 EQ 슬라이더 하나 더 붙이기") 으로는 상업용 등급의 일관성을 만들 수 없다는 전제로 작성됨.
