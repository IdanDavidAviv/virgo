import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as child_process from 'child_process';
import { PlaybackEngine, PlaybackOptions } from '../src/playbackEngine';
import { EventEmitter } from 'events';

// --- MODULE MOCKS ---
const { mockTtsInstance } = vi.hoisted(() => ({
    mockTtsInstance: {
        getVoices: vi.fn().mockResolvedValue([]),
        setMetadata: vi.fn().mockResolvedValue(undefined),
        toStream: vi.fn()
    }
}));

vi.mock('msedge-tts', () => {
    class MockMsEdgeTTS {
        constructor() { return mockTtsInstance; }
        getVoices() { return mockTtsInstance.getVoices(); }
        setMetadata(m: any) { return mockTtsInstance.setMetadata(m); }
        toStream(t: string, f: string) { return mockTtsInstance.toStream(t, f); }
    }
    return {
        MsEdgeTTS: MockMsEdgeTTS,
        OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'mp3-format' }
    };
});

vi.mock('child_process', () => ({
    exec: vi.fn().mockImplementation((_cmd: string, cb: any) => { if (cb) {cb(null, '', '');} }),
    execSync: vi.fn().mockImplementation(() => ''),
    spawn: vi.fn().mockImplementation(() => {
        const emitter = new EventEmitter();
        (emitter as any).pid = 999;
        (emitter as any).stdin = { write: vi.fn(), end: vi.fn() };
        return emitter;
    })
}));

