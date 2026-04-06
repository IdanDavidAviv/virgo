import { vi } from 'vitest';
import 'fake-indexeddb/auto';

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
