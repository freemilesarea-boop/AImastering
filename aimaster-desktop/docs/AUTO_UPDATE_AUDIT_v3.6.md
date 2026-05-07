# Auto-update audit — v3.6 release

> Question:  Can existing installed users receive v3.6 through the
> `electron-updater` channel?
>
> Method:  read the updater main-process code, the renderer event
> surface, the electron-builder configuration, and the GitHub Actions
> release pipeline; trace the bytes from a tag push through to a
> client's "update available" toast.
>
> Result:  **conditionally GO** — three real bugs were blocking the
> path; all three are fixed in this commit (no DSP changes).  Per-
> platform status follows below.

---

## TL;DR

| Platform               | Auto-update status (after fixes)                                                               |
|------------------------|------------------------------------------------------------------------------------------------|
| **Windows NSIS x64**   | ✅ **GO** — installer-style update works once `latest.yml` reaches the GitHub Release.         |
| Windows portable       | ❌ **N/A** — target retired in v3.4.4; existing portable users must reinstall via NSIS.        |
| **macOS arm64 / x64**  | ❌ **NO-GO** until code-signing + notarization land (see §5.3).  Falls back to manual download. |
| **Linux AppImage x64** | ✅ **GO** — works once `latest-linux.yml` reaches the GitHub Release (fixed below).             |

The critical fixes shipped with this audit:

1. CI `Upload Linux AppImage` now also uploads `latest-linux.yml`
   (parity with mac / windows artifacts).
2. CI `release-draft` `files:` list now attaches every `latest*.yml`
   alongside the binary (so a user-mediated release doesn't ship
   without the metadata file).
3. Renderer `Settings → 정보 → 버전` was reading
   `import.meta.env.VITE_APP_VERSION` (never injected); it now reads
   the `__APP_VERSION__` `define` constant that vite.config.ts
   actually sets.

The previous behaviour silently broke Linux auto-update unless
`electron-builder --publish always` ran (i.e. tag-push only) — and even
that path showed `1.0.0` in Settings on every build.

---

## 1 · electron-updater configuration (PASS)

| Check                                                       | Result | Source |
|-------------------------------------------------------------|:------:|--------|
| Updater code enabled in production builds                   |  ✅    | `apps/desktop/src/main/updater.ts` — `_autoUpdateEnabled()` returns `app.isPackaged && __AUTO_UPDATE_ENABLED__`. |
| `__AUTO_UPDATE_ENABLED__` set to `true` for release builds  |  ✅    | `apps/desktop/esbuild.main.cjs` reads `process.env.AUTO_UPDATE_ENABLED === 'true'` and bakes the boolean as a `define` constant. |
| CI sets `AUTO_UPDATE_ENABLED='true'` only for tag pushes    |  ✅    | `.github/workflows/build.yml` (3 places — linux/mac/win build steps): `${{ startsWith(github.ref, 'refs/tags/v') && 'true' \|\| 'false' }}`. |
| Update check is called on app startup                       |  ✅    | `initUpdater()` schedules `autoUpdater.checkForUpdates()` `FIRST_CHECK_DELAY_MS = 5000` ms after `app.whenReady()`. |
| Manual `Check / Download / Restart` IPC handlers exist      |  ✅    | `updater:check` / `updater:download` / `updater:quit-and-install` / `updater:get-status` registered in `initUpdater()`. |
| Update events surfaced to renderer                          |  ✅    | `apps/desktop/src/preload/index.ts` exposes `window.updater.{onStatus, getStatus, checkForUpdates, downloadUpdate, quitAndInstall}`; `apps/desktop/src/renderer/components/UpdateToast.tsx` consumes the stream and is mounted in `App.tsx`. |
| Soft "no release" 404s suppressed                           |  ✅    | `_isNoReleaseError()` in `updater.ts` reclassifies the literal "No published versions on GitHub" / `404` patterns to a benign `no-release` status that the renderer renders silently. |
| Updater disabled cleanly in dev / non-tag CI artefacts       |  ✅    | When `_autoUpdateEnabled()` returns false, IPC handlers respond `{ ok: false, reason: 'no_release_channel' \| 'dev_build' }` and no GitHub query happens. |

