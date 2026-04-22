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

    // [jsdom CONTRACT] Full EventTarget-compatible Audio stub.
    // The minimal stub (vi.fn() for everything) has no dispatchEvent(), which breaks any
    // test that calls audio.dispatchEvent() or relies on event propagation (e.g. playBlob()).
    // This stub stores listeners by type and correctly dispatches events, matching browser behavior.
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

        private _listeners: Map<string, Function[]> = new Map();

        play = vi.fn().mockResolvedValue(undefined);
        pause = vi.fn();
        removeAttribute = vi.fn();

        load = vi.fn().mockImplementation(() => {
            // [jsdom CONTRACT] Dispatch 'canplay' via microtask, matching real browser timing.
            // WebviewAudioEngine.playBlob() awaits the 'canplay' event before calling play().
            queueMicrotask(() => this.dispatchEvent(new Event('canplay')));
        });

        addEventListener = vi.fn().mockImplementation((type: string, listener: Function) => {
            if (!this._listeners.has(type)) { this._listeners.set(type, []); }
            this._listeners.get(type)!.push(listener);
        });

        removeEventListener = vi.fn().mockImplementation((type: string, listener: Function) => {
            const arr = this._listeners.get(type) ?? [];
            this._listeners.set(type, arr.filter(l => l !== listener));
        });

        dispatchEvent(event: Event): boolean {
            const listeners = this._listeners.get(event.type) ?? [];
            listeners.forEach(l => l(event));
            return true;
        }
    };
}

// [v2.4.5] Global Mock for msedge-tts (Baseline for Extension tests)
vi.mock('msedge-tts', () => {
    class MockMsEdgeTTS {
        getVoices = vi.fn().mockResolvedValue([]);
        setMetadata = vi.fn().mockResolvedValue(undefined);
        toStream = vi.fn().mockReturnValue({ audioStream: new (require('events').EventEmitter)() });
        close = vi.fn();
    }
    return {
        MsEdgeTTS: MockMsEdgeTTS,
        OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'mp3-format' }
    };
});
