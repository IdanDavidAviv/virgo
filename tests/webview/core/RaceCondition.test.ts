/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebviewAudioEngine } from '../../../src/webview/core/WebviewAudioEngine';
import { PlaybackController } from '../../../src/webview/playbackController';

describe('Resilience: RaceCondition (v2.0.0 Hardening)', () => {
    let engine: WebviewAudioEngine;
    let controller: PlaybackController;

    beforeEach(() => {
        vi.clearAllMocks();

        // 1. Reset all singletons
        WebviewAudioEngine.resetInstance();
        PlaybackController.resetInstance();
        
        // 2. Clear window state
        (window as any).__WEBVIEW_STORE__ = undefined;

        // 3. Mock Audio
        (window as any).Audio = class {
            volume = 1;
            playbackRate = 1;
            src = '';
            onended: any = null;
            onerror: any = null;
            onplay: any = null;
            onpause: any = null;
            onwaiting: any = null;
            onplaying: any = null;
            play = vi.fn().mockResolvedValue(undefined);
            pause = vi.fn();
            load = vi.fn();
        };
        
        engine = WebviewAudioEngine.getInstance();
        controller = PlaybackController.getInstance();
    });

    afterEach(() => {
        vi.clearAllMocks();
        vi.clearAllTimers();
        vi.useRealTimers();
        WebviewAudioEngine.resetInstance();
        PlaybackController.resetInstance();
    });

    it('SHOULD reject late audio packets from a previous intent (Zombie Guard)', async () => {
        const audio = engine.getAudioElement();
        const playSpy = vi.spyOn(audio, 'play');

        // Ensure controller is in playing state
        vi.spyOn(controller, 'getState').mockReturnValue({ intent: 'PLAYING' } as any);
        
        // 1. User rapidly skips to Sentence B (Intent 2)
        // We simulate the webview state reflecting Intent 2
        await engine.playBlob(new Blob(['fake-audio-B'], { type: 'audio/mpeg' }), 'key-B', 2);
        expect(playSpy).toHaveBeenCalledTimes(1);

        // 2. Late arrival of Sentence A (Intent 1) via playFromBase64
        const fakeBase64 = 'YmFzZTY0LWRhdGE='; 
        await engine.playFromBase64(fakeBase64, 'key-A', 1);

        // 3. ASSERT: play() should NOT have been called for Intent 1
        expect(playSpy).toHaveBeenCalledTimes(1);
    });

    it('SHOULD allow audio packets that match the current intent', async () => {
        const audio = engine.getAudioElement();
        const playSpy = vi.spyOn(audio, 'play');
        
        vi.spyOn(controller, 'getState').mockReturnValue({ intent: 'PLAYING' } as any);

        // 1. Current intent is 5
        await engine.playFromBase64('YmFzZTY0', 'key-5', 5);
        expect(playSpy).toHaveBeenCalledTimes(1);

        // 2. Another packet for the SAME intent
        await engine.playFromBase64('YmFzZTY0LTI=', 'key-5', 5);
        expect(playSpy).toHaveBeenCalledTimes(2);
    });

    it('SHOULD honor the STOP intent even if audio arrives', async () => {
        const audio = engine.getAudioElement();
        const playSpy = vi.spyOn(audio, 'play');

        // 1. User stops playback
        controller.stop(); 
        
        // 2. Late audio arrives
        await engine.playFromBase64('YmFzZTY0', 'key-10', 10);

        // 3. ASSERT: Audio should NOT play because controller.intent is STOPPED
        expect(playSpy).not.toHaveBeenCalled();
    });
});
