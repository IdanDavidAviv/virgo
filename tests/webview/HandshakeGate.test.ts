import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebviewStore } from '../../src/webview/core/WebviewStore';
import { PlaybackController } from '../../src/webview/playbackController';
import { MessageClient } from '../../src/webview/core/MessageClient';
import { OutgoingAction } from '../../src/common/types';

/**
 * Handshake Gate Test
 * Verifies that the Webview components and controller strictly block user-initiated actions
 * until the authoritative handshake from the Extension is complete.
 * 
 * @vitest-environment jsdom
 */
import { resetAllSingletons } from './testUtils';

describe('Handshake Gate (Webview Side)', () => {
    let mockVscode: any;

    beforeEach(() => {
        resetAllSingletons();

        // Mock VS Code API
        mockVscode = { postMessage: vi.fn() };
        (window as any).acquireVsCodeApi = () => mockVscode;
        
        vi.useFakeTimers();
    });

    it('should block PLAY action when handshake is incomplete', async () => {
        const controller = PlaybackController.getInstance();
        const store = WebviewStore.getInstance();

        // 1. Ensure handshake is NOT complete
        expect(store.getState().isHandshakeComplete).toBe(false);

        // 2. Attempt to play
        controller.play();
        
        vi.advanceTimersByTime(100);

        // 3. Verification: No message sent to extension
        expect(mockVscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            command: OutgoingAction.PLAY
        }));
    });

    it('should allow PLAY action after handshake is complete', async () => {
        const controller = PlaybackController.getInstance();
        const store = WebviewStore.getInstance();

        // 1. Simulate authoritative sync packet (Hydrates store + Completes handshake)
        store.updateState({ state: {} } as any); 
        controller.handleSync({ 
            playbackIntentId: 0,
            batchIntentId: 0,
            state: {}
        } as any);
        
        expect(store.getState().isHandshakeComplete).toBe(true);
        expect(store.isHydrated()).toBe(true);

        // 2. Attempt to play
        controller.play();
        
        vi.advanceTimersByTime(100);

        // 3. Verification: Message IS sent to extension
        expect(mockVscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            command: OutgoingAction.PLAY
        }));
    });

    it('should block LOAD_DOCUMENT action when handshake is incomplete', async () => {
        const controller = PlaybackController.getInstance();
        const store = WebviewStore.getInstance();

        expect(store.getState().isHandshakeComplete).toBe(false);

        controller.loadDocument();
        
        vi.advanceTimersByTime(100);

        expect(mockVscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            command: OutgoingAction.LOAD_DOCUMENT
        }));
    });

    it('should allow LOAD_DOCUMENT action after handshake is complete', async () => {
        const controller = PlaybackController.getInstance();
        const store = WebviewStore.getInstance();

        // 1. Simulate authoritative sync packet (Hydrates store + Completes handshake)
        store.updateState({ state: {} } as any);
        controller.handleSync({ 
            playbackIntentId: 0,
            batchIntentId: 0,
            state: {}
        } as any);

        // 2. Attempt to load
        controller.loadDocument();
        
        vi.advanceTimersByTime(100);

        // 3. Verification: Message IS sent to extension
        expect(mockVscode.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            command: OutgoingAction.LOAD_DOCUMENT
        }));
    });
});
