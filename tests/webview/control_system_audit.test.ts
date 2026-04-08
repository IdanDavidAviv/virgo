/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlaybackControls } from '../../src/webview/components/PlaybackControls';
import { WebviewStore } from '../../src/webview/core/WebviewStore';
import { MessageClient } from '../../src/webview/core/MessageClient';
import { CommandDispatcher } from '../../src/webview/core/CommandDispatcher';
import { IncomingCommand, OutgoingAction } from '../../src/common/types';
import { WebviewAudioEngine } from '../../src/webview/core/WebviewAudioEngine';
import { CacheManager } from '../../src/webview/cacheManager';


describe('Control System Audit (Reproduction)', () => {
    let elements: any;
    let postMessageSpy: any;

    beforeEach(() => {
        document.body.innerHTML = `
            <button id="btn-play">Play</button>
            <button id="btn-pause">Pause</button>
            <button id="btn-stop">Stop</button>
            <button id="btn-autoplay">AUTO</button>
            <div id="wave-container"></div>
            <span id="status-dot"></span>
        `;
        elements = {
            btnPlay: document.getElementById('btn-play'),
            btnPause: document.getElementById('btn-pause'),
            btnStop: document.getElementById('btn-stop'),
            btnAutoplay: document.getElementById('btn-autoplay'),
            waveContainer: document.getElementById('wave-container'),
            statusDot: document.getElementById('status-dot')
        };

        // Mock VS Code API
        postMessageSpy = vi.fn();
        (window as any).vscode = undefined; // CRITICAL: Clear existing instance
        (window as any).acquireVsCodeApi = vi.fn(() => ({
            postMessage: postMessageSpy
        }));

        MessageClient.resetInstance();
        WebviewStore.resetInstance();
        CommandDispatcher.resetInstance();
    });

    beforeEach(async () => {
        // [SOVEREIGNTY] Hydrate the store correctly via the authoritative handshake
        const dispatcher = CommandDispatcher.getInstance();
        await dispatcher.dispatch(IncomingCommand.UI_SYNC, {
            state: { currentChapterIndex: 0, currentSentenceIndex: 0 } as any,
            isPlaying: false,
            isPaused: false,
            autoPlayMode: 'auto',
            availableVoices: { local: [], neural: [] },
            cacheStats: { count: 0, size: 0 }
        } as any);
    });

    it('Play button should dispatch OutgoingAction.PLAY', () => {
        const ctrl = new PlaybackControls(elements);
        ctrl.mount();

        if (elements.btnPlay) {
            elements.btnPlay.click();
            expect(postMessageSpy).toHaveBeenCalledWith(expect.objectContaining({
                command: OutgoingAction.PLAY
            }));
        }
    });

    it('CORRUPTION REPRO: PLAYBACK_STATE_CHANGED with partial data should NOT wipe the store state', async () => {
        const dispatcher = CommandDispatcher.getInstance();
        const store = WebviewStore.getInstance();

        // Initial state is healthy
        expect(store.getState()!.state).toBeDefined();

        // Simulate a "snappy" update that only contains playback flags (common regression source)
        // Historically, speechProvider.ts sends: { command: 'playbackStateChanged', state: 'paused' } 
        // Or sometimes just partial flags.
        await dispatcher.dispatch(IncomingCommand.PLAYBACK_STATE_CHANGED, {
            isPlaying: true,
            isPaused: true
            // MISSING 'state' object!
        });

        // BUG REPRO: If missing 'state', handleUiSync currently sets store.state to undefined
        const finalState = store.getState();
        expect(finalState).not.toBeNull();
        if (finalState) {
            expect(finalState.state).toBeDefined(); // This SHOULD pass after fix
        }
    });

    it('Autoplay cycle should transition correctly: auto -> chapter -> row', () => {
        const ctrl = new PlaybackControls(elements);
        ctrl.mount();

        // Initial: auto
        expect(elements.btnAutoplay?.textContent).toBe('AUTO');

        // Click to cycle
        if (elements.btnAutoplay) {
            elements.btnAutoplay.click();
            expect(postMessageSpy).toHaveBeenCalledWith(expect.objectContaining({
                command: OutgoingAction.SET_AUTO_PLAY_MODE,
                mode: 'chapter'
            }));
        }
    });
    
    it('ZOMBIE FIX: playFromCache should NOT trigger the Zombie Guard', async () => {
        const engine = WebviewAudioEngine.getInstance();
        const consoleSpy = vi.spyOn(console, 'log');
        
        // 1. Mock cache to return a dummy blob
        const dummyBlob = new Blob(['abc'], { type: 'audio/mpeg' });
        vi.spyOn(CacheManager.getInstance(), 'get').mockResolvedValue(dummyBlob);
        
        // 2. Mock audio.play to avoid JSDOM errors
        const audioElement = engine.audioElement;
        vi.spyOn(audioElement, 'play').mockResolvedValue(undefined);

        // ACT: Trigger playback from cache
        // MUST set intent to PLAYING to pass controller intent guard
        const controller = (await import('../../src/webview/playbackController')).PlaybackController.getInstance();
        controller.handleSync({ isPlaying: true, isPaused: false } as any);
        
        await engine.playFromCache('test-key');

        // ASSERT: Zombie Guard should NOT fire anymore
        const zombieLog = consoleSpy.mock.calls.find(call => 
            typeof call[0] === 'string' && call[0].includes('🧟 Ignoring Zombie Audio')
        );

        expect(zombieLog).toBeUndefined(); 
    });


    it('IPC REPRO: VOICES command updates store', async () => {
        const dispatcher = CommandDispatcher.getInstance();
        const store = WebviewStore.getInstance();

        const testVoices = [{ name: 'Voice A', id: 'a' }];
        await dispatcher.dispatch(IncomingCommand.VOICES, {
            neuralVoices: testVoices
        });

        expect(store.getState()?.availableVoices?.neural).toEqual(testVoices);
    });

    it('IPC FIX: CACHE_STATS command updates store correctly', async () => {
        const dispatcher = CommandDispatcher.getInstance();
        const store = WebviewStore.getInstance();

        const stats = { count: 10, size: 1024 };

        // [BOOTSTRAP] Hydrate the store first (Regression Guard #2)
        await dispatcher.dispatch(IncomingCommand.UI_SYNC, {
            cacheCount: 0,
            cacheSizeBytes: 0,
            cacheStats: { count: 0, size: 0 }
        });

        await dispatcher.dispatch(IncomingCommand.CACHE_STATS, stats);

        expect((store.getState() as any).cacheCount).toBe(10);
        // [PARITY] Match the store's internal composite object structure
        expect((store.getState() as any).cacheStats).toEqual({ count: 10, size: 1024 });
    });

    it('REPRO: Clicking STOP should stop the local audio engine immediately', async () => {
        const engine = WebviewAudioEngine.getInstance();
        const stopSpy = vi.spyOn(engine, 'stop');
        const ctrl = new PlaybackControls(elements);
        ctrl.mount();

        if (elements.btnStop) {
            elements.btnStop.click();
            
            expect(postMessageSpy).toHaveBeenCalledWith(expect.objectContaining({
                command: OutgoingAction.STOP
            }));

            // VERIFICATION: Does the engine stop immediately?
            // If this fails, it means the webview is waiting for a command back from the host.
            expect(stopSpy).toHaveBeenCalled();
        }
    });

    it('PULL FIX: Cache Miss in Webview should trigger FETCH_AUDIO handshake (NOT immediate synthesis)', async () => {
        const engine = WebviewAudioEngine.getInstance();
        const dispatcher = CommandDispatcher.getInstance();
        const postActionSpy = vi.spyOn(MessageClient.getInstance(), 'postAction');
        
        // Mock cache to return null (MISS)
        vi.spyOn(CacheManager.getInstance(), 'get').mockResolvedValue(null);
        
        // 1. MUST set intent to PLAYING otherwise Zombie Guard blocks it
        engine.ensureAudioContext();
        const controller = (await import('../../src/webview/playbackController')).PlaybackController.getInstance();
        controller.handleSync({ isPlaying: true, isPaused: false } as any);
        
        await dispatcher.dispatch(IncomingCommand.PLAY_AUDIO, {
            cacheKey: 'missing-key'
            // NO data provided!
        });

        // The webview now triggers a Pull-handshake first to avoid loops
        expect(postActionSpy).toHaveBeenCalledWith(
            OutgoingAction.FETCH_AUDIO,
            expect.objectContaining({ cacheKey: 'missing-key' })
        );
    });
});

