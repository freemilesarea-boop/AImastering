# M3-P-NEXT-4 — Slide-Over Specification

> Layout / motion / lifecycle rules for `LouiModuleSlideOver`.

---

## 1. Visual anatomy

```
                                                      ┌──────────────────────────┐
┌──────────────────────────────┐                      │ EQ                    ✕ │  ← header (56 px)
│                              │                      │ Adaptive 7-band          │
│                              │                      ├──────────────────────────┤
│  ProductPage main canvas     │   ◄ backdrop ►       │                          │
│  (analyzer + meter rail)     │   (translucent       │  ┌──────────────────┐    │
│                              │    backdrop          │  │ EQ Curve          │   │
│                              │    captures clicks)  │  │ ...               │   │
│                              │                      │  └──────────────────┘    │  ← scrollable body
│                              │                      │                          │
└──────────────────────────────┘                      │                          │
                                                      └──────────────────────────┘
                                                       │  ◄ 480 px ►              │
```

### Layers (z-index)

| z-index | Element |
|---|---|
| 90 | Backdrop (translucent #000 @ 55 % alpha + 2 px blur) |
| 91 | Panel surface |

The slide-over is positioned `fixed` and inset to the viewport — it
shows above the ProductPage chrome, including TopBar drag region.

### Width

- **Default**: `min(480 px, 100vw)` — at viewport widths < 480 px the
  panel fills the entire screen
- **Customisable**: `width` prop on the component

---

## 2. Motion

```
Open
  ┌─ Backdrop opacity 0 → 1   over 200 ms ease-out
  └─ Panel transform translateX(480 px) → 0   over 280 ms ease-out

Close
  ├─ Backdrop opacity 1 → 0   over 200 ms ease-out
  └─ Panel transform 0 → translateX(480 px)   over 280 ms ease-out
```

The 80 ms offset between backdrop and panel keeps the panel visible
for the duration of the slide-back, so users feel the panel "leave"
rather than blink out.

Both transitions are CSS `transition` rules on inline styles — no
JS animation libraries.

---

## 3. Open / close triggers

| Trigger | Wired by |
|---|---|
| Module strip card click       | ProductPage → `setSelectedModule(id)` |
| Module strip card re-click    | ProductPage → `setSelectedModule(prev === id ? undefined : id)` (toggle) |
| ESC key                       | `LouiModuleSlideOver` keydown listener (only when open) |
| Backdrop click                | `LouiModuleSlideOver` backdrop `onClick` → `onClose()` |
| Close button (✕)              | `LouiModuleSlideOver` header button → `onClose()` |

ESC is captured with `useCapture = true` to short-circuit any other
keyboard listener competing for the same event.

---

## 4. Focus management

### On open

1. Capture the currently-focused element into `lastFocusRef`
2. After ~50 ms (so the panel is in the DOM): query all focusable
   children; focus the **second** one if available, otherwise the
   first.  (Reason: the first is the ✕ button — we focus the first
   *interactive parameter* instead so the user can change values
   immediately.)

### While open

Tab / Shift+Tab cycle through the focusable elements within the panel
only:
- At the last element, `Tab` → focus the first
- At the first element, `Shift+Tab` → focus the last
- Anywhere else, browser default behaviour

Focusable selector:
```ts
'a[href], button:not([disabled]), input:not([disabled]), ' +
'select:not([disabled]), textarea:not([disabled]), ' +
'[tabindex]:not([tabindex="-1"]):not([disabled]), [role="slider"]:not([disabled])'
```

The `role="slider"` clause picks up `LouiKnob` since the knob renders a
`<button role="slider">` so screen readers narrate it correctly.

### On close

Restore focus to `lastFocusRef.current` — the trigger that opened the
panel.

---

## 5. ARIA / semantics

```html
<aside
  role="dialog"
  aria-modal="true"
  aria-label="EQ"
  aria-hidden={!open}
>
  <header>
    <h-text>EQ</h-text>
    <h-subtitle>Adaptive 7-band</h-subtitle>
    <button aria-label="Close">…</button>
  </header>
  …
</aside>
```

The `aria-modal="true"` advertises modal behaviour even though the
slide-over does not technically block all interaction (a determined
user can still tab to the underlying chrome).  Our focus trap mitigates
that for typical keyboard users.

---

## 6. Lifecycle inside ProductPage

```ts
// ProductPage state
const [selectedModule, setSelectedModule] = useState<ModuleCardDef['id']>();

// Toggle on click
const onSelectModule = (id) =>
  setSelectedModule((prev) => (prev === id ? undefined : id));

// LouiModuleStrip receives selectedId + onSelect
// LouiModuleSlideOver receives `open={Boolean(selectedModule)}`

// onClose fires when the slide-over wants to close itself
//   → call onSelectModule with the same id to trip the toggle to undefined
const onClose = () => { if (selectedModule) onSelectModule(selectedModule); };
```

### Why mirror the toggle through the same callback

The slide-over's `onClose` and the strip's `onSelect(sameCard)` are
semantically the same action — "user wants the panel gone".  Routing
both through the same toggle keeps ProductPage's local state the
single source of truth.

---

## 7. Render-during-close optimisation

When the slide-over closes, the panel content (e.g.
`<EqParameterPanel/>`) would normally unmount immediately as
`selectedModule` becomes `undefined`.  That blanks out the body before
the 280 ms slide-back animation completes.

The fix lives in `ModuleSlideOverHost`:

```ts
const [renderedId, setRenderedId] = useState(props.selected);
useEffect(() => {
  if (props.selected) setRenderedId(props.selected);
}, [props.selected]);
```

So while `selected` is `null` we still render `renderedId`'s panel
content during the slide-out.  The next open changes `renderedId` to
the new module, and the cycle repeats.

---

## 8. Responsive behaviour

| Viewport | Panel | Notes |
|---|---|---|
| ≥ 1440 px | 480 px right rail               | Plenty of breathing room |
| 1280 px   | 480 px right rail               | Still comfortable; analyzer canvas left of panel compresses |
| 1024 px   | 480 px right rail               | Backdrop fills the remaining 544 px |
| 768 px    | 480 px right rail               | Content visible behind backdrop; functional |
| ≤ 480 px  | 100 vw full-screen take-over    | Panel fills screen; backdrop invisible (full-screen panel acts as the focus surface) |

We intentionally do NOT animate width — the panel is always 480 px
wide and only the framework `min()` collapses it on very narrow
viewports.  This avoids reflow-during-transition stutter.

---

## 9. Implementation notes

- The slide-over component is **stateless beyond focus tracking**.  All
  module-specific state lives inside the panel components.
- The panel content is unmounted only after the close animation
  completes (handled by `ModuleSlideOverHost` keeping `renderedId` in
  local state).
- ESC handling uses `addEventListener('keydown', …, true)` (capture
  phase) so it preempts any other handler attached to a child.
- No portal — the slide-over renders inside ProductPage's React tree
  with `position: fixed`.  Future Portal extraction (for nested page
  shells) is documented in `07-NEXT-STEPS.md`.

---

## 10. Tested interactions

| Scenario | Verified via |
|---|---|
| ESC closes from any focused element                | Storybook "EqOpen" + manual `Tab → ESC` |
| Backdrop click closes                              | Storybook "EqOpen" |
| Close × button closes                              | Storybook "EqOpen" |
| Re-clicking the active module card closes          | ProductPage stories |
| Tab cycles within panel, doesn't escape            | Storybook + manual tab walk |
| Shift+Tab at first focusable cycles to last        | Manual tab walk |
| Auto-focus lands on first interactive (not ×)      | Storybook opens each panel |
| Focus restores to the trigger on close             | Storybook + manual `click → ESC` |
| Open/close animation visually smooth at 60 fps     | Visual inspection |
| Knob drag inside panel works (pointer + keyboard)  | LouiControls / Showcase story |
