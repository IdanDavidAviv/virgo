import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node', // Use node for non-DOM logic tests like documentParser
    globals: true,
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
