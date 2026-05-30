# M3-REVISION-WORKFLOW — Persistence / Cleanup Policy

> Lifetime + cleanup of revision temp files.

---

## 1. Where revision files live

Every revision's `outputPath` (WAV) and `previewPath` (MP3) are written by
`audio:master` into the OS temp dir (`os.tmpdir()`), with human-readable
names (e.g. `song_master_balanced_-14LUFS.wav`).  These are the SAME temp
files the existing single-master flow already produces — revisions just
keep references to more of them.

## 2. Lifetime

| Scope | Behaviour |
|---|---|
| Session | `revisionGroup` lives in the in-memory zustand store. |
| New source / queue clear / reset | `clearQueue` + `reset` set `revisionGroup = null` (references dropped). |
| App quit | Temp files remain in `os.tmpdir()`; reclaimed by the OS temp-cleaning policy (unchanged from before this milestone). |
| User export | `file:save-wav` / `file:save-audio` copy to a user-chosen path — **permanent, never touched by cleanup**. |

## 3. Revision deletion policy (decided)

- `removeRevision` drops the revision from the group (and re-points active).
- It does **NOT** unlink the temp WAV/MP3.  Rationale: the same temp file
  may be referenced elsewhere (e.g. it was the `masteringResult` the page
  seeded from), and aggressive unlinking risks breaking an in-flight
  `<audio>` src or an export.  OS temp reclamation handles disk hygiene.
- The **source file is never deleted** by any revision action.

## 4. Future enhancement (documented, not implemented)

- Reference-count temp paths and `fs.unlink` a revision's files on delete
  once no other revision/active-preview references them.
- An explicit `app.on('before-quit')` sweep of Loui-created temp files.

Both are additive and out of scope here (no DSP/pipeline change); the
current policy leans on the existing OS-temp behaviour, which already
governed the single-master flow.
