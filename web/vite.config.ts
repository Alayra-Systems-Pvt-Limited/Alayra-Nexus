import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

// The dashboard builds to static assets the gateway serves as-is (no SSR), so the single
// self-hostable container is unchanged. `base: './'` keeps asset URLs relative, so it works
// whether mounted at the site root or a sub-path.
export default defineConfig({
  base: './',
  plugins: [preact()],
  // Dev only: the built app is served by the gateway itself, so /admin is same-origin in
  // production. During `vite dev` it runs on its own port, so proxy the admin API to the local
  // gateway (PORT 3000). Never used in the static build.
  server: {
    proxy: {
      '/admin': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/tests/setup.ts'],
    // CSS Modules are not needed for behaviour tests (queries use roles/text), and skipping
    // their transform keeps the suite fast.
    css: false,
  },
});
