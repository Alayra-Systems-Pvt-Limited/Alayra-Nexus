// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    // Never lint build output, deps, the generated client, or the brand kit
    // (SVG/PNG assets plus a standalone CommonJS render script).
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'prisma/migrations/**', 'brand/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The dashboard. Now that it is a set of ES modules rather than one inline
    // <script>, it can be linted like real source — which is what catches a
    // function that was moved between files but never imported.
    files: ['frontend/js/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        Chart: 'readonly', // loaded from a CDN on first paint of the Analytics tab
      },
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // `try { ... } catch {}` is the dashboard's idiom for "this widget is optional,
      // a failure here must not take the tab down". The intent is the empty block.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
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
