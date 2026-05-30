# M3-P-NEXT-5C — Debounce / Latest-Wins Controller

> `PreviewRenderController` — coalesce requests, ignore stale responses.

---

## 1. Responsibilities

| Concern | Mechanism |
|---|---|
| Avoid render spam        | Debounce (default 600 ms) |
| Use only the final value | Last queued payload wins within the window |
| Ignore stale responses   | Monotonic `requestId` + `latestRequestId` check |
| Decouple transport       | Injectable `PreviewRenderTransport` |
| Surface state            | `onState` / `onSuccess` / `onError` callbacks |

---

## 2. API

```ts
class PreviewRenderController {
  constructor(transport: PreviewRenderTransport, opts?: {
    debounceMs?: number;          // default 600
    onState?: (s: PreviewRenderState) => void;
    onSuccess?: (previewPath: string, durationMs: number) => void;
    onError?: (error: string) => void;
  });

  request(payload): void;   // queue (debounced)
  flush(): void;            // fire immediately (e.g. explicit button click)
  cancel(): void;           // drop pending + mark in-flight stale
  dispose(): void;          // clear timers
}
```

`PreviewRenderState`:

```ts
| { phase: 'idle' }
| { phase: 'pending' }                                    // debounce window open
| { phase: 'rendering'; requestId: number }
| { phase: 'updated'; previewPath: string; at: number; durationMs: number }
| { phase: 'error'; error: string; at: number }
```

---

## 3. Debounce

```ts
request(payload) {
  this.queued = payload;        // keep only the latest
  this.setState({ phase: 'pending' });
  clearTimeout(this.timer);
  this.timer = setTimeout(() => this.fire(), this.debounceMs);
}
```

Repeated `request()` calls within `debounceMs` reset the timer and
overwrite `queued`.  Only the final payload fires.

The product UI calls `request()` then `flush()` on an explicit "Update
Preview" click — so the button renders immediately (no debounce wait),
while a future auto-render mode would call `request()` alone and let the
debounce coalesce.

---

## 4. Latest-wins

```ts
fire() {
  const requestId = this.nextRequestId++;
  this.latestRequestId = requestId;
  this.setState({ phase: 'rendering', requestId });
  this.transport.render({ requestId, ... }).then((response) => {
    if (response.requestId !== this.latestRequestId) return;   // STALE → drop
    if (response.ok) { ...onSuccess... } else { ...onError... }
  });
}
```

Every fired request gets a monotonic id.  When a response arrives, it's
honoured only if its id is still the latest.  A slow render whose result
arrives after a newer request fired is dropped.

### Worked example (StaleResponseIgnored story)

```
t=0    request A (targetLufs -10) → requestId=1, latest=1, render starts
t=50   request B (targetLufs -8)  → requestId=2, latest=2, render starts
t=1000 response A arrives (requestId=1) → 1 !== 2 → DROPPED
t=1050 response B arrives (requestId=2) → 2 === 2 → swap to B's preview
```

Only B's preview is applied.

---

## 5. Cancel

```ts
cancel() {
  clearTimeout(this.timer);
  this.queued = null;
  this.latestRequestId = this.nextRequestId;   // any in-flight → stale
  this.setState({ phase: 'idle' });
}
```

Bumping `latestRequestId` past every issued id guarantees no in-flight
response will match.  Used when the user navigates away or resets.

---

## 6. Transport injection

```ts
interface PreviewRenderTransport {
  readonly name: string;
  render(request: PreviewRenderRequest): Promise<PreviewRenderResponse>;
}
```

| Implementation | Use |
|---|---|
| `IpcPreviewRenderTransport` | Production — `window.electronAPI.invoke('audio:re-render-preview', …)` |
| `MockPreviewRenderTransport`| Stories/tests — configurable delay + success/failure, records history |

The controller never references IPC directly — it's transport-agnostic,
so the entire debounce/latest-wins behaviour is testable in Storybook
with the mock.

---

## 7. Rapid-debounce example (RapidDebounced story)

```
t=0   request (-12)  → pending, timer(600ms)
t=100 request (-11)  → pending, timer reset
t=200 request (-10)  → pending, timer reset
t=800 timer fires    → ONE render with the last payload (-10)
```

Three requests in the window → one render.  The intermediate values
(-12, -11) never hit the transport.

---

## 8. Lifecycle in React

`ProductionPreviewControl` creates the controller once (lazy ref init)
and disposes on unmount:

```ts
const controllerRef = useRef<PreviewRenderController | null>(null);
if (!controllerRef.current) controllerRef.current = new PreviewRenderController(...);
React.useEffect(() => () => controllerRef.current?.dispose(), []);
```

Callbacks that close over fresh values (`onRendered`, requested override)
use refs updated each render, so the once-constructed controller always
sees current data without re-construction.

---

## 9. Default debounce tuning

600 ms balances responsiveness vs render cost.  With the explicit
"Update Preview" button (which `flush()`es), the debounce only matters
for a future auto-render mode.  When auto-render ships (5D), the value
may need tuning per render latency — exposed as a setting.
