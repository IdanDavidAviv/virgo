import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WebviewStore } from '../../../src/webview/core/WebviewStore';
import { PlaybackController, PlaybackIntent } from '../../../src/webview/playbackController';
import { MessageClient } from '../../../src/webview/core/MessageClient';
import { WebviewAudioEngine } from '../../../src/webview/core/WebviewAudioEngine';

/**
 * @vitest-environment jsdom
 */

describe('PlaybackController: Optimistic Transitions (TDD)', () => {
    let store: WebviewStore;
    let controller: PlaybackController;

    beforeEach(() => {
        // Reset singletons for isolation
        WebviewStore.resetInstance();
        PlaybackController.resetInstance();
        MessageClient.resetInstance();
        WebviewAudioEngine.resetInstance();

        // Mock WebviewAudioEngine.getInstance
        vi.spyOn(WebviewAudioEngine, 'getInstance').mockReturnValue({
            pause: vi.fn(),
            stop: vi.fn(),
            getAudioElement: vi.fn(() => ({ pause: vi.fn(), onerror: null }))
        } as any);

        store = WebviewStore.getInstance();
        controller = PlaybackController.getInstance();

        // Hydrate store
        store.optimisticPatch({ 
            isPlaying: true, 
            isPaused: false,
            playbackStalled: false 
        });
    });

    it('STOP: should patch the store with intent=STOPPED immediately', () => {
        const optimisticSpy = vi.spyOn(store, 'optimisticPatch');
        
        controller.stop();

        expect(optimisticSpy).toHaveBeenCalledWith(
            expect.objectContaining({ isPlaying: false, isPaused: true }),
            expect.objectContaining({ isAwaitingSync: true })
        );

        expect(store.getUIState().playbackIntent).toBe('STOPPED');
    });

    it('PAUSE: should patch the store with intent=PAUSED immediately', () => {
        controller.play(); // Setup playing state
        const optimisticSpy = vi.spyOn(store, 'optimisticPatch');
        
        controller.pause();

        expect(optimisticSpy).toHaveBeenCalledWith(
            expect.objectContaining({ isPaused: true }),
            expect.objectContaining({ isAwaitingSync: true })
        );

        expect(store.getUIState().playbackIntent).toBe('PAUSED');
    });
});
