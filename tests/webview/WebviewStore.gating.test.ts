/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebviewStore } from '../../src/webview/core/WebviewStore';
import { IncomingCommand } from '../../src/common/types';

describe('WebviewStore: Delta Sync Integrity', () => {
    beforeEach(() => {
        // @ts-ignore
        WebviewStore.instance = undefined;
    });

    it('SHOULD preserve existing voice list when availableVoices is OMITTED from UI_SYNC', () => {
        const store = WebviewStore.getInstance();
        const initialVoices = {
            neural: [{ id: 'v1', name: 'Voice 1' }],
            local: []
        };

        // 1. Initial Handshake Sync (Voices included)
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                availableVoices: initialVoices,
                state: { currentSentenceIndex: 0 }
            }
        }));

        expect(store.getState()!.availableVoices).toEqual(initialVoices);

        // 2. Subsequent Update Sync (Voices OMITTED - Delta Sync)
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                // availableVoices missing!
                state: { currentSentenceIndex: 1 }
            }
        }));

        // 3. ASSERT: Voices are PRESERVED
        expect(store.getState()!.availableVoices).toEqual(initialVoices);
        expect(store.getState()!.state.currentSentenceIndex).toBe(1);
    });

    it('SHOULD update voice list when explicitly provided (Handshake/Engine Change)', () => {
        const store = WebviewStore.getInstance();
        const initialVoices = { neural: [{ id: 'v1', name: 'V1' }], local: [] };
        const updatedVoices = { neural: [{ id: 'v2', name: 'V2' }], local: [] };

        // 1. Initial Sync
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                availableVoices: initialVoices,
                state: { currentSentenceIndex: 0 }
            }
        }));

        // 2. Explicit Update (e.g. Engine changed)
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                availableVoices: updatedVoices,
                state: { currentSentenceIndex: 0 }
            }
        }));

        // 3. ASSERT: Update happened
        expect(store.getState()!.availableVoices).toEqual(updatedVoices);
    });
});
