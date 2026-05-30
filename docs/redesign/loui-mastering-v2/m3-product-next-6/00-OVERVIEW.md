# M3-P-NEXT-6 — ProductPage Default Promotion + QA Gate

> Make the Ozone-style ProductPage the default result screen, with an
> error boundary + three rollback levers keeping the classic ResultPage
> one toggle away.

---

## 1. What changed

| Before | After |
|---|---|
| `result` slot → ResultPage (default) | `result` slot → ProductPage (default) |
| ProductPage behind opt-in flag (`true` only) | ResultPage behind opt-out flag (`false`) |
| No render-crash safety net | ProductPageErrorBoundary → classic fallback |

| Deliverable | Where |
|---|---|
| Readiness audit          | `PRODUCTPAGE_READINESS_AUDIT.md` |
| Default flag flip        | `audio/product-layout-flag.ts` (default ON; runtime/env opt-out) |
| ResultPage fallback      | kept; error-boundary + flag restore it |
| Error boundary           | `components/ProductPageErrorBoundary.tsx` + App.tsx wrap |
| QA checklist             | `QA_CHECKLIST.md` (31 manual + CI gates) |
| Storybook error/fallback | `ProductPageErrorBoundary.stories.tsx` (Healthy / CrashedFallback) |
| Rollback plan            | `ROLLBACK_PLAN.md` |

---

## 2. Flag semantics (new)

```
isProductLayoutEnabled():
  1. window.__LOUI_PRODUCT_LAYOUT__ === boolean → honour it (true OR false)
  2. VITE_LOUI_PRODUCT_LAYOUT 'false'/'0' → false ; 'true'/'1' → true
  3. default → true (ProductPage)
```

The runtime override now honours an explicit `false`, so the classic
view can be forced without a rebuild.

---

## 3. Error boundary

`<ProductPageErrorBoundary fallback={<ResultPage/>}>` wraps ProductPage
in the result slot.  A render crash:
- renders the classic ResultPage in place + a banner
- logs the error + records a support-bundle failure
- contains the crash to the `result` slot (rest of the app unaffected)

The user keeps full save / export via the classic view.

---

## 4. What did NOT change

| Untouched | Verification |
|---|---|
| ResultPage source | kept (fallback) |
| V1 LoudnessMeterPanel | kept |
| Python pipeline | none |
| `audio:master` / `file:save-wav` / `file:save-audio` | none |
| Rust DSP | none |
| Home / Mastering / Settings / QC pages | none |

Constraints honoured: ResultPage NOT removed, V1 NOT removed, no Python
change, no Rust DSP, no export-pipeline rewrite.

---

## 5. Verification

| Check | Result |
|---|---|
| `pnpm typecheck`        | clean |
| `pnpm build:renderer`   | 438 KB JS / 99 KB WASM |
| `pnpm build` (main)     | esbuild OK |
| `pnpm build-storybook`  | **14 components / 100 stories** |
| `cargo test -p loui-dsp --lib` | **31/31** |
| Default → ProductPage   | `isProductLayoutEnabled()` returns true by default |
| Runtime `false` → ResultPage | precedence honours explicit false |
| ProductPage crash → fallback | error boundary renders ResultPage |
| audio:master / save-wav / save-audio | untouched |

---

## 6. Rollout posture

ProductPage is now the default experience.  Safety net:
1. **Error boundary** — automatic per-render fallback
2. **Runtime flag** — `window.__LOUI_PRODUCT_LAYOUT__ = false`
3. **Build env** — `VITE_LOUI_PRODUCT_LAYOUT=false`

See `ROLLBACK_PLAN.md` for the field playbook.

---

## 7. Next

**M3-P-NEXT-7** — remove ResultPage + V1.  Gated on one full release
with ProductPage default + zero error-boundary trips + QA sign-off.
Until then ResultPage is a first-class fallback.
