# Calibration Evidence

Canonical, repository-managed location for calibration run evidence.

## Why this directory exists

The P1 calibration run produced 1,400 renders and eighteen artifacts under
`~/Desktop/Closed-Loop-Calibration-P1-Output`. That directory no longer exists.
A later audit could not determine how many renders were missing, how many were
duplicates, how many were corrupt, or whether any mapping had ever been
promotable — every one of those questions was answerable only from data that had
been written outside version control and then deleted.

Evidence written here is inside the repository, so losing it takes a deliberate
commit rather than a folder deletion.

## Layout

```
calibration-evidence/
  runs/
    <run_id>/
      manifest.json          # run identity, expected/found counts, config hash
      candidates/<id>.json   # one record per candidate that PASSED
      failures/<id>.json     # one record per candidate that did not
      summary.json           # derived counts and validity, never asserted
      renders/               # rendered audio — NOT committed (see below)
```

## What is and is not committed

Committed — small, textual, and the only thing that can reconstruct a run:

- `manifest.json`, `summary.json`
- every candidate record and every failure record
- all hashes and extracted feature data

Not committed — large and reproducible from the records plus the source audio:

- rendered WAV files (`renders/`, `*.wav`, `*.flac`, `*.aiff`)

A record stores `render_sha256` and `render_bytes`, so a re-render can be
verified against the original bit-for-bit without the original being kept.

## Rules

1. **Failures are recorded.** A run is complete when
   `successes + failures == expected_candidate_count`. Without failure records,
   "absent" and "failed" cannot be told apart and completeness is uncheckable.
2. **Measurements, not verdicts.** `safety_pass` is stored alongside the true
   peak, sample peak, clipping count, ISP overshoot, loudness and mono
   compatibility it was derived from, so a changed threshold can be re-applied
   without re-rendering.
3. **Append-only.** Writing a `candidate_id` that already exists is an error.
4. **No absolute paths, no personal data.** Track paths are relative to the
   dataset root. Absolute paths, machine temp directories, usernames and email
   addresses are rejected at write time.
5. **Deterministic.** Same input, same engine commit, same candidate produce
   byte-identical canonical JSON and therefore identical hashes.

## Code

- `app/mastering/calibration/evidence.py` — schema, canonical form, hashing, store
- `app/mastering/calibration/evidence_validator.py` — completeness validation

Set `AIMASTER_CALIBRATION_EVIDENCE_DIR` to write elsewhere (tests, CI).
