import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebviewStore } from '../../src/webview/core/WebviewStore';
import { WebviewAudioEngine } from '../../src/webview/core/WebviewAudioEngine';

/**
 * @vitest-environment jsdom
 */

describe('Loading Lifecycle Audit & Stabilization', () => {
    let store: WebviewStore;
    let engine: WebviewAudioEngine;
    let mockAudioInstance: any;

    beforeEach(() => {
        // [CRITICAL] Setup mock Audio with listeners
        global.Audio = class {
            play = vi.fn().mockResolvedValue(undefined);
            pause = vi.fn();
            load = vi.fn();
            addEventListener = vi.fn();
            removeEventListener = vi.fn();
            src = '';
            readyState = 4;
            paused = true;
            constructor() {
                mockAudioInstance = this;
            }
        } as any;

        WebviewStore.resetInstance();
        WebviewAudioEngine.resetInstance();
        
        store = WebviewStore.getInstance();
        engine = WebviewAudioEngine.getInstance();

        // 🟢 Hydrate the store so patchState works (it ignores null states)
        store.optimisticPatch({ playbackStalled: false });
    });

    it('BUG RERO: isAwaitingSync should be cleared by pause() and skip commands', () => {
        // 1. Manually trigger a "Sync Lock"
        store.updateUIState({ isAwaitingSync: true });
        expect(store.getUIState().isAwaitingSync).toBe(true);

        // 2. User clicks Pause
        engine.pause();

        // [VERIFIED]: isAwaitingSync is now cleared via unified resetLoadingStates()
        expect(store.getUIState().isAwaitingSync).toBe(false);
    });

    it('BUG REPRO: playbackStalled should be cleared by pause()', () => {
        // 1. Trigger buffer stall during active playback intent
        (engine as any).intent = 'PLAYING';
        mockAudioInstance.onwaiting();
        expect(store.getState()?.playbackStalled).toBe(true);

        // 2. User clicks Pause
        engine.pause();

        // [VERIFIED]: playbackStalled is now cleared via unified resetLoadingStates()
        expect(store.getState()?.playbackStalled).toBe(false);
    });

    it('OPTIMISTIC GESTURE: optimisticPatch should kill ALL loading states', () => {
        // 1. High-tension state: Stalled and Awaiting Sync
        store.updateUIState({ isAwaitingSync: true });
        store.patchState({ playbackStalled: true });
        expect(store.getUIState().isAwaitingSync).toBe(true);
        expect(store.getState()?.playbackStalled).toBe(true);

        // 2. User clicks play (generates optimistic patch)
        store.optimisticPatch({ isPlaying: true, isPaused: false });

        // [VERIFIED]: optimisticPatch now calls resetLoadingStates() first
        expect(store.getUIState().isAwaitingSync).toBe(false);
        expect(store.getState()?.playbackStalled).toBe(false);
    });
});
