# M3-bridge-impl — Feature Flag Flow

> Two switches.  One env var (build-time).  One window override (runtime).
> Default is synthetic.  WASM is opt-in.

---

## 1. The two switches

| Switch | Set when | Persistence |
|---|---|---|
| `VITE_LOUI_WASM_ANALYZER=true` | build time (e.g. CI release pipeline) | bundled into the artifact |
| `window.__LOUI_WASM_ANALYZER__ = true` | runtime (devtools, dev panel toggle) | session only |

Either flag set to truthy → factory resolves to WASM.  Both unset → synthetic.

---

## 2. Code

`apps/desktop/src/renderer/audio/analyzer-factory-resolver.ts`:

```ts
const wasmFactory = new WasmAnalyzerSessionFactory();
const syntheticFactory = new SyntheticAnalyzerSessionFactory();

export function isWasmAnalyzerEnabled(): boolean {
  const envFlag = (import.meta.env?.VITE_LOUI_WASM_ANALYZER ?? '').toString().toLowerCase();
  if (envFlag === 'true' || envFlag === '1') return true;
  if (typeof window !== 'undefined' && window.__LOUI_WASM_ANALYZER__ === true) return true;
  return false;
}

export function resolveAnalyzerFactory(): AnalyzerSessionFactory {
  return isWasmAnalyzerEnabled() ? wasmFactory : syntheticFactory;
}
```

Both factories are instantiated eagerly (see `00-OVERVIEW.md` § 4.3 for
the tree-shaking rationale).

---

## 3. Setting the env var

### Build time

```sh
VITE_LOUI_WASM_ANALYZER=true pnpm build:renderer
```

Or in CI:

```yaml
- name: Renderer build (WASM analyzer)
  run: pnpm build:renderer
  env:
    VITE_LOUI_WASM_ANALYZER: 'true'
```

The compiled bundle has the value inlined.

### Runtime

```js
// In Chromium devtools console:
window.__LOUI_WASM_ANALYZER__ = true;
// reload affected components or navigate to a page that calls resolveAnalyzerFactory()
```

---

## 4. Toggling from the dev panel

`/?dev=analyzer-stream` mounts `DevAnalyzerStreamPage` (without touching
`appStore`).  The page has a `[toggle]` button that flips
`window.__LOUI_WASM_ANALYZER__` and triggers a re-resolution.

```tsx
const toggleFlag = () => {
  const next = !wasmEnabled;
  window.__LOUI_WASM_ANALYZER__ = next;
  setWasmEnabled(next);
};
```

Note: this re-resolves the factory for the dev page only.  Other parts of
the app (which currently don't use the resolver — they use the V1 path)
are unaffected.

---

## 5. Promotion to default

When M3-meter-swap ships:
1. Existing pages start calling `resolveAnalyzerFactory()`.
2. CI builds set `VITE_LOUI_WASM_ANALYZER=true`.
3. Synthetic factory is kept for dev environments without WASM tooling.

When V2 components are promoted (M3 mid):
1. Synthetic factory becomes an explicit dev-only constructor.
2. `resolveAnalyzerFactory()` becomes WASM-only (no flag check).
3. Synthetic class moves under `__dev__/` or behind a `dev`-named export.

---

## 6. Verification

| Check | Result |
|---|---|
| `isWasmAnalyzerEnabled()` defaults to `false` in dev | ✅ |
| Setting `window.__LOUI_WASM_ANALYZER__ = true` flips to WASM | ✅ (compile-time tested via resolver logic; runtime untested in this commit) |
| Build with env var sets compile-time `true` | ✅ (compile-time tested; runtime untested) |
| Dev panel toggle button changes the displayed label | ✅ (visual; manual smoke required for actual factory swap) |
