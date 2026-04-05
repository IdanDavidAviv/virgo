import { PlaybackEngine } from '../../src/extension/core/playbackEngine';
import * as assert from 'assert';

/**
 * 🛡️ Playback Integrity Verification Suite
 * Verifies that the hardening measures against race conditions and NaN leakage are effective.
 */

async function testCacheHardening() {
    console.log('\n--- [TEST] Cache Leakage & Arithmetic Hardening ---');
    
    // We need to provide a logger to the constructor.
    const engine = new PlaybackEngine((msg) => console.log(`[PlaybackEngine Mock] ${msg}`));

    console.log('1. Testing _pruneCache with NaN-inducing input...');
    try {
        // Manually trigger pruning with garbage data
        (engine as any)._cacheSizeBytes = NaN;
        (engine as any)._pruneCache('garbage_key', undefined as any);
        
        const stats = engine.getCacheStats();
        assert.ok(!isNaN(stats.sizeBytes), 'Cache size should not be NaN after pruning');
        assert.strictEqual(stats.sizeBytes, 0, 'Should have reset to 0');
        console.log('✅ Passed: NaN cache size caught and reset.');
    } catch (e) {
        console.error('❌ Failed: Cache pruning induction failed', e);
        throw e;
    }
}

async function testIntentIdGuards() {
    console.log('\n--- [TEST] Sovereign Intent Guards (Extension Side) ---');
    const engine = new PlaybackEngine((msg) => {});
    
    const initialIntent = (engine as any)._playbackIntentId;
    console.log(`Current Intent ID: ${initialIntent}`);

    console.log('1. Testing _addToCache with stale Intent ID...');
    const staleIntentId = initialIntent - 1;
    const testKey = 'stale_segment';
    const testData = new Uint8Array([1, 2, 3]);

    (engine as any)._addToCache(testKey, testData, staleIntentId);
    
    // Check if it was added (it shouldn't be)
    const cache = (engine as any)._audioCache;
    assert.ok(!cache.has(testKey), 'Stale segment should NOT have been added to cache');
    console.log('✅ Passed: Stale Intent ID rejected.');

    console.log('2. Testing _addToCache with current Intent ID...');
    (engine as any)._addToCache('valid_segment', testData, initialIntent);
    assert.ok(cache.has('valid_segment'), 'Valid segment should be added to cache');
    console.log('✅ Passed: Current Intent ID accepted.');
}

async function runIntegrityTests() {
    try {
        await testCacheHardening();
        await testIntentIdGuards();
        console.log('\n✨ ALL PLAYBACK INTEGRITY LOGIC VERIFIED');
    } catch (e) {
        console.error('\n❌ INTEGRITY VERIFICATION FAILED:', e);
        process.exit(1);
    }
}

runIntegrityTests();
