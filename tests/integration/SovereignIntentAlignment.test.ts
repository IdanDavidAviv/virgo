import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlaybackEngine } from '../../src/extension/core/playbackEngine';

/**
 * Sovereign Intent Alignment Test
 * Verifies that the Extension-side PlaybackEngine correctly identifies and drops
 * stale intent noise (specifically Intent 0) produced during Webview reloads or race conditions.
 */
describe('Sovereign Intent Alignment (Extension Side)', () => {
    let engine: PlaybackEngine;
    const logger = vi.fn();

    beforeEach(() => {
        engine = new PlaybackEngine(logger);
        vi.clearAllMocks();
    });

    it('should reject Intent 0 if a high-intent session is already established', () => {
        // 1. Establish a high intent (e.g. 5) representing a running session
        engine.adoptIntent(5);
        expect((engine as any)._playbackIntentId).toBe(5);

        // 2. Simulate a stale handshake (Intent 0) from a newly created webview
        // This simulates the "Bridge Storm" where a reloaded webview defaults to 0
        // and tries to sync its state back to the extension.
        engine.adoptIntent(0);

        // 3. Verification: Intent should remain at 5, and rejection should be logged
        expect((engine as any)._playbackIntentId).toBe(5);
        expect(logger).toHaveBeenCalledWith(expect.stringContaining('Ignored Intent 0'));
    });

    it('should accept higher intent IDs normally', () => {
        engine.adoptIntent(5);
        engine.adoptIntent(6);
        expect((engine as any)._playbackIntentId).toBe(6);
    });

    it('should correctly Adopt Intent when the engine is fresh (0 -> 1)', () => {
        // Initial state _playbackIntentId is 0
        engine.adoptIntent(1); 
        expect((engine as any)._playbackIntentId).toBe(1);
    });

    it('should serialize synthesis requests using the lock (Mutex Logic)', async () => {
        // This is harder to test directly without mocking the internal _acquireLock,
        // but we can verify that multiple calls to _getNeuralAudio behave correctly.
        // For now, we'll verify the helper exists and behaves as a semaphore.
        const release1 = await (engine as any)._acquireLock();
        
        let lock2Acquired = false;
        const lock2Promise = (engine as any)._acquireLock().then((release: any) => {
            lock2Acquired = true;
            release();
        });

        // Lock 2 should be stuck waiting for Release 1
        await new Promise(res => setTimeout(res, 50));
        expect(lock2Acquired).toBe(false);

        // Release 1 should unblock Lock 2
        release1();
        await lock2Promise;
        expect(lock2Acquired).toBe(true);
    });
});
