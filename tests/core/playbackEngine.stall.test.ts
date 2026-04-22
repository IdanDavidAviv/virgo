import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlaybackEngine } from '@core/playbackEngine';
import { StateStore } from '@core/stateStore';

// Mock msedge-tts
vi.mock('msedge-tts', () => {
    return {
        MsEdgeTTS: vi.fn().mockImplementation(function() {
            return {
                getVoices: vi.fn().mockResolvedValue([]),
                setMetadata: vi.fn().mockResolvedValue(undefined),
                push: vi.fn(),
                on: vi.fn(),
            };
        }),
        OUTPUT_FORMAT: {}
    };
});

describe('PlaybackEngine Stall Detection', () => {
    let engine: PlaybackEngine;
    const logger = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        const stateStore = new StateStore(logger);
        engine = new PlaybackEngine(stateStore, logger);
    });

    it('should initialize with isStalled as false', () => {
        expect(engine.isStalled).toBe(false);
    });

    it('should set isStalled to true when starting priority neural synthesis', async () => {
        const statusSpy = vi.fn();
        engine.on('status', statusSpy);

        // We don't await the full synthesis here to check the intermediate stalling state
        const promise = engine.speakNeural('test', 'key', { mode: 'neural', voice: 'v', rate: 0, volume: 50 }, true);
        
        expect(engine.isStalled).toBe(true);
        expect(statusSpy).toHaveBeenCalled();
        
        // Silently handle the promise to avoid unhandled rejection in Vitest
        promise.catch(() => {});
    });

    it('should set isStalled to false if cache hit occurs', async () => {
        // Manually inject into private cache for testing
        (engine as any)._audioCache.set('hit', 'data');
        
        const statusSpy = vi.fn();
        engine.on('status', statusSpy);

        await engine.speakNeural('test', 'hit', { mode: 'neural', voice: 'v', rate: 0, volume: 50 }, true);
        
        expect(engine.isStalled).toBe(false);
        expect(statusSpy).toHaveBeenCalled();
    });
});
