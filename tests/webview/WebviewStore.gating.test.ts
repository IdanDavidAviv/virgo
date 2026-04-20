/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebviewStore } from '@webview/core/WebviewStore';
import { CommandDispatcher } from '@webview/core/CommandDispatcher';
import { IncomingCommand } from '@common/types';
import { resetAllSingletons, wireDispatcher } from './testUtils';

describe('WebviewStore: Delta Sync Integrity', () => {
    beforeEach(() => {
        resetAllSingletons();
        wireDispatcher();
    });

    it('SHOULD preserve existing voice list when availableVoices is OMITTED from UI_SYNC', async () => {
        const store = WebviewStore.getInstance();
        const initialVoices = {
            neural: [{ id: 'v1', name: 'Voice 1' }],
            local: []
        };

        // 1. Initial Handshake Sync (Voices included)
        await CommandDispatcher.getInstance().dispatch(IncomingCommand.UI_SYNC, {
            availableVoices: initialVoices,
            currentSentenceIndex: 0
        });

        expect(store.getState()!.availableVoices).toEqual(initialVoices);

        // 2. Subsequent Update Sync (Voices OMITTED - Delta Sync)
        await CommandDispatcher.getInstance().dispatch(IncomingCommand.UI_SYNC, {
            currentSentenceIndex: 1
        });

        // 3. ASSERT: Voices are PRESERVED
        expect(store.getState()!.availableVoices).toEqual(initialVoices);
        expect(store.getState()!.currentSentenceIndex).toBe(1);
    });

    it('SHOULD update voice list when explicitly provided (Handshake/Engine Change)', async () => {
        const store = WebviewStore.getInstance();
        const initialVoices = { neural: [{ id: 'v1', name: 'V1' }], local: [] };
        const updatedVoices = { neural: [{ id: 'v2', name: 'V2' }], local: [] };

        // 1. Initial Sync
        await CommandDispatcher.getInstance().dispatch(IncomingCommand.UI_SYNC, {
            availableVoices: initialVoices,
            currentSentenceIndex: 0
        });

        // 2. Explicit Update (e.g. Engine changed)
        await CommandDispatcher.getInstance().dispatch(IncomingCommand.UI_SYNC, {
            availableVoices: updatedVoices,
            currentSentenceIndex: 0
        });

        // 3. ASSERT: Update happened
        expect(store.getState()!.availableVoices).toEqual(updatedVoices);
    });
});
