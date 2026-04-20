import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlaybackEngine, PlaybackOptions } from '@core/playbackEngine';
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
    exec: vi.fn(),
    execSync: vi.fn(),
    spawn: vi.fn()
}));

describe('PlaybackEngine TDD: Cache Optimization & Clearing', () => {
    let engine: PlaybackEngine;
    const logger = vi.fn();
    const defaultOptions: PlaybackOptions = { voice: 'V', rate: 0, volume: 50, mode: 'neural' };

    beforeEach(() => {
        engine = new PlaybackEngine(logger);
        vi.clearAllMocks();
    });

    it('should emit "synthesis-complete" when a new neural segment is synthesized', async () => {
        const stream = new EventEmitter() as any;
        stream.destroy = vi.fn();
        mockTtsInstance.toStream.mockReturnValue({ audioStream: stream });
        
        const onComplete = vi.fn();
        // @ts-ignore - dynamic event for TDD
        engine.on('synthesis-complete', onComplete);

        const speakPromise = engine.speakNeural('Hello', 'cache-key-1', defaultOptions);
        
        // Wait for microtasks
        await new Promise(r => setTimeout(r, 20));

        // Simulate stream flow
        stream.emit('data', Buffer.from('audio-chunk'));
        stream.emit('end');
        
        await speakPromise;

        expect(onComplete).toHaveBeenCalledWith({
            cacheKey: 'cache-key-1',
            intentId: expect.any(Number)
        });
    });

    it('should emit "clear-cache" when clearCache() is called', () => {
        const onClear = vi.fn();
        // @ts-ignore - dynamic event for TDD
        engine.on('clear-cache', onClear);

        engine.clearCache();

        expect(onClear).toHaveBeenCalled();
    });

    it('should broadcast cache stats update after synthesis', async () => {
        const stream = new EventEmitter() as any;
        stream.destroy = vi.fn();
        mockTtsInstance.toStream.mockReturnValue({ audioStream: stream });
        
        const onStats = vi.fn();
        // @ts-ignore - dynamic event for TDD
        engine.on('cache-stats-update', onStats);

        const speakPromise = engine.speakNeural('Hello', 'cache-key-1', defaultOptions);
        
        await new Promise(r => setTimeout(r, 20));

        stream.emit('data', Buffer.from('abc'));
        stream.emit('end');
        await speakPromise;

        expect(onStats).toHaveBeenCalledWith({
            count: 1,
            sizeBytes: 3 // 'abc' is 3 bytes
        });
    });
});
