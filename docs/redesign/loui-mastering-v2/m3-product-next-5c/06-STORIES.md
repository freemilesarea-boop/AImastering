# M3-P-NEXT-5C — Storybook Preview Render States

> `Product / Preview Render` — 6 stories driving the real controller +
> mock transport.

---

## 1. Setup

Each story mounts `LouiPreviewControl` wired to a real
`PreviewRenderController` backed by a `MockPreviewRenderTransport`
(1000 ms simulated render).  An event log shows the request → response
sequence so the debounce / latest-wins behaviour is visible.

No live IPC — the mock transport stands in for the main-process handler.

---

## 2. Stories

### NoChanges

- `pendingCount = 0` → "Update Preview" button **disabled**.
- Status: "Preview reflects the original master".
- Verifies the button can't fire a pointless render.

### PendingChange

- `pendingCount = 1` → button **enabled**.
- Status: "Pending changes — update to hear them" (amber).
- The baseline interactive state.

### RenderingSuccess

- Click → request fires → 1000 ms "Re-rendering preview…" → success.
- Status flips to "Preview updated · HH:MM:SS" (green).
- Event log: `→ rendering req#1`, `✓ preview swapped → /tmp/...`.
- `pendingCount` resets to 0.

### RenderFailed

- Mock configured with `failWith: 'mock engine: render timed out'`.
- Click → "Re-rendering…" → failure.
- Status: "Render failed · mock engine: render timed out" (red).
- Event log: `✗ mock engine: render timed out`.
- No preview swap — previous preview retained.

### StaleResponseIgnored

- Click fires request A (-10), then request B (-8) 50 ms later.
- Both renders run (1000 ms each); A's response arrives first but is
  **dropped** (requestId stale); only B's swaps.
- Event log shows both `→ rendering` lines but a single `✓ swapped`.
- Demonstrates latest-wins.

### RapidDebounced

- Click queues three `request()` calls (-12, -11, -10) within the
  600 ms debounce window — WITHOUT `flush()`.
- Only ONE render fires, using the last value (-10).
- Event log: "queued 3 requests … → expect 1 render" then a single
  `→ rendering`.
- Demonstrates debounce coalescing.

---

## 3. Why a mock transport

The `Product / Preview Render` stories test the **renderer-side loop**
in full:
- pending-state computation
- debounce timing
- latest-wins / stale rejection
- success / failure UI
- preview-path propagation

…all without a Python engine.  The production path swaps the mock for
`IpcPreviewRenderTransport`, which calls the real handler — the only
difference is where the response comes from.

---

## 4. Reading the event log

The log interleaves controller lifecycle + outcome:

```
fired req A (-10) then req B (-8); only B should swap
→ rendering req#1
→ rendering req#2
✓ preview swapped → /tmp/mock_preview_2.mp3
```

`req#1`'s response is absent from the log (dropped as stale) — exactly
the latest-wins guarantee.

---

## 5. Total Storybook footprint

| Category | Components | Stories |
|---|---:|---:|
| Audio Panels        | 4 | 31 |
| Design System       | 1 | 2  |
| Product             | 7 | 43 |
| **Total**           | **12** | **76** |

`Product / Preview Render` adds 6 stories.  The `Product` category now
spans: ProductPage, Module Strip, Module Slide-Over, Controls,
Parameter State, Engine Dispatcher, Preview Render.

---

## 6. Manual verification (flag on, real app)

When run in the real app with `__LOUI_PRODUCT_LAYOUT__ = true` and a
mastered track:

1. Open the Limiter module → change Target LUFS.
2. The Preview strip shows "1 pending" + amber "Pending changes".
3. Click "Update Preview" → "Re-rendering preview…".
4. On success → audio swaps, "Preview updated · HH:MM:SS".
5. Playback resumes at the same position with the new loudness.

(Not executable in the CI/sandbox environment — no Python engine — but
the loop is verified via stories + the handler reuses `masterFile`.)
