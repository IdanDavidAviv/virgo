/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebviewAudioEngine } from '@webview/core/WebviewAudioEngine';
import { WebviewStore } from '@webview/core/WebviewStore';
import { resetAllSingletons, wireDispatcher } from './testUtils';

describe('UnifiedPlaybackMutex (E2E Integration)', () => {
    let engine: WebviewAudioEngine;
    let store: WebviewStore;

    beforeEach(() => {
        vi.useFakeTimers();
        resetAllSingletons();
        wireDispatcher();

        engine = WebviewAudioEngine.getInstance();
        store = WebviewStore.getInstance();
        
        // Mock store state
        vi.spyOn(store, 'getUIState').mockReturnValue({
            playbackIntent: 'PLAYING',
            currentCacheKey: '',
            isWarmingUp: false,
            lastError: null,
            cacheStatus: {}
        } as any);

        // Mock strategies
        (engine as any).neuralStrategy.audio = {
            pause: vi.fn(),
            play: vi.fn().mockImplementation(() => new Promise(resolve => setTimeout(resolve, 50))),
            load: vi.fn(),
            paused: true,
            src: ''
        };

        // Mock speechSynthesis
        (window as any).speechSynthesis = {
            speak: vi.fn().mockImplementation((utterance) => {
                setTimeout(() => {
                    if (utterance.onstart) { utterance.onstart(); }
                }, 50);
            }),
            cancel: vi.fn(),
            getVoices: vi.fn().mockReturnValue([]),
            speaking: false,
            paused: false
        };
    });

    it('SHOULD serialize synthesis and playBlob calls across strategies', async () => {
        const traces: string[] = [];
        let resolveNeural: () => void;
        const neuralPlayStarted = new Promise<void>(r => { resolveNeural = r; });

        // Force intent to PLAYING
        (engine as any).playbackIntent = 'PLAYING';

        // Ensure Neural is active
        (engine as any).updateStrategy('Neural:Voice1');

        // Mock play to be manually controlled
        (engine as any).neuralStrategy.audio.play = vi.fn().mockImplementation(() => neuralPlayStarted);

        // 1. Trigger Neural Playback (Stuck until we resolveNeural)
        const neuralPromise = engine.playBlob(new Blob(), 'key-1', 100).then(() => traces.push('neural_done'));

        // 2. Trigger Local synthesis immediately (Should wait for Neural)
        const localPromise = engine.synthesize('hello', { id: 'voice-1', engine: 'local' } as any, 101).then(() => traces.push('local_done'));

        // Important: Wait for microtasks so that locks have a chance to be requested
        await Promise.resolve();
        await Promise.resolve();
        
        // At this point, Neural is "playing" (waiting for neuralPlayStarted)
        // Local should be waiting for the lock.
        expect(traces.length, `Traces currently: ${traces.join(',')}`).toBe(0);

        // 3. Resolve Neural
        resolveNeural!();
        await neuralPromise;
        expect(traces).toContain('neural_done');

        // 4. Now Local should get the lock and finish
        await vi.advanceTimersByTimeAsync(50);
        await localPromise;
        expect(traces).toContain('local_done');
        expect(traces).toEqual(['neural_done', 'local_done']);
    });

    it('SHOULD NOT allow an old strategy to play if a new strategy took over', async () => {
        // [SCENARIO]: Neural is waiting for the lock. 
        //             Before it gets the lock, we switch to Local.
        
        // 1. Manually take the lock
        const unlock = await engine.acquirePlaybackLock();
        
        // 2. Queue Neural Playback
        const neuralAudio = (engine as any).neuralStrategy.audio;
        const audioSpy = vi.spyOn(neuralAudio, 'play');
        
        const neuralPromise = engine.playBlob(new Blob(), 'key-1', 100);

        // 3. Switch strategy to Local via updateState (which triggers updateStrategy subscription)
        // [SOVEREIGNTY]: Engine switches strategy based on selectedVoice prefix
        store.updateState({ selectedVoice: 'Local:Default' } as any, 'remote');
        
        // 4. Release lock - Step 1 is done
        unlock();
        
        // Neural should now get the lock but MUST reject the playback because it's no longer active
        await neuralPromise;
        
        // Verify audio.play was NOT called on the neural strategy's player
        expect(audioSpy).not.toHaveBeenCalled();
    });
    it('SHOULD recover and allow subsequent playback if a previous one fails', async () => {
        // 1. Trigger a failing playback (rejects its lock)
        const neuralAudio = (engine as any).neuralStrategy.audio;
        vi.spyOn(neuralAudio, 'play').mockRejectedValue(new Error('Audio Error'));
        
        // Ensure store intent is NOT STOPPED so guard doesn't prune it before calling play()
        WebviewStore.getInstance().updateUIState({ playbackIntent: 'PLAYING' });

        try {
            await engine.playBlob(new Blob(), 'key-fail', 200);
        } catch (e) {
            // Expected error
        }

        // 2. Trigger a successful playback
        const successTraces: string[] = [];
        vi.spyOn(neuralAudio, 'play').mockResolvedValue(undefined);
        
        await engine.playBlob(new Blob(), 'key-success', 201).then(() => successTraces.push('success_done'));
        
        expect(successTraces).toContain('success_done');
    });
});
