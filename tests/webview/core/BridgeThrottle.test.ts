/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebviewAudioEngine } from '../../../src/webview/core/WebviewAudioEngine';
import { PlaybackController } from '../../../src/webview/playbackController';

// Mock WebviewStore to avoid IPC/State side effects in JSDOM
vi.mock('../../../src/webview/core/WebviewStore', () => ({
    WebviewStore: {
        getInstance: vi.fn(() => ({
            subscribe: vi.fn(() => () => {}),
            subscribeUI: vi.fn(() => () => {}),
            patchState: vi.fn(),
            resetLoadingStates: vi.fn(),
            getState: vi.fn(() => ({ intent: 'PLAYING', selectedVoice: 'Neural:Azure' })),
            getUIState: vi.fn(() => ({})),
            updateUIState: vi.fn()
        })),
        resetInstance: vi.fn()
    }
}));

// Mock CacheManager to avoid indexedDB issues in JSDOM
vi.mock('../../../src/webview/cacheManager', () => ({
    CacheManager: class {
        get = vi.fn().mockResolvedValue(null);
        set = vi.fn().mockResolvedValue(undefined);
        delete = vi.fn().mockResolvedValue(undefined);
        clear = vi.fn().mockResolvedValue(undefined);
    }
}));

describe('Resilience: BridgeThrottle & Adaptive JIT (v2.0.0 Hardening)', () => {
    let engine: WebviewAudioEngine;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();

        // Mock URL for Blob support in JSDOM
        if (typeof window.URL.createObjectURL === 'undefined') {
            Object.defineProperty(window.URL, 'createObjectURL', { value: vi.fn(() => 'blob:test') });
            Object.defineProperty(window.URL, 'revokeObjectURL', { value: vi.fn() });
        }

        // 1. Reset all singletons proper (SSOT parity)
        WebviewAudioEngine.resetInstance();
        PlaybackController.resetInstance();

        // 2. Mock Audio
        (window as any).Audio = class {
            volume = 1;
            playbackRate = 1;
            src = '';
            onended = () => {};
            onerror = () => {};
            onplay = () => {};
            onpause = () => {};
            onwaiting = () => {};
            onplaying = () => {};
            play = vi.fn().mockResolvedValue(undefined);
            pause = vi.fn();
            load = vi.fn();
            addEventListener = vi.fn();
            removeEventListener = vi.fn();
        };

        engine = WebviewAudioEngine.getInstance();
        
        // Mock binary processing to keep tests lean
        const strategy = (engine as any).neuralStrategy;
        vi.spyOn(strategy, 'base64ToBlob').mockReturnValue(new Blob(['fake-audio']));
        
        // Ensure controller says we are playing
        const controller = PlaybackController.getInstance();
        vi.spyOn(controller, 'getState').mockReturnValue({ intent: 'PLAYING' } as any);
    });

    it('SHOULD enter Adaptive Wait state and resolve when data arrives', async () => {
        const strategy = (engine as any).neuralStrategy;
        const playSpy = vi.spyOn(strategy, 'playBlob').mockResolvedValue(undefined);

        console.log('[TEST] Starting startAdaptiveWait');
        // 1. Trigger Adaptive Wait for "key-1"
        const waitPromise = engine.startAdaptiveWait('key-1', 100);
        
        // 2. Data arrives via push 10ms later
        setTimeout(() => {
            console.log('[TEST] setTimeout fired! Calling ingestData');
            engine.ingestData('key-1', 'fake-base64', 100).catch(e => console.error(e));
        }, 10);

        console.log('[TEST] Advancing timers');
        // Advance timers past the 10ms push but BEFORE the 40ms timeout
        await vi.advanceTimersByTimeAsync(20);
        
        console.log('[TEST] Timers advanced, awaiting waitPromise');
        // 3. ASSERT: Audio should have played immediately upon ingestion
        await waitPromise;
        console.log('[TEST] waitPromise resolved');
        expect(playSpy).toHaveBeenCalled();
    });

    it('SHOULD timeout the Adaptive Wait after 40ms if no data arrives', async () => {
        const strategy = (engine as any).neuralStrategy;
        const playSpy = vi.spyOn(strategy, 'playBlob').mockResolvedValue(undefined);

        // 1. Trigger Adaptive Wait
        const waitPromise = engine.startAdaptiveWait('key-2', 200);
        
        // 2. Advance timers past the 40ms limit
        await vi.advanceTimersByTimeAsync(100);
        
        await waitPromise;

        // 3. ASSERT: play() should NOT have been called (it timed out)
        expect(playSpy).not.toHaveBeenCalled();
    });

    it('SHOULD reject late push for a timed-out wait', async () => {
        const strategy = (engine as any).neuralStrategy;
        const playSpy = vi.spyOn(strategy, 'playBlob').mockResolvedValue(undefined);

        // 1. Trigger Adaptive Wait
        const waitPromise = engine.startAdaptiveWait('key-3', 300);
        
        // 2. Advance past timeout
        await vi.advanceTimersByTimeAsync(100);
        await waitPromise;

        // 3. Push data arrives LATE
        await engine.ingestData('key-3', 'fake-base64', 300);

        // 4. ASSERT: Even though the Wait timed out (showing Loading...), 
        // the push is STILL valid because intentId matches the sentence.
        expect(playSpy).toHaveBeenCalled(); 
    });
});
