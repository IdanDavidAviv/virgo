import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebviewStore } from '../../src/webview/core/WebviewStore';
import { WebviewAudioEngine } from '../../src/webview/core/WebviewAudioEngine';
import { PlaybackController } from '../../src/webview/playbackController';
import { resetAllSingletons, wireDispatcher } from './testUtils';

/**
 * @vitest-environment jsdom
 */

describe('Loading Lifecycle Audit & Stabilization (v2.3.1)', () => {
    let store: WebviewStore;
    let engine: WebviewAudioEngine;
    let controller: PlaybackController;

    beforeEach(() => {
        // [CRITICAL] Setup mock Audio with listeners
        if (!(window as any).Audio) {
            (window as any).Audio = class {
                play = vi.fn().mockResolvedValue(undefined);
                pause = vi.fn();
                load = vi.fn();
                addEventListener = vi.fn();
                removeEventListener = vi.fn();
                src = '';
                readyState = 4;
                paused = true;
            } as any;
        }

        resetAllSingletons();
        wireDispatcher();
        
        store = WebviewStore.getInstance();
        engine = WebviewAudioEngine.getInstance();
        controller = PlaybackController.getInstance();

        // 🟢 Authoritative Handshake
        store.updateState({ isHandshakeComplete: true });
    });

    it('SHOULD clear isAwaitingSync during resetLoadingStates', () => {
        // 1. Manually trigger a "Sync Lock"
        store.updateUIState({ isAwaitingSync: true });
        expect(store.getUIState().isAwaitingSync).toBe(true);

        // 2. Clear it via store
        store.resetLoadingStates();
        expect(store.getUIState().isAwaitingSync).toBe(false);
    });

    it('playbackStalled should be cleared by resetLoadingStates()', () => {
        // 1. Trigger buffer stall
        store.patchState({ playbackStalled: true });
        expect(store.getState().playbackStalled).toBe(true);

        // 2. Reset
        store.resetLoadingStates();

        // [VERIFIED]: playbackStalled is now cleared via unified resetLoadingStates()
        expect(store.getState().playbackStalled).toBe(false);
    });

    it('OPTIMISTIC GESTURE: resetLoadingStates should kill ALL loading states', () => {
        // 1. High-tension state: Stalled and Awaiting Sync
        store.updateUIState({ isAwaitingSync: true });
        store.patchState({ playbackStalled: true });
        
        expect(store.getUIState().isAwaitingSync).toBe(true);
        expect(store.getState().playbackStalled).toBe(true);

        // 2. Call resetLoadingStates
        store.resetLoadingStates();

        // [VERIFIED]: resetLoadingStates() cleared the indicators
        expect(store.getUIState().isAwaitingSync).toBe(false);
        expect(store.getState().playbackStalled).toBe(false);
    });
});
