import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node', // Use node for non-DOM logic tests like documentParser
    globals: true,
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['./tests/vitest.setup.ts'],
  },
  resolve: {
    alias: {
      '@extension': path.resolve(__dirname, './src/extension'),
      '@core': path.resolve(__dirname, './src/extension/core'),
      '@vscode': path.resolve(__dirname, './src/extension/vscode'),
      '@webview': path.resolve(__dirname, './src/webview'),
      '@common': path.resolve(__dirname, './src/common'),
    },
  },
});
