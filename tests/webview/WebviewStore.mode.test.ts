/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebviewStore } from '@webview/core/WebviewStore';
import { MessageClient } from '@webview/core/MessageClient';
import { IncomingCommand, UISyncPacket } from '@common/types';
import { wireDispatcher } from './testUtils';

describe('WebviewStore: activeMode Sync', () => {
    beforeEach(() => {
        (window as any).vscode = null;
        (window as any).acquireVsCodeApi = vi.fn(() => ({
            postMessage: vi.fn()
        }));
        MessageClient.resetInstance();
        WebviewStore.resetInstance();
        wireDispatcher();
    });

    it('should hydrate activeMode: FILE by default', () => {
        const store = WebviewStore.getInstance();
        
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                isPlaying: false,
                activeMode: 'FILE'
            }
        }));

        expect(store.getState()?.activeMode).toBe('FILE');
    });

    it('should hydrate activeMode: SNIPPET when received', () => {
        const store = WebviewStore.getInstance();
        
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                isPlaying: false,
                activeMode: 'SNIPPET'
            }
        }));

        expect(store.getState()?.activeMode).toBe('SNIPPET');
    });

    it('should notify subscribers when activeMode changes', () => {
        const store = WebviewStore.getInstance();
        const listener = vi.fn();
        
        // Subscribe to activeMode
        store.subscribe((state) => state.activeMode, listener);

        // First sync
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                isPlaying: false,
                activeMode: 'FILE'
            }
        }));

        expect(listener).toHaveBeenCalledWith('FILE');
        vi.clearAllMocks();

        // Change to SNIPPET
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                isPlaying: false,
                activeMode: 'SNIPPET'
            }
        }));

        expect(listener).toHaveBeenCalledWith('SNIPPET');
    });
});