**Net**: the updater code itself is correct.  No changes required.

## 2 · Build targets (PASS after fix)

| Check                                                                      | Result | Source |
|----------------------------------------------------------------------------|:------:|--------|
| Windows target is **NSIS only**                                            |  ✅    | `apps/desktop/electron-builder.yml` `win.target` = `[{ target: nsis, arch: [x64] }]`. |
| Windows portable target NOT produced                                       |  ✅    | No `target: portable` anywhere; `release-smoke` (`H9`) verifies this. |
| NSIS installer supports auto-update                                         |  ✅    | Default electron-updater `NsisUpdater` works with `oneClick: false` + per-user installs (`perMachine: false`).  Both set in `nsis:` block. |
| macOS target is dmg + zip                                                  |  ✅    | `mac.target` = `[{ dmg, [arm64,x64] }, { zip, [arm64,x64] }]`.  electron-updater on macOS specifically reads from the **zip**, not the dmg, for delta updates. |
| macOS auto-update blocked by signing/notarization?                         |  ⚠️    | YES — see §5.3.  No Apple Developer cert is configured (`mac.identity` placeholder commented out in `electron-builder.yml`).  Fails gracefully via the renderer's UpdateToast error state. |
| Linux AppImage update metadata uploaded                                     |  ✅ ¹  | **FIXED in this audit.**  CI Linux upload step now includes `latest-linux.yml`; release-draft `files:` list now attaches it. |

¹ Before this commit the Linux upload-artifact step uploaded only
`*.AppImage` and the release-draft `files:` list excluded all
`latest*.yml`.  electron-builder's `--publish always` on tag push
DID upload the yml directly to a draft release, but the
`workflow_dispatch + release_tag` path silently produced a release
without metadata, breaking Linux auto-update for any user who installed
that build.

## 3 · Release metadata (PASS after fix)

