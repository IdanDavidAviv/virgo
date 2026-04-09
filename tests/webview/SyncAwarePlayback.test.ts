/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WebviewStore } from '@webview/core/WebviewStore';
import { PlaybackControls } from '@webview/components/PlaybackControls';
import { PlaybackController } from '@webview/playbackController';
import { WebviewAudioEngine } from '@webview/core/WebviewAudioEngine';
import { CommandDispatcher } from '@webview/core/CommandDispatcher';
import { IncomingCommand } from '@common/types';
import { resetAllSingletons, wireDispatcher, FULL_DOM_TEMPLATE } from './testUtils';

describe('Simplified Sync Playback UI', () => {
    vi.setConfig({ testTimeout: 10000 });
    let store: WebviewStore;
    let controls: PlaybackControls;
    let mockEls: any;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = FULL_DOM_TEMPLATE;
        
        resetAllSingletons();
        wireDispatcher();
        
        store = WebviewStore.getInstance();
        (store as any)._isHydrated = true;

        // Mock Engine to avoid actual audio calls
        const engine = WebviewAudioEngine.getInstance();
        const audioElement = engine.audioElement;
        vi.spyOn(audioElement, 'play').mockImplementation(function(this: HTMLMediaElement) {
            // [v2.3.2] Safe dispatch to avoid JSDOM race conditions
            const target = this || audioElement;
            setTimeout(() => {
                if (target && typeof target.dispatchEvent === 'function') {
                    target.dispatchEvent(new Event('ended'));
                }
            }, 0);
            return Promise.resolve();
        });
        vi.spyOn(engine, 'ensureAudioContext').mockImplementation(async () => {});
        vi.spyOn(engine, 'playFromCache').mockResolvedValue(true);

        // Mock Elements
        mockEls = {
            btnPlay: document.createElement('button'),
            btnPause: document.createElement('button'),
            btnNext: document.createElement('button'),
            btnPrev: document.createElement('button'),
            btnPrevSentence: document.createElement('button'),
            btnNextSentence: document.createElement('button'),
            waveContainer: document.createElement('div'),
            statusDot: document.createElement('div'),
        };

        controls = new PlaybackControls(mockEls);
        controls.mount();
        
        // Initial Store State with high-density mockup
        store.updateState({ 
            isPlaying: false, 
            isPaused: false, 
            playbackStalled: false,
            availableVoices: { local: [], neural: [] },
            selectedVoice: 'test-voice',
            currentChapterIndex: 0, 
            currentSentenceIndex: 0,
            focusedFileName: 'test.md',
            focusedRelativeDir: '/docs',
            focusedDocumentUri: 'file:///test.md',
            focusedIsSupported: true,
            activeFileName: 'test.md',
            activeRelativeDir: '/docs',
            activeDocumentUri: 'file:///test.md',
            versionSalt: '1',
            focusedVersionSalt: '1',
            allChapters: [{ title: 'Chapter 1', level: 1, index: 0, count: 1 }],
            isHydrated: true
        }, 'local');
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('should reflect isAwaitingSync immediately on PlaybackController trigger', async () => {
        // User clicks Play via Controller (Sovereign Head)
        PlaybackController.getInstance().play();
        
        // UI and Store should show loading immediately (Optimistic state set by Controller)
        expect(store.isSyncing).toBe(true);
        controls.render(); 
        expect(mockEls.btnPlay.classList.contains('is-loading')).toBe(true);
        
        // Remote sync arrives via UI_SYNC command
        await CommandDispatcher.getInstance().dispatch(IncomingCommand.UI_SYNC, {
            ...store.getState(),
            isPlaying: true,
            isPaused: false,
            playbackStalled: false,
            currentSentenceIndex: 0,
            currentSentences: ['Test'],
            totalChapters: 1,
            availableVoices: { local: [], neural: [] },
            isHydrated: true
        });

        expect(store.isSyncing).toBe(false);
        controls.render();
        expect(mockEls.btnPlay.classList.contains('is-loading')).toBe(false);
    });

    it('should apply loading classes and respect grace periods (Stall Logic)', async () => {
        // 1. User Action (Instant Loading)
        PlaybackController.getInstance().play();
        expect(store.isSyncing).toBe(true);
        controls.render();
        expect(mockEls.btnPlay.classList.contains('is-loading')).toBe(true);

        // 2. Playback Starts (Clears Loading from Sync)
        await CommandDispatcher.getInstance().dispatch(IncomingCommand.UI_SYNC, {
            ...store.getState(),
            isPlaying: true,
            isPaused: false,
            playbackStalled: false,
            currentSentenceIndex: 0,
            currentSentences: ['Test'],
            totalChapters: 1,
            availableVoices: { local: [], neural: [] }
        });
        
        controls.render();
        expect(mockEls.btnPlay.classList.contains('is-loading')).toBe(false);

        // 3. Background Engine Stall 
        await CommandDispatcher.getInstance().dispatch(IncomingCommand.UI_SYNC, {
            ...store.getState(),
            isPlaying: true,
            playbackStalled: true,
            availableVoices: { local: [], neural: [] }
        });
        
        // Wait for 401ms to ensure we are strictly past the 400ms grace period
        vi.advanceTimersByTime(401);
        
        // Explicitly render to catch the state change
        controls.render();
        expect(mockEls.btnPlay.classList.contains('is-loading')).toBe(true);
    });
});
