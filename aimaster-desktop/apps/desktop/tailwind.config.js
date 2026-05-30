/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        // Charcoal surface ladder (DESIGN-POLISH-2) — pure black removed.
        // 950 app background · 900 main panel · 800 elevated · 700 subtle.
        surface: {
          950: '#13131A',
          900: '#1A1A24',
          800: '#222230',
          700: '#2A2A36',
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
