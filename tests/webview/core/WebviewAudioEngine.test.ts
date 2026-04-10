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
        engine.stop(); 
        (engine as any).activeIntentId = 0; // [HARDENING] Reset intentId to 0 for each test isolation
        store = WebviewStore.getInstance();
        
        // Hydrate store for engine listeners
        store.updateState({ isHydrated: true }, 'local');

        // Spy on Audio elements
        vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
        vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
        vi.spyOn(HTMLMediaElement.prototype, 'addEventListener');
        // [jsdom CONTRACT] vitest.setup.ts Audio stub handles canplay dispatch via load().
        // No prototype-level load() override needed here.

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
        const audio = engine.audioElement;

        const playPromise = engine.playBlob(blob, 'test-key', intentId);

        // Flush: acquireLock -> mutex race -> inner Promise body (registers listeners + calls load)
        await Promise.resolve();
        await Promise.resolve();
        // Flush: canplay microtask -> onCanPlay -> play() fires (fire-and-forget)
        await Promise.resolve();

        // [jsdom CONTRACT] 'ended' is dispatched natively on the element.
        // The stub's dispatchEvent calls all registered listeners, matching browser semantics.
        audio.dispatchEvent(new Event('ended'));

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
        await vi.waitFor(() => expect(window.speechSynthesis.speak).toHaveBeenCalledTimes(1));
        
        engine.stop();
        await playback;
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// [NEURAL GUARD] setRate() — Law 8.1: No playbackRate for pre-baked neural audio
// ─────────────────────────────────────────────────────────────────────────────
describe('WebviewAudioEngine.setRate() — Neural Guard (Law 8.1)', () => {
    let engine: WebviewAudioEngine;
    let store: WebviewStore;

    beforeEach(() => {
        resetAllSingletons();
        engine = WebviewAudioEngine.getInstance();
        store = WebviewStore.getInstance();
        store.updateState({ isHydrated: true }, 'local');
        vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
        vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('[Law 8.1] should set relative playbackRate when engineMode is neural (rate / bakedRate)', () => {
        // [ARRANGE] Engine in neural mode synthesized at 1.0, user wants 2.0
        store.patchState({ engineMode: 'neural', rate: 2.0 });
        (engine as any).bakedRate = 1.0;

        // [ACT]
        engine.setRate(2.0);

        // [ASSERT] playbackRate must be 2.0 (2.0 / 1.0)
        expect(engine.audioElement.playbackRate).toBe(2.0);

        // [ACT] Change target rate to 0.5
        engine.setRate(0.5);
        expect(engine.audioElement.playbackRate).toBe(0.5);
    });

    it('[Law 8.1] should calculate relative rate correctly when bakedRate > 1.0', () => {
        // [ARRANGE] Synthesized at 2.0, user wants 2.0 (effective 1.0)
        store.patchState({ engineMode: 'neural', rate: 2.0 });
        (engine as any).bakedRate = 2.0;

        // [ACT]
        engine.setRate(2.0);

        // [ASSERT] 2.0 / 2.0 = 1.0
        expect(engine.audioElement.playbackRate).toBe(1.0);
    });

    it('[Law 8.1] should SET playbackRate when engineMode is local', () => {
        // [ARRANGE] Engine in local TTS mode
        store.patchState({ engineMode: 'local', rate: 2 });

        // [ACT]
        engine.setRate(2);

        // [ASSERT] playbackRate must be applied for local mode
        expect(engine.audioElement.playbackRate).toBe(2);
    });

    it('[Law 8.1] rate store subscription must update relative speed in neural mode', () => {
        // [ARRANGE] Start in neural mode, synthesized at 1.0
        store.patchState({ engineMode: 'neural', rate: 1.0 });
        (engine as any).bakedRate = 1.0;

        // [ACT] Simulate store rate change
        store.patchState({ rate: 1.5 });

        // [ASSERT] 1.5 / 1.0 = 1.5
        expect(engine.audioElement.playbackRate).toBe(1.5);
    });
});
