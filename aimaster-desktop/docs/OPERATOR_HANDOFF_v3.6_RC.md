# 운영자 핸드오프 — v3.6.0-rc.1 필드 테스트

> 이 문서 한 장으로 v3.6 RC 필드 테스트를 끝까지 진행할 수 있도록 만든
> 체크리스트입니다.  코드는 건드리지 않습니다.  개발 환경 / Node /
> Electron 지식이 없어도 따라갈 수 있도록 단계별로 적었습니다.
>
> 소요 시간: 빌드 트리거 ~3분 · CI 실행 ~30분 · 테스터 7일 · 정리 ~30분.

---

## 0 · 시작 전 준비물

- [ ] GitHub repo `freemilesarea-boop/AImastering` 의 **Actions / Secrets**
      쓰기 권한
- [ ] 테스터 5명 (분류: AI 음원 / KPOP 보컬 / 플레이리스트 큐레이터 /
      저사양 Windows / macOS)
- [ ] 테스터 한 명당 본인 이름이나 닉네임으로 만든 **Tester ID**
      (예: `kpop-vocal-1`, `low-spec-win-2`)
- [ ] 테스터에게 파일을 전달할 채널 (Slack DM / 메일 / Drive 링크)
- [ ] 진단 리포트가 돌아올 폴더 (예: `~/Documents/v3.6-rc1-bundles/`)

> ⚠️ 운영자 본인이 코드를 빌드할 필요는 없습니다.  모든 빌드는 GitHub
> Actions 가 대신 합니다.

---

## 1 · GitHub Actions Secret 설정 (변경됨 — 별도 secret 불필요)

> **v3.6.0-rc.1+1 패치 이후, 이 단계는 사실상 비어 있습니다.**  이전 RC
> 에서는 `LICENSE_HMAC_SECRET` 을 secret 으로 설정해야 했지만, 라이선스
> 게이트가 비활성화되어 더 이상 필요하지 않습니다.  앱은 어떤 환경변수도
> 없이 packaged 빌드에서 정상 실행됩니다.

`GITHUB_TOKEN` 은 Actions 가 자동으로 주입하므로 **추가 secret 등록은
필요 없습니다**.  바로 §2 로 넘어가세요.

---

## 2 · GitHub Actions 로 RC 인스톨러 빌드 (Windows + macOS + Linux)

빌드 트리거 방법은 두 가지인데, **방법 B (workflow_dispatch)** 를
권장합니다 — 정식 release tag 를 만들지 않고도 산출물을 받을 수
있습니다.

### 방법 B (권장) · workflow_dispatch

1. 브라우저에서 `https://github.com/freemilesarea-boop/AImastering/actions`
   열기
2. 좌측 사이드바에서 **"Build Louver Mastering AI"** 워크플로우 클릭
3. 우상단 **"Run workflow"** 버튼 → 드롭다운 펼치기
4. **Branch** 가 `claude/add-section-analysis-ui-kFBNW` 인지 확인 (RC 가
   머지된 브랜치)
5. **`release_tag` 입력란은 비워둡니다** (release draft 를 만들지 않음 —
   이번에는 산출물만 받기)
6. **Run workflow** 클릭

→ 워크플로우가 실행됩니다.  약 25–35분 후 3개 platform job (linux / mac /
win) 이 모두 초록색으로 끝나야 합니다.

### 방법 A (선택) · tag push

정식 release draft 까지 같이 만들고 싶다면:

1. 로컬에서 누군가 (개발자 / CI 권한자) 가:
   ```
   git tag v3.6.0-rc.1
   git push origin v3.6.0-rc.1
   ```
2. 동일한 워크플로우가 자동 실행됩니다.
3. 추가로 `release-draft` job 이 GitHub Releases 에 **draft + prerelease**
   상태로 새 release 를 만듭니다.

---

## 3 · 산출물 다운로드

워크플로우가 끝나면 (각 platform job 옆에 ✅ 가 보이면):

1. 워크플로우 실행 페이지 맨 아래로 스크롤 → **"Artifacts"** 박스
2. 다음 3개 zip 을 모두 다운로드:

