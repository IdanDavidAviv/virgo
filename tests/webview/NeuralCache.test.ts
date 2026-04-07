/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebviewStore } from '@webview/core/WebviewStore';
import { WebviewAudioEngine } from '@webview/core/WebviewAudioEngine';
import { CommandDispatcher } from '@webview/core/CommandDispatcher';
import { IncomingCommand } from '@common/types';
import { resetAllSingletons, wireDispatcher } from './testUtils';

describe('NeuralCache TDD: Storage Optimization & Clearing', () => {
    beforeEach(() => {
        resetAllSingletons();
        wireDispatcher();
        (WebviewStore.getInstance() as any)._isHydrated = true;
    });

    it('should handle DATA_PUSH by ingesting into audio engine', async () => {
        const audioEngine = WebviewAudioEngine.getInstance();
        const ingestSpy = vi.spyOn(audioEngine, 'ingestData').mockResolvedValue(undefined as any);

        // Simulate message from extension
        await CommandDispatcher.getInstance().dispatch(IncomingCommand.DATA_PUSH, {
            cacheKey: 'c1',
            data: 'audio-data',
            intentId: 1
        });

        expect(ingestSpy).toHaveBeenCalledWith('c1', 'audio-data', 1);
    });

    it('should handle CLEAR_CACHE_WIPE by wiping audio engine cache', async () => {
        const audioEngine = WebviewAudioEngine.getInstance();
        const wipeSpy = vi.spyOn(audioEngine, 'wipeCache').mockResolvedValue(undefined as any);

        await CommandDispatcher.getInstance().dispatch(IncomingCommand.CLEAR_CACHE_WIPE, {});

        expect(wipeSpy).toHaveBeenCalled();
    });

    it('should update neuralBuffer stats in the store state', async () => {
        const store = WebviewStore.getInstance();
        
        // Use CommandDispatcher to simulate the incoming message correctly
        await CommandDispatcher.getInstance().dispatch(IncomingCommand.CACHE_STATS_UPDATE, {
            count: 10,
            sizeBytes: 2.5 * 1024 * 1024
        });

        expect(store.getUIState().neuralBuffer.count).toBe(10);
        expect(store.getUIState().neuralBuffer.sizeMb).toBe(2.5);
    });
});
