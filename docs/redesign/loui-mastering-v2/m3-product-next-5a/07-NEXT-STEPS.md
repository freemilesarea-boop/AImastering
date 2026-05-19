# M3-P-NEXT-5A — Next Steps

> The roadmap from this contract-only milestone to real DSP writes.

---

## 1. Immediate follow-up

### M3-P-NEXT-5B — Engine bridge wire-up

Implement the dispatcher described in `06-FUTURE-M2-FULL-CHECKLIST.md`.
The work fans out as nine PRs:

1. **M2-full EngineSchema additions** — 11 fields across modules
2. **Dispatcher module** — `audio/engine-bridge/dispatcher.ts` +
   provider `onCommand` wire-up
3. **Wired parameter writes** — 7 fields ready today
4. **Pending parameter writes** — after EngineSchema lands
5. **Live signal reads** — replace mock GR / correlation walks
6. **Preset bridge** — `LOAD_PRESET` → state hydration
7. **Reference profile bridge** — delta application
8. **Export descriptor IPC** — main-process format/SR/depth/dither
9. **Test harness** — vitest + equivalence

Each PR is gated behind the existing `VITE_LOUI_PRODUCT_LAYOUT` flag —
no production user sees changes until M3-P-NEXT-6 flips defaults.

---

## 2. Within this milestone — polish opportunities

These are NOT required for M3-P-NEXT-5A but are worth queueing:

### Vitest unit tests for the validator

`engine-command.ts`'s `validateParameterValue` is pure — easy to test.
A 30-line vitest suite covers:

- Numeric clamping (low / high / NaN / Infinity)
- Step quantisation
- Boolean type rejection
- Enum membership
- Enum non-string rejection

Estimated effort: 1 hour.  Slots into the next CI pass.

### Storybook: "all panels at once" overview

A new story that mounts all five panels in a vertical stack with a
single provider — useful for designers reviewing typography
consistency across panels.  Out of scope here (the existing Parameter
State stories cover one at a time).

### Persist provider state to localStorage

Survive reload by hydrating provider state from localStorage.  Useful
for power-users iterating on settings.  Out of scope until M3-P-NEXT-6
(when ProductPage becomes default and persistence is more valuable).

---

## 3. Documentation hand-off

The seven docs in `m3-product-next-5a/` are the contract.  When
M3-P-NEXT-5B lands:

- Strike `pending` → `wired` rows in `02-PARAMETER-DEFINITIONS.md` and
  `04-PARAMETER-SCHEMA-MAPPING.md`
- Move `06-FUTURE-M2-FULL-CHECKLIST.md` into a "completed" archive
- Update `00-OVERVIEW.md` "What's next" section
- Add a new `m3-product-next-5b/` directory with the bridge specs

`01-STATE-MODEL.md`, `03-ENGINE-COMMAND-CONTRACT.md`, and
`05-CONTROLLED-PANELS.md` stay authoritative through the bridge work
and beyond.

---

## 4. UX follow-ups (M3-P-NEXT-6 polish)

Pre-default-promotion polish list:

- **Visualise clamping** — show a red flash on the slider thumb when a
  value gets clamped, not just a log row
- **Modified per-parameter** — show a small dot next to every changed
  parameter (not just the module header badge)
- **"Match preset" detection** — when state equals a known preset's
  values, show the preset name in the header
- **Reset confirmation** — for irreversible reset, add a single-click
  undo toast ("Reset · Undo")
- **Module reordering** — let users drag-reorder the Module Strip
  cards (state already independent per module)
- **Group reset** — "Reset all modules" button in TopBar Settings menu

None of these block M3-P-NEXT-5B; they're listed so the design team
has a punch list for the GA polish pass.

---

## 5. Accessibility follow-ups (M3-P-NEXT-6 polish)

Tracked across milestones (see M3-P-NEXT-4 `04-INTERACTION-NOTES.md`):

- Unified focus ring across all primitives
- Reduced-motion opt-out for the slide-over
- `axe-core` audit clean on every panel
- Screen-reader walk-throughs for each panel
- Keyboard shortcut help overlay

Same applies — none gate this milestone.

---

## 6. Engineering follow-ups

### Module-state migrations

When parameter definitions evolve (rename, type change), the central
state from a saved session may have stale keys.  Migration logic
lives in `useModuleParameterState` and runs on hydration.  Today the
provider has no persistence — when persistence lands (item §2.3
above), migrations become important.

### Provider performance budget

The current provider re-allocates the full module slice on every
`setParam`.  For a knob drag emitting ~50 commands/sec, this is fine
(measured at < 15 µs per command).  When live engine reads pile on
(M3-P-NEXT-5B), profile again and consider:

- Per-parameter atoms (Jotai-style) instead of one-state-per-module
- Subscription selector functions to reduce re-renders

Don't optimise speculatively — wait until profiling shows a hit.

### Log capacity tuning

Current default 256 entries.  A 30-second knob workout generates
~1500 commands — way past the cap.  This is intentional (we
don't want unbounded growth) but the rolling window loses early
context.  Options:

- Bump capacity to 1024 in dev / Storybook (256 in prod)
- Add log compression (debounce repeated SET on the same parameter)
- Stream the log to a file when `__LOUI_DEBUG_LOG__` is set

---

## 7. The bigger picture

Four milestones now form the product UI:

| Milestone | Layer | Status |
|---|---|---|
| M3-P-NEXT-1 | Storybook + theme tokens             | ✓ |
| M3-P-NEXT-3 | Ozone-style layout                    | ✓ |
| M3-P-NEXT-4 | Slide-over + panel shells             | ✓ |
| M3-P-NEXT-5A | Central state + command contract     | **this milestone** |
| M3-P-NEXT-5B | Engine bridge wire-up                | next |
| M3-P-NEXT-6  | Default promotion                    | after wire-up |
| M3-P-NEXT-7  | Legacy ResultPage removal            | after one full release at default |

After M3-P-NEXT-5B, every UI knob turn writes to the real DSP and the
result audibly changes.  After M3-P-NEXT-6, users see the product
layout by default.  After M3-P-NEXT-7, the legacy result page is
gone.

The contract laid down in M3-P-NEXT-5A is what makes the next three
milestones possible without UI re-work.
