import { vi } from 'vitest';
import 'fake-indexeddb/auto';

// Mock Webview-specific globals
(global as any).acquireVsCodeApi = () => ({
    postMessage: vi.fn(),
    getState: vi.fn(),
    setState: vi.fn()
});
