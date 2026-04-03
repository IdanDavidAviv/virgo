/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebviewStore } from '../../src/webview/core/WebviewStore';

describe('WebviewStore Debug', () => {
    beforeEach(() => {
        WebviewStore.resetInstance();
    });

    it('should hydrate with updateState', () => {
        const store = WebviewStore.getInstance();
        expect(store.getState()).toBeNull();

        store.updateState({ 
            state: { currentSentenceIndex: 10 } 
        } as any);

        expect(store.getState()).not.toBeNull();
        expect(store.getState()?.state.currentSentenceIndex).toBe(10);
    });
});
