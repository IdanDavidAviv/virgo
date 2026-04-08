/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { WebviewStore } from '@webview/core/WebviewStore';
import { WebviewAudioEngine } from '@webview/core/WebviewAudioEngine';
import { IncomingCommand } from '@common/types';
import { CommandDispatcher } from '@webview/core/CommandDispatcher';
import { CacheManager } from '@webview/cacheManager';

describe('Cache Wipe Sovereignty (TDD: #45)', () => {
    let store: WebviewStore;
    let engine: WebviewAudioEngine;

    beforeEach(() => {
        vi.clearAllMocks();
        // Reset singletons for a clean TDD state
        WebviewStore.resetInstance();
        WebviewAudioEngine.resetInstance();
        
        store = WebviewStore.getInstance();
        engine = WebviewAudioEngine.getInstance();
    });

    it('SHOULD revoke all blob URLs before clearing IndexedDB (Ghost Audio Guard)', async () => {
        const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
        const cacheClearSpy = vi.spyOn(CacheManager.getInstance(), 'clearAll');
        
        // [v2.3.1] Add a fake blob to authoritative set so revocation is triggered
        (engine as any)._activeObjectURLs.add('blob:fake-url');

        await engine.wipeCache();
        
        const revokeOrder = revokeSpy.mock.invocationCallOrder[0];
        const clearOrder = cacheClearSpy.mock.invocationCallOrder[0];

        expect(revokeSpy).toHaveBeenCalled();
        expect(cacheClearSpy).toHaveBeenCalled();
        expect(revokeOrder).toBeLessThan(clearOrder); // Revocation MUST happen first
    });

    it('SHOULD reset neuralBuffer stats to zero immediately after wipe', async () => {
        // 1. Manually hydrate store with "stale" cache stats
        // [REINFORCEMENT] Use updateState to ensure this.state is hydrated in test environment
        store.updateState({ 
            cacheCount: 15,
            cacheSizeBytes: 5242880 // 5MB
        }, 'local');

        expect(store.getState()?.cacheCount).toBe(15);

        // 2. Trigger wipe (Stage: GREEN)
        store.resetCacheStats();
        expect(store.getState()?.cacheCount).toBe(0);
        expect(store.getState()?.cacheSizeBytes).toBe(0);
    });

    it('SHOULD trigger wipe when extension sends CLEAR_CACHE_WIPE command', async () => {
        const wipeSpy = vi.spyOn(engine, 'wipeCache');
        const resetSpy = vi.spyOn(store, 'resetCacheStats');
        const dispatcher = CommandDispatcher.getInstance();

        // Simulate incoming message from extension
        await dispatcher.dispatch(IncomingCommand.CLEAR_CACHE_WIPE, {});

        expect(wipeSpy).toHaveBeenCalled();
        expect(resetSpy).toHaveBeenCalled();
    });
});
