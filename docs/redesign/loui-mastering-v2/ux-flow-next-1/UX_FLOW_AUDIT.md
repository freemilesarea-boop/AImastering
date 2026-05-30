# UX-FLOW-NEXT-1 — Navigation / Page Flow Audit

> How screens transition today, and what blocked "upload → tweak → listen".

---

## 1. Routing

- `App.tsx` switches on `appStore.currentPage`; `'result'` → ProductPage
  (behind the product-layout flag + error boundary → ResultPage fallback).
- HomePage `handleViewResult(item)` set file + analysis + masteringResult,
  then `setPage('result')` — but it **required** a finished
  `masteringResult` (`if (!item.analysis || !item.masteringResult) return`).

## 2. The blocker

- ProductPage's preview source came only from a master result / revision
  preview → with no result, `basePreviewSrc` was `''` (nothing to play).
- There was no way to enter the workspace before mastering, and no Back
  button (only the "Import" top-bar button, which also goes home).

## 3. State that must survive Back

- `queue`, `revisionGroup`, `options` live in `audioStore`.  `setPage('home')`
  does NOT clear them — only `clearQueue` / `reset` do.  So Back =
  `setPage('home')` is safe (session preserved).

## 4. Source / preview wiring

- `sourceAudioPath = audioStore.selectedFile`; `toFileUrl(path)` is a safe
  preview URL the `<audio>` element + analyzer can play.
- The realtime graph inserts the chain on the SAME audio element, so a
  source preview is tweakable live (flag ON).

## 5. What this milestone adds

| Gap | Fix |
|---|---|
| No Back button | `LouiTopBar.onBack` → `setPage('home')` (keeps queue + versions) |
| Can't enter before master | HomePage "조절하며 듣기" (`handleTweakListen`) → `setPage('result')` with no result required |
| ProductPage needs a result | Source-preview mode: `basePreviewSrc` falls back to the source file; `hasResult` gates A/B + export |
| Stale revisions on file switch | clear the group when `sourceAudioPath` changes |
| First version from scratch | revision empty-state + "새 버전 만들기" (existing `onCreateRevision`) → Revision 1 |
