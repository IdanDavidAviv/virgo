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
import { resetAllSingletons, wireDispatcher } from './testUtils';

describe('Simplified Sync Playback UI', () => {
    let store: WebviewStore;
    let controls: PlaybackControls;
    let mockEls: any;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
        
        resetAllSingletons();
        wireDispatcher();
        
        store = WebviewStore.getInstance();
        (store as any)._isHydrated = true;

        // Mock Engine to avoid actual audio calls
        const engine = WebviewAudioEngine.getInstance();
        vi.spyOn(engine, 'ensureAudioContext').mockImplementation(async () => {});
        vi.spyOn(engine, 'prepareForPlayback').mockImplementation(() => {});
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
            state: { 
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
                totalChapters: 1
            } as any
        }, 'remote');
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('should reflect isAwaitingSync immediately on PlaybackController trigger', async () => {
        // User clicks Play via Controller (Sovereign Head)
        PlaybackController.getInstance().play();
        
        // UI and Store should show loading immediately (Optimistic state set by Controller)
        expect(store.getUIState().isSyncing).toBe(true);
        controls.render(); 
        expect(mockEls.btnPlay.classList.contains('is-loading')).toBe(true);
        
        // Remote sync arrives via UI_SYNC command
        await CommandDispatcher.getInstance().dispatch(IncomingCommand.UI_SYNC, {
            state: { ...store.getState(), isPlaying: true, isPaused: false },
            isPlaying: true,
            isPaused: false,
            playbackStalled: false,
            currentSentenceIndex: 0,
            currentSentences: ['Test'],
            totalChapters: 1,
            availableVoices: { local: [], neural: [] }
        });

        expect(store.getUIState().isSyncing).toBe(false);
        controls.render();
        expect(mockEls.btnPlay.classList.contains('is-loading')).toBe(false);
    });

    it('should apply loading classes and respect grace periods (Stall Logic)', async () => {
        // 1. User Action (Instant Loading)
        PlaybackController.getInstance().play();
        expect(store.getUIState().isSyncing).toBe(true);
        controls.render();
        expect(mockEls.btnPlay.classList.contains('is-loading')).toBe(true);

        // 2. Playback Starts (Clears Loading from Sync)
        await CommandDispatcher.getInstance().dispatch(IncomingCommand.UI_SYNC, {
            state: { ...store.getState(), isPlaying: true, isPaused: false, playbackStalled: false },
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
            state: { ...store.getState(), isPlaying: true, playbackStalled: true },
            isPlaying: true,
            playbackStalled: true,
            availableVoices: { local: [], neural: [] }
        });
        
        // Wait for 400ms grace period to expire for background stall
        vi.advanceTimersByTime(400);

        controls.render();
        expect(mockEls.btnPlay.classList.contains('is-loading')).toBe(true);
    });
});
