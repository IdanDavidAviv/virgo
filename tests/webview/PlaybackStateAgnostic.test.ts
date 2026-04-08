import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WebviewStore } from '../../src/webview/core/WebviewStore';
import { PlaybackControls } from '../../src/webview/components/PlaybackControls';
import { PlaybackController } from '../../src/webview/playbackController';
import { resetAllSingletons } from './testUtils';

/**
 * @vitest-environment jsdom
 */

describe('Playback State-Aware UI & Transition Grace (v2.3.1)', () => {
    let store: WebviewStore;
    let controls: PlaybackControls;
    let els: any;

    beforeEach(() => {
        // Mock DOM elements
        document.body.innerHTML = `
            <div id="btn-play" class="ctrl-btn primary"></div>
            <div id="btn-pause" class="ctrl-btn primary"></div>
            <div id="btn-stop" class="ctrl-btn"></div>
            <div id="wave-container"></div>
            <div id="status-dot"></div>
        `;

        els = {
            btnPlay: document.getElementById('btn-play'),
            btnPause: document.getElementById('btn-pause'),
            btnStop: document.getElementById('btn-stop'),
            waveContainer: document.getElementById('wave-container'),
            statusDot: document.getElementById('status-dot')
        };

        resetAllSingletons();
        store = WebviewStore.getInstance();
        
        // Initial authoritative hydration
        store.updateState({ 
            isPlaying: false, 
            isPaused: true, 
            playbackStalled: false,
            volume: 50,
            rate: 1,
            selectedVoice: 'test',
            isHandshakeComplete: true,
            state: {
                currentSentenceIndex: 0
            } as any
        }, 'local');

        controls = new PlaybackControls(els);
        controls.mount();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('PAUSE GESTURE: should switch icon immediately and NOT show spinner even if sync is pending', () => {
        // 1. Setup: Active playback
        store.patchState({ 
            playbackIntent: 'PLAYING',
            isPlaying: true, 
            isPaused: false 
        });
        controls.render();
        expect(els.btnPause.style.display).toBe('inline-block');

        // 2. User clicks Pause (Simulating optimistic patch)
        store.patchState({ 
            playbackIntent: 'PAUSED', 
            isAwaitingSync: true, 
            lastStallSource: 'USER',
            isPaused: true 
        });
        
        controls.render();

        // ICON should flip to Play immediately (Intent-driven: intent is PAUSED)
        expect(els.btnPlay.style.display).toBe('inline-block');
        expect(els.btnPause.style.display).toBe('none');
        // SPINNER should be HIDDEN because intent is PAUSED, even if sync is pending
        expect(els.btnPlay.classList.contains('is-loading')).toBe(false);
    });

    it('INITIAL PLAY: should show spinner IMMEDIATELY for user clicks (0ms grace)', () => {
        // 1. User clicks Play
        store.patchState({ 
            isPaused: false,
            playbackIntent: 'PLAYING',
            isAwaitingSync: true, 
            lastStallSource: 'USER' 
        }); 
        
        controls.render();

        // [ASSERT]: Icon should flip to Pause (Intent-driven: intent is PLAYING)
        expect(els.btnPause.style.display).toBe('inline-block');
        // [ASSERT]: Spinner should appear because intent=PLAYING but state.isPlaying=false
        expect(els.btnPause.classList.contains('is-loading')).toBe(true);
    });

    it('CONTINUOUS PLAY: should NOT flicker spinner during AUTO transitions (< 300ms)', () => {
        vi.useFakeTimers();
        
        // 1. Setup: Already playing
        store.patchState({ 
            isPlaying: true, 
            isPaused: false,
            playbackIntent: 'PLAYING'
        });
        vi.advanceTimersByTime(1000); // Clear the 'USER' intent frame
        
        // 2. Simulate AUTO-next (Awaiting sync)
        store.patchState({ isAwaitingSync: true, lastStallSource: 'AUTO' });
        
        controls.render();

        // [ASSERT]: Spinner should be SUPPRESSED during the initial grace period
        expect(els.btnPause.classList.contains('is-loading')).toBe(false);
    });

    it('STALL THRESHOLD: should show spinner only after 400ms grace period', () => {
        vi.useFakeTimers();
        
        // 1. Setup: Engine is transitioning to next segment (AUTO)
        store.patchState({ 
            isPaused: false,
            playbackIntent: 'PLAYING',
            isAwaitingSync: true, 
            lastStallSource: 'AUTO' 
        });
        
        // 2. Wait 400ms (Exactly at grace period)
        vi.advanceTimersByTime(400);
        controls.render();

        // [ASSERT]: Spinner should now appear for real stalls where isPlaying is false
        expect(els.btnPause.classList.contains('is-loading')).toBe(true);
    });
    
    it('RESPONSIVENESS: should allow user to pause even if button is in loading state', () => {
        const patchSpy = vi.spyOn(store, 'patchState');
        
        // 1. Setup: Intended to play, but engine is stalled (isPlaying=false)
        store.patchState({ 
            isPaused: false,
            playbackIntent: 'PLAYING', 
            isAwaitingSync: true, 
            lastStallSource: 'USER' 
        }); // 0ms grace
        
        controls.render();
        expect(els.btnPause.style.display).toBe('inline-block');
        expect(els.btnPause.classList.contains('is-loading')).toBe(true);
        
        // 2. User clicks Pause (despite the spinner)
        els.btnPause.click();
        
        // [ASSERT]: The click handler MUST be triggered regardless of the loading class
        expect(patchSpy).toHaveBeenCalledWith(expect.objectContaining({ isPaused: true }));
    });

    it('STABILITY: should ensure primary controls have consistent identifying classes', () => {
        // Toggle to Play
        store.patchState({ isPlaying: false });
        controls.render();
        expect(els.btnPlay.classList.contains('primary')).toBe(true);
        
        // Simulating pause intent
        store.patchState({ 
            playbackIntent: 'PAUSED',
            isPlaying: true, 
            isPaused: true 
        });
        controls.render();
        expect(els.btnPause.classList.contains('primary')).toBe(true);
    });
});
