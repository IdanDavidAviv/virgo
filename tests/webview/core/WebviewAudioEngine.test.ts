/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebviewAudioEngine } from '../../../src/webview/core/WebviewAudioEngine';
import { MessageClient } from '../../../src/webview/core/MessageClient';
import { WebviewStore } from '../../../src/webview/core/WebviewStore';
import { PlaybackController } from '../../../src/webview/playbackController';

describe('WebviewAudioEngine (Strategy Architecture)', () => {
    let engine: WebviewAudioEngine;
    let controller: PlaybackController;

    beforeEach(() => {
        vi.clearAllMocks();

        // 1. Mock MessageClient.getInstance
        vi.spyOn(MessageClient, 'getInstance').mockReturnValue({
            postAction: vi.fn(),
            resetInstance: vi.fn()
        } as any);

        // 2. Mock WebviewStore.getInstance
        const mockStore = {
            getState: vi.fn(() => ({ volume: 50, rate: 0, selectedVoice: 'en-US-SteffanNeural' })),
            getUIState: vi.fn(() => ({ isAwaitingSync: false, playbackIntent: 'PAUSED' })),
            updateUIState: vi.fn(),
            optimisticPatch: vi.fn(),
            patchState: vi.fn(),
            getSentenceKey: vi.fn(),
            subscribe: vi.fn((selector, handler) => { 
                // Immediate trigger for initial strategy
                if (selector.toString().includes('selectedVoice')) {
                    handler('en-US-SteffanNeural');
                }
            }),
            subscribeUI: vi.fn((selector, handler) => {
                // Initial trigger
                handler(selector({ playbackIntent: 'PAUSED' } as any));
            })
        };
        vi.spyOn(WebviewStore, 'getInstance').mockReturnValue(mockStore as any);

        // 3. Mock window.speechSynthesis for Local Strategy
        (window as any).speechSynthesis = {
            speak: vi.fn(),
            cancel: vi.fn(),
            pause: vi.fn(),
            resume: vi.fn(),
            getVoices: vi.fn(() => []),
            pending: false,
            speaking: false,
            paused: false
        };

        // 4. Mock window.Audio for Neural Strategy
        (window as any).Audio = class {
            volume = 1;
            playbackRate = 1;
            play = vi.fn().mockResolvedValue(undefined);
            pause = vi.fn();
            muted = false;
        };

        // Reset singletons for isolation
        WebviewAudioEngine.resetInstance();
        PlaybackController.resetInstance();
        
        engine = WebviewAudioEngine.getInstance();
        controller = PlaybackController.getInstance();
    });

    it('should initialize with LocalAudioStrategy by default', () => {
        // @ts-ignore - accessing private for verification
        expect(engine.activeStrategy.id).toBe('local');
    });

    it('should switch to NeuralAudioStrategy for neural voices', () => {
        const store = WebviewStore.getInstance();
        // Trigger the subscription handler
        // @ts-ignore - access private method for testing
        engine.updateStrategy('Neural:en-US-SteffanNeural');
        
        // @ts-ignore
        expect(engine.activeStrategy.id).toBe('neural');
    });

    it('pause() should call the active strategy pause', () => {
        // @ts-ignore
        const pauseSpy = vi.spyOn(engine.activeStrategy, 'pause');
        engine.pause();
        expect(pauseSpy).toHaveBeenCalled();
    });

    it('stop() should call the active strategy stop', () => {
        // @ts-ignore
        const stopSpy = vi.spyOn(engine.activeStrategy, 'stop');
        engine.stop();
        expect(stopSpy).toHaveBeenCalled();
    });
});
