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
    // ESM helper scripts. Same situation as the CommonJS block below — untyped JavaScript run
    // standalone by Node, so `no-undef` needs Node's globals declared explicitly, which the
    // TypeScript blocks get for free from typescript-eslint disabling that rule. Separate from it
    // only because sourceType has to be 'module': a .mjs file is one whether or not eslint is told,
    // and declaring it 'commonjs' makes every import a parse error.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
      sourceType: 'module',
      parserOptions: { ecmaVersion: 2022 },
    },
  },
  {
    // The plain-CommonJS entry points: the published `bin` shim, the npm lifecycle script, and the
    // benchmark profiler wrapper. All are deliberately untyped JavaScript, because each runs in a
    // situation where `require` is not a style choice but the only thing available — the shim
    // reports a missing build, the postinstall runs before anything has been built at all, and
    // profileServer.cjs must `require` the compiled server into its OWN isolate so the inspector
    // session it opened is attached to the code being measured. `no-undef` needs Node's globals
    // declared, which the TypeScript blocks get for free from typescript-eslint turning that rule
    // off entirely.
    files: ['bin/**/*.js', 'scripts/**/*.js', 'scripts/**/*.cjs'],
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
    // k6 load scripts. These do not run in Node at all — k6 executes them in its own JavaScript
    // runtime, which supplies `__ENV` (and `__VU`, `__ITER`) and resolves `k6/*` imports itself.
    // So Node's globals would be wrong here and k6's have to be declared; there is no config in
    // which this file both runs and typechecks as ordinary source, which is why it is plain JS
    // outside the TypeScript projects.
    files: ['scripts/bench/k6/**/*.js'],
    languageOptions: {
      globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly', console: 'readonly' },
      sourceType: 'module',
      parserOptions: { ecmaVersion: 2022 },
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
