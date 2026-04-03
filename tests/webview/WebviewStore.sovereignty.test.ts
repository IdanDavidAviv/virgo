/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebviewStore } from '../../src/webview/core/WebviewStore';
import { IncomingCommand } from '../../src/common/types';

describe('WebviewStore Sovereignty (TDD: Stale Sync Guard)', () => {
    beforeEach(() => {
        // @ts-ignore
        WebviewStore.instance = undefined;
        vi.useFakeTimers();
    });

    it('SHOULD ignore stale UI_SYNC playback states if a recent user intent exists', () => {
        const store = WebviewStore.getInstance();
        
        // 1. Initial State: Hydrate via first sync
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                isPlaying: false,
                isPaused: false,
                state: { currentSentenceIndex: 0 },
                volume: 50,
                rate: 1.0,
                availableVoices: []
            }
        }));
        
        expect(store.getState()?.isPlaying).toBe(false);

        // 2. USER ACTION: Play (Optimistic Patch)
        store.optimisticPatch({ isPlaying: true, isPaused: false });
        expect(store.getState()?.isPlaying).toBe(true);

        // 3. STALE SYNC: Host sends a packet saying it is STOPPED
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                isPlaying: false, // STALE!
                isPaused: false,
                state: { currentSentenceIndex: 0 },
                volume: 50,
                rate: 1.0,
                availableVoices: []
            }
        }));

        // 4. ASSERT: Store MUST ignore the stale playback state
        // BUG: In the current code, this will fail and return 'false'.
        expect(store.getState()?.isPlaying).toBe(true);
    });
});
