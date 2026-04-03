/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebviewStore } from '../../src/webview/core/WebviewStore';
import { IncomingCommand } from '../../src/common/types';

describe('WebviewStore Payload Gating (TDD: Voice Stall Fix)', () => {
    beforeEach(() => {
        // @ts-ignore
        WebviewStore.instance = undefined;
    });

    it('SHOULD NOT notify subscribers if the voice list is identical to the previous sync (Content Change Test)', () => {
        const store = WebviewStore.getInstance();
        const listener = vi.fn();
        
        store.subscribe((state) => state.availableVoices, listener);

        const voices1 = {
            neural: [{ id: 'v1', name: 'Voice 1' }],
            local: []
        };

        const voices2 = {
            neural: [{ id: 'v1', name: 'Voice 1 (Changed!)' }], // Content changed!
            local: []
        };

        // 1. Initial Sync
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                availableVoices: voices1,
                isPlaying: false,
                rate: 1.0,
                volume: 50,
                state: { currentSentenceIndex: 0 }
            }
        }));

        expect(listener).toHaveBeenCalledTimes(1);
        vi.clearAllMocks();

        // 2. SECOND SYNC: Same length, DIFFERENT content
        // Current 'length-only' hash will incorrectly flag this as identical and skip update!
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                availableVoices: voices2,
                isPlaying: false,
                rate: 1.0,
                volume: 50,
                state: { currentSentenceIndex: 0 }
            }
        }));

        // 3. ASSERT: Store MUST notify if content changed.
        // BUG: Current code only checks .length, so it will miss this update.
        // We expect it to be called.
        expect(listener).toHaveBeenCalled();
        
        // 4. THIRD SYNC: Exactly the same content as voices2
        vi.clearAllMocks();
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                availableVoices: JSON.parse(JSON.stringify(voices2)), // New ref, same content
                isPlaying: false,
                rate: 1.0,
                volume: 50,
                state: { currentSentenceIndex: 0 }
            }
        }));
        
        // ASSERT: Store MUST NOT notify if content is identical.
        expect(listener).not.toHaveBeenCalled();
    });
});
