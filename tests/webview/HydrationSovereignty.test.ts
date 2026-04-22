import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebviewStore } from '../../src/webview/core/WebviewStore';
import { PlaybackController } from '../../src/webview/playbackController';
import { MessageClient } from '../../src/webview/core/MessageClient';
import { OutgoingAction } from '../../src/common/types';

/**
 * Hydration Sovereignty Test
 * Verifies that the Webview components and controller allow user-initiated actions
 * OPTIMISTICALLY, even before the authoritative sync/hydration from the Extension is complete.
 * 
 * @vitest-environment jsdom
 */
import { resetAllSingletons } from './testUtils';

describe('Hydration Sovereignty (Webview Side)', () => {
    let mockVscode: any;

    beforeEach(() => {
        resetAllSingletons();

        // Mock VS Code API
        mockVscode = { postMessage: vi.fn() };
        (window as any).acquireVsCodeApi = () => mockVscode;
        
        vi.useFakeTimers();
    });

    it('should allow PLAY action when hydration is incomplete (Standalone Sovereignty)', async () => {
        const controller = PlaybackController.getInstance();
        const store = WebviewStore.getInstance();

        // 1. Ensure hydration is NOT complete
        expect(store.getState().isHydrated).toBe(false);

        // 2. Attempt to play — play() is async (awaits ensureAudioContext internally)
        //    We must await it so postMessage fires before the assertion.
        await controller.play();

        // 3. Verification: Message IS sent to extension (Optimistic UI)
        expect(mockVscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            command: OutgoingAction.PLAY
        }));
    });

    it('should allow LOAD_DOCUMENT action when hydration is incomplete', async () => {
        const controller = PlaybackController.getInstance();
        const store = WebviewStore.getInstance();

        expect(store.getState().isHydrated).toBe(false);

        controller.loadDocument();
        
        vi.advanceTimersByTime(100);

        // 3. Verification: Message IS sent to extension
        expect(mockVscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            command: OutgoingAction.LOAD_DOCUMENT
        }));
    });

    it('should correctly adopt hydration state upon first sync', async () => {
        const controller = PlaybackController.getInstance();
        const store = WebviewStore.getInstance();

        expect(store.getState().isHydrated).toBe(false);

        // Simulate authoritative sync packet
        controller.handleSync({ 
            playbackIntentId: 100,
            batchIntentId: 100,
            focusedIsSupported: true,
            activeFileName: 'test.md'
        } as any);
        
        expect(store.getState().isHydrated).toBe(true);
        expect(store.getState().playbackIntentId).toBe(100);
        expect(store.getState().activeFileName).toBe('test.md');
    });
});
