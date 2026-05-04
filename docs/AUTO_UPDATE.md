# Auto-update — release & version policy (v3.4.5)

이 문서는 `electron-updater` 기반 자동 업데이트가 어떻게 동작하는지,
그리고 새 버전을 release 할 때 무엇을 해야 하는지 정리합니다.

## ⚠️ 가장 자주 묻는 질문

**Q. GitHub Actions 의 "Artifacts" 탭에서 받은 빌드인데 "업데이트 실패: No published versions on GitHub" 토스트가 떴어요.**

A. **Actions artifact 는 자동 업데이트 대상이 아닙니다.** `electron-updater`
는 GitHub Releases 에 **publish 된** release 의 `latest.yml` 을 봐야
하는데, branch / workflow_dispatch 로 만든 artefact 는 그런 release 가
없습니다.

v3.4.5 부터는 **artefact 빌드는 아예 자동 업데이트 자체가 비활성화**
되어 있어 토스트가 뜨지 않습니다.  내부 동작:

  · CI `build.yml` 의 build step 에서
    `AUTO_UPDATE_ENABLED: ${{ startsWith(github.ref, 'refs/tags/v') && 'true' || 'false' }}`
  · esbuild 가 이 값을 main 번들에 baked-in 상수로 inject
  · `tag push` (production release) 만 `AUTO_UPDATE_ENABLED=true`
    → 진짜 자동 업데이트 동작
  · `branch push` / `workflow_dispatch` / dev 빌드 → `false`
    → autoUpdater 가 절대 GitHub 를 query 하지 않음 → 토스트 없음

**소비자용 정식 빌드는 반드시 git tag (`v*`) push 로 만들어야
auto-update 가 켜집니다.**

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

## 자동 업데이트가 비활성화되는 경우 (v3.4.5)

다음 중 **하나라도** 해당되면 `autoUpdater` 는 절대 GitHub 를 query
하지 않으며, IPC 도 `{ ok: false, reason: ... }` 만 반환합니다:

| 조건 | reason | 비고 |
|------|--------|------|
| `!app.isPackaged` | `dev_build` | `pnpm dev` 또는 unpackaged 실행 |
| `__AUTO_UPDATE_ENABLED__ === false` | `no_release_channel` | branch / workflow_dispatch artefact, 로컬 `pnpm dist` 테스트 빌드 |

`__AUTO_UPDATE_ENABLED__` 는 esbuild `define` 으로 main 번들에 baked-in
되는 boolean 상수입니다.  CI workflow 가 build step 에서
`AUTO_UPDATE_ENABLED=true` env 를 설정하는 경우에만 true 가 됩니다.

> "No published versions on GitHub" — 사용자에게 보이지 않게 처리
>
> 만약 어떤 이유로 auto-update 가 켜진 빌드인데 GitHub Releases 가
> 비어있다면, electron-updater 는 위 메시지로 error 이벤트를 발생시킵니다.
> v3.4.5 부터는 이 메시지를 `no-release` 상태로 reclassify 해서 토스트가
> 뜨지 않게 처리합니다 (renderer 의 `UpdateToast` 가 silent 렌더).

## Dev 빌드 / artefact 빌드 디버깅

devtools 에서:

```js
await window.updater.checkForUpdates()
// → { ok: false, reason: 'dev_build' }    (pnpm dev)
// → { ok: false, reason: 'no_release_channel' }  (artefact 빌드)
// → { ok: true }                          (정상 release 빌드)
```

main.log 에는 다음이 기록됩니다:

```
[updater] auto-update disabled (packaged=true, buildEnabled=false)
```

→ 이 로그가 보이면 정상.  artefact 빌드는 의도적으로 비활성화 상태입니다.

## 디버깅

- 클라이언트 로그: electron-log → `~/Library/Logs/Louver Mastering AI/main.log`
  (macOS), `%AppData%\Louver Mastering AI\logs\main.log` (Windows)
- `[updater] checking-for-update` / `[updater] update-available: 3.4.4` 등
  모든 이벤트가 main.log 에 기록됨.
- 서버 메타: `https://github.com/freemilesarea-boop/AImastering/releases/latest/download/latest.yml`
  를 브라우저에서 직접 받아 검증 가능.
