import { fileURLToPath, URL } from 'node:url';

import { configDefaults, defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // Pure logic tests (parser, codegen helpers, SSE invalidation
    // engine) — no DOM needed. Avoids jsdom@29's top-level-await
    // require() footgun on Node 22.
    environment: 'node',
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
