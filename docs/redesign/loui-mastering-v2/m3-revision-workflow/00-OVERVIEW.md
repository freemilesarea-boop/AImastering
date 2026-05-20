# M3-REVISION-WORKFLOW — Multiple Mastering Versions per Source

> Turn Loui from "master once and you're done" into a workstation: from
> one upload, render many versions, keep them all, compare, and download —
> without clearing the queue.  No DSP / Python / export-pipeline rewrite.

---

## 1. What shipped

| # | Deliverable | Where | Status |
|---|---|---|---|
| 1 | Result-state audit | `REVISION_STATE_AUDIT.md` | ✓ |
| 2 | Revision data model | `audio/revisions/revision-types.ts` + `revision-logic.ts` | ✓ |
| 3 | Store integration | `audioStore` `revisionGroup` + actions | ✓ |
| 4 | New-version flow | bridge `onCreateRevision` → `audio:master` → `addRevision` | ✓ |
| 5 | Revision list UI | `LouiRevisionStack` + 7 stories | ✓ |
| 6 | Active revision → preview/export | ProductPage derives sources from active revision | ✓ |
| 7 | Load settings from revision | "이 설정으로 편집" → restore options (+ preset) | ✓ |
| 8 | A/B = baseline vs active | A = Revision 1, B = active revision | ✓ |
| 9 | Cleanup policy | `CLEANUP_POLICY.md` | ✓ |
| 10 | Storybook states | one/multiple/active/rendering/failed/duplicate/interactive | ✓ |
| 11 | Verification | this doc §3 | ✓ |

---

## 2. How it works

```
first master (HomePage) ──seed──▶ Revision 1 (active)
edit settings / preset
  └─ "+ 새 버전 만들기" ─▶ audio:master(current options) ─▶ Revision 2 (active)
                                                            └─ Revision 3 …
select a revision ─▶ preview source + Export As-is target + A/B "B" switch to it
"이 설정으로 편집" ─▶ load that revision's options (+ preset) back into the editor
```

- `audio:master` is reused unchanged — a revision IS a full master
  (`{outputPath, previewPath, metrics}`).
- Pure `revision-logic.ts` (add / select / remove / rename / favorite /
  duplicate-detect) is unit-tested headlessly.
- Each revision card: play (select), WAV save, format save, rename
  (double-click), favorite, delete (never the last), "이 설정으로 편집".
- Failure keeps prior revisions (create errors surface in the stack;
  the group is untouched on failure).

---

## 3. Verification

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm test:revision` | **11/11** (init/add/select/baseline/remove/rename/favorite/duplicate/labels) |
| `pnpm build:renderer` / `build:main` | OK |
| `pnpm build-storybook` | OK (+ revision stack stories) |
| `cargo test -p loui-dsp --lib` | 54/54 |
| full desktop suite + preset selftests | no regression (22/22 · 14/14 · 11/11) |
| first master → Revision 1 | seeded on ProductPage mount |
| new version w/o clearing queue | `audio:master` → appended, prior kept |
| active preview / export switch | derived from active revision |
| existing single-master flow | unchanged (group is additive; null = legacy behaviour) |

---

## 4. Constraints honoured

No DSP change · no Python pipeline rewrite · no export-pipeline rewrite ·
realtime flag default OFF · ResultPage/V1 intact · queue structure
preserved (revisions are additive store state).

Note: live audio/render verification needs the Electron app (no audio
device / Python engine in the sandbox); logic + build + stories verified
here. On-device QA recommended for the render→compare→download loop.
