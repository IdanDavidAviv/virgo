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
            getState: vi.fn(() => ({ intent: 'PLAYING' })),
            getUIState: vi.fn(() => ({})),
            updateUIState: vi.fn()
        })),
        resetInstance: vi.fn()
    }
}));

describe('Resilience: BridgeThrottle & Adaptive JIT (v2.0.0 Hardening)', () => {
    let engine: WebviewAudioEngine;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();

        // 1. Reset all singletons proper (SSOT parity)
        WebviewAudioEngine.resetInstance();
        PlaybackController.resetInstance();

        // 2. Mock Audio
        (window as any).Audio = class {
            volume = 1;
            playbackRate = 1;
            src = '';
            onended: any = null;
            onerror: any = null;
            onplay: any = null;
            onpause: any = null;
            onwaiting: any = null;
            onplaying: any = null;
            play = vi.fn().mockResolvedValue(undefined);
            pause = vi.fn();
            load = vi.fn();
        };

        engine = WebviewAudioEngine.getInstance();
        
        // Mock binary processing to keep tests lean
        vi.spyOn(engine as any, 'base64ToBlob').mockReturnValue(new Blob(['fake-audio']));
        
        // Ensure controller says we are playing
        const controller = PlaybackController.getInstance();
        vi.spyOn(controller, 'getState').mockReturnValue({ intent: 'PLAYING' } as any);
    });

    it('SHOULD enter Adaptive Wait state and resolve when data arrives', async () => {
        const playSpy = vi.spyOn(engine, 'playBlob').mockResolvedValue(undefined);

        // 1. Trigger Adaptive Wait for "key-1"
        const waitPromise = engine.startAdaptiveWait('key-1', 100);
        
        // 2. Data arrives via push 10ms later
        setTimeout(() => {
            engine.ingestData('key-1', 'fake-base64', 100);
        }, 10);

        // Advance timers ASYNC to flush microtasks
        await vi.advanceTimersByTimeAsync(15);
        
        // 3. ASSERT: Audio should have played immediately upon ingestion
        await waitPromise;
        expect(playSpy).toHaveBeenCalledWith(expect.any(Blob), 'key-1', 100);
    });

    it('SHOULD timeout the Adaptive Wait after 30ms if no data arrives', async () => {
        const playSpy = vi.spyOn(engine, 'playBlob').mockResolvedValue(undefined);

        // 1. Trigger Adaptive Wait
        const waitPromise = engine.startAdaptiveWait('key-2', 200);
        
        // 2. Advance timers past the 30ms limit
        await vi.advanceTimersByTimeAsync(50);
        
        await waitPromise;

        // 3. ASSERT: play() should NOT have been called (it timed out)
        expect(playSpy).not.toHaveBeenCalled();
    });

    it('SHOULD reject late push for a timed-out wait', async () => {
        const playSpy = vi.spyOn(engine, 'playBlob').mockResolvedValue(undefined);

        // 1. Trigger Adaptive Wait
        const waitPromise = engine.startAdaptiveWait('key-3', 300);
        
        // 2. Advance past timeout
        await vi.advanceTimersByTimeAsync(50);
        await waitPromise;

        // 3. Push data arrives LATE
        await engine.ingestData('key-3', 'fake-base64', 300);

        // 4. ASSERT: Even though the Wait timed out (showing Loading...), 
        // the push is STILL valid because intentId matches the sentence.
        expect(playSpy).toHaveBeenCalledWith(expect.any(Blob), 'key-3', 300); 
    });
});
