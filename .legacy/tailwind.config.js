/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{js,ts,jsx,tsx,html}'],
  theme: {
    extend: {
      colors: {
        // 다크 테마 기반 오디오 앱 색상
        surface: {
          50:  '#f8f8f8',
          100: '#f0f0f0',
          800: '#1a1a2e',
          850: '#16213e',
          900: '#0f0f23',
          950: '#0a0a1a',
        },
        accent: {
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
        },
        success: '#10b981',
        warning: '#f59e0b',
        danger:  '#ef4444',
        lufs: {
          good:    '#10b981',
          warning: '#f59e0b',
          bad:     '#ef4444',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'spin-slow':  'spin 3s linear infinite',
      },
    },
  },
  plugins: [],
}
