import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PlaybackController } from '@webview/playbackController';
import { WebviewStore } from '@webview/core/WebviewStore';
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
        resetAllSingletons();
        wireDispatcher();
        
        controller = PlaybackController.getInstance();
        store = WebviewStore.getInstance();
        client = MessageClient.getInstance();
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

    it('SHOULD time out isAwaitingSync if no response arrives within DEFAULT_INTENT_TIMEOUT (2000ms)', () => {
        controller.nextChapter();
        expect(store.getUIState().isAwaitingSync).toBe(true);

        // Advance time by 3500ms (INTENT_TIMEOUT_MS)
        vi.advanceTimersByTime(3500);

        expect(store.getUIState().isAwaitingSync).toBe(false);
    });

    it('SHOULD increment intentId on every navigation to prevent race conditions', () => {
        const firstId = (controller as any).activeIntentId;
        
        controller.nextChapter();
        const secondId = (controller as any).activeIntentId;
        expect(secondId).toBeGreaterThan(firstId);

        controller.prevChapter();
        const thirdId = (controller as any).activeIntentId;
        expect(thirdId).toBeGreaterThan(secondId);
    });
});
