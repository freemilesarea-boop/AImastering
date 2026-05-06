import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Vite 설정: 렌더러 프로세스(React) 전용 번들러 설정
export default defineConfig({
  plugins: [react()],
  base: './',
  root: 'src/renderer',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/renderer/index.html'),
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
      '@types': path.resolve(__dirname, 'src/renderer/types'),
    },
  },
  server: {
    port: 5173,
  },
})
