import { PlaybackEngine } from '../../src/extension/core/playbackEngine';
import { describe, it, expect, vi } from 'vitest';

/**
 * 🛡️ Playback Integrity Verification Suite
 * Verifies that the hardening measures against race conditions and NaN leakage are effective.
 */
describe('Playback Integrity (Extension Side)', () => {
    
    it('Cache Leakage & Arithmetic Hardening: SHOULD catch and reset NaN cache size', () => {
        // We need to provide a logger to the constructor.
        const engine = new PlaybackEngine((msg) => console.log(`[PlaybackEngine Mock] ${msg}`));

        // 1. Manually trigger pruning with garbage data (inducing NaN)
        (engine as any)._cacheSizeBytes = NaN;
        
        // 2. Prune should detect NaN and reset to 0
        (engine as any)._pruneCache('garbage_key', undefined as any);
        
        const stats = engine.getCacheStats();
        expect(isNaN(stats.sizeBytes)).toBe(false);
        expect(stats.sizeBytes).toBe(0);
    });

    it('Sovereign Intent Guards: SHOULD reject stale Intent IDs in _addToCache', () => {
        const engine = new PlaybackEngine((msg) => {});
        const initialIntent = (engine as any)._playbackIntentId;

        // 1. Testing _addToCache with stale Intent ID
        const staleIntentId = initialIntent - 1;
        const testKey = 'stale_segment';
        const testData = new Uint8Array([1, 2, 3]);

        (engine as any)._addToCache(testKey, testData, staleIntentId);
        
        // Check if it was added (it shouldn't be)
        const cache = (engine as any)._audioCache;
        expect(cache.has(testKey)).toBe(false);

        // 2. Testing _addToCache with current Intent ID
        (engine as any)._addToCache('valid_segment', testData, initialIntent);
        expect(cache.has('valid_segment')).toBe(true);
    });
});
