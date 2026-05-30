# M3-P-NEXT-3 — Feature Flag & Rollout

> How `VITE_LOUI_PRODUCT_LAYOUT` controls ProductPage visibility and
> how to roll back if the new layout produces a regression.

---

## 1. Flag mechanics

`apps/desktop/src/renderer/audio/product-layout-flag.ts` exposes:

```ts
isProductLayoutEnabled(): boolean
productLayoutLabel(): string  // diagnostic
```

Resolution order (first-match-wins):

| Priority | Source | Value |
|---|---|---|
| 1 | Build-time env | `VITE_LOUI_PRODUCT_LAYOUT=true` (Vite's `import.meta.env`) |
| 2 | Runtime override | `window.__LOUI_PRODUCT_LAYOUT__ = true` (mutate in DevTools) |
| 3 | Default | `false` — ResultPage stays |

`App.tsx` reads the flag once during render of `AppInner`.  Toggling the
runtime override at the console requires a re-render (state mutation) or
a hard reload to take effect.

---

## 2. Orthogonality matrix

The product-layout flag is **independent** of the WASM analyzer flag
(`VITE_LOUI_WASM_ANALYZER`).  Four combinations:

| Product layout | WASM analyzer | Result |
|---|---|---|
| OFF | OFF | Legacy ResultPage + V1 LoudnessMeterPanel (default) |
| OFF | ON  | Legacy ResultPage + V2 AnalyzerPanelStack inside `PreviewPlayer` |
| ON  | OFF | ProductPage layout, panels show **null session** (V2 panels' "awaiting frames…" empty state) |
| ON  | ON  | ProductPage layout, WasmAnalyzerProvider supplies real session |

The "Product ON, WASM OFF" combination is intentional — it lets
designers preview the new layout in storybook-equivalent state without
requiring the Rust toolchain.  In production builds we recommend
enabling both flags together (the WASM analyzer is what makes the
spectrum / loudness panels actually render real data).

---

## 3. Build-time enablement

```bash
# In CI / dist:* scripts
VITE_LOUI_WASM_ANALYZER=true VITE_LOUI_PRODUCT_LAYOUT=true pnpm build:renderer

# In dev
VITE_LOUI_PRODUCT_LAYOUT=true pnpm dev
```

The two env vars compose.  Default `pnpm dev` / `pnpm build` keeps both
off, which is the safe behaviour for the 3.6.0-rc.1+1 internal RC.

---

## 4. Runtime override (power users / QA)

In the running app, open DevTools → Console:

```js
// Enable
window.__LOUI_PRODUCT_LAYOUT__ = true;
// Navigate to /result via the existing flow OR call:
//   window.dispatchEvent(new Event('hashchange'));
location.reload();   // simplest — forces re-render with new flag value
```

To return to ResultPage:

```js
window.__LOUI_PRODUCT_LAYOUT__ = false;
location.reload();
```

The runtime override survives soft re-renders but not page reloads
(unless you set it in localStorage / a wrapper script — out of scope).

---

## 5. Rollback procedure

If a regression is found after enabling the flag in a CI build:

1. **Immediate**: rebuild with the env var unset.  No code revert needed.
   ```bash
   pnpm build:renderer   # flag absent → defaults to false → ResultPage
   ```
2. **Targeted fix**: file a `M3-P-NEXT-3-fixup` task; the legacy path is
   undisturbed so users have a working app while the fix lands.
3. **Last resort**: revert the App.tsx import / flag check stanza — three
   lines.  ProductPage code remains in the tree for future iteration.

The flag is one-way: dropping it falls back to the original behaviour
without data migration.  No state lives in ProductPage that isn't also
in the audioStore.

---

## 6. Detection in logs

`productLayoutLabel()` returns `'ProductPage (Loui v2)'` or
`'ResultPage (legacy)'`.  Hook this into:

- Crash reporter context tag (when M5 ships)
- Support-bundle metadata (`SupportBundleButton` payload)
- DevTools "Engine status" chip (`analyzerFactoryLabel()` already does
  this for the WASM flag — add product-layout label to the same
  diagnostic surface in a follow-up PR)

For this milestone the label is informational only — no telemetry / no
auto-reporting.

---

## 7. Default policy across release cycles

| Release | Default flag value | Rationale |
|---|---|---|
| 3.6.0-rc.1+1 (this milestone) | OFF | Opt-in only; engineering preview |
| 3.6.0-rc.2 (after design review) | OFF | External opt-in test |
| 3.6.0 (GA) | OFF | Conservative — V1 stays default until M3-P-NEXT-4 |
| 3.7.0 (M3-P-NEXT-4) | ON  | Product layout becomes default; flag gates rollback |
| 3.8.0 (M3-P-NEXT-5) | (removed) | ResultPage deleted; flag check removed |

This sequence keeps the legacy ResultPage available for **one full
release** after ProductPage becomes default — the same rollout pattern
used for the WASM analyzer in M3-P-NEXT-4 (per
`m3-product-next-1/06-NEXT-STEPS.md`).
