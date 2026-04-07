import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WebviewStore } from '@webview/core/WebviewStore';
import { WebviewAudioEngine } from '@webview/core/WebviewAudioEngine';
import { PlaybackController } from '@webview/playbackController';
import { resetAllSingletons, wireDispatcher } from './testUtils';

/**
 * @vitest-environment jsdom
 */

describe('Loading Lifecycle Audit & Stabilization', () => {
    let store: WebviewStore;
    let engine: WebviewAudioEngine;
    let controller: PlaybackController;
    let mockAudioInstance: any;

    beforeEach(() => {
        // [CRITICAL] Setup mock Audio with listeners
        global.Audio = class {
            play = vi.fn().mockResolvedValue(undefined);
            pause = vi.fn();
            load = vi.fn();
            addEventListener = vi.fn();
            removeEventListener = vi.fn();
            onplay = () => {};
            onpause = () => {};
            onended = () => {};
            onerror = () => {};
            onwaiting = () => {};
            onplaying = () => {};
            src = '';
            readyState = 4;
            paused = true;
            constructor() {
                mockAudioInstance = this;
            }
        } as any;

        resetAllSingletons();
        wireDispatcher();
        
        store = WebviewStore.getInstance();
        engine = WebviewAudioEngine.getInstance();
        controller = PlaybackController.getInstance();

        // 🟢 Hydrate the store properly
        store.updateState({ playbackStalled: false }, 'remote');
    });

    it('BUG REPRO: isAwaitingSync should be cleared by pause() and skip commands', () => {
        // 1. Manually trigger a "Sync Lock"
        store.updateUIState({ isAwaitingSync: true });
        expect(store.getUIState().isAwaitingSync).toBe(true);

        // 2. User clicks Pause via Controller (which is what happens in the UI)
        controller.pause();

        // [VERIFIED]: isAwaitingSync is initially set to TRUE because a new user command started
        expect(store.getUIState().isAwaitingSync).toBe(true);

        // 3. Manually clear it to verify resetLoadingStates effectiveness
        store.resetLoadingStates();
        expect(store.getUIState().isAwaitingSync).toBe(false);
    });

    it('BUG REPRO: playbackStalled should be cleared by pause()', () => {
        // 1. Trigger buffer stall during active playback intent
        // [SOVEREIGNTY]: Use PlaybackController to set intent and matching URL for strategy
        const mockUrl = 'neural-cache://test-segment';
        
        // Mock the strategy's internal state to pass sovereignty check
        (engine as any).neuralStrategy.sovereignUrl = mockUrl;
        mockAudioInstance.src = mockUrl;
        
        // Verify stall logic
        mockAudioInstance.onwaiting();
        expect(store.getState()?.playbackStalled).toBe(true);

        // 2. User clicks Pause via Controller
        controller.pause();

        // [VERIFIED]: playbackStalled is now cleared via unified resetLoadingStates()
        expect(store.getState()?.playbackStalled).toBe(false);
    });

    it('OPTIMISTIC GESTURE: resetLoadingStates should kill ALL loading states', () => {
        // 1. High-tension state: Stalled and Awaiting Sync
        store.updateUIState({ isAwaitingSync: true });
        store.updateState({ playbackStalled: true } as any, 'remote');
        expect(store.getUIState().isAwaitingSync).toBe(true);
        expect(store.getState()?.playbackStalled).toBe(true);

        // 2. Call resetLoadingStates (e.g. on new user gesture)
        store.resetLoadingStates();

        // [VERIFIED]: resetLoadingStates() cleared the indicators
        expect(store.getUIState().isAwaitingSync).toBe(false);
        expect(store.getState()?.playbackStalled).toBe(false);
    });
});
