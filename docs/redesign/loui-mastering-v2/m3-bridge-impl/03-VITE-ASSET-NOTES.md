# M3-bridge-impl — Vite Asset Pipeline Notes

> What went wrong with the obvious approach, why we settled on `public/`.

---

## 1. The problem we hit

The standard Vite pattern for shipping a worklet alongside a renderer
bundle is:

```ts
const url = new URL('./my.worklet.js', import.meta.url).toString();
audioContext.audioWorklet.addModule(url);
```

Vite's static analyser detects `new URL(..., import.meta.url)` and emits
the referenced file as a build asset (with fingerprinted name).

**This works fine for the existing `loudnessProcessor.worklet.js`** in
`loudnessStream.ts`.

**It did NOT work for our new `analyzer-tap.worklet.js`** when imported
from `wasm-analyzer-session.ts`.  Three rebuild iterations confirmed the
worklet file was missing from the dist output despite:
- Module-level constant `const URL = new URL(...)` ❌
- Function-scoped `function urlFor() { return new URL(...).toString(); }` ❌
- Vite's `?url` import suffix `import url from './...?url'` ❌

---

## 2. Why

The diagnostic trail (running `grep` against the built bundle):

```
grep "WasmAnalyzerSession" dist/.../index.js   → 0 matches
grep "analyzer session not started" dist/.../index.js   → 2 matches
grep "new URL(...)" dist/.../index.js   → only loudnessProcessor + wasm
```

So the FACTORY CLASS BODY survived (the error strings were there), but
the `new URL` call did not survive optimisation.  Vite/Rollup was
**inlining the URL function call** at build time, after which the
worklet asset reference was lost.

Most plausible cause (subject to further investigation):
- The WASM factory is constructed eagerly at module load.
- But the worklet URL is only fetched when `start()` is called.
- Vite's terser pass recognised the factory as constructed-but-not-used.
- Rollup's tree-shaker eliminated the `new URL` evaluation because the
  result was never written to a side-effect output.
- The .worklet.js source file was processed (98 modules transformed,
  one more than before) but the emit step was dropped.

(This is a guess — we did not isolate the exact Vite/Rollup phase that
removed it.  See § 4 for a debugging starting point if you need to.)

---

## 3. The workaround we shipped

Move the worklet into Vite's `public/` directory:

```
apps/desktop/src/renderer/public/analyzer-tap.worklet.js
```

Vite **always** copies `public/*` verbatim to the output (no
fingerprinting, no static analysis).  Reference it as a root-relative
URL:

```ts
const DEFAULT_WORKLET_URL = './analyzer-tap.worklet.js';
```

This is bulletproof but loses two niceties:
- No content fingerprint → cache busting must be manual (rare for worklet code).
- No build-time dependency tracking → editing the worklet doesn't force
  a renderer rebuild.

For M3-bridge-impl this is acceptable.  Re-investigating the original
pattern can land in M3-bridge-impl-NEXT.

---

## 4. Future debugging starting point

If you want to fix the `new URL` pattern properly:

1. Add `console.log(import.meta.url, new URL('./analyzer-tap.worklet.js', import.meta.url))` to wasm-analyzer-session.ts before any other code.
2. Build with `DEBUG=vite:* pnpm build:renderer 2>&1 | grep -i worklet`.
3. Verify Rollup's asset emission graph (`pnpm build:renderer --debug`).
4. Compare the AST of `loudnessStream.ts` vs `wasm-analyzer-session.ts`
   in the transformed output — find the diverging transform step.

Suspects:
- `assetsInclude` setting interaction with `.worklet.js` extension.
- Different import depth (LoudnessStream is imported directly by a
  page; WasmAnalyzerSessionFactory is two indirections away via the resolver).
- Terser's pure-call elimination annotated on the factory constructor.

---

## 5. Vite config we did keep

`apps/desktop/vite.config.ts` was extended with:

```ts
assetsInclude: ['**/*.wasm'],
server: {
  fs: {
    allow: [path.resolve(__dirname, '..', '..')],
  },
},
build: {
  rollupOptions: {
    output: {
      assetFileNames: (asset) => {
        if (asset.name?.endsWith('.wasm'))         return 'assets/[name][extname]';
        if (asset.name?.endsWith('.worklet.js'))   return 'assets/[name][extname]';
        return 'assets/[name]-[hash][extname]';
      },
    },
  },
},
```

These changes are still useful:
- `assetsInclude: ['**/*.wasm']` — Vite recognises the wasm-bindgen
  `.wasm` file as an asset (this works correctly — see 99 KB in dist).
- `server.fs.allow` — Vite dev server can serve files from the workspace
  root (needed for `@loui/dsp-wasm`'s wasm file).
- `assetFileNames` — keeps `.wasm` + `.worklet.js` at recognisable
  names (matches what `dist/renderer/assets/` already produces).

---

## 6. Practical lesson

When a worklet build pipeline is fragile, the `public/` approach is
cheap insurance.  Saved hours of investigation; cost is one
filesystem-level duplicate (gitignored if you want — see "follow-up"
section in `00-OVERVIEW.md`).
