import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['./tests/vitest.setup.ts'],
    alias: {
      '@extension': path.resolve(__dirname, './src/extension'),
      '@core': path.resolve(__dirname, './src/extension/core'),
      '@mcp': path.resolve(__dirname, './src/extension/mcp'),
      '@mcp-core': path.resolve(__dirname, './src/extension/mcp/core'),
      '@vscode': path.resolve(__dirname, './src/extension/vscode'),
      '@webview': path.resolve(__dirname, './src/webview'),
      '@common': path.resolve(__dirname, './src/common'),
    },
  },
});
