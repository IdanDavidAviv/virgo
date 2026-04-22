import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlaybackEngine, PlaybackOptions } from '@core/playbackEngine';
import { StateStore } from '@core/stateStore';
import { EventEmitter } from 'events';

// --- MODULE MOCKS ---
const { mockTtsInstance } = vi.hoisted(() => ({
    mockTtsInstance: {
        getVoices: vi.fn().mockResolvedValue([]),
        setMetadata: vi.fn().mockResolvedValue(undefined),
        toStream: vi.fn()
    }
}));

vi.mock('msedge-tts', () => ({
    MsEdgeTTS: class {
        constructor() { return mockTtsInstance; }
        getVoices() { return mockTtsInstance.getVoices(); }
        setMetadata(m: any) { return mockTtsInstance.setMetadata(m); }
        toStream(t: string) { return mockTtsInstance.toStream(t); }
    },
    OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 'mp3-format' }
}));

describe('PlaybackEngine Lock Integrity', () => {
    let engine: PlaybackEngine;
    const logger = vi.fn();
    const defaultOptions: PlaybackOptions = { voice: 'V', rate: 0, volume: 50, mode: 'neural' };

    beforeEach(() => {
        vi.useFakeTimers();
        const stateStore = new StateStore(logger);
        engine = new PlaybackEngine(stateStore, logger);
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    async function tick(count: number = 1) {
        for (let i = 0; i < count; i++) {
            await vi.advanceTimersByTimeAsync(0);
        }
    }

    it('should maintain FIFO order and block concurrent synthesis if prompts are different', async () => {
        const stream1 = new EventEmitter() as any;
        const stream2 = new EventEmitter() as any;
        stream1.destroy = vi.fn();
        stream2.destroy = vi.fn();
        
        // Return different streams for each call
        mockTtsInstance.toStream
            .mockReturnValueOnce({ audioStream: stream1 })
            .mockReturnValueOnce({ audioStream: stream2 });

        // Fire both calls instantly as NON-PRIORITY to prevent "Latest Wins" abortion
        // Priority tasks (isPriority: true) explicitly abort previous segments, which would break FIFO testing.
        const testIntent = 1000;
        const p1 = engine.speakNeural('Prompt 1', 'id1', defaultOptions, false, testIntent);
        const p2 = engine.speakNeural('Prompt 2', 'id2', defaultOptions, false, testIntent);

        // Wait for multiple microtask cycles (lock acquisition -> setMetadata -> new Promise)
        for (let i = 0; i < 20; i++) {
            await vi.advanceTimersByTimeAsync(0);
        }
        
        expect(mockTtsInstance.toStream).toHaveBeenCalledWith('Prompt 1');

        // Stream 2 should NOT have been called yet
        expect(mockTtsInstance.toStream).not.toHaveBeenCalledWith('Prompt 2');

        // Complete stream 1
        stream1.emit('data', Buffer.from('data1'));
        stream1.emit('end');
        
        for (let i = 0; i < 5; i++) {
            await vi.advanceTimersByTimeAsync(0);
        }

        const r1 = await p1;
        expect(r1).toBe(Buffer.from('data1').toString('base64'));

        // Now stream 2 should have been called
        expect(mockTtsInstance.toStream).toHaveBeenCalledTimes(2);
        expect(mockTtsInstance.toStream).toHaveBeenCalledWith('Prompt 2');

        // Complete stream 2
        stream2.emit('data', Buffer.from('data2'));
        stream2.emit('end');
        
        for (let i = 0; i < 5; i++) {
            await vi.advanceTimersByTimeAsync(0);
        }

        const r2 = await p2;
        expect(r2).toBe(Buffer.from('data2').toString('base64'));
    });

    it('should release lock immediately if aborted', async () => {
        const stream1 = new EventEmitter() as any;
        stream1.destroy = vi.fn();
        mockTtsInstance.toStream.mockReturnValue({ audioStream: stream1 });

        const testIntent = 1000;
        const p1 = engine.speakNeural('Prompt 1', 'id1', defaultOptions, false, testIntent);
        const p2 = engine.speakNeural('Prompt 2', 'id2', defaultOptions, false, testIntent);

        for (let i = 0; i < 20; i++) {
            await vi.advanceTimersByTimeAsync(0);
        }
        
        expect(mockTtsInstance.toStream).toHaveBeenCalledWith('Prompt 1');

        // Stop engine - should abort p1 AND p2 (since stop() is now authoritative)
        engine.stop();
        
        for (let i = 0; i < 10; i++) {
            await vi.advanceTimersByTimeAsync(0);
        }

        const r1 = await p1;
        const r2 = await p2;
        expect(r1).toBe(null);
        expect(r2).toBe(null);

        // Verify lock is released by starting p3
        mockTtsInstance.toStream.mockReturnValue({ audioStream: new EventEmitter() as any });
        const p3 = engine.speakNeural('Prompt 3', 'id3', defaultOptions, true);
        
        await tick(5);
        expect(mockTtsInstance.toStream).toHaveBeenCalledWith('Prompt 3');
    });
});
