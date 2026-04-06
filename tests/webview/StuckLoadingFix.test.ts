import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebviewStore } from '../../src/webview/core/WebviewStore';
import { WebviewAudioEngine } from '../../src/webview/core/WebviewAudioEngine';
import { UISyncPacket } from '../../src/common/types';

/**
 * @vitest-environment jsdom
 */

describe('Stuck Loading State Fix Verification', () => {
    let store: WebviewStore;
    let engine: WebviewAudioEngine;
    let mockAudioInstance: any;

    beforeEach(() => {
        // 1. [CRITICAL] Polyfill Audio BEFORE engine initialization
        // This ensures WebviewAudioEngine constructor uses our mock and attaches listeners
        global.Audio = class {
            play = vi.fn().mockResolvedValue(undefined);
            pause = vi.fn();
            load = vi.fn();
            addEventListener = vi.fn();
            removeEventListener = vi.fn();
            onplay = () => {};
            onpause = () => {};
            onended = () => {};
            onerror = () => {};
            onwaiting = () => {};
            onplaying = () => {};
            src = '';
            readyState = 4;
            paused = true;
            constructor() {
                mockAudioInstance = this;
            }
        } as any;

        // Reset singletons
        WebviewStore.resetInstance();
        WebviewAudioEngine.resetInstance();
        
        store = WebviewStore.getInstance();
        engine = WebviewAudioEngine.getInstance();

        // 2. Initial hydration
        store.optimisticPatch({ 
            isPlaying: false, 
            isPaused: true, 
            playbackStalled: false 
        });
    });

    it('FIX VERIFICATION: playbackStalled should be cleared after pause', async () => {
        // 1. Set intent to PLAYING so onwaiting isn't ignored
        (engine as any).intent = 'PLAYING';
        
        // [SOVEREIGNTY MOCK] Align src and sovereignUrl to satisfy isSovereign() audit
        const mockUrl = 'blob:mock-audio-data';
        mockAudioInstance.src = mockUrl;
        (engine as any).neuralStrategy.sovereignUrl = mockUrl;

        // 2. Simulate a stall (listeners are attached to mockAudioInstance by the engine)
        mockAudioInstance.onwaiting();
        expect(store.getState()?.playbackStalled).toBe(true);

        // 3. Simulate user clicking PAUSE
        engine.pause();

        // VERIFICATION: pause() calls releaseLock() which clears playbackStalled
        expect(store.getState()?.playbackStalled).toBe(false); 
    });

    it('FIX VERIFICATION: onwaiting should be ignored if intent is not PLAYING', async () => {
        // Default intent is STOPPED/PAUSED after pause()
        engine.pause();
        
        // This should be ignored now
        mockAudioInstance.onwaiting();
        
        expect(store.getState()?.playbackStalled).toBe(false);
    });

    it('SOVEREIGNTY VERIFICATION: remote sync should be blocked while optimistic intent is active', async () => {
        // 1. User clicks Play -> optimistic clearing
        store.optimisticPatch({ isPlaying: true, playbackStalled: false });
        expect(store.getState()?.playbackStalled).toBe(false);

        // 2. Delayed heartbeat from host (stalled) within 500ms
        store.updateState({
            playbackStalled: true,
            isPlaying: true,
            isPaused: false,
            currentSentenceIndex: 0,
            currentChapterIndex: 0,
            totalSentences: 10,
            totalChapters: 1,
            availableVoices: { local: [], neural: [] }
        } as unknown as UISyncPacket, 'remote');

        // VERIFICATION: playbackStalled is protected by INTENT_TIMEOUT
        expect(store.getState()?.playbackStalled).toBe(false);
    });
});
