/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebviewStore } from '../../src/webview/core/WebviewStore';

describe('WebviewStore Debug', () => {
    beforeEach(() => {
        WebviewStore.resetInstance();
    });

    it('should track hydration via updateState', () => {
        const store = WebviewStore.getInstance();
        expect(store.isHydrated()).toBe(false);

        store.updateState({ 
            currentSentenceIndex: 10,
            isHydrated: true
        } as any);

        expect(store.isHydrated()).toBe(true);
        expect(store.getState()?.currentSentenceIndex).toBe(10);
    });
});
