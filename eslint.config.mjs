// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    // Never lint build output, deps, generated client, or the browser dashboard
    // (public/index.html is a single-file vanilla-JS app with its own conventions).
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'public/**', 'prisma/migrations/**'],
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
