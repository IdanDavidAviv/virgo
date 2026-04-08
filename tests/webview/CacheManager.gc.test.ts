/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { CacheManager } from '../../src/webview/cacheManager';

// Mock MessageClient to avoid outbound IPC during tests
vi.mock('../../src/webview/core/MessageClient', () => ({
    MessageClient: {
        getInstance: () => ({
            postAction: vi.fn()
        })
    }
}));

describe('CacheManager GC (Lifecycle Management)', () => {
    let cache: CacheManager;

    beforeEach(async () => {
        // 1. Tear down previous instance
        if (cache) {
            await cache.close();
        }
        
        // 2. Clear previous state
        const dbName = 'ReadAloudAudioCache';
        await new Promise((resolve) => {
            const req = indexedDB.deleteDatabase(dbName);
            req.onsuccess = resolve;
            req.onerror = resolve;
        });

        CacheManager.resetInstance();
        cache = CacheManager.getInstance();
        
        // 3. Wait for full readiness (v3 bootstrap)
        await cache.ready();
    });

    afterEach(async () => {
        if (cache) {
            await cache.close();
        }
        vi.restoreAllMocks();
    });

    it('should prune entries older than 7 days (TTL)', async () => {
        const now = 1712570000000;
        const oldKey = 'item-old';
        const newKey = 'item-new';
        const blob = new Blob(['test'], { type: 'audio/mpeg' });

        const dateSpy = vi.spyOn(Date, 'now');
        
        // 1. Add "old" item
        dateSpy.mockReturnValue(now - (8 * 24 * 60 * 60 * 1000));
        await cache.set(oldKey, blob);
        
        // 2. Add "new" item
        dateSpy.mockReturnValue(now);
        await cache.set(newKey, blob);

        // Verification: Both should exist before GC
        expect(await cache.get(oldKey), 'oldKey should exist before GC').not.toBeNull();
        expect(await cache.get(newKey), 'newKey should exist before GC').not.toBeNull();

        // 3. Run GC
        await (cache as any)._runGC();

        expect(await cache.get(oldKey), 'oldKey should be pruned').toBeNull();
        expect(await cache.get(newKey), 'newKey should be preserved').not.toBeNull();
    });

    it('should prune oldest entries when exceeding 100MB (Size Cap)', async () => {
        const largeData = new Uint8Array(40 * 1024 * 1024);
        const largeBlob = new Blob([largeData], { type: 'audio/mpeg' });
        const now = 1712570000000;
        const dateSpy = vi.spyOn(Date, 'now');

        // Add 3 items (Time-spaced)
        dateSpy.mockReturnValue(now + 1000);
        await cache.set('item-1', largeBlob);
        
        dateSpy.mockReturnValue(now + 2000);
        await cache.set('item-2', largeBlob);
        
        dateSpy.mockReturnValue(now + 3000);
        await cache.set('item-3', largeBlob);

        // Verify initial state
        expect(await cache.get('item-1')).not.toBeNull();
        expect(await cache.get('item-2')).not.toBeNull();
        expect(await cache.get('item-3')).not.toBeNull();

        // Trigger GC
        await (cache as any)._runGC();

        // Pruned to 80MB (Item-1 is oldest)
        expect(await cache.get('item-1'), 'item-1 (oldest) should be pruned').toBeNull();
        expect(await cache.get('item-2'), 'item-2 should stay').not.toBeNull();
        expect(await cache.get('item-3'), 'item-3 should stay').not.toBeNull();
    });

    it('should synchronize Tier-1 (Memory) with GC deletions', async () => {
        const largeData = new Uint8Array(60 * 1024 * 1024); // 60MB
        const largeBlob = new Blob([largeData], { type: 'audio/mpeg' });
        
        // 1. Add two large items (120MB total > 100MB cap)
        await cache.set('mem-1', largeBlob);
        await cache.set('mem-2', largeBlob);

        // 2. Verify both are in memory (they were just added)
        // Accessing the private _memoryCache via casting for inspection
        const memCache = (cache as any)._memoryCache;
        expect(memCache.has('mem-1')).toBe(true);
        expect(memCache.has('mem-2')).toBe(true);

        // 3. Trigger GC
        await (cache as any)._runGC();

        // 4. Verify mem-1 (oldest) is gone from BOTH tiers
        expect(await cache.get('mem-1')).toBeNull();
        expect(memCache.has('mem-1')).toBe(false);
        
        // mem-2 should still be there
        expect(await cache.get('mem-2')).not.toBeNull();
        expect(memCache.has('mem-2')).toBe(true);
    });
});
