# Field test log — v3.6.0-rc.1

> Maintainer-facing tracking sheet.  Fill in as testers come back.
> The aggregate script (`pnpm --filter @aimaster/desktop aggregate-bundles
> -- <dir>`) ingests the JSON bundles named in this file and produces a
> rollup for the GO / NO-GO meeting.

Build under test:
- Branch / commit:
- Tag (if any):
- Win NSIS installer artifact URL:
- macOS arm64 ZIP artifact URL:
- macOS x64 ZIP artifact URL:
- Linux AppImage artifact URL:

Test window opens / closes:

---

## Tester roster (5 slots — fill what you have, leave rest blank)

| # | Tester ID | Profile | Platform | Hardware notes | Invited | Bundle in | Status |
|---|-----------|---------|----------|---------------|--------|-----------|--------|
| 1 |           | AI music user             |          |               |        |           | pending |
| 2 |           | KPOP vocal track          |          |               |        |           | pending |
| 3 |           | Playlist creator (batch)  |          |               |        |           | pending |
| 4 |           | Low-spec Windows          |          |               |        |           | pending |
| 5 |           | macOS                     |          |               |        |           | pending |

**Status legend** — `pending` / `installed` / `running` / `bundle-received` /
`reviewed` / `blocked` (blocked = tester ran into an install or first-launch
issue we couldn't unblock; needs maintainer follow-up).

---

## Per-tester notes

For each tester, paste the bundle filename (saved under
`docs/field-test/<tester>/aimaster-support-*.json` in this repo or in a
private archive) and a short summary.  Add new sub-headings as needed.

### Tester 1 — _AI music user_
- Bundle file:
- Scenarios run:
- Free-form notes:

### Tester 2 — _KPOP vocal_
- Bundle file:
- Scenarios run:
- Free-form notes:

### Tester 3 — _Playlist creator_
- Bundle file:
- Scenarios run:
- Free-form notes:

### Tester 4 — _Low-spec Windows_
- Bundle file:
- Scenarios run:
- Free-form notes:

### Tester 5 — _macOS_
- Bundle file:
- Scenarios run:
- Free-form notes:

---

## Aggregate rollup (paste output of `aggregate-bundles`)

```
$ pnpm --filter @aimaster/desktop aggregate-bundles -- /path/to/bundles

(paste the markdown here)
```

---

## Install-UX observations

For each platform tested, paste the user-facing copy seen on first launch.
This catches Windows Defender / SmartScreen / Gatekeeper regressions early.

| Platform | First-launch behavior | Workaround user followed | Time-to-success | Notes |
|----------|----------------------|--------------------------|----------------:|-------|
| Win11 x64 (Defender on)  |  |  |  |  |
| Win10 x64 (no Defender)  |  |  |  |  |
| macOS 14 arm64 (Gatekeeper) |  |  |  |  |
| macOS 14 x64                 |  |  |  |  |
| Linux x64 (no fuse)          |  |  |  |  |

### Korean / special-character path coverage

| File path | Status | Notes |
|-----------|--------|-------|
| `한글_트랙.wav`        |        |       |
| `Track #2.mp3`        |        |       |
| `What is this?.mp3`   |        |       |
| `My Track v2.wav`     |        |       |

### Missing-ffmpeg environments

| Platform | `which ffmpeg` returned | Bundled binary used | Result |
|----------|-------------------------|---------------------|--------|
| Win11 (no ffmpeg installed) |  |  |  |
| macOS (no Homebrew ffmpeg)  |  |  |  |

---

## Decision log

After all bundles arrive, the maintainer fills this in:

| Decision    | Rationale | Date | Approver |
|-------------|-----------|------|----------|
| Promote v3.6.0-rc.1 → v3.6.0 |  |  |  |
| Cut v3.6.0-rc.2             |  |  |  |
| Hold for upstream fix       |  |  |  |

Acceptance bar (from `QA_v3.6_RC.md`):

- [ ] All P0 cases PASS on at least 2 testers per platform
- [ ] No `recentFailures` entry of severity > advisory in any bundle
- [ ] No leak of `/Users/`, `/home/`, `outputPath` etc. in any bundle
- [ ] License-secret production gate verified (A9 / A10)
- [ ] Live loudness meter (E3) confirmed by at least 1 tester
- [ ] Phase-D analyzer cases (F1–F5) remain DEFERRED — not a blocker
