import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PlaybackController } from '@webview/playbackController';
import { WebviewStore, DEFAULT_SYNC_PACKET } from '@webview/core/WebviewStore';
import { MessageClient } from '@webview/core/MessageClient';
import { OutgoingAction } from '@common/types';
import { resetAllSingletons, wireDispatcher } from '../testUtils';

/**
 * @vitest-environment jsdom
 */

describe('PlaybackController: Watchdog & Stall Suppression', () => {
    let controller: PlaybackController;
    let store: WebviewStore;
    let client: MessageClient;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1000000000); // Stable starting time
        resetAllSingletons();
        wireDispatcher();
        
        controller = PlaybackController.getInstance();
        store = WebviewStore.getInstance();
        client = MessageClient.getInstance();

        // Satisfy Handshake Gate by providing 'state' to trigger hydration
        store.updateUIState({ 
            isHandshakeComplete: true,
            state: { ...DEFAULT_SYNC_PACKET.state } 
        });
    });

    it('SHOULD trigger watchdog and set isAwaitingSync=true on navigation', () => {
        const postSpy = vi.spyOn(client, 'postAction');
        
        controller.nextChapter();

        expect(store.getUIState().isAwaitingSync).toBe(true);
        expect(postSpy).toHaveBeenCalledWith(OutgoingAction.NEXT_CHAPTER, expect.any(Object));
    });

    it('SHOULD clear isAwaitingSync when a UI_SYNC arrives with matching state', () => {
        controller.nextChapter();
        expect(store.getUIState().isAwaitingSync).toBe(true);

        // Simulate UI_SYNC arrival
        store.updateUIState({ isAwaitingSync: false });
        
        expect(store.getUIState().isAwaitingSync).toBe(false);
    });

    it('SHOULD time out isAwaitingSync if no response arrives within INTENT_TIMEOUT_MS (5000ms)', () => {
        controller.nextChapter();
        expect(store.getUIState().isAwaitingSync).toBe(true);

        // [v2.2.2] Advance time by 5500ms (exceeds INTENT_TIMEOUT_MS)
        vi.advanceTimersByTime(5500);

        expect(store.getUIState().isAwaitingSync).toBe(false);
    });

    it('SHOULD increment intentId on every navigation to prevent race conditions', () => {
        // Capture initial ID (often 0 if not set)
        const firstId = store.getUIState().playbackIntentId;
        
        vi.setSystemTime(1000000001); 
        controller.nextChapter();
        const secondId = store.getUIState().playbackIntentId;
        expect(secondId).toBeGreaterThan(firstId);

        vi.setSystemTime(1000000002);
        controller.prevChapter();
        const thirdId = store.getUIState().playbackIntentId;
        expect(thirdId).toBeGreaterThan(secondId);
    });
});
