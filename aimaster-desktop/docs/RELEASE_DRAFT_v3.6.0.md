# Louver Mastering AI v3.6.0 — Release Draft

> 이 파일은 GitHub Actions `release-draft` job 이 GitHub Release 본문으로
> 사용합니다 (`body_path`).  RC 단계에서는 `RELEASE_NOTES_v3.6.0.md` 의
> 내용을 그대로 미러합니다.  정식 v3.6.0 으로 승격할 때 이 파일도 함께
> 업데이트하세요.

이 빌드의 사용자 대상 변경 사항은 다음 문서를 참조하세요:

→ [`RELEASE_NOTES_v3.6.0.md`](./RELEASE_NOTES_v3.6.0.md)

QA 진행 체크리스트:

→ [`QA_v3.6_RC.md`](./QA_v3.6_RC.md)

---

## Highlights

- 🔓 **라이선스 게이트 비활성화** — 라이선스 키 / HMAC 시크릿 / 트라이얼
  카운트 / production 차단 다이얼로그 전부 제거.  `LICENSE_HMAC_SECRET`
  환경변수가 없어도 packaged 빌드가 정상 실행됩니다.  관련 IPC / UI /
  store 는 dead-code 로 남아 있어 추후 재활성화 가능.
- 🎚 **라이브 LUFS / TP 미터 정식 연결** — 결과 페이지 PreviewPlayer 가
  `LoudnessMeterPanel` 을 mount, 재생 중 BS.1770-4 측정값을 실시간 표시.
- 🛠 **Vite worklet emit 수정** — worklet 소스를 plain JS 로 변환하고
  release-smoke 가 .ts 회귀를 자동 차단.
- 🎛 **v3.5 결과 페이지 안정화** — 누락 필드 안전 폴백, 7-mode 동기화.
- 🎧 **Mono-safe stereo enhancement** — 1ch 입력에서 NaN/Inf 발생 안 함.
- 🧠 **Phase-E UI 패널 4종** — sectionAnalysis / aiArtifactCheck /
  vocalIntelligence / translationCheck / modeSuggestion 가 emit 되면
  자동으로 활성화.  현재 빌드에서는 UI 인프라만 준비된 상태이며 Python
  analyzer emit 은 v3.6.x 패치에서 추가됩니다.
- 📤 **Exportable Mastering Report** — TXT + JSON 단일 스냅샷, 파일
  경로 / 디버그 필드 누설 없음.

## ⚠️ 알려진 한계

- macOS 코드 서명 / Notarization 미적용 (v3.6.x 예정).
- Phase-D analyzer Python emit 미구현 — Phase-E UI 패널은 데이터가
  없으면 무해하게 폴백 (false-positive 표시 안 함).
- Reference matching UI 진입점 부재 (RPC 는 v3.4 부터 존재).
- 강제 종료 시 OS temp dir 의 `aimaster_*.wav` 잔존 가능성.
- 라이선스 / 트라이얼 카운트 표시 없음 — 게이트 비활성화로 인해
  사용자에게 "Free" / "Pro" 구분이 보이지 않습니다.

## 자동 업데이트 정상 조건

| 플랫폼 | 자동 업데이트 |
|--------|:-------------:|
| Windows NSIS installer | ✅ 정상 |
| Linux AppImage | ✅ 정상 |
| macOS DMG / ZIP | ❌ 코드 서명 미완 |

또한 build 자체가:
- `app.isPackaged === true`
- `__AUTO_UPDATE_ENABLED__ === true` (= git tag `v*` push 빌드)

→ 두 조건이 모두 충족될 때만 GitHub Releases 를 query 합니다.
