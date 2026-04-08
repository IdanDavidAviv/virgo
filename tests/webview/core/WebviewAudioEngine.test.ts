import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WebviewAudioEngine } from '../../../src/webview/core/WebviewAudioEngine';
import { WebviewStore } from '../../../src/webview/core/WebviewStore';
import { resetAllSingletons } from '../testUtils';

/**
 * @vitest-environment jsdom
 */

describe('WebviewAudioEngine (v2.3.1 - Dumb Player)', () => {
    let engine: WebviewAudioEngine;
    let store: WebviewStore;

    beforeEach(() => {
        resetAllSingletons();
        engine = WebviewAudioEngine.getInstance();
        engine.stop(true); // [HARDENING] Reset intentId to 0 for each test
        store = WebviewStore.getInstance();
        
        // Hydrate store for engine listeners
        store.updateState({ isHandshakeComplete: true }, 'local');

        // Spy on Audio elements
        vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
        vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
        vi.spyOn(HTMLMediaElement.prototype, 'addEventListener');

        // [v2.3.1] Synchronous synthesis mock: prevents event loop delays and race conditions
        vi.spyOn(window.speechSynthesis, 'speak').mockImplementation((utterance: any) => {
            if (utterance.onstart) { utterance.onstart(); }
            if (utterance.onend) { utterance.onend(); }
        });
        vi.spyOn(window.speechSynthesis, 'cancel').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('should acquire lock for speakLocal and release it on completion', async () => {
        const intentId = 12345;
        await engine.speakLocal('Hello', undefined, intentId);

        expect(window.speechSynthesis.speak).toHaveBeenCalled();
        expect(engine.isBusy()).toBe(false);
    });

    it('should acquire lock for playBlob and release it on completion', async () => {
        const intentId = 67890;
        const blob = new Blob(['audio'], { type: 'audio/mp3' });

        const playPromise = engine.playBlob(blob, 'test-key', intentId);
        
        // Give it a microtick to set up listeners
        await new Promise(r => setTimeout(r, 0));
        
        const audio = engine.audioElement;
        
        // Find the 'ended' listener and trigger it
        const endedCall = vi.mocked(audio.addEventListener).mock.calls.find(call => call[0] === 'ended');
        
        expect(endedCall).toBeDefined();
        const listener = endedCall![1] as Function;
        
        // Trigger fulfillment
        listener();

        await playPromise;
        expect(engine.isBusy()).toBe(false);
    });

    it('stop() should kill all active playback and release locks', async () => {
        // Start a speak action but don't finish it
        engine.speakLocal('Long text', undefined, 999);
        
        // Wait for it to become busy (needs a microtask tick for acquireLock)
        await vi.waitFor(() => expect(engine.isBusy()).toBe(true));

        engine.stop();

        // [ASSERT]: Stop must clear resolvers
        expect(engine.isBusy()).toBe(false);
        expect(window.speechSynthesis.cancel).toHaveBeenCalled();
        expect(engine.audioElement.pause).toHaveBeenCalled();
    });

    it('should allow newer intents to bust older ones', async () => {
        // 1. Current intent is 1000
        const p1 = engine.speakLocal('First', undefined, 1000);
        
        // Wait for it to acquire lock and start
        await Promise.resolve();
        await Promise.resolve();

        // 2. Newer intent arrives (1001)
        const p2 = engine.speakLocal('Second', undefined, 1001);

        // [ASSERT]: P1 should resolve (being busted) and P2 should take over
        await p1;
        await p2;
    });

    it('should reject requests with old intent IDs', async () => {
        // 1. Start a long-running playback with intent 2000
        const playback = engine.speakLocal('First', undefined, 2000); 
        
        // Wait for it to become active
        await vi.waitFor(() => expect(engine.isBusy()).toBe(true));

        // 2. Try to speak with an older intent (1999) - should be rejected immediately
        await engine.speakLocal('Old', undefined, 1999);
        
        // [ASSERT]: Overall we should only have called speak once
        expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(1);
        
        engine.stop('infinity');
        await playback;
    });
});
