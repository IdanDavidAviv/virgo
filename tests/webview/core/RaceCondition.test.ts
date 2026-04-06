/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebviewAudioEngine } from '../../../src/webview/core/WebviewAudioEngine';
import { PlaybackController } from '../../../src/webview/playbackController';
import { WebviewStore } from '../../../src/webview/core/WebviewStore';
import { NeuralAudioStrategy } from '../../../src/webview/strategies/NeuralAudioStrategy';

describe('Resilience: RaceCondition (v2.0.0 Hardening)', () => {
    let engine: WebviewAudioEngine;
    let controller: PlaybackController;
    let playSpy: any;

    beforeEach(() => {
        vi.clearAllMocks();
        
        // 1. Reset Singleton State
        (window as any).__WEBVIEW_STORE__ = undefined;
        WebviewAudioEngine.resetInstance();
        PlaybackController.resetInstance();

        // 2. Setup Store
        const store = WebviewStore.getInstance();
        store.updateUIState({ playbackIntent: 'PLAYING' });

        // 3. Initialize Engine
        engine = WebviewAudioEngine.getInstance();
        controller = PlaybackController.getInstance();

        // 4. Spy on the ACTUAL instance created by the engine
        const audio = engine.getAudioElement();
        playSpy = vi.spyOn(audio, 'play').mockResolvedValue(undefined);
        vi.spyOn(audio, 'pause').mockImplementation(() => {});
        vi.spyOn(audio, 'load').mockImplementation(() => {});

        // 5. Mock URL.createObjectURL for JSDOM
        if (typeof window.URL.createObjectURL === 'undefined') {
            window.URL.createObjectURL = vi.fn(() => 'blob:mock');
            window.URL.revokeObjectURL = vi.fn();
        }

        // 6. Force controller state to PLAYING
        vi.spyOn(controller, 'getState').mockReturnValue({ intent: 'PLAYING' } as any);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('SHOULD reject late audio packets from a previous intent (Zombie Guard)', async () => {
        // 1. Current intent is 2
        await engine.playBlob(new Blob(['fake-audio-B'], { type: 'audio/mpeg' }), 'key-B', 2);
        expect(playSpy).toHaveBeenCalledTimes(1);

        // 2. Late arrival of Intent 1
        await engine.playFromBase64('bm9wZQ==', 'key-A', 1);

        // 3. ASSERT: play() should NOT have been called for Intent 1
        expect(playSpy).toHaveBeenCalledTimes(1);
    });

    it('SHOULD allow audio packets that match the current intent', async () => {
        // 1. Current intent is 5
        await engine.playFromBase64('bm9wZQ==', 'key-5', 5);
        expect(playSpy).toHaveBeenCalledTimes(1);

        // 2. Another packet for the SAME intent
        await engine.playBlob(new Blob(['extra'], { type: 'audio/mpeg' }), 'key-5-extra', 5);
        expect(playSpy).toHaveBeenCalledTimes(2);
    });

    it('SHOULD honor the STOP intent even if audio arrives', async () => {
        // 1. User stops playback
        WebviewStore.getInstance().updateUIState({ playbackIntent: 'STOPPED' });

        // 2. Audio arrives for a valid intent number, but intent is STOPPED
        await engine.playFromBase64('bm9wZQ==', 'key-stop', 10);

        // 3. ASSERT: Audio should NOT play because intent is STOPPED
        expect(playSpy).not.toHaveBeenCalled();
    });
});
