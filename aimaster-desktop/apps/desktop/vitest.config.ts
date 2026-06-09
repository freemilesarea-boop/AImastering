import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Renderer unit-test harness (C-3).  Separate from vite.config.ts (which sets
// root: src/renderer for the app build) so tests can live next to any source
// file as `*.test.ts(x)`.  jsdom gives a DOM for React component tests; the
// react plugin enables JSX/TSX.  Vite resolves NodeNext-style `.js` import
// specifiers to their `.ts` source, so tests need no special import rules.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src/renderer') },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['./vitest.setup.ts'],
    css: false,
    clearMocks: true,
    restoreMocks: true,
  },
});
