# Louver Mastering AI v3.5.0

> **베타 배포** — Windows + Linux 우선 배포.  macOS 는 코드 서명 / Apple
> 공증 (notarization) 완료 전까지 정식 배포 보류.  포함된 mac dmg/zip 은
> *unsigned beta* 로 첨부됩니다.  ⚠️ Mac 사용자는 첫 실행 시 Gatekeeper
> 차단 화면이 보일 수 있으니, 정식 (signed) 빌드를 기다리시거나 우회
> 안내 (아래 §Troubleshooting) 를 따라주세요.

---

## 다운로드

| Platform     | Architecture | File                                                  | 상태 |
|--------------|--------------|-------------------------------------------------------|:----:|
| **Windows**  | x64 (NSIS)   | `Louver Mastering AI-Setup-3.5.0.exe`                  | ✅ Primary |
| **Linux**    | x64          | `Louver Mastering AI-3.5.0-linux-x86_64.AppImage`      | ✅ Primary |
| macOS — Apple Silicon | arm64 | `Louver Mastering AI-3.5.0-arm64-mac.zip` / `…-arm64.dmg` | ⚠️ unsigned beta |
| macOS — Intel | x64         | `Louver Mastering AI-3.5.0-x64-mac.zip`  / `…-x64.dmg`    | ⚠️ unsigned beta |

> **Windows** — `Setup-3.5.0.exe` 를 다운로드해서 실행하세요.  설치 위치를
> 직접 선택할 수 있고, 시작 메뉴 / 데스크톱 바로가기가 자동 생성됩니다.
> 자동 업데이트가 정상 지원됩니다.
>
> **Linux** — AppImage 파일에 실행 권한을 주고 실행:
> `chmod +x "Louver Mastering AI-3.5.0-linux-x86_64.AppImage"` → 실행.
> 자동 업데이트가 정상 지원됩니다.
>
> **macOS** — 정식 배포 보류 중.  unsigned beta 로 받아보시려면
> §Troubleshooting 참조.  자동 업데이트는 코드 서명이 완료될 때까지
> 작동하지 않습니다.

---

## Highlights

이번 릴리스는 v3.4.5 이후 누적된 사운드 엔진 / 자동 업데이트 / 빌드 구조
개선을 정식 버전으로 묶은 것입니다.

### 🎚️ 사운드 엔진 — KPOP Loud 톤 밸런스 완전 재설계

- **v3.4.6 텔레폰 사운드 수정** — 80 Hz overlay cut 제거 + 90 Hz warmth
  bell + 고역 boost 축소
- **v3.4.7 adaptive 톤 밸런스** — 입력 spectrum 기반 동적 EQ + post-master
  tonal guard
- **v3.5 Phase 1 critical 버그 수정**
  - `adynamicequalizer.range` 단위 버그 (LINEAR factor vs dB) 수정
    → 기존 `range=2.0` 이 실제 -6 dB cut 발생하던 문제 해결
  - `alimiter.level=true` default 가 EQ 보정을 무력화하던 버그 수정
  - Saturation 단계를 compressor knee 로 흡수 (chain 단순화)
- **v3.5 Phase 2 target convergence 아키텍처**
  - T1 Adaptive Corrective EQ — base + overlay 통합 단일 함수
  - 4-band pre-limiter measurement (LOW/MID/HIGH/AIR)
  - Tonal budget 시스템 (`tonal_budget.py`)
  - Final tonal guard 1-pass simultaneous solver

### 📊 측정상 개선 (3 가지 입력 케이스 평균)

| 메트릭 | v3.4.5 | v3.5.0 | 목표 |
|--------|-------:|-------:|-----:|
| `lowEnergyRatio` | 0.70–0.85 | **0.94–1.14** | 0.85–1.15 ideal |
| `highLowTilt` | +1 ~ +10 dB (불안정) | **+1.5 ~ +2.0 dB** | ±2 dB ideal |
| Dynamic EQ 단일-stage 영향 | -10 dB (worst) | **±1.5 dB cap** | ±1.5 dB |

→ 입력 종류 (베이스 강한 트랙 / 약한 트랙 / 이미 밝은 트랙) 에 관계없이
일관된 톤 밸런스 도달.

### 🛡️ Vocal Protection (always-on engine guard)

- 1.5–5 kHz 보컬 대역 dynamic-EQ cut ≤ 2.5 dB
- Compressor ratio ≤ 2.0 / attack ≥ 25 ms / makeup ≤ 0.7 dB
- Entry gain ≤ +6 dB, limiter level_in ≤ +0.5 dB
- 보컬 손실 ≥ 1.5 dB 감지 시 자동 fallback 권장

### 🔧 자동 업데이트 (Windows / Linux)

- `electron-updater` + GitHub Releases
- **AUTO_UPDATE_ENABLED gate** — tag push 정식 빌드만 자동 업데이트 활성
  → branch / workflow_dispatch 로 받은 artefact 는 "No published versions"
  토스트 안 뜸
- **NSIS installer 가 Windows 정식 배포 1순위** (portable .exe 는
  배포 기본에서 제외 — self-update 불가능 때문)

### 🔍 디버그 / 진단 시스템

- 시간대별 의심 구간 검출 (`suspectSegments`)
- Limiter excess QC (crest factor / LRA / ceiling-attached / brickwall)
- Reference matching (Ozone-style iterative, beta) — UI 진입점은 추후
- Debug bundle export (zip)

### 🛠️ 빌드 / 배포 인프라

- Renderer (`dist/`) 와 main/preload (`dist-electron/`) 출력 경로 분리
  → CI cleanup 단계가 main JS 를 wipe 하던 버그 영구 차단
