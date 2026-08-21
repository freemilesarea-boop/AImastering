import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Mastering is on-device (Web Audio API). No server/API env is used.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
  // Don't inherit the repo-root postcss.config.js (Tailwind) — this app uses
  // plain CSS. An inline empty config stops Vite's upward search.
  css: { postcss: {} },
});
