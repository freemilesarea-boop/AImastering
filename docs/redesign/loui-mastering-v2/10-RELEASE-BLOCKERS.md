# 10 — 상업용 출시 전 반드시 해결해야 하는 치명적 문제

> `02-PROBLEM-INVENTORY.md` 의 P0 13건 중,
> **출시 시점에 해결되지 않으면 사용자/법무/품질의 실질적 피해가 발생하는 9건** 만 추출.
> 나머지 P0 는 일정 이슈로 분류해 마이그레이션 트랙으로.

---

## ★ 치명적 출시 차단 항목 (9건)

### B1 — Python ↔ TS DSP 출력 동일성 미보장

| 항목 | 내용 |
|---|---|
| **현상** | `services/python-audio` 와 `apps/desktop/src/renderer/audio` 가 별도의 DSP 구현을 갖고 있으며, 사용자가 미리듣기에서 들은 소리와 최종 렌더가 같다는 자동 검증이 없음. |
| **영향** | 사용자가 "들었던 그 소리" 가 결과물과 다르면 즉시 환불 사유. 신뢰 붕괴. |
| **위치** | `pipeline.py` (전체) ↔ `apps/desktop/src/renderer/audio/masteringModes.ts` 등 |
| **해결 (v2)** | dsp-core 단일 구현으로 통합 (`09-RUST-CPP-MIGRATION-PLAN.md`) + 골든 회귀 의무 |
| **출시 차단 등급** | **🔴 BLOCKER** |
| **임시 우회 (출시 강행 시)** | 미리듣기에서 항상 "최종 결과는 다를 수 있습니다" 명시 — UX 불성실. 권장 안 함. |

---

### B2 — Dither 미구현 (16비트 출력 품질)

| 항목 | 내용 |
|---|---|
| **현상** | 24→16비트 변환 시 dither (TPDF 등) 적용 없음. 양자화 잡음 가청. |
| **영향** | 16비트 마스터 (CD/스트리밍 일부) 품질이 경쟁사 대비 명백히 떨어짐. 전문 사용자에게 즉시 들킴. |
| **위치** | FFmpeg 의 default 의존 (디더 없음 또는 미지정) |
| **해결 (v2)** | dsp-core 에 TPDF + Pow-r 1-3 디더 모듈 (M2) |
| **출시 차단 등급** | **🔴 BLOCKER** (16비트 출력 옵션 있는 한) |
| **임시 우회** | 16비트 출력 비활성화 → 24비트만 제공. 일시적 가능. |

---

### B3 — Oversampling 미구현 (True-Peak 정확도)

| 항목 | 내용 |
|---|---|
| **현상** | True-Peak 측정/제어가 4×/8× 오버샘플링 없이 1× 측정만 사용. ITU-R BS.1770-4 의 True-Peak 정의 미충족. |
| **영향** | "-1 dBTP 보장" 클레임이 거짓. 일부 입력에서 디코딩 시 ISP 가 0 dB 초과. 플랫폼 자체 정규화에서 추가 감쇠 발생 → 음량 손실. |
| **위치** | `apps/desktop/src/renderer/audio/truePeak.ts` (부분), Python pipeline 의 alimiter (1×) |
| **해결 (v2)** | dsp-core 의 limiter 가 4× oversample 표준, 오프라인 8/16× 옵션 |
| **출시 차단 등급** | **🔴 BLOCKER** (-1 dBTP 보장 마케팅 클레임 유지하려면) |
| **임시 우회** | 안전 마진 -1.5 dBTP 로 변경. 마케팅 표현 수정. |

---

### B4 — Python 시스템 의존 (PyInstaller 번들 부재)

