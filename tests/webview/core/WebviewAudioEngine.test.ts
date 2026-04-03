/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebviewAudioEngine } from '../../../src/webview/core/WebviewAudioEngine';
import { MessageClient } from '../../../src/webview/core/MessageClient';
import { WebviewStore } from '../../../src/webview/core/WebviewStore';
import { PlaybackController } from '../../../src/webview/playbackController';

describe('WebviewAudioEngine (TDD: Autoplay Regression)', () => {
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
        vi.spyOn(WebviewStore, 'getInstance').mockReturnValue({
            getState: vi.fn(() => ({ volume: 50, rate: 0 })),
            getUIState: vi.fn(() => ({ isAwaitingSync: false })),
            updateUIState: vi.fn(),
            optimisticPatch: vi.fn(),
            patchState: vi.fn(),
            getSentenceKey: vi.fn(),
            subscribe: vi.fn()
        } as any);

        // 3. Mock window and document globals for JSDOM
        (window as any).Audio = class {
            volume = 1;
            playbackRate = 1;
            onended = null;
            onerror = null;
            onplay = null;
            onpause = null;
            onwaiting = null;
            play = vi.fn().mockResolvedValue(undefined);
            pause = vi.fn();
        };

        // Reset singletons for isolation
        // @ts-ignore
        WebviewAudioEngine.instance = undefined;
        // @ts-ignore
        PlaybackController.instance = undefined;
        // @ts-ignore
        window.__AUDIO_ENGINE__ = undefined;
        // @ts-ignore
        window.__PLAYBACK_CONTROLLER__ = undefined;
        
        engine = WebviewAudioEngine.getInstance();
        controller = PlaybackController.getInstance();
    });

    it('SHOULD NOT reset intent to STOPPED when a segment naturally ends', () => {
        // 1. Simulate user starting playback via controller
        controller.play(); 
        
        expect(controller.getState().intent).toBe('PLAYING');

        // 2. Simulate audio segment ending in engine
        const audio = engine.getAudioElement();
        if (audio.onended) {
            audio.onended(new Event('ended'));
        }

        // 3. ASSERT: The controller intent should STAY 'PLAYING'
        expect(controller.getState().intent).toBe('PLAYING');
    });
});
