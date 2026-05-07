# RC build runbook — v3.6.0-rc.1

> Maintainer's checklist for producing the Win NSIS + macOS ZIP RC
> installers that go to the 5 internal testers.  Honest about the
> environment requirements: macOS-signed builds REQUIRE the macOS
> runner; Windows builds REQUIRE the Windows runner.  Producing them
> from a Linux laptop is not a supported path.

---

## 1 · Prerequisites

| Need | Where |
|------|-------|
| Branch `claude/add-section-analysis-ui-kFBNW` (or whatever the RC branch is) up-to-date |  |
| `services/python-audio` ready for PyInstaller (handled by CI) |  |
| FFmpeg static binaries available via `pnpm install` (`ffmpeg-static`, `@ffprobe-installer/ffprobe`) | Both already in `apps/desktop/devDependencies`. |
| `LICENSE_HMAC_SECRET` injected into the CI runner secrets BEFORE build (≥ 16 chars, not the dev fallback) | GitHub repo settings → Secrets → Actions. |

---

## 2 · Triggering the RC builds via CI

The existing `.github/workflows/build.yml` produces all three platforms
in parallel.  Two ways to trigger it:

### A · Tag push (production-style)

```bash
git tag v3.6.0-rc.1
git push origin v3.6.0-rc.1
```

This sets `AUTO_UPDATE_ENABLED=true` and (if all 3 platform jobs succeed)
runs the `release-draft` job that bundles a draft GitHub Release using
`docs/RELEASE_DRAFT_v3.6.0.md` as the body.  `prerelease: true` is set in
the workflow so the draft is marked as a pre-release.

### B · Manual `workflow_dispatch` (no tag)

GitHub UI → Actions → "Build Louver Mastering AI" → Run workflow.
Leave `release_tag` empty if you don't want a release-draft attached.
Build artifacts still upload under `Louver-Mastering-AI-{linux,mac,windows}`
in the run's Artifacts panel.

---

## 3 · What artefacts to download

After the workflow run finishes, the runner uploads:

| Platform | Artifact name | Files inside |
|----------|---------------|--------------|
| Windows  | `Louver-Mastering-AI-windows` | `Louver Mastering AI-Setup-3.6.0-rc.1.exe`, `latest.yml` |
| macOS    | `Louver-Mastering-AI-mac`     | `Louver Mastering AI-3.6.0-rc.1-arm64-mac.zip`, `…-x64-mac.zip`, `latest-mac.yml` |
| Linux    | `Louver-Mastering-AI-linux`   | `Louver Mastering AI-3.6.0-rc.1-linux-x86_64.AppImage` |

Distribute the `.exe`, `.zip`, and `.AppImage` to testers.  The `latest*.yml`
files are auto-update metadata for **future** RCs, not needed by manual
testers.

---

## 4 · Pre-distribution checklist

Run on a maintainer machine before sending links to testers:

```bash
cd aimaster-desktop
pnpm install
pnpm typecheck                                 # must be clean
pnpm --filter @aimaster/desktop build
pnpm --filter @aimaster/desktop test           # 81 PASS / 0 FAIL
pnpm --filter @aimaster/desktop test:release-smoke
( cd services/python-audio && pytest -q )      # 79 passed / 41 skipped
```

Then for each downloaded installer:

| Installer | Spot-check |
|-----------|-----------|
| Windows `.exe`   | SHA256 hash matches CI run summary; file size ~150 MB or larger; opens NSIS welcome screen on a clean Win11 VM. |
| macOS `.zip`     | Unzip on macOS; `app.app/Contents/Resources/bin/{ffmpeg,ffprobe}` are executable; `xattr -dr com.apple.quarantine` workaround documented in tester guide works. |
| Linux AppImage   | `chmod +x` then `--appimage-extract-and-run` opens the home page. |

If anything fails: do NOT ship to testers.  File the failure in
`FIELD_TEST_LOG_v3.6_RC.md` under "Decision log" with `Hold for upstream fix`.

---

## 5 · Distribution

1. Upload installers to the internal artifact bucket (or the GitHub
   Release draft if §2A was used).
2. Send each tester:
   - their tester ID
   - the platform-specific download link
   - a copy of `TESTER_GUIDE_v3.6_RC.md`
   - a date by which to send back the support bundle (default: 7 days)
3. Mark them as `installed` in `FIELD_TEST_LOG_v3.6_RC.md`.

---

## 6 · Bundle ingestion

When bundles come back, drop them in a temp dir and run:

```bash
pnpm --filter @aimaster/desktop aggregate-bundles -- /path/to/bundles
```

Paste the resulting markdown into the **Aggregate rollup** section of
`FIELD_TEST_LOG_v3.6_RC.md`.

---

## 7 · GO / NO-GO

The acceptance bar is in `FIELD_TEST_LOG_v3.6_RC.md` ("Decision log").
On GO:
- Update `RELEASE_DRAFT_v3.6.0.md` to remove the `prerelease: true` flag
  (in `.github/workflows/build.yml`) and remove `-rc.1` from package
  versions (`apps/desktop/package.json`, root, `shared-types`).
- Tag `v3.6.0` and push.

On NO-GO:
- File a hardening commit on this branch.
- Bump to `v3.6.0-rc.2` (across all 3 packages) and re-trigger CI.
- Re-do the field test cycle.
