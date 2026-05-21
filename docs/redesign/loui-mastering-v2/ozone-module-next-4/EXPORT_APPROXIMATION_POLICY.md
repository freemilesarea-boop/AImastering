# EXPORT_APPROXIMATION_POLICY

> Why the "approximate" export bucket is empty today.

---

## Considered

The brief suggested approximating EQ tone / dynamics in the export via
existing engine fields — e.g. nudging `style` (warm/bright) or
`saturationAmount` when the user boosts air/presence, or scaling
`limiterStrength` from the dynamics knobs.

## Rejected (for now)

- **Lossy + surprising.** `style` is a discrete, fixed EQ-overlay +
  comp-preset bundle; the user's continuous low-shelf/presence/air dB do
  not map to it.  Auto-switching `style`/`saturationAmount` would silently
  override the user's explicit Preset/Style choice — the opposite of
  trustworthy.
- **Not "the same tone".** A 3 kHz presence cut ≠ switching to "warm";
  approximating it would mislabel the result.
- The brief forbids marking unsupported params as export-exact AND forbids
  adding Python DSP.  An honest "approximate" would need (a) a defensible
  mapping and (b) a clear, opt-in UI — neither is justified yet.

## Decision

Keep EQ tone / Dynamics / low-mono / limiter lookahead+ISP as
**preview-only** (honest).  The `approximate` support level exists in the
type system + UI for a future, explicit, opt-in "approximate export"
feature, but **no parameter is auto-approximated today** — enforced by the
selftest (`no param is "approximate"`).

## If we add it later

It must be: explicit (a user toggle "approximate tone in export"), clearly
badged "Export approximate", and never silently change Style/Saturation
the user set.
