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

        // Mock WebviewAudioEngine.getInstance (v2.3.1 Dumb Player)
        vi.spyOn(WebviewAudioEngine, 'getInstance').mockReturnValue({
            pause: vi.fn(),
            stop: vi.fn(),
            ensureAudioContext: vi.fn(),
            speakLocal: vi.fn(),
            playBlob: vi.fn(),
            playFromBase64: vi.fn(),
            playFromCache: vi.fn().mockResolvedValue(false),
            scanVoices: vi.fn(),
            ingestData: vi.fn(),
            wipeCache: vi.fn(),
            purgeMemory: vi.fn()
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
            isHandshakeComplete: true,
            state: {
                currentSentenceIndex: 0
            },
            playbackStalled: false 
        };
        (store as any)._isHydrated = true;
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