describe('PlaybackEngine', () => {
    let engine: PlaybackEngine;
    const logger = vi.fn();
    const defaultOptions: PlaybackOptions = { voice: 'V', rate: 0, volume: 50, mode: 'neural' };

    beforeEach(() => {
        vi.useFakeTimers();
        engine = new PlaybackEngine(logger);
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('Cache Management', () => {
        it('should correctly calculate cache stats', () => {
            const data = 'A'.repeat(100);
            engine['_addToCache']('key1', data);

            const stats = engine.getCacheStats();
            expect(stats.count).toBe(1);
            expect(stats.sizeBytes).toBe(75);
            expect(logger).toHaveBeenCalledWith(expect.stringContaining('[CACHE] count:1'));
        });

        it('should evict oldest items when cache limit is reached', () => {
            const twentyMBInBase64 = 'A'.repeat(Math.ceil(20 * 1024 * 1024 / 0.75));
            engine['_addToCache']('l1', twentyMBInBase64); // 20
            engine['_addToCache']('l2', twentyMBInBase64); // 40
            engine['_addToCache']('l3', twentyMBInBase64); // 60 -> evicts l1

            const stats = engine.getCacheStats();
            expect(stats.count).toBe(2);
            expect(engine['_audioCache'].has('l1')).toBe(false);
            expect(engine['_audioCache'].has('l2')).toBe(true);
        });

        it('should clear all cache', () => {
            engine['_addToCache']('key1', 'data');
            engine.clearCache();
            expect(engine.getCacheStats().count).toBe(0);
        });
    });

    describe('Neural Synthesis', () => {
        it('should synthesize and cache the result', async () => {
            const stream = new EventEmitter() as any;
            stream.destroy = vi.fn();
            mockTtsInstance.toStream.mockReturnValue({ audioStream: stream });

            const speakPromise = engine.speakNeural('Hi', 'c1', defaultOptions);

            for (let i = 0; i < 10; i++) { await Promise.resolve(); }

            stream.emit('data', Buffer.from('chunk'));
            stream.emit('end');

            const result = await speakPromise;
            expect(result).toBe(Buffer.from('chunk').toString('base64'));
            expect(logger).toHaveBeenCalledWith(expect.stringContaining('[NEURAL] success: c1'));
        });

        it('should reuse pending tasks', async () => {
            const stream = new EventEmitter() as any;
            stream.destroy = vi.fn();
            mockTtsInstance.toStream.mockReturnValue({ audioStream: stream });

            // Call speakNeural once
            const p1 = engine.speakNeural('Same', 'k1', defaultOptions);
            
            // Call it again with same key - should return the cached promise
            const p2 = engine.speakNeural('Same', 'k1', defaultOptions);

            // We need to advance timers or wait for microtasks
            for (let i = 0; i < 10; i++) { await Promise.resolve(); }
            
            expect(mockTtsInstance.toStream).toHaveBeenCalledTimes(1);
            
            stream.emit('data', Buffer.from('abc'));
            stream.emit('end');
            
            const r1 = await p1;
            const r2 = await p2;
            expect(r1).toBe(r2);
            expect(r1).toBe(Buffer.from('abc').toString('base64'));
        });

        it('should abort when engine is stopped', async () => {
            const stream = new EventEmitter() as any;
            stream.destroy = vi.fn();
            mockTtsInstance.toStream.mockReturnValue({ audioStream: stream });

            const p = engine.speakNeural('Wait', 'abort1', defaultOptions);
            await vi.advanceTimersByTimeAsync(100);

            engine.stop();
            const result = await p;
            expect(result).toBe(null);
        });

        it('should trigger circuit breaker on 429', async () => {
            const stream = new EventEmitter() as any;
            stream.destroy = vi.fn();
            mockTtsInstance.toStream.mockReturnValue({ audioStream: stream });

            // Mock first call to fail with 429
            const err429 = new Error('429');
            mockTtsInstance.setMetadata.mockRejectedValueOnce(err429);

            const p = engine.speakNeural('Too Fast', 'c429', { ...defaultOptions, retryCount: 0 });
            
            await expect(p).rejects.toThrow('429');
            expect(engine['_isRateLimited']).toBe(true);
            
            vi.advanceTimersByTime(61000);
            expect(engine['_isRateLimited']).toBe(false);
        });
    });

    describe('Voice Discovery', () => {
        it('should aggregate voices', async () => {
            const originalPlatform = process.platform;
            Object.defineProperty(process, 'platform', { value: 'win32' });

            (child_process.exec as any).mockImplementation((cmd: string, cb: any) => {
                cb(null, 'Hazel\r\nDavid\r\n');
            });
            mockTtsInstance.getVoices.mockResolvedValue([{ FriendlyName: 'Neural', ShortName: 'N', Locale: 'en', Gender: 'F' }]);

            const voices = await engine.getVoices();
            expect(voices.local).toContain('Hazel');
            expect(voices.neural[0].id).toBe('N');

            Object.defineProperty(process, 'platform', { value: originalPlatform });
        });
    });

    describe('Watchdog', () => {
        it('should recycle on hang', async () => {
            const stream = new EventEmitter() as any;
            stream.destroy = vi.fn();
            mockTtsInstance.toStream.mockReturnValue({ audioStream: stream });

            const p = engine.speakNeural('Hang', 'h1', defaultOptions);
            await vi.advanceTimersByTimeAsync(5100);

            expect(logger).toHaveBeenCalledWith(expect.stringContaining('[TTS HANG]'));
            expect(await p).toBe(null);
        });
    });

    describe('Local Synthesis', () => {
        it('should generate sanitized command on Windows', () => {
            const originalPlatform = process.platform;
            Object.defineProperty(process, 'platform', { value: 'win32' });

            const mockProc = new EventEmitter() as any;
            mockProc.pid = 123;
            mockProc.stdin = { write: vi.fn(), end: vi.fn() };
            (child_process.spawn as any).mockReturnValue(mockProc);

            // '/' and '&' are stripped as they are not in the whitelist
            engine.speakLocal('Hello & rm -rf /', { ...defaultOptions, mode: 'local' }, vi.fn());

            const spawnCall = (child_process.spawn as any).mock.calls[0];
            const psScript = spawnCall[1][1];
            expect(psScript).not.toContain('&');
            expect(psScript).not.toContain('/');
            expect(psScript).toContain('Hello   rm -rf  ');

            Object.defineProperty(process, 'platform', { value: originalPlatform });
        });
    });
});