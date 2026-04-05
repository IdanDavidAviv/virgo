/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommandDispatcher } from '../../src/webview/core/CommandDispatcher';
import { WebviewStore } from '../../src/webview/core/WebviewStore';
import { WebviewAudioEngine } from '../../src/webview/core/WebviewAudioEngine';

describe('CacheWipeSymmetry (TDD)', () => {
    let dispatcher: CommandDispatcher;
    let store: WebviewStore;

    beforeEach(() => {
        store = WebviewStore.getInstance();
        dispatcher = CommandDispatcher.getInstance();
        
        // [HYDRATION]: Ensure store is not null
        store.updateState({
            state: { currentSentenceIndex: 0, currentChapterIndex: 0 },
            isPlaying: false,
            isPaused: false,
            playbackStalled: false,
            cacheCount: 0,
            cacheSizeBytes: 0
        } as any);

        // Populate store with fake values
        store.patchState({
            cacheCount: 50,
            cacheSizeBytes: 1024 * 1024 * 5 // 5MB
        });
        
        // Mock engine
        vi.spyOn(WebviewAudioEngine.getInstance(), 'wipeCache').mockResolvedValue(undefined);
    });

    it('SHOULD reset all store properties to zero when CLEAR_CACHE_WIPE arrives', async () => {
        // [GIVEN]: Store is populated
        const state1 = store.getState();
        if (!state1) { throw new Error('Store state is null'); }
        expect(state1.cacheCount).toBe(50);
        expect(state1.cacheSizeBytes).toBe(1024 * 1024 * 5);
        
        // [WHEN]: Signal arrives
        await dispatcher.dispatch('CLEAR_CACHE_WIPE', {});
        
        // [THEN]: Store should be empty
        // [BUG]: The current implementation might be missing entries or using wrong keys!
        const state2 = store.getState();
        if (!state2) { throw new Error('Store state is null'); }
        expect(state2.cacheCount, 'cacheCount was NOT zeroed!').toBe(0);
        expect(state2.cacheSizeBytes, 'cacheSizeBytes was NOT zeroed!').toBe(0);
    });
});
