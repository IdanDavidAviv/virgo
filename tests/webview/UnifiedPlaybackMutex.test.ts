import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WebviewAudioEngine } from '../../src/webview/core/WebviewAudioEngine';
import { WebviewStore } from '../../src/webview/core/WebviewStore';
import { resetAllSingletons } from './testUtils';

/**
 * @vitest-environment jsdom
 */

describe('UnifiedPlaybackMutex (E2E Integration - v2.3.1)', () => {
    let engine: WebviewAudioEngine;
    let store: WebviewStore;

    beforeEach(() => {
        vi.useRealTimers();
        resetAllSingletons();
        engine = WebviewAudioEngine.getInstance();
        store = WebviewStore.getInstance();
        
        // Hydrate store to bypass Handshake gate
        store.updateState({ isHandshakeComplete: true }, 'local');

        // Mock native APIs
        vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
        vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
        vi.spyOn(HTMLMediaElement.prototype, 'addEventListener');
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('SHOULD serialize synthesis and playBlob calls', async () => {
        const traces: string[] = [];

        // 1. Manually hold the lock via speakLocal (simulated)
        // We need a mock that captures the utterance but doesn't finish immediately
        let capturedUtt: SpeechSynthesisUtterance;
        vi.spyOn(window.speechSynthesis, 'speak').mockImplementation((utt: any) => {
            capturedUtt = utt;
            traces.push('speak_started');
        });
        
        const speakPromise = engine.speakLocal('Hello', undefined, 100);

        // 2. Trigger playBlob immediately (Should wait for speakLocal lock)
        const playBlobPromise = engine.playBlob(new Blob(), 'key-1', 100).then(() => traces.push('playblob_done'));

        // Wait for microtasks
        await new Promise(r => setTimeout(r, 0));
        
        expect(traces).toEqual(['speak_started']);
        expect(traces).not.toContain('playblob_done');

        // 3. Finish speakLocal via authoritative stop
        engine.stop('reset');
        
        await speakPromise; // resolves on stop
        await playBlobPromise; // acquires and finishes (since play is mocked)
        
        expect(traces).toContain('playblob_done');
    });

    it('SHOULD NOT allow an old intent to play if a new intent took over', async () => {
        const audio = engine.audioElement;
        const playSpy = vi.spyOn(audio, 'play').mockImplementation(() => Promise.resolve());
        
        // 1. Kick off a long-running playback with intent 100
        // We bypass speakLocal to avoid the 50ms timeout in testUtils mock for more control
        const lock100 = await engine.acquireLock(100);
        
        // 2. Queue intent 90 (Should be rejected immediately by acquireLock)
        const result90 = await engine.playBlob(new Blob(), 'old', 90);
        
        expect(playSpy).not.toHaveBeenCalled();
        
        // 3. Release 100
        lock100!();
        
        // 4. Queue intent 110 (Should work)
        await engine.playBlob(new Blob(), 'new', 110);
        expect(playSpy).toHaveBeenCalled();
    });

    it('SHOULD recover and allow subsequent playback if a previous one fails', async () => {
        // 1. Trigger a failing playback (rejects its lock)
        vi.spyOn(HTMLMediaElement.prototype, 'play').mockRejectedValueOnce(new Error('Audio Error'));
        
        console.log('[TEST] Starting failing playBlob sequence...');
        await engine.playBlob(new Blob(), 'key-fail', 300);
        
        // 2. Trigger a successful playback
        const successTraces: string[] = [];
        vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
        
        console.log('[TEST] Starting recovery playBlob sequence...');
        await engine.playBlob(new Blob(), 'key-success', 301).then(() => successTraces.push('success_done'));
        
        expect(successTraces).toContain('success_done');
    }, 15000);
});
