import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WebviewAudioEngine } from '../../../src/webview/core/WebviewAudioEngine';
import { WebviewStore } from '../../../src/webview/core/WebviewStore';
import { resetAllSingletons } from '../testUtils';

/**
 * @vitest-environment jsdom
 */

describe('Resilience: RaceCondition (v2.3.1 - Mutex Guard)', () => {
    let engine: WebviewAudioEngine;
    let store: WebviewStore;
    let playSpy: any;

    beforeEach(() => {
        resetAllSingletons();
        engine = WebviewAudioEngine.getInstance();
        engine.activeIntentId = 0;
        engine.stop('reset'); // [HARDENING] Reset intentId for isolation

        const audio = engine.audioElement;
        playSpy = vi.spyOn(audio, 'play').mockImplementation(() => Promise.resolve());
        vi.spyOn(audio, 'pause');
        vi.spyOn(audio, 'addEventListener');

        WebviewStore.getInstance().updateState({ isHandshakeComplete: true }, 'local');
        
        if (typeof window.URL.createObjectURL === 'undefined') {
            window.URL.createObjectURL = vi.fn().mockReturnValue('mock-url');
        }
    });

    it('SHOULD reject late audio packets from a previous intent (Zombie Guard)', async () => {
        // 1. Start intent 100
        const release = await engine.acquireLock(100); 
        
        // 2. A "Late" packet from intent 90 arrives
        const blob = new Blob(['late'], { type: 'audio/mp3' });
        await engine.playBlob(blob, 'key', 90);
        
        // [ASSERT]: The play command should NOT reach the audio element
        expect(playSpy).not.toHaveBeenCalled();

        if (release) release(); // [v2.3.1] Critical cleanup
    });

    it('SHOULD allow audio packets that match the current intent', async () => {
        // 1. Current intent is 200
        const blob = new Blob(['valid'], { type: 'audio/mp3' });
        
        // 2. Start playback
        const playPromise = engine.playBlob(blob, 'key', 200);
        
        // Use multiple flushes to ensure we reach the promise wait
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        
        const audio = engine.audioElement;
        // Wait for the engine to add the 'ended' listener
        await vi.waitFor(() => {
            const calls = vi.mocked(audio.addEventListener).mock.calls;
            return calls.some(call => call[0] === 'ended');
        });

        const endedCall = vi.mocked(audio.addEventListener).mock.calls.find(call => call[0] === 'ended');
        const listener = endedCall![1] as any;
        listener(new Event('ended'));

        await playPromise;
        
        // [ASSERT]: Use should be allowed
        expect(playSpy).toHaveBeenCalled();
    });

    it('SHOULD honor the STOP intent even if audio arrives', async () => {
        const audio = engine.audioElement;
        const playSpy = vi.spyOn(audio, 'play').mockImplementation(() => Promise.resolve());

        // 1. Current intent is 100
        const release = await engine.acquireLock(100);
        
        // 2. Stop is called (should effectively block any intent < infinity)
        engine.stop('infinity');
        
        // 3. A packet arrives with a "valid" but now stale intent
        const blob = new Blob(['stale'], { type: 'audio/mp3' });
        await engine.playBlob(blob, 'key', 101); // Even higher than 100 but < MAX
        
        expect(playSpy).not.toHaveBeenCalled();
        if (release) release();
    });
});
