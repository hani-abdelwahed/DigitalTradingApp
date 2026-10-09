import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    environment: 'node',
    // Integration tests share one database, so run files one at a time.
    fileParallelism: false,
    setupFiles: ['./test/setup.ts'],
    testTimeout: 20_000,
  },
});
