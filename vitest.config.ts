import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    // CLI tests run npm (build/pack) against the same repo: serialize files.
    fileParallelism: false,
  },
});
