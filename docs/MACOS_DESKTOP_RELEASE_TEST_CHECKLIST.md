# macOS 정식 출시 검증 체크리스트 — apps/desktop (Louver Mastering AI)

목적: macOS 정식 출시 경로를 **`apps/desktop`**(풀 Electron + 번들 로컬 엔진)으로 전환한다.
실기기에서 30초 mp3 **로컬 마스터링 → 결과 → 미리듣기 → Export**까지 검증한다.

- 마스터링은 **사용자 Mac에서 100% 로컬**(번들 Python/FFmpeg 엔진 + Rust DSP WASM, IPC
  `audio:master`/`audio:analyze`). **Render/서버 의존 0**(코드 grep 증명: §5).
- `apps/mac-shell`은 **폐기/비출시**(WebAudio 렌더러 SIGSEGV). macOS는 이 앱으로만 출시.
- 각 항목 **PASS / FAIL / BLOCKED**. 코드 수정 금지 — 검증 문서.

---

## 0. 산출물 / 설치 준비

| ID | 항목 | 기대 | 결과 |
|---|---|---|---|
| 0-1 | macOS 산출물 다운로드 | GitHub Actions `Build Louver Mastering AI` → 최신 성공 run → Artifacts → **`Louver-Mastering-AI-mac`**(dmg+zip, arm64+x64, latest-mac.yml) | [ ] |
| 0-2 | 아키텍처 선택 | Apple Silicon = `*-arm64.dmg`, Intel = `*-x64.dmg` | [ ] |
| 0-3 | (미서명) Gatekeeper 우회 | 첫 실행 "확인되지 않은 개발자" → **우클릭 → 열기**(1회) 또는 `xattr -dr com.apple.quarantine "/Applications/Louver Mastering AI.app"` | [ ] |
| 0-4 | 기기 정보 기록 | 모델 / macOS 버전 / 칩(arm64·x64) / RAM | [ ] |

> 미서명/미공증 빌드라 자동 업데이트는 동작하지 않음(설치/실행/마스터링엔 무관). 서명·공증은
> 별도 단계(`electron-builder.yml` `mac.identity` TODO + `docs/MACOS-RELEASE.md`).

---

## 1. 설치 / 기동

| ID | 동작 | 기대 | 결과 |
|---|---|---|---|
| 1-1 | dmg 마운트 → Applications로 드래그 | 설치 완료 | [ ] |
| 1-2 | 앱 첫 실행 | 정상 기동(화이트/블랙스크린 0, 크래시 0) | [ ] |
| 1-3 | 번들 엔진 로드 | 앱 내 마스터링 진입 시 엔진 오류 없음(번들 `bin/engine` + ffmpeg 인식) | [ ] |

---

## 2. 핵심 — 30초 mp3 로컬 마스터링 (오프라인)

| ID | 동작 | 기대 | 결과 |
|---|---|---|---|
| 2-1 | **인터넷 차단**(Wi-Fi OFF) 상태로 진행 | 서버 없이 동작(로컬 엔진) | [ ] |
| 2-2 | 30초 mp3 Import | 파형/메타 표시 | [ ] |
| 2-3 | 마스터링 실행 | 진행률 정상, 크래시 0, 완료 | [ ] |
| 2-4 | 결과 화면 진입 | LUFS/True Peak/파형 등 결과 표시(검은 화면 없음 — mac-shell 증상 재발 없음 확인) | [ ] |
| 2-5 | **미리듣기 재생** | 결과 오디오 재생됨 | [ ] |
| 2-6 | **Export(WAV 저장)** | 파일 저장 성공, Finder에서 재생 확인 | [ ] |
| 2-7 | (대조) 처리 중 네트워크 모니터 | onrender.com 등 외부 마스터링 호출 0건 | [ ] |

---

## 3. 추가 케이스

| ID | 동작 | 기대 | 결과 |
|---|---|---|---|
| 3-1 | 3분 wav 마스터링 | 정상 완료 + Export | [ ] |
| 3-2 | 다양한 프리셋(YouTube/Spotify 등) | 타깃 LUFS 반영, 음질 파탄 0 | [ ] |
| 3-3 | 연속 2~3곡 처리 | 메모리 누수/크래시 0 | [ ] |
| 3-4 | 앱 종료 후 재실행 | 정상 기동, 직전 상태 영향 없음 | [ ] |
| 3-5 | (해당 시) 라이선스/무료 한도 | 정책대로 동작(결제 서버는 마스터링과 무관) | [ ] |

---

## 4. arm64 / x64 양쪽

| ID | 동작 | 기대 | 결과 |
|---|---|---|---|
| 4-1 | Apple Silicon에서 arm64 dmg | 네이티브 실행 + 2절 PASS | [ ] |
| 4-2 | Intel Mac에서 x64 dmg | 네이티브 실행 + 2절 PASS | [ ] |
| 4-3 | (선택) Apple Silicon에서 x64(Rosetta) | 실행 가능(권장은 arm64) | [ ] |

---

## 5. Render 의존성 0 증명 (코드 기준)
```bash
cd aimaster-desktop/apps/desktop
grep -rniE "onrender|render\.com|MASTERING_API|VITE_MASTERING|/v1/master|/v1/jobs|/v1/analyze|mastering-api" \
  --include=*.ts --include=*.tsx --include=*.js --include=*.cjs --include=*.json --include=*.yml --include=*.html . \
  | grep -v node_modules | grep -v dist
# → 출력 없음(0건). 마스터링 = 로컬 IPC audio:master/audio:analyze → 번들 엔진.
```

---

## 6. Go / No-Go

### ✅ Go
- 1절 기동 PASS + 2절 **전 항목 PASS**(특히 2-4 검은화면 없음, 2-5 미리듣기, 2-6 Export, 2-7 외부호출 0)
- 4절 대상 아키텍처 PASS
- 5절 Render 0건

### ⛔ No-Go
- 기동 크래시/화이트·블랙스크린
- 마스터링/결과/Export 실패, 음질 파탄
- 외부(onrender.com) 호출 발생
- 재실행 크래시

---

## 기록란
- run URL / 산출물: __________
- 기기(모델/macOS/칩/RAM): __________
- 검증자 / 일자: __________
- 최종 판정: ☐ Go / ☐ No-Go / ☐ 재검증