| 항목 | 내용 |
|---|---|
| **현상** | Python 서비스가 시스템 Python 에 의존. 설치 가이드 (`setup-python.sh`) 가 일반 사용자에게 진입 장벽. |
| **영향** | 사용자 환경에 Python/pip/venv 가 없으면 설치 실패. 비기술 사용자 (마스터링 앱의 메인 타겟) 의 절반 이상이 차단. |
| **위치** | `scripts/setup-python.sh`, `aimaster-desktop/scripts/` (PyInstaller 미사용) |
| **해결 (v2)** | DSP 가 Rust 로 이전되면 Python 의존 자체 제거. M5 까지. |
| **임시 우회 (v3 출시 강행 시)** | PyInstaller 로 `python-audio` 를 단일 바이너리로 번들 + electron-builder extraResources 에 포함. **이 우회를 출시 전 반드시 적용 필요.** |
| **출시 차단 등급** | **🔴 BLOCKER** |

---

### B5 — macOS 코드 사이닝 / 노타라이즈 미완

| 항목 | 내용 |
|---|---|
| **현상** | `electron-builder.yml` 에 `hardenedRuntime: true` 만 설정. `CSC_LINK`, `CSC_KEY_PASSWORD`, `notarytool` 자격 증명 CI 미주입. |
| **영향** | macOS Gatekeeper 가 앱 차단. 사용자가 우회 경로 (System Settings → Privacy → "Open Anyway") 를 알아야 함. 자동 업데이트 또한 거부됨. |
| **위치** | `aimaster-desktop/apps/desktop/electron-builder.yml` |
| **해결** | Apple Developer ID 인증서 발급 → CSC_LINK/PASS 환경변수 → notarytool credentials → CI integration |
| **출시 차단 등급** | **🔴 BLOCKER** |
| **소요** | 인증서 발급 ~1주, CI 통합 ~3일 |

---

### B6 — Windows EV 코드 사이닝 미구성

| 항목 | 내용 |
|---|---|
| **현상** | NSIS 인스톨러에 EV (Extended Validation) 또는 표준 코드 사이닝 미적용. |
| **영향** | Microsoft SmartScreen 이 "알 수 없는 게시자" 경고. 다수 사용자 차단. |
| **위치** | `electron-builder.yml` win 섹션 |
| **해결** | EV 인증서 (USB HSM) 또는 Azure Trusted Signing |
| **출시 차단 등급** | **🟠 HIGH** (EV 없이도 출시는 가능, SmartScreen 평판 누적까지 1~3개월) |
| **소요** | EV 인증서 발급 + HSM 셋업 ~2주 |

---

### B7 — 라이선스 게이트 비활성화 + RemoteValidator 부재

| 항목 | 내용 |
|---|---|
| **현상** | `v3.6 RC field test` 를 위해 라이선스 게이트가 비활성화 (`b44a24f` 커밋). RemoteValidator 가 인터페이스만 존재하고 서버 측 미구현. |
| **영향** | 결제 시스템과 통합 불가. 키 도용/공유 무방비. Pro 기능 무료 노출. |
| **위치** | `src/main/index.ts:11`, `packages/license-core/` |
| **해결** | 1) 라이선스 게이트 재활성 — 1일 / 2) RemoteValidator + 서버 (`services/license-server`) — 2주 / 3) 결제 (Stripe) 통합 — 1주 |
| **출시 차단 등급** | **🔴 BLOCKER** |
| **임시 우회** | 베타 무료 출시 (라이선스 없이) → 정식 출시 시 라이선스 의무화. 마케팅적으로 받아들여질 수 있는지 별도 결정 필요. |

---

### B8 — 약관 / 개인정보 / 환불 정책 / EULA 부재

