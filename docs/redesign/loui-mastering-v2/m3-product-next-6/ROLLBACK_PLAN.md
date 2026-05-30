# M3-P-NEXT-6 — Rollback Plan

> Three independent ways to restore the classic ResultPage if ProductPage
> misbehaves in the field.

---

## 1. Three rollback levers (fastest → most permanent)

| Lever | Scope | How | Effect |
|---|---|---|---|
| **Error boundary** | per-render, automatic | (built-in) | ProductPage crash → classic ResultPage rendered in place + banner |
| **Runtime flag** | per-session, manual | DevTools: `window.__LOUI_PRODUCT_LAYOUT__ = false` + reload | classic ResultPage for that session |
| **Build env** | per-build, permanent | `VITE_LOUI_PRODUCT_LAYOUT=false` | classic ResultPage for everyone |

All three keep ResultPage as the destination — none deletes code or
touches the pipeline.

---

## 2. Flag precedence (after M3-P-NEXT-6)

```
isProductLayoutEnabled():
  1. window.__LOUI_PRODUCT_LAYOUT__ === boolean   → use it (true OR false)
  2. VITE_LOUI_PRODUCT_LAYOUT === 'false'/'0'     → false
     VITE_LOUI_PRODUCT_LAYOUT === 'true'/'1'      → true
  3. default                                       → true (ProductPage)
```

The runtime override now honours an explicit `false` (previously only
`true` enabled it).  So a power user / support engineer can force the
classic view without a rebuild.

---

## 3. Error boundary behaviour

`ProductPageErrorBoundary` wraps `<ProductPage />` in the `result` slot:

- On a render crash → `getDerivedStateFromError` flips to fallback
- Renders `<ResultPage />` (the classic view) + a Korean/English banner
- Logs `[ProductPage] render crash …` to the console
- Records a `preview`-category failure to the support-bundle ring

The user keeps full save / export via the classic ResultPage buttons.
The crash is contained to the `result` slot — Home / Mastering / Settings
are unaffected.

---

## 4. Field response playbook

| Symptom | Action |
|---|---|
| Isolated crash reports | error boundary already handles it; investigate the stack from the support bundle |
| Widespread crashes | ship a build with `VITE_LOUI_PRODUCT_LAYOUT=false` (one-line config); fix forward |
| A specific user blocked | guide them to set `window.__LOUI_PRODUCT_LAYOUT__ = false` in DevTools |
| Export regression only | classic ResultPage save buttons still work; flip default off if needed |

---

## 5. What is NOT removed

Per the milestone constraints:
- ResultPage source — kept
- V1 LoudnessMeterPanel — kept (used inside the V2 stack when WASM off)
- Python pipeline — unchanged
- `file:save-wav` — unchanged
- `audio:master` — unchanged

ProductPage default is a flag flip + an error boundary.  Reverting is a
config change, never a code revert.

---

## 6. Permanent revert (if ever needed)

To fully revert to ResultPage-default:

1. `product-layout-flag.ts` — change the step-3 default `return true` →
   `return false`.
2. (Optional) remove the error boundary wrap in `App.tsx`.

ProductPage + all its infrastructure stay in the tree, dormant behind
the flag — no deletion, no data migration.

---

## 7. Forward path (NOT this milestone)

ResultPage removal is **M3-P-NEXT-7**, gated on:
- one full release with ProductPage default + zero error-boundary trips
- QA sign-off (QA_CHECKLIST.md all green)

Until then, ResultPage is a first-class fallback.
