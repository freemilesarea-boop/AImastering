import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as {
  version: string;
  name:    string;
};

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_NAME__:    JSON.stringify(pkg.name),
    // Paddle checkout URL for the in-app purchase link.  CI injects
    // PADDLE_CHECKOUT_URL for production builds; falls back to the marketing
    // site when unset so the link is never broken.
    __PADDLE_CHECKOUT_URL__: JSON.stringify(process.env.PADDLE_CHECKOUT_URL || 'https://aimaster.io'),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
    },
  },
  // ── M3-bridge-impl: WASM + AudioWorklet asset handling ────────────────
  //
  // The Rust dsp-core ships as a workspace package (`@loui/dsp-wasm`)
  // whose `pkg/loui_dsp_wasm_bg.wasm` we want emitted as a static
  // asset.  `assetsInclude` makes Vite copy the `.wasm` file alongside
  // the renderer bundle; the wasm-bindgen JS module's `init()` then
  // fetches it from the resolved URL.
  //
  // The `analyzer-tap.worklet.js` file is loaded by Vite's `new URL(...)`
  // import pattern in `wasm-analyzer-session.ts` — no plugin config needed.
  assetsInclude: ['**/*.wasm'],
  // Allow Vite to serve from the workspace `packages/` directory so
  // the wasm-bindgen JS module's relative-URL `.wasm` fetch succeeds.
  // (Vite's default `server.fs.allow` is just `root`; broaden to the repo.)
  server: {
    port: 5173,
    fs: {
      allow: [path.resolve(__dirname, '..', '..')],
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    // Keep wasm + worklet files at recognisable names — easier debug,
    // matches the wasm-bindgen JS module's resolution.
    rollupOptions: {
      output: {
        assetFileNames: (asset) => {
          if (asset.name?.endsWith('.wasm')) {
            return 'assets/[name][extname]';
          }
          if (asset.name?.endsWith('.worklet.js')) {
            return 'assets/[name][extname]';
          }
          return 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
});
