import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlaybackEngine } from '@core/playbackEngine';
import { StateStore } from '@core/stateStore';
import { EventEmitter } from 'events';

const { mockTtsInstance } = vi.hoisted(() => ({
    mockTtsInstance: {
        getVoices: vi.fn().mockResolvedValue([]),
        setMetadata: vi.fn().mockResolvedValue(undefined),
        toStream: vi.fn()
    }
}));

vi.mock('msedge-tts', () => {
    return {
        MsEdgeTTS: class {
            constructor() { return mockTtsInstance; }
            getVoices() { return mockTtsInstance.getVoices(); }
            setMetadata(m: any) { return mockTtsInstance.setMetadata(m); }
            toStream(t: string) { return mockTtsInstance.toStream(t); }
        },
        OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'mp3' }
    };
});

describe('PlaybackEngine Stall Detection & Recovery', () => {
    let engine: PlaybackEngine;
    const logger = vi.fn();

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        const stateStore = new StateStore(logger);
        engine = new PlaybackEngine(stateStore, logger);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('should initialize with isStalled as false', () => {
        expect(engine.isStalled).toBe(false);
        expect(engine.neuralHealth).toBe('HEALTHY');
    });

    it('should transition to DEGRADED on first failure and STALLED after 3 consecutive failures', async () => {
        mockTtsInstance.toStream.mockImplementation(() => {
            const stream = new EventEmitter() as any;
            stream.destroy = vi.fn();
            process.nextTick(() => {
                stream.emit('error', new Error('Network Error'));
            });
            return { audioStream: stream };
        });

        // 1st failure
        const p1 = engine.speakNeural('test 1', 'k1', { mode: 'neural', voice: 'v', rate: 0, volume: 50, retryCount: 0 }, true);
        p1.catch(() => {});
        await vi.advanceTimersByTimeAsync(10);
        expect(engine.neuralHealth).toBe('DEGRADED');

        // 2nd failure
        const p2 = engine.speakNeural('test 2', 'k2', { mode: 'neural', voice: 'v', rate: 0, volume: 50, retryCount: 0 }, true);
        p2.catch(() => {});
        await vi.advanceTimersByTimeAsync(10);
        expect(engine.neuralHealth).toBe('DEGRADED');

        // 3rd failure
        const p3 = engine.speakNeural('test 3', 'k3', { mode: 'neural', voice: 'v', rate: 0, volume: 50, retryCount: 0 }, true);
        p3.catch(() => {});
        await vi.advanceTimersByTimeAsync(10);
        expect(engine.neuralHealth).toBe('STALLED');
    });

    it('should immediately transition to STALLED on fast-gate offline error', async () => {
        mockTtsInstance.toStream.mockImplementation(() => {
            const stream = new EventEmitter() as any;
            stream.destroy = vi.fn();
            process.nextTick(() => {
                stream.emit('error', new Error('ENOTFOUND'));
            });
            return { audioStream: stream };
        });

        const p = engine.speakNeural('test 1', 'k1', { mode: 'neural', voice: 'v', rate: 0, volume: 50, retryCount: 0 }, true);
        p.catch(() => {});
        await vi.advanceTimersByTimeAsync(10);
        expect(engine.neuralHealth).toBe('STALLED');
    });

    it('should not schedule probe timer if player is paused or stopped', async () => {
        mockTtsInstance.toStream.mockImplementation(() => {
            const stream = new EventEmitter() as any;
            stream.destroy = vi.fn();
            process.nextTick(() => {
                stream.emit('error', new Error('ENOTFOUND'));
            });
            return { audioStream: stream };
        });

        const p = engine.speakNeural('test 1', 'k1', { mode: 'neural', voice: 'v', rate: 0, volume: 50, retryCount: 0 }, true);
        p.catch(() => {});
        await vi.advanceTimersByTimeAsync(10);
        expect(engine.neuralHealth).toBe('STALLED');

        // Stop the engine
        engine.stop();

        // Verify no probe timer runs because isPlaying is false
        expect(engine.isPlaying).toBe(false);
        expect((engine as any)._probeTimer).toBeNull();
    });

    it('should run probe timer when stalled and playing, recovering health on success', async () => {
        // Fast-stall
        mockTtsInstance.toStream.mockImplementation(() => {
            const stream = new EventEmitter() as any;
            stream.destroy = vi.fn();
            process.nextTick(() => {
                stream.emit('error', new Error('ENOTFOUND'));
            });
            return { audioStream: stream };
        });

        const p = engine.speakNeural('test 1', 'k1', { mode: 'neural', voice: 'v', rate: 0, volume: 50, retryCount: 0 }, true);
        p.catch(() => {});
        await vi.advanceTimersByTimeAsync(10);
        expect(engine.neuralHealth).toBe('STALLED');

        // Set playing
        engine.setPlaying(true);

        // Mock a failure while playing to start the probe
        const pPlay = engine.speakNeural('test 2', 'k2', { mode: 'neural', voice: 'v', rate: 0, volume: 50, retryCount: 0 }, true);
        pPlay.catch(() => {});
        await vi.advanceTimersByTimeAsync(10);

        expect(engine.isPlaying).toBe(true);
        expect((engine as any)._probeTimer).not.toBeNull();

        // Now mock successful probe stream
        const stream = new EventEmitter() as any;
        stream.destroy = vi.fn();
        mockTtsInstance.toStream.mockReturnValue({ audioStream: stream });

        // Advance timer by 30 seconds to trigger probe
        vi.advanceTimersByTime(30000);
        
        // Let the probe complete successfully
        stream.emit('data', Buffer.from('data'));
        stream.emit('end');

        await vi.advanceTimersByTimeAsync(10);

        expect(engine.neuralHealth).toBe('HEALTHY');
        expect((engine as any)._probeTimer).toBeNull();
    });

    it('should throttle prefetch when sliding window request threshold is crossed', () => {
        // Mock 10 request timestamps in the last 5 seconds
        const now = Date.now();
        (engine as any)._requestTimestamps = Array(10).fill(now - 1000);

        expect((engine as any)._isPrefetchThrottled()).toBe(true);
        
        // Trigger prefetch should abort instantly
        const spy = vi.spyOn(engine, 'speakNeural');
        engine.triggerPrefetch('text', 'key', { mode: 'neural', voice: 'v', rate: 0, volume: 50 }, 1);
        expect(spy).not.toHaveBeenCalled();
    });
});
