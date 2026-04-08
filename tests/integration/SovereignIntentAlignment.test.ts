import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
        engine = new PlaybackEngine(logger);
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('should reject Intent 0 if a high-intent session is already established', () => {
        // 1. Establish a high intent (e.g. timestamp) representing a running session
        const highIntent = Date.now() + 1000;
        engine.adoptIntent(highIntent);
        expect((engine as any)._playbackIntentId).toBe(highIntent);

        // 2. Simulate a stale handshake (Intent 0) from a newly created webview
        engine.adoptIntent(0);

        // 3. Verification: Intent should remain at high value
        expect((engine as any)._playbackIntentId).toBe(highIntent);
        expect(logger).toHaveBeenCalledWith(expect.stringContaining('Ignored Intent 0'));
    });

    it('should accept higher intent IDs normally', () => {
        const intent1 = Date.now() + 1000;
        const intent2 = Date.now() + 2000;
        engine.adoptIntent(intent1);
        engine.adoptIntent(intent2);
        expect((engine as any)._playbackIntentId).toBe(intent2);
    });

    it('should correctly Adopt Intent when the engine is fresh (Initial -> New)', () => {
        // Initial state _playbackIntentId is Date.now() (system time)
        const newIntent = Date.now() + 5000;
        engine.adoptIntent(newIntent); 
        expect((engine as any)._playbackIntentId).toBe(newIntent);
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
        await vi.advanceTimersByTimeAsync(50);
        expect(lock2Acquired).toBe(false);

        // Release 1 should unblock Lock 2
        release1();
        await lock2Promise;
        expect(lock2Acquired).toBe(true);
    });
});
