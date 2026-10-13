import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    // server/db.ts opens its database on import, so each file gets its own process and temp dir.
    pool: 'forks',
    isolate: true,
    setupFiles: ['tests/unit/setup.ts'],
  },
});
