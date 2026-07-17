// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mjs'],
    languageOptions: {
      globals: {
        // Plain node processes: the mock provider, the setup scripts, and the specs.
        process: 'readonly', console: 'readonly', Buffer: 'readonly',
        fetch: 'readonly', URL: 'readonly', setTimeout: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      // Playwright fixtures destructure with unused parts; keep the escape hatch consistent
      // with the root package's convention.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
