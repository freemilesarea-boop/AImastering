# REALTIME-PASSTHROUGH — "starting / passthrough / config pushes 0"

> Observed: Realtime Preview enabled, `readiness: realtime-ready`, but
> `status: starting`, `worklet: passthrough`, `config pushes: 0`,
> `avg process: 0.000 ms`, and playback `0:00 / 0:00`. Module edits are
> inaudible.

## 1. Root cause (verified in code)

The realtime graph can only attach onto the analyzer **session**, and the
session is created by `WasmAnalyzerProvider` only when **both**:

```
// wasm-analyzer-context.tsx:94
if (!active || !mediaElement) { setSession(null); return; }
```

- `mediaElement` is `meterReady ? audioRef.current : null`, and `meterReady`
  flips to `true` only in the `<audio onLoadedMetadata>` handler
  (`ProductPage.tsx:1297-1306`).
- `active` is `playing`.

So the dependency chain to a *processing* realtime preview is:

```
playable src → <audio> fires loadedmetadata → meterReady=true
   → provider gets mediaElement → (while playing) creates session + MediaElementSource
   → useRealtimeMasteringGraph sees session ≠ null → attaches worklet node
   → setInsertNode wires source→node→tap→destination
   → AudioContext running → process() pulled every quantum
   → worklet posts metrics → avg process > 0 → ACTIVE
```

The reported state breaks at the **very first link**: duration `0:00 / 0:00`
means the audio element never loaded metadata, so:

- `meterReady` stays `false` → `mediaElement` is `null`
- `WasmAnalyzerProvider` keeps `session = null`
- `useRealtimeMasteringGraph` early-returns (`!session`) → **no graph, no
  attach, no config push** → `config pushes: 0`
- nothing pulls the worklet → `process()` never runs → `avg process 0`,
  `worklet: passthrough`

### Secondary honesty bug

Even once the node *is* spliced, the hook reported `active = (graphState
=== 'active')` — i.e. "node inserted", **not** "audio is actually flowing
through it". With a suspended context or no audio, the chip could read
"Live" while the worklet was passing through. `active` must require real
process evidence.

### Why config pushes stayed 0 (not 1)

The seed `graph.updateConfig(...)` fired before `attach()` resolved was
**not counted** (`configUpdates` only incremented in the rAF effect, which
early-returns when `graphRef.current` is null). So with no session, the
counter never moved off 0.

## 2. Fixes

1. **Process-gated `active`** — `active` (and the "active" UI status) now
   requires the worklet to actually be processing (metrics samples > 0,
   which the worklet only posts from its non-passthrough branch). No more
   "Live" during passthrough.
2. **New honest statuses** — `deriveRealtimeUiStatus` returns
   `off / unavailable / waiting / starting / passthrough / active /
   bypassed / failed`:
   - `waiting` — flag on + env ready, but **no session yet** (not playing
     or the track hasn't loaded). Copy: "waiting for playback / a loaded
     track".
   - `starting` — session present, worklet loading/attaching.
   - `passthrough` — node spliced but `process()` not running yet.
   - `active` — process running; edits are heard live.
3. **Seed config counted + forced** — on a successful `attach()` the hook
   pushes the current parameter state and bumps `configUpdates`, so the
   first config is guaranteed and visible.
4. **AudioContext resume** — `attach()` calls `ctx.resume()` when the
   context is suspended, so a gesture-suspended context starts pulling.
5. **User toggle** — `LouiRealtimeToggle` (localStorage-persisted, reload)
   already provides explicit Enable/Disable; precedence is
   `window flag → localStorage → env → default OFF`.
6. **Passthrough/waiting UX** — the status chip + module badges read
   "changes are staged" until the status is genuinely `active`.

Defaults unchanged; export path untouched; nothing is faked — when the
worklet is passing through, the UI says so.
