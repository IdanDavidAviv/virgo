import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WebviewStore } from '@webview/core/WebviewStore';
import { PlaybackController, PlaybackIntent } from '@webview/playbackController';
import { MessageClient } from '@webview/core/MessageClient';
import { WebviewAudioEngine } from '@webview/core/WebviewAudioEngine';
import { resetAllSingletons, wireDispatcher } from '../testUtils';

/**
 * @vitest-environment jsdom
 */

describe('PlaybackController: Optimistic Transitions (TDD)', () => {
    let store: WebviewStore;
    let controller: PlaybackController;

    beforeEach(() => {
        // Reset singletons for isolation
        resetAllSingletons();
        wireDispatcher();

        // Mock WebviewAudioEngine.getInstance
        vi.spyOn(WebviewAudioEngine, 'getInstance').mockReturnValue({
            pause: vi.fn(),
            stop: vi.fn(),
            ensureAudioContext: vi.fn(),
            prepareForPlayback: vi.fn(),
            synthesize: vi.fn(),
            playBlob: vi.fn(),
            playFromBase64: vi.fn(),
            playFromCache: vi.fn().mockResolvedValue(false),
            getAudioElement: vi.fn(() => ({ pause: vi.fn(), onerror: null }))
        } as any);

        store = WebviewStore.getInstance();
        controller = PlaybackController.getInstance();

        // Hydrate store
        (store as any).state = { 
            isPlaying: true, 
            isPaused: false,
            volume: 50,
            rate: 0,
            selectedVoice: 'en-US-SteffanNeural',
            currentChapterIndex: 0,
            state: {
                currentSentenceIndex: 0
            },
            playbackStalled: false 
        };
        store.updateUIState({ isAwaitingSync: false });
    });

    it('STOP: should patch the store with intent=STOPPED immediately', () => {
        const uiSpy = vi.spyOn(store, 'updateUIState');
        
        controller.stop();

        expect(uiSpy).toHaveBeenCalledWith(
            expect.objectContaining({ playbackIntent: 'STOPPED', isAwaitingSync: true })
        );

        expect(store.getUIState().playbackIntent).toBe('STOPPED');
    });

    it('PAUSE: should patch the store with intent=PAUSED immediately', () => {
        controller.play(); // Setup playing state
        const uiSpy = vi.spyOn(store, 'updateUIState');
        
        controller.pause();

        expect(uiSpy).toHaveBeenCalledWith(
            expect.objectContaining({ playbackIntent: 'PAUSED', isAwaitingSync: true })
        );

        expect(store.getUIState().playbackIntent).toBe('PAUSED');
    });
});
