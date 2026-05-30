# UX-FLOW-NEXT-1 — Back Navigation + Upload→Tweak/Listen Workspace

> Move Loui from "set options → render once" to "upload → listen + tweak →
> make versions".  Source-preview mode (no master needed), a Back button
> that keeps the session, and first-revision creation.  No queue-clearing,
> no re-uploading, no result-only restriction.

---

## 1. What shipped

| # | Deliverable | Where | Status |
|---|---|---|---|
| 1 | Flow audit | `UX_FLOW_AUDIT.md` | ✓ |
| 2 | Back navigation | `LouiTopBar.onBack` → `setPage('home')` (keeps queue + versions; tooltip "파일과 버전은 유지됩니다") | ✓ |
| 3 | Upload → workspace entry | HomePage "조절하며 듣기" per queued file → `handleTweakListen` (no master required) | ✓ |
| 4 | Source-preview mode | ProductPage plays the ORIGINAL when no result; A/B + export gated off | ✓ |
| 5 | Realtime tweak before render | existing live path (preset / EQ drag / sliders) works in source-preview; realtime status chip explains live vs Update-Preview | ✓ |
| 6 | First revision generation | revision empty-state + "새 버전 만들기" → Revision 1 (reuses onCreateRevision; Python or Rust-exp) | ✓ |
| 7 | Existing revision workflow | unchanged (add Revision 2/3, per-revision save/export) | ✓ |
| 8 | UX copy | empty-state + realtime-status + Back tooltip strings | ✓ |
| 9 | Storybook | revision no-version / creating / failed; top bar with/without Back | ✓ |
| 10 | Verification | this doc §2 | ✓ |

---

## 2. Verification

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm build:renderer` / `build:main` / `build-storybook` | OK |
| `cargo test -p loui-dsp --lib` | 54/54 |
| full desktop suite + all module/rust/export/preset/revision selftests | no regression |
| open workspace before master | source-preview plays original; no crash with null result |
| Back → home keeps queue + revisions | `setPage('home')` (no clear) |
| first revision | empty-state CTA → onCreateRevision → Revision 1 active |
| existing revision workflow | unchanged |
| export with no version | disabled (no `activeOutputPath`) |
| preset browser / EQ drag / live visualizer | untouched |

---

## 3. Constraints honoured

Back ≠ clear queue · no re-upload required · ProductPage is NOT result-only
(source-preview mode) · existing Revision workflow kept · export pipeline
not rewritten · realtime flag default OFF · Python pipeline kept ·
ResultPage/V1 intact.

On-device QA recommended for the live tweak-while-listening loop (no audio
device in the sandbox); flow logic verified via typecheck + builds + stores.
