/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebviewAudioEngine } from '@webview/core/WebviewAudioEngine';
import { WebviewStore } from '@webview/core/WebviewStore';

describe('Playback Sovereignty: Stall Suppression (TDD)', () => {
    let engine: WebviewAudioEngine;
    let store: WebviewStore;

    beforeEach(() => {
        vi.clearAllMocks();
        WebviewStore.resetInstance();
        WebviewAudioEngine.resetInstance();
        
        store = WebviewStore.getInstance();
        (store as any)._isHydrated = true;
        engine = WebviewAudioEngine.getInstance();
        
        // Hydrate store with a base state
        const basePacket: any = {
            state: {
                activeDocumentUri: 'test_uri',
                activeFileName: 'test.md',
                playbackState: 'STOPPED',
                playbackRate: 1,
                playbackVolume: 50,
                autoPlayMode: 'auto'
            },
            isPlaying: false,
            isPaused: true,
            playbackStalled: false,
            currentChapterIndex: 0
        };
        
        // Use updateState directly to ensure initialization
        (store as any).updateState(basePacket, 'remote');
    });

    it('SHOULD suppress playbackStalled UI when audio is actively playing', async () => {
        // 1. Initial State: Playing
        const playSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
        const pauseSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'pause');
        
        // Mock audio.paused to return false (playing)
        Object.defineProperty(window.HTMLMediaElement.prototype, 'paused', {
            get: () => false,
            configurable: true
        });

        // 2. Trigger Synthesis (Background pre-fetch)
        engine.startAdaptiveWait('test_key', 123);
        
        // 3. Wait for Adaptive Wait to expire (40ms + safety)
        await new Promise(resolve => setTimeout(resolve, 100));

        // 4. VERIFY: playbackStalled remains false
        const state = store.getState();
        console.log('DEBUG: Final State (Playing):', JSON.stringify(state));
        expect(state).toBeDefined();
        expect(state?.playbackStalled).toBe(false);
    });

    it('SHOULD allow playbackStalled UI when audio is paused/stopped', async () => {
        // 1. Initial State: Paused
        Object.defineProperty(window.HTMLMediaElement.prototype, 'paused', {
            get: () => true,
            configurable: true
        });

        // 2. Trigger Synthesis
        engine.setTarget('test_key'); // [SOVEREIGNTY] Identify this key as the playback target
        engine.startAdaptiveWait('test_key', 456);
        
        // 3. Wait for Adaptive Wait to expire
        await new Promise(resolve => setTimeout(resolve, 100));

        // 4. VERIFY: playbackStalled becomes true
        const state = store.getState();
        console.log('DEBUG: Final State (Paused):', JSON.stringify(state));
        expect(state).toBeDefined();
        expect(state?.playbackStalled).toBe(true);
    });
});
