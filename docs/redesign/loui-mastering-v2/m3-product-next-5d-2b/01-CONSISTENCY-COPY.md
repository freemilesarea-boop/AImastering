# M3-P-NEXT-5D-2-b — Consistency Copy

> The exact UI strings that keep the two export paths unambiguous.

---

## 1. Why copy matters here

Two export buttons sitting next to each other is a classic source of
confusion ("which one do I press?").  Clear, consistent copy is the
difference between a confident export and a support ticket.

---

## 2. Button labels

| State | Export As-is | Re-master & Export |
|---|---|---|
| Default              | `Export As-is` | `Re-master & Export` |
| No master rendered   | `No master yet` (disabled) | (disabled) |
| No changes           | `Export As-is` (primary)   | `No changes` (disabled) |
| In progress          | `Saving…`      | `Re-mastering…` |

---

## 3. Help line (always shown)

> Export As-is saves the current rendered master.  Re-master & Export
> applies the latest parameter changes first (slower).

One sentence per path, parallel structure, the speed trade-off stated
plainly.

---

## 4. Unrendered-changes warning

Shown only when there are renderable changes AND they haven't been
previewed:

> ⚠ You have unrendered changes.  Export As-is will not include them;
> Re-master & Export applies the latest changes first.

This single line tells the user:
- there ARE changes
- Export As-is will SKIP them
- Re-master & Export will APPLY them

---

## 5. Staged-only note

Shown when non-renderable params changed:

> N staged-only changes not applied to either export (no render mapping
> yet).

"either export" is deliberate — neither path can apply staged-only
params, so the user isn't misled into thinking Re-master will include
them.

---

## 6. Status lines (per path)

| Path | Success | Failure |
|---|---|---|
| Export As-is       | `✓ Saved (as-is) → {path}` | `✗ Saved (as-is) failed · {error}` |
| Re-master & Export | `✓ Re-mastered & exported → {path}` | `✗ Re-mastered & exported failed · {error}` |

The verb makes it unambiguous WHICH action produced the status, even
though both lines can be visible at once.

---

## 7. Badge copy

| Badge | Meaning |
|---|---|
| `Changes · N renderable` | how many params will be applied by Re-master |
| `Skip · N staged-only`   | how many changed params neither path applies |

---

## 8. Tone principles

- **Plain English** — "saves the current master", not "persists the
  rendered artifact".
- **State the cost** — "(slower)" on Re-master so the user isn't
  surprised by latency.
- **Never hide a skip** — staged-only + unpreviewed are always
  surfaced, never silent.
- **Parallel structure** — the two help sentences mirror each other so
  the contrast is instant.

---

## 9. Future copy (5D-2-c+)

When format / sample-rate / bit-depth wire into the export, add:

> Exporting as {format} · {sampleRate} · {bitDepth}.

…above the buttons, so the user confirms the file spec before saving.
Deferred until 5D-2-c/d wire those controls.
