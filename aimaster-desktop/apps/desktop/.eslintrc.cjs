// Minimal ESLint config for @aimaster/desktop.
//
// Scope: only the rules already referenced by inline `eslint-disable` comments
// throughout the codebase, plus a small set of correctness-only checks that
// catch real bugs without flagging stylistic noise.  Anything beyond this is
// deliberately silent so adding the config does not bury the team in
// thousands of new errors at once.
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  env: {
    browser: true,
    node:    true,
    es2022:  true,
  },
  plugins: ['@typescript-eslint', 'react-hooks'],
  ignorePatterns: [
    'dist',
    'dist-electron',
    'out',
    'storybook-static',
    'public/bin',
    '**/*.worklet.js',
    'scripts/**',
  ],
  rules: {
    // ── Rules referenced by existing eslint-disable directives ────────────
    'no-console':       'warn',
    'no-control-regex': 'error',
    'react-hooks/exhaustive-deps': 'off', // referenced via disable, plugin not installed

    // ── Correctness only — no style ───────────────────────────────────────
    'no-unused-vars':                          'off',          // delegated to @typescript-eslint
    '@typescript-eslint/no-unused-vars':       ['warn', {
      argsIgnorePattern:  '^_',
      varsIgnorePattern:  '^_',
      caughtErrorsIgnorePattern: '^_',
    }],
    '@typescript-eslint/no-floating-promises': 'off',  // requires type-aware linting, costly
    'no-debugger':                             'error',
    'no-duplicate-case':                       'error',
    'no-unreachable':                          'error',
    'no-self-assign':                          'error',
    'no-self-compare':                         'error',
  },
  overrides: [
    {
      files: ['src/main/**/*.ts'],
      env: { node: true, browser: false },
    },
    {
      files: ['src/renderer/**/*.{ts,tsx}', 'src/preload/**/*.ts'],
      env: { browser: true, node: false },
    },
  ],
};
