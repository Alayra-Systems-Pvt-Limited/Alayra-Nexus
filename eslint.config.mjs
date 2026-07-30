// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    // Never lint build output, deps, the generated client, or the brand kit
    // (SVG/PNG assets plus a standalone CommonJS render script). The dashboard app
    // under web/ is a separate package with its own ESLint config and CI job, so it is
    // ignored here wholesale (otherwise its built bundle in web/dist gets linted).
    // `docs/**` covers the committed static demo (docs/demo): it is minified build output from the
    // dashboard, whose own source is linted in web/. Linting a bundle reports hundreds of errors
    // about generated code nobody wrote and nobody can fix.
    ignores: ['dist/**', 'web/**', 'e2e/**', 'node_modules/**', 'coverage/**', 'prisma/migrations/**', 'brand/**', 'docs/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    rules: {
      // Real-bug rules stay as errors.
      'no-unused-vars': 'off', // superseded by the TS-aware version below
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off', // this is a server; structured console output is intentional
      // `any` shows up in a few boundary casts (request augmentation, provider payloads).
      // Warn rather than error so it surfaces in review without blocking CI, and can be
      // tightened as the typed-boundary work lands in later phases.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // The two plain-CommonJS entry points: the published `bin` shim and the npm lifecycle script.
    // Both are deliberately untyped JavaScript, because both run in situations where the compiled
    // output may not exist yet — the shim reports a missing build, and the postinstall runs before
    // anything has been built at all. `require` is not a style choice here, it is the only thing
    // available; and `no-undef` needs Node's globals declared, which the TypeScript blocks get for
    // free from typescript-eslint turning that rule off entirely.
    files: ['bin/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'commonjs',
      parserOptions: { ecmaVersion: 2022 },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Test files: allow the usual test-time loosenings.
    files: ['src/**/*.test.ts', 'test/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
