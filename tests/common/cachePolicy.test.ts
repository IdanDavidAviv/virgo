import { describe, it, expect } from 'vitest';
import { generateCacheKey } from '../../src/common/cachePolicy';

describe('CachePolicy (generateCacheKey)', () => {
    it('should generate deterministic keys for the same content', () => {
        const key1 = generateCacheKey('Hello world', 'en-US-Neural', 1.0, 'doc1');
        const key2 = generateCacheKey('Hello world', 'en-US-Neural', 1.0, 'doc1');
        expect(key1).toBe(key2);
    });

    it('should generate different keys for different text', () => {
        const key1 = generateCacheKey('Hello world', 'en-US-Neural', 1.0, 'doc1');
        const key2 = generateCacheKey('Hello world!', 'en-US-Neural', 1.0, 'doc1');
        expect(key1).not.toBe(key2);
    });

    it('should generate different keys for different voices', () => {
        const key1 = generateCacheKey('Hello', 'voice-A', 1.0, 'doc1');
        const key2 = generateCacheKey('Hello', 'voice-B', 1.0, 'doc1');
        expect(key1).not.toBe(key2);
    });

    it('should generate different keys for different rates', () => {
        const key1 = generateCacheKey('Hello', 'voice-A', 1.0, 'doc1');
        const key2 = generateCacheKey('Hello', 'voice-A', 1.2, 'doc1');
        expect(key1).not.toBe(key2);
    });

    it('should generate different keys for different documents', () => {
        const key1 = generateCacheKey('Hello', 'voice-A', 1.0, 'doc1');
        const key2 = generateCacheKey('Hello', 'voice-A', 1.0, 'doc2');
        expect(key1).not.toBe(key2);
    });

    it('should handle optional docUri gracefully', () => {
        const key1 = generateCacheKey('Hello', 'voice-A', 1.0);
        const key2 = generateCacheKey('Hello', 'voice-A', 1.0, undefined);
        expect(key1).toBe(key2);
        expect(typeof key1).toBe('string');
        expect(key1.length).toBeGreaterThan(0);
    });
});
