import { vi } from 'vitest';
import 'fake-indexeddb/auto';

// [v2.3.1] Mock crypto for UUID support in JSDOM
if (typeof global !== 'undefined') {
    Object.defineProperty(global, 'crypto', {
        value: {
            randomUUID: () => '00000000-0000-0000-0000-000000000000'
        },
        configurable: true
    });
}

// Mock Webview-specific globals
(global as any).acquireVsCodeApi = () => ({
    postMessage: vi.fn(),
    getState: vi.fn(),
    setState: vi.fn()
});

// Global Strategy Mocks (Baseline for all tests)
if (typeof window !== 'undefined') {
    (window as any).speechSynthesis = {
        speak: vi.fn(),
        cancel: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        getVoices: vi.fn(() => []),
        pending: false,
        speaking: false,
        paused: false,
        onvoiceschanged: null
    };

    (window as any).Audio = class {
        volume = 1;
        playbackRate = 1;
        src = '';
        readyState = 4;
        paused = true;
        onplay = null;
        onpause = null;
        onended = null;
        onerror = null;
        onwaiting = null;
        onplaying = null;
        play = vi.fn().mockResolvedValue(undefined);
        pause = vi.fn();
        load = vi.fn();
        addEventListener = vi.fn();
        removeEventListener = vi.fn();
    };
}
