/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebviewStore } from '../../src/webview/core/WebviewStore';
import { MessageClient } from '../../src/webview/core/MessageClient';

describe('NeuralCache TDD: Storage Optimization & Clearing', () => {
    beforeEach(() => {
        WebviewStore.resetInstance();
        MessageClient.resetInstance();
        (WebviewStore.getInstance() as any)._isHydrated = true;
    });

    it('should handle NEURAL_CACHE_PUSH by saving to local store', async () => {
        const store = WebviewStore.getInstance();
        // @ts-ignore - testing private method for TDD verification
        const saveSpy = vi.spyOn(store, 'saveNeuralCache').mockResolvedValue(undefined as any);

        // Simulate message from extension (native VS Code message event)
        window.postMessage({
            command: 'DATA_PUSH',
            cacheKey: 'c1',
            data: 'audio-data'
        }, '*');

        // Give message some time to propagate through MessageClient
        await vi.waitFor(() => {
            expect(saveSpy).toHaveBeenCalledWith('c1', 'audio-data');
        }, { timeout: 1000 });
    });

    it('should handle CLEAR_CACHE_WIPE by clearing local store', async () => {
        const store = WebviewStore.getInstance();
        // @ts-ignore - testing private method
        const clearSpy = vi.spyOn(store, 'clearLocalCache').mockResolvedValue(undefined as any);

        window.postMessage({
            command: 'CLEAR_CACHE_WIPE'
        }, '*');

        await vi.waitFor(() => {
            expect(clearSpy).toHaveBeenCalled();
        }, { timeout: 1000 });
    });

    it('should update neuralBuffer stats in the store state', async () => {
        const store = WebviewStore.getInstance();
        
        window.postMessage({
            command: 'CACHE_STATS_UPDATE',
            count: 5,
            sizeBytes: 1024 * 1024 // 1MB
        }, '*');

        await vi.waitFor(() => {
            expect(store.getUIState().neuralBuffer).toEqual({
                count: 5,
                sizeMb: 1.0
            });
        }, { timeout: 1000 });

    });
});
