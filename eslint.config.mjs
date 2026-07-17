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
    ignores: ['dist/**', 'web/**', 'e2e/**', 'node_modules/**', 'coverage/**', 'prisma/migrations/**', 'brand/**'],
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