| 다운로드 zip 이름 | 안에 들어있는 파일 |
|---|---|
| `Louver-Mastering-AI-windows` | `Louver Mastering AI-Setup-3.6.0-rc.1.exe`, `latest.yml` |
| `Louver-Mastering-AI-mac` | `Louver Mastering AI-3.6.0-rc.1-arm64-mac.zip`, `Louver Mastering AI-3.6.0-rc.1-x64-mac.zip`, `latest-mac.yml` |
| `Louver-Mastering-AI-linux` | `Louver Mastering AI-3.6.0-rc.1-linux-x86_64.AppImage` |

3. 각 zip 을 풀어서 `.exe` / `.zip` (mac 안의 zip) / `.AppImage` 만 골라
   놓습니다.  `latest*.yml` 은 자동 업데이트용 — 이번 RC 에서는 사용하지
   않습니다.

### 테스터에게 보낼 파일

| 테스터 분류 | 보낼 파일 |
|---|---|
| AI 음원 사용자 / KPOP 보컬 / 플레이리스트 큐레이터 — Windows | `Louver Mastering AI-Setup-3.6.0-rc.1.exe` |
| 저사양 Windows | 동일 |
| macOS — Apple Silicon (M1/M2/M3) | `Louver Mastering AI-3.6.0-rc.1-arm64-mac.zip` |
| macOS — Intel | `Louver Mastering AI-3.6.0-rc.1-x64-mac.zip` |

> 테스터 본인이 어떤 mac 인지 모를 수 있습니다.  Apple 메뉴 → "이 Mac
> 에 관하여" 에 "Apple M-시리즈" 가 보이면 arm64, "Intel" 이 보이면 x64.

---

## 4 · 테스터 메시지 (한국어 템플릿 — 그대로 복사하세요)

테스터마다 분류 / 파일 이름만 바꿔서 보내세요.  **Tester ID 는 반드시
본인 ID 를 써서 1:1 매칭이 가능하도록 합니다**.

```
안녕하세요, Louver Mastering AI v3.6.0-rc.1 내부 테스트에 참여해 주셔서
감사합니다.

──────────────────────────────────────
- Tester ID: kpop-vocal-1                (← 본인 ID)
- 빌드 버전: 3.6.0-rc.1
- 마감: 7일 안에 진단 리포트 1개 + 메모 1개
──────────────────────────────────────

1. 다음 파일을 다운로드 + 설치해 주세요.
   <여기에 다운로드 링크>

2. 설치 + 실행 방법은 첨부 가이드 (TESTER_GUIDE_v3.6_RC.md) 참조.
   - Windows 의 경우 SmartScreen 에서 "추가 정보" → "실행" 누르세요.
   - macOS 의 경우 Finder 에서 우클릭 → "열기" 입니다.

3. 가이드의 "필수" 시나리오 2개 + 본인 분류 시나리오 1개 진행해 주세요.

4. 결과 페이지 우상단 "지원 진단" 버튼을 눌러 JSON 파일을 저장.
   파일명: aimaster-support-<날짜>.json

5. 다음 정보와 함께 회신해 주세요.
   - 첨부: aimaster-support-*.json
   - Tester ID: kpop-vocal-1
   - OS / 아키텍처: 예) Windows 11 x64 / macOS 14.4 arm64
   - 메모 1–2줄: 막혔던 부분, 화면, 어떤 파일에서

문제가 생기면 바로 회신해 주세요.  진단 파일에는 절대 경로 / 파일 본문
/ 라이선스 키가 포함되지 않습니다.  파일명은 포함되니 민감하면
별도로 알려주세요.
```

첨부할 가이드: `aimaster-desktop/docs/TESTER_GUIDE_v3.6_RC.md`

---

## 5 · 테스터의 진단 리포트 export 절차 (한 줄 요약)

테스터에게 알려줄 필요는 없는 (가이드에 이미 있는) 흐름이지만 운영자가
참고로 알아둡니다:

1. 앱 실행 → 곡 마스터링 1회
2. 결과 페이지 진입 (이때까지가 "필수" 시나리오)
3. 우상단 **"지원 진단"** 버튼 클릭
4. 저장 다이얼로그에서 위치 선택 (바탕화면 등)
5. 생성된 `aimaster-support-<timestamp>.json` 을 회신

