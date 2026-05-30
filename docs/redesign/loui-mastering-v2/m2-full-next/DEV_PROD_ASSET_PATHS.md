# M2-full-NEXT — Dev / Prod Asset Paths

> Where the worklet WASM assets resolve in `vite dev` vs the packaged
> Electron build, and why the chosen URLs work in both.

---

## 1. The three asset URLs

Declared in `mastering-worklet-loader.ts` (single source of truth):

| Constant | URL |
|---|---|
| `MASTERING_WORKLET_URL` | `./mastering-chain.worklet.js` |
| `MASTERING_WASM_GLUE_URL` | `./loui-mastering-wasm.nomodules.js` |
| `MASTERING_WASM_BINARY_URL` | `./loui-mastering-wasm.nomodules.wasm` |

All root-relative, mirroring the analyzer's `./analyzer-tap.worklet.js`.

---

## 2. Why root-relative `public/` (not `new URL(...,import.meta.url)`)

`new URL('./x.js', import.meta.url)` makes Vite emit the asset — *unless*
the importing statement is behind a build-time-resolvable conditional (a
flag), in which case the tree-shaker can drop the import **and silently
drop the asset emission**.  The realtime path is exactly that: flag-gated.

`public/` files are copied **verbatim** and served at a stable,
predictable URL regardless of tree-shaking.  This is the same reason the
analyzer tap ships from `public/`.

---

## 3. Resolution in each environment

| Environment | `base` | Document URL | `./asset` resolves to |
|---|---|---|---|
| `vite dev` (renderer) | `/` effective | `http://localhost:5173/` | `http://localhost:5173/asset` (served from `public/`) |
| `vite build` | `'./'` | — | emitted at `dist/renderer/asset` |
| Electron prod | `'./'` | `file://…/dist/renderer/index.html` | `file://…/dist/renderer/asset` |

Because `base: './'` and the assets sit at the renderer root, the same
relative URL works under the dev server's HTTP origin and under
`file://` in the packaged app.

`server.fs.allow` is already broadened to the repo root for the web
build's wasm fetch; the worklet assets are inside `public/` so they need
no extra allowance.

---

## 4. dev server fetch caveat

`fetch` of the `.wasm` happens on the **main thread** (renderer), which
has full `fetch` — no worklet-scope limitation.  `addModule(url)` is the
standard worklet module-load and accepts the same relative URLs.

`detectWorkletAssetReadiness()` uses `GET` (not `HEAD`) because the Vite
dev server and `file://` do not reliably answer `HEAD` for static files.

---

## 5. Verified emission

`pnpm build:renderer` → `dist/renderer/` contains:

```
analyzer-tap.worklet.js
loui-mastering-wasm.nomodules.js     (34 KB)
loui-mastering-wasm.nomodules.wasm   (139 KB)
mastering-chain.worklet.js           (6 KB)
assets/loui_dsp_wasm_bg.wasm         (139 KB, web build — unchanged)
```

Both the web (`assets/`) and worklet (`root`) WASM artifacts coexist.
