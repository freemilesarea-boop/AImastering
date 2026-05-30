# M3-P-NEXT-5D-2-a — Preview / Export Consistency Policy

> What guarantees "what you preview is what you export", and how
> unpreviewed changes are surfaced.

---

## 1. The three override snapshots

| Snapshot | Meaning | Source |
|---|---|---|
| `currentRenderOverride` | the override implied by the CURRENT UI state | `summary.renderOverride` |
| `lastRenderedOverride`  | the override that produced the CURRENT preview | provider state, set on preview success |
| `exportOverride`        | the override sent to the export re-master       | `buildExportOverride(summary)` = `currentRenderOverride` |

Key relationships:
- `exportOverride === currentRenderOverride` — always (same source).
- `currentRenderOverride` may differ from `lastRenderedOverride` if the
  user changed something after the last preview update.

---

## 2. Policy: export uses current UI state

The export applies the **current** render override (current UI state),
NOT the last-previewed override.  Rationale: the user expects "export"
to reflect what they see on screen, not a stale preview.

But this creates a risk: the user might export changes they haven't
HEARD.  We mitigate with a warning, not a block.

---

## 3. The unpreviewed warning

```ts
hasUnpreviewedChanges = summary.patchHash !== hashOverride(lastRenderedOverride)
```

When true AND there are changes to apply, the export UI shows:

> ⚠ This export includes changes not previewed yet.

The user can still export (we don't block), but they're informed that
the exported audio may differ from what they last heard.

### Why warn, not block

Blocking would force a preview render before every export — annoying
when the user is confident in their settings.  A warning respects the
user's agency while preventing silent surprises.

---

## 4. "Export last previewed settings" (documented, not built)

A safe-mode alternative: export using `lastRenderedOverride` instead of
`currentRenderOverride`.  This guarantees the export matches the last
preview exactly.

Not built in 5D-2-a (adds UI complexity for an edge case).  Documented
here as a future option:

```ts
// Safe mode (future):
const exportOverride = useLastPreviewed
  ? lastRenderedOverride
  : summary.renderOverride;
```

A toggle "Export last previewed settings" would sit next to the
Re-master & Export button.  Deferred until user testing shows the
warning isn't sufficient.

---

## 5. Staged-only consistency

Staged-only changes (non-renderable params) are NOT in either preview or
export.  They're consistent (both omit them) but the user is told:

> N staged-only changes not applied to this export (no render mapping yet).

So there's no hidden inconsistency — preview, export, and the UI all
agree that staged-only params don't affect the audio yet.

---

## 6. Consistency matrix

| Scenario | Preview reflects | Export reflects | Consistent? |
|---|---|---|---|
| No changes                       | base | base | ✓ |
| Changed + previewed + exported   | change | change | ✓ |
| Changed, NOT previewed, exported | base (stale) | change | ⚠ warned |
| Staged-only change               | base | base | ✓ (both omit) |
| Renderable + staged-only mix     | renderable only | renderable only | ✓ (staged-only labelled) |

The only "inconsistent" row is fully surfaced by the unpreviewed
warning.

---

## 7. Hash-based equality

Both consistency checks use the deterministic `hashOverride`:
- `summary.patchHash` = hash of `currentRenderOverride`
- `hashOverride(lastRenderedOverride)` = hash of the previewed override

Equality is order-independent (keys sorted), so reordering parameter
changes never produces a false "unpreviewed" warning.

---

## 8. Future: preview-then-export coupling

When auto-render lands (5D-3), the preview will update continuously, so
`lastRenderedOverride` tracks `currentRenderOverride` closely and
`hasUnpreviewedChanges` is rarely true.  At that point the warning
becomes a rare-edge safeguard rather than a common state.

Until then (explicit "Update Preview"), the warning is the primary
mechanism keeping the user informed when export ≠ last preview.