만약 테스터가 어디 있는지 못 찾으면 (예: "지원 진단" 버튼이 안 보임 —
모든 페이지의 TopBar 우측 끝에 있어야 합니다):

- DevTools 열기: `Ctrl + Shift + I` (Win) 또는 `Cmd + Option + I` (mac)
- Console 탭에 다음 한 줄 붙여넣기:
  ```js
  await window.electronAPI.invoke('support:bundle-export')
  ```
- 저장 다이얼로그가 뜨면 위치를 선택하면 끝.

---

## 6 · 회신된 JSON 들 모으기

테스터들이 회신한 `.json` 파일을 한 폴더에 모읍니다.

```
~/Documents/v3.6-rc1-bundles/
  ai-music-1.json
  kpop-vocal-1.json
  playlist-curator-1.json
  low-spec-win-1.json
  macos-1.json
```

> Tester ID 그대로 파일명을 바꿔두면 나중에 추적이 쉽습니다 — 테스터가
> `aimaster-support-2026-05-06T12-00-00.json` 으로 보내도 운영자가
> `kpop-vocal-1.json` 으로 rename 하세요.

---

## 7 · 진단 리포트 집계 (1개 명령)

운영자 머신에 Node + pnpm 이 있어야 합니다.  없으면 회사 개발자 한
명에게 부탁하세요 — 명령은 30초면 끝납니다.

```bash
# repo clone 했다면 (한 번만)
git clone https://github.com/freemilesarea-boop/AImastering.git
cd AImastering/aimaster-desktop
pnpm install                   # 한 번만

# 매번 돌릴 명령 ↓
pnpm --filter @aimaster/desktop aggregate-bundles -- ~/Documents/v3.6-rc1-bundles
```

→ 터미널에 마크다운 리포트가 출력됩니다.  내용을 그대로 복사해서
`aimaster-desktop/docs/FIELD_TEST_LOG_v3.6_RC.md` 의 **"Aggregate
rollup"** 섹션에 붙여넣으세요.

리포트에 포함되는 것:
- 테스터 수 / 빌드 버전 / OS 분포
- 8개 카테고리별 실패 수 + 가장 많은 실패 메시지
- 가장 많이 본 메시지 Top 10 (개인 경로 자동 마스킹 됨)
- 테스터 1명당 한 줄 요약 (가장 많이 발생한 카테고리 / 파이프라인 경고
  수)

---

## 8 · GO / NO-GO 의사결정 (테스터가 다 돌아온 뒤)

다음 5개 항목을 모두 만족하면 **GO** (정식 v3.6.0 으로 승격), 한 개라도
실패하면 **NO-GO** (v3.6.0-rc.2 빌드 또는 보류).

- [ ] **G1** — P0 케이스 (`docs/QA_v3.6_RC.md` 의 A1, A2, A5/A7, A9, A10,
      B1–B3, C1–C4, D1–D7, E1, E2, E4–E6, E8, G1, H1–H7, H10, H12, H13)
      가 platform 당 최소 2명 이상에서 PASS.
- [ ] **G2** — 어떤 진단 리포트에도 advisory 이상 (`fail` 수준) 의
      `recentFailures` 항목이 없음.
- [ ] **G3** — 진단 JSON grep 결과 `/Users/`, `/home/<name>/`, `outputPath`,
      `previewPath`, `debugSummary`, `artifactDir`, `jobId` 어느 것도
      등장하지 않음.  사용자 홈은 모두 `~` 로 마스킹됨.
- [ ] **G4** — packaged 빌드가 `LICENSE_HMAC_SECRET` 없이 정상 실행됨
      (`A9`).  더 이상 startup blocked 다이얼로그가 뜨면 안 됩니다.
- [ ] **G5** — Live LUFS / TP 미터 (`E3`) 가 macOS 1명 + Windows 1명에서
      재생 중 갱신됨이 확인됨.

> Phase-D analyzer 케이스 (F1–F5) 는 **DEFERRED** — 이번 RC 의 GO/NO-GO
> 판단에 들어가지 않습니다 (아래 §9 참조).