| 항목 | 내용 |
|---|---|
| **현상** | 사용자가 동의해야 할 EULA / 개인정보처리방침 / 환불정책 / 데이터 처리 동의 화면이 없음. |
| **영향** | 한국 (전자상거래법, 개인정보보호법), EU (GDPR), 미국 (CCPA) 등 모든 주요 시장에서 위법. 결제 처리사 (Stripe) 가 약관 누락으로 가입 거부 가능. |
| **위치** | UI / 설치 플로우 / 결제 페이지 |
| **해결** | 법무 검토된 4문서 작성 + 동의 UI (설치 시 / 첫 실행 시 / 결제 시) |
| **출시 차단 등급** | **🔴 BLOCKER** |
| **소요** | 법무 검토 ~2주 + 구현 ~3일 |

---

### B9 — 크래시 / 에러 텔레메트리 (Sentry 등) 부재

| 항목 | 내용 |
|---|---|
| **현상** | 클라이언트 크래시 / Python 서브프로세스 충돌 / 처리 실패 시 본사에 자동 보고 없음. 사용자가 `export_debug_bundle` 을 수동으로 이메일 첨부해야 함. |
| **영향** | 출시 직후 1주 내 발생할 다수 환경 문제를 조기 발견 불가. 환불/이탈률 ↑. |
| **위치** | 없음 |
| **해결** | Sentry SDK 통합 (electron-main + renderer) + Python 측 stderr 캡처 + opt-in UI + PII 마스킹 |
| **출시 차단 등급** | **🔴 BLOCKER** |
| **소요** | ~1주 |

---

## 부록: 출시 차단 - "치명적은 아니지만 매우 위험" 4건

| ID | 항목 | 등급 |
|---|---|---|
| C1 | FFmpeg 7~9 spawn = 처리 시간 길어 경쟁사 대비 2~5배 느림 | 🟠 HIGH — 환불 사유는 아니지만 리뷰 평점에 직격 |
| C2 | `loud` / `kpop_loud` 가 정확한 LUFS 보장 안 함 (정적 volume) | 🟠 HIGH — 마케팅 클레임 ("-14 LUFS 보장") 과 불일치 |
| C3 | 결제 시스템 (Stripe / Paddle) 미통합 | 🟠 HIGH — 영업 못 함 |
| C4 | 자동 업데이트 채널 (stable/beta) 분리 부재 | 🟡 MEDIUM — 단일 채널 강제 배포 |

---

## 출시 게이트 체크리스트

상업 출시 (v2.0 GA) 전 다음 모두 ✅:

- [ ] DSP 단일 구현 (Python 폐기 또는 PyInstaller 번들) — B1, B4
- [ ] 16비트 출력 Dither — B2
- [ ] Limiter / TP 4× Oversampling — B3
- [ ] macOS Code Sign + Notarize — B5
- [ ] Windows EV Code Sign (또는 평판 누적 정책 합의) — B6
- [ ] 라이선스 게이트 활성 + RemoteValidator + 결제 — B7
- [ ] EULA / Privacy / Refund / 데이터처리 동의 — B8
- [ ] Sentry + opt-in 텔레메트리 — B9
- [ ] 골든 회귀 셋 10곡 통과 (모든 OS) — B1
- [ ] EBU R-128 LUFS 정확도 ±0.1 LUFS 검증 — B3
- [ ] 처리 시간 1분 곡 < 15초 (i5 8세대 기준) — C1
- [ ] 다국어 (ko/en/ja) — i18n
- [ ] FAQ + 사용자 문서 + 지원 채널

위 모두 통과해야 GA 출시.

---

## 회피 옵션 (조기 출시 시)

만약 **베타 / 얼리 액세스** 출시 (유료가 아닌 무료 또는 제한 베타) 라면 다음만 필수:

- [ ] B1 (DSP 동일성) — 사용자에게 불일치 가능성 명시
- [ ] B4 (Python 번들) — PyInstaller 가 임시 해결
- [ ] B5 (macOS 사이닝) — 사용자에게 우회 가이드
- [ ] B8 (간략 약관)
- [ ] B9 (간략 텔레메트리)

→ 마케팅 메시지: **"Loui Mastering Beta — 출시 전 사용자 의견 수렴"** 으로 명시.
