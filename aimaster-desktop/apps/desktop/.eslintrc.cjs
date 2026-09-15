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
  ],
  rules: {
    // ── Rules referenced by existing eslint-disable directives ────────────
    'no-console':       'warn',
    'no-control-regex': 'error',
    'react-hooks/exhaustive-deps': 'off', // referenced via disable, plugin not installed

    // ── Correctness only — no style ───────────────────────────────────────
    'no-unused-vars':                          'off',          // delegated to @typescript-eslint
    // An ERROR, not a warning, and the reason is measured: `scripts/` was
    // outside the lint entirely and had 39 dead imports in it.  As a warning
    // this rule exits 0, so CI would go green on every one of them and the
    // pile would rebuild itself.  `src` has zero of these today, so promoting
    // it costs nothing and is what makes the check load-bearing.
    '@typescript-eslint/no-unused-vars':       ['error', {
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
    {
      // The self-tests and benchmarks.  They were excluded from linting
      // entirely, which is how 39 dead imports and two real findings sat in
      // them unnoticed; a directory nothing checks is where unused code goes
      // to live.
      //
      // `no-console` is OFF here rather than the directory being skipped.
      // Printing the measurements IS what a self-test does — every one of
      // these ends by printing its table — so the rule would report 594
      // problems that are all the feature working.  A warning that is always
      // wrong trains people to ignore the whole report, which is the state
      // this directory was already in.
      files: ['scripts/**/*.{ts,tsx,mjs,cjs}'],
      env: { node: true, browser: false },
      rules: {
        'no-console': 'off',
      },
    },
  ],
};