| File              | Platform | Purpose                                          | Uploaded by |
|-------------------|:--------:|--------------------------------------------------|-------------|
| `latest.yml`      | win      | electron-updater fetches to learn new version    | electron-builder `--publish always`; release-draft `files:` (this audit) |
| `latest-mac.yml`  | mac      | same, for `darwin`                                | electron-builder `--publish always`; release-draft `files:` (this audit) |
| `latest-linux.yml`| linux    | same, for AppImage                                | electron-builder `--publish always`; release-draft `files:` (this audit, **fix #1**) |

The `latest*.yml` files contain `{ version, files[].sha512, releaseDate }`.
electron-builder generates them automatically into `apps/desktop/out/`
during the build step.  Their content is verified locally:

```
$ cat apps/desktop/out/latest-linux.yml
version: 3.6.0-rc.1
files:
  - url: Louver-Mastering-AI-3.6.0-rc.1-linux-x86_64.AppImage
    sha512: ...
    size: 164233838
    blockMapSize: 172674
path: Louver-Mastering-AI-3.6.0-rc.1-linux-x86_64.AppImage
sha512: ...
releaseDate: '2026-05-06T13:36:22.488Z'
```

Filename templates configured in `electron-builder.yml`:

- Windows: `Louver Mastering AI-Setup-${version}.${ext}`
- macOS DMG: `Louver Mastering AI-${version}-${arch}.${ext}`
- All other targets: `Louver Mastering AI-${version}-${os}-${arch}.${ext}`

These match the `path:` field that electron-updater hashes — no
mismatch.

## 4 · Versioning (PASS after fix)

| Check                                                                 | Result | Notes |
|-----------------------------------------------------------------------|:------:|-------|
| `apps/desktop/package.json` `version`                                  |  ✅    | `3.6.0-rc.1` |
| `aimaster-desktop/package.json` `version` (root monorepo)             |  ✅    | `3.6.0-rc.1` |
| `@aimaster/shared-types` version                                       |  ✅    | `0.2.0` (additive Phase-D types) |
| `app.getVersion()` reports the new version                             |  ✅    | Electron reads from `apps/desktop/package.json` automatically; `electron-updater` compares this against `latest*.yml.version`. |
| Renderer `Settings → 정보 → 버전` row displays the right version       |  ✅ ²  | **FIXED in this audit** (fix #3).  Was using `import.meta.env.VITE_APP_VERSION` (never set) and falling back to `1.0.0`.  Now uses `__APP_VERSION__` (Vite `define`). |
| `electronAPI.version` (preload bridge)                                 |  ⚠️    | Falls back to `1.0.0` in packaged builds — `process.env.npm_package_version` only exists during pnpm/npm scripts, not at runtime.  No active call-site consumes this in v3.6.0-rc.1; not a release blocker, but a follow-up cleanup item.  See §5.5. |

² Confirms during install: open Settings → 정보 → 버전 in v3.5 vs v3.6
to verify the displayed version transitions correctly across an
auto-update.

## 5 · Existing user compatibility

### 5.1 Windows NSIS — ✅ GO

- Existing v3.5.0 user runs Louver Mastering AI v3.5 on Windows.
- 5 s after launch, `autoUpdater.checkForUpdates()` issues
  `HEAD https://github.com/freemilesarea-boop/AImastering/releases/latest/download/latest.yml`.
- Once v3.6.0 is published (NOT prerelease — see §5.4), the file is
  reachable; electron-updater compares `3.6.0 > 3.5.0` and emits
  `update-available`.
- UpdateToast renders "새 버전 v3.6.0" with [지금 받기] button.
- User clicks → `downloadUpdate()` streams the new
  `Louver Mastering AI-Setup-3.6.0.exe` into the user-data temp dir.
- User clicks "재시작" → `quitAndInstall(false, true)` runs the NSIS
  installer with the silent flag; new version replaces the old in
  place.

### 5.2 Windows portable — ❌ N/A (retired)

Portable target was removed in v3.4.4.  Any user who is still running a
portable v3.4.3 or earlier **cannot** auto-update — electron-updater
requires a writable installation directory (NSIS knows where to put the
new bytes; portable doesn't).  These users must:

1. Download the new NSIS installer from the v3.6.0 GitHub Release.
2. Run the installer (it'll install fresh — old portable folder can be
   deleted afterwards).
3. Future updates will then auto-flow.

This is documented in `RELEASE_NOTES_v3.5.0.md` already; nothing to
change.

### 5.3 macOS — ❌ NO-GO until signing lands

Auto-update on macOS REQUIRES a code-signed + notarized `.app` inside
the `.zip`.  Without notarization the OS Gatekeeper refuses to launch
the replacement process and electron-updater logs:

> Could not get code signature for running application

Currently `electron-builder.yml` has the `mac.identity` placeholder
commented out and the CI runner uses
`CSC_IDENTITY_AUTO_DISCOVERY: false`.  This is the **known limitation**
already documented in `RELEASE_NOTES_v3.6.0.md` §"Known Limitations" #1
and the updater.ts header.

**Implication for existing macOS users**: every macOS user installs
manually for v3.6 (via the unsigned ZIP per `TESTER_GUIDE_v3.6_RC.md`).
No auto-update path until v3.6.x ships with signing.

### 5.4 Linux AppImage — ✅ GO (after this commit)

Same flow as Windows but reads `latest-linux.yml`.  Two preconditions:

1. **`latest-linux.yml` is in the GitHub Release** — fixed by this
   audit (see §2 ¹).
2. **AppImage runs on the same architecture** — we only ship x64.
   ARM64 Linux users would need a separate target (out of scope).

### 5.5 Channel / prerelease semantics

- `v3.6.0-rc.1` (current branch version) contains the segment `rc`
  which is **not** a known electron-updater channel.  Without an
  explicit `channel:` in the publisher config, electron-updater treats
  this as the `latest` channel.
- The GitHub Release for `v3.6.0-rc.1` is created with
  `prerelease: true` (CI workflow: `release-draft` step).
- electron-updater defaults `allowPrerelease: false`, meaning
  **existing v3.5 stable users will NOT see v3.6.0-rc.1** — by design.
  RC builds are field-test only.
- For the **production v3.6.0** promotion, the maintainer must:
  1. Bump `package.json` versions from `3.6.0-rc.1` → `3.6.0`.
  2. Flip `prerelease: true` → `false` in `.github/workflows/build.yml`
     (release-draft step).
  3. Tag `v3.6.0`, push.
  4. After CI completes, review the draft release and click "Publish".

This is already in the GO/NO-GO acceptance bar in
`OPERATOR_HANDOFF_v3.6_RC.md` §8.

## 6 · Test plan (manual verification on a real Windows VM)

This is the smallest end-to-end check that proves auto-update works
across a real version bump.  Run before promoting `v3.6.0-rc.1` →
`v3.6.0`.

```
PRECONDITION: a published v3.5.x GitHub Release with latest.yml.

1. On a clean Windows 11 VM:
   download `Louver Mastering AI-Setup-3.5.0.exe` from the v3.5 release.
2. Install → run.  Verify TopBar shows app starts, Settings → 정보 →
   버전 reads `3.5.0`.
3. Quit the app.

4. On the maintainer machine:
   git tag v3.6.0
   git push origin v3.6.0
   → wait for CI to finish (~30 min, all 3 platforms).
5. In the GitHub Releases UI, find the new draft for v3.6.0.
   Verify each of the three latest*.yml files is attached as a
   release asset (not just the binaries).
6. Flip `prerelease: false` (was true for the RC tag), then click
   "Publish release".

7. Back on the Windows VM:
   re-launch the v3.5 installation.  Wait 5 s after the home page
   appears.  UpdateToast must show "새 버전 v3.6.0".
8. Click "지금 받기".  Watch the progress bar.  When complete, click
   "재시작".
9. App relaunches → TopBar / Settings → 정보 → 버전 must now read
   `3.6.0`.  Master a clip to verify the new binary works end-to-end.

10. Repeat steps 1-9 on a Linux VM with the v3.5 AppImage.  macOS is
    skipped because of §5.3.
```

## 7 · GO / NO-GO summary

| Component                       | Status | Action |
|---------------------------------|:------:|--------|
| `electron-updater` main process  |  ✅    | none |
| `__AUTO_UPDATE_ENABLED__` gate   |  ✅    | none |
| First-check timer + manual IPC   |  ✅    | none |
| UpdateToast renderer surface     |  ✅    | none |
| Windows NSIS target              |  ✅    | none |
| Windows portable retirement      |  ✅    | none |
| macOS dmg + zip target            |  ✅    | none |
| macOS code signing / notarization |  ❌   | OUT OF SCOPE for this audit; v3.6.x deliverable.  Document as known limitation (already done). |
| Linux AppImage target            |  ✅    | none |
| Linux `latest-linux.yml` upload   |  ✅ ¹ | **FIXED — CI Linux upload step + release-draft files list updated.** |
| Release metadata yml attached     |  ✅ ¹ | **FIXED — release-draft files list now includes all three yml files.** |
| `package.json` versions          |  ✅    | none |
| `app.getVersion()` source of truth |  ✅  | none |
| Renderer Settings 버전 row        |  ✅ ²  | **FIXED — uses `__APP_VERSION__` instead of unset `VITE_APP_VERSION`.** |
| `electronAPI.version` preload     |  ⚠️    | Returns `'1.0.0'` fallback in packaged builds.  Not auto-update-blocking; v3.6.x cleanup. |

**Verdict**: Windows NSIS and Linux AppImage auto-update paths are
GREEN after this commit.  macOS remains RED with documented manual-
download workaround pending the v3.6.x signing work.