### GO 일 때 (정식 승격 절차)

다음 단계는 개발자가 처리합니다.  운영자는 GO 결정만 알리면 됩니다:

1. `package.json` 3 곳에서 `3.6.0-rc.1` → `3.6.0` 으로 변경
2. `.github/workflows/build.yml` 의 `prerelease: true` → `false`
3. `git tag v3.6.0 && git push origin v3.6.0`
4. CI 가 다시 빌드 + draft release 생성 → 검토 후 publish

### NO-GO 일 때

1. 운영자가 이 문서의 §1–§3 단계를 다시 진행하지 않습니다 (개발자가
   먼저 fix 를 만든 뒤).
2. 개발자가 hardening commit 을 추가하고 `3.6.0-rc.1` → `3.6.0-rc.2`
   로 bump.
3. CI 재빌드 → §3 부터 재시작.

---

## 9 · 이 RC 의 알려진 한계 (테스터에게도 미리 알려주세요)

이 항목들은 **이번 RC 에서 평가 대상이 아닙니다**.  테스터가 이걸로
이슈를 올려도 GO/NO-GO 에 영향이 없습니다.

1. **macOS 코드 서명 / Notarization 미적용** — Gatekeeper 첫 실행 차단,
   electron-updater 자동 업데이트 작동 안 함.  v3.6.x 패치 예정.
2. **Phase-D analyzer Python emit 미구현** — sectionAnalysis,
   aiArtifactCheck, vocalIntelligence, translationCheck, modeSuggestion
   필드는 UI 인프라만 준비된 상태.  결과 페이지에서 해당 패널이
   비어 보이는 것은 정상.  Python emit 은 v3.6.x 패치에서 추가.
3. **Reference matching UI 진입점 부재** — RPC method 는 v3.4 부터
   존재하지만 결과 페이지 외 진입 버튼이 없음.  v3.6.x 예정.
4. **임시 파일 잔존 가능성** — 강제 종료 시 OS temp dir 의
   `aimaster_*.wav` 가 남을 수 있음 (v3.5 와 동일).
5. **macOS 자동 업데이트 작동 안 함** — 위 §1 과 동일 사유.

---

## 10 · 필드 테스트 기간 동안 절대 변경 금지

- ❌ DSP 알고리즘 (`apps/desktop/src/renderer/audio/`)
- ❌ Python 마스터링 엔진 (`services/python-audio/app/`)
- ❌ 새 마스터링 모드 추가
- ❌ 새 UI 시스템 / 새 패널 / 새 페이지 추가
- ❌ shared-types 의 기존 필드 시그니처 변경 (옵셔널 추가는 OK 였지만
    이번 필드 테스트 기간에는 보류)
- ❌ electron-builder.yml 의 target / signing 설정 변경
- ❌ 라이선스 게이트 재활성화 (이번 RC 기간에는 비활성화 상태로 유지)

허용되는 것 (오직 critical 한 경우만):
- ✅ 문서 (docs/) 수정
- ✅ tester guide / field-test log 업데이트
- ✅ 진단 리포트 ring buffer / 카테고리 추가 (이미 v3.6.0-rc.1 에 있는
    구조라면)

---

## 11 · 운영자 한 줄 요약

```
(Secrets 등록 단계는 이번 RC 부터 생략 — 라이선스 게이트 비활성화)
Actions → Run workflow (release_tag 비움)
→ 30분 기다림
→ 3개 Artifacts 다운로드
→ Tester 5명에게 본인 분류 빌드 + 가이드 + 메시지 전달
→ 7일 후 .json 5개 회수
→ pnpm aggregate-bundles → 결과를 FIELD_TEST_LOG 에 붙여넣기
→ §8 체크리스트로 GO / NO-GO 결정
```

문제가 생기면 개발자에게 다음 정보를 첨부해서 알려주세요:
- 어느 단계 (§ 번호)
- 어떤 화면 / 메시지
- Actions 실행 URL (있다면)

작성 / 검토:
- v3.6.0-rc.1 RC tag 기준
- 마지막 commit: `4ea249f`
