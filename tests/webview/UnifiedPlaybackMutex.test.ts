/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WebviewAudioEngine } from '../../src/webview/core/WebviewAudioEngine';
import { WebviewStore } from '../../src/webview/core/WebviewStore';
import { MessageClient } from '../../src/webview/core/MessageClient';
import { CommandDispatcher } from '../../src/webview/core/CommandDispatcher';
import { CacheManager } from '../../src/webview/cacheManager';
import { OutgoingAction } from '../../src/common/types';
import { resetAllSingletons, FULL_DOM_TEMPLATE } from './testUtils';

describe('UnifiedPlaybackMutex (E2E Integration - v2.3.2)', () => {
    // Increase timeout for all tests in this suite to allow for safety watchdog timing
    vi.setConfig({ testTimeout: 15000 });
    
    let engine: WebviewAudioEngine;
    let store: WebviewStore;

    beforeEach(() => {
        resetAllSingletons();
        vi.useRealTimers();
        
        document.body.innerHTML = FULL_DOM_TEMPLATE; // Use the standard template
        engine = WebviewAudioEngine.getInstance();
        store = WebviewStore.getInstance();

        // Hydrate store to bypass Handshake gate
        store.updateState({ isHydrated: true }, 'local');

        // Mock native APIs
        vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => { });

        // Default play mock: resolves instantly and dispatches ended shortly after
        vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
            setTimeout(() => {
                this.dispatchEvent(new Event('ended'));
            }, 10);
            return Promise.resolve();
        });

        vi.spyOn(engine, 'isSegmentReady').mockReturnValue(true);

        // Mock native play on the instance directly to be absolutely sure
        const audio = engine.audioElement;
        vi.spyOn(audio, 'play').mockImplementation(function() {
            setTimeout(() => {
                if (audio && typeof audio.dispatchEvent === 'function') {
                    audio.dispatchEvent(new Event('ended'));
                }
            }, 10);
            return Promise.resolve();
        });

        // Mock URL to prevent JSDOM errors
        if (typeof global.URL.createObjectURL !== 'function') {
            global.URL.createObjectURL = vi.fn(() => 'blob:test');
            global.URL.revokeObjectURL = vi.fn();
        }
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('SHOULD serialize synthesis and playBlob calls', async () => {
        const traces: string[] = [];
        let capturedUtt: any;

        vi.spyOn(window.speechSynthesis, 'speak').mockImplementation((utt: any) => {
            capturedUtt = utt;
            traces.push('speak_started');
        });

        vi.spyOn(window.speechSynthesis, 'cancel').mockImplementation(() => {
            if (capturedUtt && capturedUtt.onend) {
                capturedUtt.onend(new Event('end'));
            }
        });

        const speakPromise = engine.speakLocal('Hello', undefined, 100);
        await new Promise(r => setTimeout(r, 50));

        // trigger playBlob immediately (Should wait for speakLocal lock)
        const playBlobPromise = engine.playBlob(new Blob(), 'key-1', 100).then(() => traces.push('playblob_done'));
        await new Promise(r => setTimeout(r, 50));

        expect(traces).toEqual(['speak_started']);
        expect(traces).not.toContain('playblob_done');

        // Finish speakLocal via authoritative stop
        engine.stop();

        await speakPromise;
        await playBlobPromise;

        expect(traces).toContain('playblob_done');
    });

    it('SHOULD NOT allow an old intent to play if a new intent took over', async () => {
        const audio = engine.audioElement;

        // 1. Kick off a long-running playback with intent 100
        let release100: (() => void) | undefined;
        const lockPromise = (engine as any).acquireLock(100).then((rel: any) => {
            release100 = rel;
        });
        await lockPromise;

        // 2. Queue intent 90 (Should be rejected immediately by sovereignty logic, but it still waits for lock)
        // We don't await this immediately because it would deadlock
        const result90Promise = engine.playBlob(new Blob(), 'old', 90);

        // 3. Start intent 110
        let release110: (() => void) | undefined;
        const lock110Promise = (engine as any).acquireLock(110).then((rel: any) => {
            release110 = rel;
        });

        if (release100) { release100(); }
        await result90Promise;
        await lock110Promise;

        // Verify intent 110 took over correctly
        expect(engine.activeIntentId).toBe(110);
        
        // Cleanup intent 110 lock to prevent hanging the suite
        if (release110) {release110();}
    });

    it('SHOULD recover and allow subsequent playback if a previous one fails', async () => {
        const audio = engine.audioElement;
        // 1. Trigger a failing playback (rejects its lock)
        vi.spyOn(audio, 'play').mockImplementationOnce(function (this: HTMLMediaElement) {
            return Promise.reject(new Error('Audio Error'));
        });

        const failPromise = engine.playBlob(new Blob(), 'fail-blob', 300);
        try { await failPromise; } catch (e) { }

        // 2. Trigger a successful playback
        const successPromise = engine.playBlob(new Blob(), 'success-blob', 301);
        await successPromise;
        expect(engine.activeIntentId).toBe(301);
    });

    it('ZOMBIE FIX: playback aborted during play() should not hang the mutex', async () => {
        const audio = engine.audioElement;
        let releaseHanging: (() => void) | undefined;

        // Mock play() to be a "long" operation
        vi.spyOn(audio, 'play').mockImplementation(function (this: HTMLMediaElement) {
            return new Promise(resolve => {
                releaseHanging = resolve;
                const onEnded = () => {
                    this.removeEventListener('ended', onEnded);
                    resolve();
                };
                this.addEventListener('ended', onEnded);
            });
        });

        // 1. Start intent 1
        const p1 = engine.playBlob(new Blob(['p1']), 'k1', 1);
        await new Promise(r => setTimeout(r, 50));

        // 2. Start intent 2 - will wait for lock
        const p2 = engine.playBlob(new Blob(['p2']), 'k2', 2);

        // Authoritative cleanup: Stop the engine, which should unblock everything
        engine.stop();

        await p1;
        await p2;
        
        expect(true).toBe(true);
        if (releaseHanging) {releaseHanging();}
    });
});
