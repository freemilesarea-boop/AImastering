# Auto-update — release & version policy (v3.4.3)

이 문서는 `electron-updater` 기반 자동 업데이트가 어떻게 동작하는지,
그리고 새 버전을 release 할 때 무엇을 해야 하는지 정리합니다.

## 동작 흐름

```
┌──────────────┐         ┌─────────────────────┐         ┌──────────────┐
│   Client     │ HTTPS   │  GitHub Releases    │  push   │  GitHub      │
│ (Louver app) │◀─GET───▶│  latest.yml /       │◀────────│  Actions CI  │
│              │         │  latest-mac.yml /   │  artefacts│  (build.yml) │
│              │         │  latest-linux.yml   │         │              │
└──────────────┘         └─────────────────────┘         └──────────────┘
       ▲                                                        ▲
       │ poll on launch (5s after ready)                        │
       │                                                        │
   user clicks                                                  │
   "지금 받기"                                                   │
       │                                                        │
       ▼                                                        │
   download .exe / .dmg / .AppImage  ◀─────── released ─────────┘
       │
       ▼
   "재시작" → quitAndInstall() → 새 버전 실행
```

## 새 버전 release 절차

1. **Renderer / main 코드 수정 후**
   - `apps/desktop/package.json` 의 `version` 을 새 값으로 변경
   - 예: `3.4.3` → `3.4.4`

2. **(중요) Tag 와 package.json version 일치**
   - electron-updater 는 *tag 가 아니라* installer 안에 들어간 `package.json.version`
     으로 새 버전을 판단합니다.
   - 따라서 git tag 를 `v3.4.4` 로 push 하기 전에 반드시 package.json 도
     `"version": "3.4.4"` 인 상태여야 합니다.
   - 불일치 시: **사용자 앱이 영원히 "최신 버전입니다" 만 표시**.

3. **Tag push**
   ```bash
   git tag v3.4.4
   git push origin v3.4.4
   ```

4. **GitHub Actions 가 자동으로**
   - macOS / Windows / Linux 빌드를 모두 실행
   - electron-builder 가 `--publish always` 로 GitHub Releases 에
     **draft release** 를 만들고 다음 파일을 업로드:
     - `Louver Mastering AI-Setup-3.4.4.exe`     (Windows NSIS installer)
     - `Louver Mastering AI-3.4.4-portable-x64.exe` (Windows portable, 보조)
     - `Louver Mastering AI-3.4.4-arm64.dmg`     (macOS)
     - `Louver Mastering AI-3.4.4-x64.dmg`
     - `Louver Mastering AI-3.4.4-arm64-mac.zip`  (auto-update delta)
     - `Louver Mastering AI-3.4.4-x64-mac.zip`
     - `Louver Mastering AI-3.4.4.AppImage`        (Linux)
     - `latest.yml`         ← Windows 클라이언트가 읽는 메타데이터
     - `latest-mac.yml`     ← macOS 클라이언트가 읽는 메타데이터
     - `latest-linux.yml`   ← Linux 클라이언트가 읽는 메타데이터

5. **수동 검토 후 publish**
   - GitHub Releases 페이지에서 release 가 draft 상태로 보임
   - release notes 추가 / 첨부 파일 검수
   - `Publish release` 버튼 클릭

6. **클라이언트 자동 발견**
   - 사용자가 앱을 켜면 5초 뒤 `checkForUpdates()` 자동 실행
   - 새 버전이 감지되면 우측 하단 토스트로 "새 버전 v3.4.4 — 지금 받기"
   - 사용자가 클릭하면 백그라운드 다운로드 → 진행률 표시 → "재시작"

## 환경별 자동 업데이트 가능 여부

| 플랫폼 | 자동 업데이트 | 비고 |
|--------|:------------:|------|
| **Windows NSIS installer** | ✅ | 1순위 — 모든 사용자 권장 |
| Windows portable .exe | ❌ | self-update 불가 (보조 artefact) |
| **Linux AppImage** | ✅ | 클라이언트가 새 AppImage 다운로드 후 실행 |
| **macOS DMG / ZIP** | ⚠️ TODO v3.5 | 코드 서명 + 공증 필요 — 아래 참고 |

## macOS 코드 서명 / 공증 (v3.5 작업)

macOS 자동 업데이트는 **반드시** Apple Developer 인증서로 코드 서명 +
notarytool 로 공증된 .app 이어야 합니다.  공증 없이는:

- Gatekeeper 가 새 버전을 실행시키지 않음
- electron-updater 가 `Could not get code signature for running application` 발생

필요한 환경 변수 (CI secrets):

```
CSC_LINK            — Developer ID Application 인증서 (.p12 base64 또는 URL)
CSC_KEY_PASSWORD    — .p12 비밀번호
APPLE_ID            — Apple 계정 (notarization 용)
APPLE_APP_SPECIFIC_PASSWORD
APPLE_TEAM_ID
```

`electron-builder.yml` 의 `mac.identity` 주석 처리된 부분 활성화 필요.

## Private repo 전환 시 (TODO)

현재 repo 는 public 이라 자동 업데이트 시 토큰이 필요 없습니다.

repo 가 private 이 되면:

- 모든 클라이언트에 `GH_TOKEN` 환경변수 필요 (PAT, repo scope)
- 또는 `private GitHub Releases` provider 대신 generic provider + 자체
  CDN 으로 전환 (대규모 배포 권장)

해당 시점에 `src/main/updater.ts` 의 TODO 참고.

## Dev 빌드는 자동 업데이트 안 됨

`!app.isPackaged` 인 환경 (즉 `pnpm dev`) 에서는 `initUpdater()` 가
이벤트 핸들러를 등록하지 않고, IPC 핸들러도 모두 `{ ok: false, reason:
'dev_build' }` 를 반환합니다.

devtools 에서 `await window.updater.checkForUpdates()` 를 호출해도
"dev_build" 가 돌아오므로 안전합니다.

## 디버깅

- 클라이언트 로그: electron-log → `~/Library/Logs/Louver Mastering AI/main.log`
  (macOS), `%AppData%\Louver Mastering AI\logs\main.log` (Windows)
- `[updater] checking-for-update` / `[updater] update-available: 3.4.4` 등
  모든 이벤트가 main.log 에 기록됨.
- 서버 메타: `https://github.com/freemilesarea-boop/AImastering/releases/latest/download/latest.yml`
  를 브라우저에서 직접 받아 검증 가능.
