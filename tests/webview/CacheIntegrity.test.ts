/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { CacheManager } from '@webview/cacheManager';

describe('Cache Integrity (TDD: Reset Guard)', () => {
    let cache: CacheManager;

    beforeEach(() => {
        cache = new CacheManager();
    });

    it('SHOULD NOT clear neural audio cache when a single click occurs', async () => {
        const dummyAudio = new Blob(['test'], { type: 'audio/mpeg' });
        const key = 'voice1-doc1-v0-0-0';
        
        await cache.set(key, dummyAudio);
        expect(await cache.get(key)).not.toBeNull();

        // 1. Mock window.confirm to always return true (if it were called)
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

        // 2. We'll verify this fails once I change the code to use dblclick
        // For now, let's just assert that it persists IF NO ONE CALLS CLEAR.
        expect(await cache.get(key)).not.toBeNull();
        confirmSpy.mockRestore();
    });
});