- `extraMetadata.main` 으로 asar package.json main 강제 override

---

## 변경된 파일 / 코드 라인 (v3.4.5 → v3.5.0)

- `app/mastering/`: 5 modules (eq.py / dynamic_eq.py / dynamics.py /
  effects.py / pipeline.py) + 신규 tonal_budget.py
- `app/qc/gain_staging.py`: 신규 측정 메트릭 (lowEnergyRatio, lowRelativeDb)
- `app/utils/vocal_protection.py`: 신규 (engine guard always-on)
- `app/utils/debug_logger.py` / `debug_bundle.py` / `env_info.py`:
  디버그 시스템
- 4-band measurement 도구: `app/qc/gain_staging.py` `_measure_bands`
- 신규 RPC: `analyze_reference` / `master_with_reference` / `env_info` /
  `export_debug_bundle` / `recommend_reference_preset` /
  `list_reference_presets`

---

## ⚠️ Known Limitations / Roadmap

### 🚫 macOS 정식 배포 보류 사유

**v3.5.0 부터는 macOS 빌드를 정식 배포 대상에 포함하지 않습니다.**
이유:

1. **Apple Developer 인증서 / Notarization 미적용** — Gatekeeper 가
   첫 실행 시 앱을 차단합니다.
2. **자동 업데이트 작동 안 함** — electron-updater 는 코드 서명된
   .app 만 self-replace 할 수 있습니다.  서명 없는 빌드에서는
   "Could not get code signature for running application" 오류 발생.

→ 정식 macOS 빌드는 **v3.6.x** 에서 인증서 발급 + notarization 파이프라인
완료 후 제공 예정.

#### macOS Troubleshooting (unsigned beta 사용 시)

unsigned 베타를 굳이 사용하시려면:

```
1. zip 또는 dmg 다운로드
2. 압축 해제 / 마운트 후 .app 을 /Applications 로 복사
3. Finder 에서 .app 우클릭 → "열기"
4. "확인되지 않은 개발자" 경고에서 "열기" 클릭 (이번 한 번만)
5. 자동 업데이트는 작동 안 함 — v3.6.x 정식 빌드 다운로드 필요
```

또는 터미널에서:

```bash
xattr -dr com.apple.quarantine "/Applications/Louver Mastering AI.app"
```

### 🔒 Windows SmartScreen

Windows 사용자는 첫 실행 시 SmartScreen 경고가 보일 수 있습니다 (코드 서명
인증서 없음 — v3.6.x 에서 EV cert 도입 예정):

```
1. Setup-3.5.0.exe 실행
2. "Windows의 PC 보호" 화면이 보이면 "추가 정보" → "실행" 클릭
3. 설치 진행
```

이후 실행은 경고 없이 정상 작동합니다.

### 🐛 알려진 이슈

- **Reference matching UI 진입점 부재** — RPC method 는 구현됐으나 UI
  버튼 미연결.  v3.6.x 에서 노출 예정.
- **Debug bundle export UI 부재** — RPC method 는 구현됨, UI 추가 v3.6.x.
- **임시 파일 잔존** — 강제 종료 시 OS temp dir 의 `aimaster_*.wav`
  파일이 남을 수 있음.  v3.5.1 에서 cleanup helper 추가 예정.

---

## 자동 업데이트 정상 조건

이 빌드는 자동 업데이트가 다음 조건에서만 작동합니다:

| 플랫폼 | 자동 업데이트 |
|--------|:-------------:|
| Windows NSIS installer | ✅ 정상 |
| Linux AppImage | ✅ 정상 |
| macOS DMG / ZIP | ❌ 코드 서명 미완 (v3.6.x 예정) |

또한 build 자체가:
- `app.isPackaged === true` (= 정식 installer 로 설치된 빌드)
- `__AUTO_UPDATE_ENABLED__ === true` (= git tag `v*` push 로 만든 release)

→ 둘 다 충족할 때만 GitHub Releases 를 query 합니다.  Actions artifact
나 dev 빌드에서는 query 자체가 비활성화되어 "No published versions" 같은
혼란스러운 토스트가 뜨지 않습니다.

---

## Test 권장 시나리오

1. **Windows 사용자**:
   - Setup-3.5.0.exe 다운로드 → 설치
   - 첫 실행 → 마스터링 1 곡 → 결과 저장
   - 다음 release tag (v3.5.1 등) push 시 자동 업데이트 토스트 확인
2. **Linux 사용자**:
   - AppImage 다운로드 → `chmod +x` → 실행
   - 마스터링 동작 검증
3. **macOS 사용자 (베타)**:
   - 위 §Troubleshooting 따라 우회 후 사용
   - 자동 업데이트 미지원 안내 확인

---

## Changelog (정식 버전 기준)

- v3.5.0: Target-convergence tonal architecture (Phase 2)
- v3.4.7: Adaptive 톤 밸런스 + tonal guard
- v3.4.6: KPOP Loud 텔레폰 사운드 긴급 수정
- v3.4.5: Auto-update gate (AUTO_UPDATE_ENABLED bake-in)
- v3.4.4: Win NSIS only (portable 제거)
- v3.4.3: electron-updater + NSIS/DMG 배포
- v3.4.2: dist/dist-electron 분리
- v3.4.1: Reference matching guidance
- v3.4.0: Ozone-style iterative reference matching
- v3.3.x: Vocal Protection + gain staging system
- v3.2.x: 디버그-quality system

---

## Credits

루베르(Louver) — 마스터링 엔진 / UI / 빌드 시스템

## License

(별도 라이선스 문서 참조)
