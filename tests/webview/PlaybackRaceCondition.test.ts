/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebviewAudioEngine } from '../../src/webview/core/WebviewAudioEngine';
import { WebviewStore } from '../../src/webview/core/WebviewStore';

describe('PlaybackRaceCondition (TDD)', () => {
    let engine: WebviewAudioEngine;
    let store: WebviewStore;

    beforeEach(() => {
        vi.useFakeTimers();
        // Reset singleton
        (WebviewAudioEngine as any).instance = undefined;
        store = WebviewStore.getInstance();
        (store as any)._isHydrated = true;
        engine = WebviewAudioEngine.getInstance();
        
        // Mock Audio element
        (engine as any).neuralStrategy.audio = {
            pause: vi.fn(),
            play: vi.fn().mockResolvedValue(undefined),
            load: vi.fn(),
            paused: true,
            src: ''
        };

        // Mock store functions needed
        vi.spyOn(store, 'updateUIState');
        store.updateState({ 
            isPlaying: false, 
            isPaused: true, 
            playbackStalled: false,
            currentSentenceIndex: 0,
            sentences: []
        } as any, 'remote');
    });

    it('SHOULD NOT resolve main wait when a prefetch signal arrives', async () => {
        // 1. Set the "Target" to Sentence A
        (engine as any).neuralStrategy.targetCacheKey = 'sentence-a';

        // 2. Start a "Main" wait for Sentence A (intentId: 100)
        const mainWait = engine.startAdaptiveWait('sentence-a', 100);
        
        // 3. Advance half-way (15ms)
        await vi.advanceTimersByTimeAsync(15);
        
        // 4. Start a "Prefetch" wait for Sentence B (intentId: 101)
        // This should NOT clear 'mainWait''s resolver OR interfere with stall logic
        engine.startAdaptiveWait('sentence-b', 101);
        
        // 5. Verify that mainWait is STILL PENDING
        let isResolved = false;
        mainWait.then(() => { isResolved = true; });
        
        await vi.advanceTimersByTimeAsync(1);
        expect(isResolved, 'Main wait was prematurely resolved by prefetch signal!').toBe(false);
        
        // 6. Verify that playbackStalled is still false (wait hasn't expired yet)
        expect(store.getState()?.playbackStalled).toBe(false);

        // 7. Advance past the original 40ms timeout (total 45ms)
        await vi.advanceTimersByTimeAsync(30);
        
        // 8. Now it should be resolved AND stalled (because it was the target)
        expect(isResolved).toBe(true);
        expect(store.getState()?.playbackStalled).toBe(true);
    });

    it('SHOULD NOT set playbackStalled for a non-target prefetch wait', async () => {
        // [GIVEN]: Target is Sentence A
        (engine as any).neuralStrategy.targetCacheKey = 'sentence-a';
        store.patchState({ playbackStalled: false });

        // [WHEN]: Wait starts for Sentence B (prefetch)
        engine.startAdaptiveWait('sentence-b', 105);
        
        // [AND]: Timeout expires
        await vi.advanceTimersByTimeAsync(100);
        
        // [THEN]: playbackStalled should STAY FALSE
        expect(store.getState()?.playbackStalled).toBe(false);
    });
});
