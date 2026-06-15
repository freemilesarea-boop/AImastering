import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Server API config is injected via env (VITE_MASTERING_API_URL / _API_KEY).
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
  // Don't inherit the repo-root postcss.config.js (Tailwind) — this app uses
  // plain CSS. An inline empty config stops Vite's upward search.
  css: { postcss: {} },
});
