import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WebviewStore } from '../../src/webview/core/WebviewStore';
import { PlaybackControls } from '../../src/webview/components/PlaybackControls';
import { PlaybackController } from '../../src/webview/playbackController';

/**
 * @vitest-environment jsdom
 */

describe('Playback State-Aware UI & Transition Grace (RED PHASE)', () => {
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

        WebviewStore.resetInstance();
        PlaybackController.resetInstance();
        store = WebviewStore.getInstance();
        
        // Initial hydration
        store.optimisticPatch({ 
            isPlaying: false, 
            isPaused: true, 
            playbackStalled: false 
        });

        controls = new PlaybackControls(els);
        controls.mount();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('PAUSE GESTURE: should switch icon immediately and NOT show spinner even if sync is pending', () => {
        // 1. Setup: Active playback
        store.optimisticPatch({ isPlaying: true, isPaused: false });
        expect(els.btnPause.style.display).toBe('inline-block');

        // 2. User clicks Pause (Simulating optimistic patch)
        store.updateUIState({ isAwaitingSync: true });
        store.optimisticPatch({ isPaused: true });

        // ICON should flip to Play immediately (Intent-driven: intent is PAUSED)
        expect(els.btnPlay.style.display).toBe('inline-block');
        expect(els.btnPause.style.display).toBe('none');
        // SPINNER should be HIDDEN because intent is PAUSED, even if sync is pending
        expect(els.btnPlay.classList.contains('is-loading')).toBe(false);
    });

    it('INITIAL PLAY: should show spinner IMMEDIATELY for user clicks (0ms grace)', () => {
        // 1. User clicks Play
        // [REALISM]: Initially, engine is NOT playing (isPlaying=false).
        // This patch sets intent=PLAYING but leaves state.isPlaying=false.
        store.optimisticPatch({ isPaused: false }); 
        store.updateUIState({ isAwaitingSync: true }); 
        
        controls.render();

        // [ASSERT]: Icon should flip to Pause (Intent-driven: intent is PLAYING)
        expect(els.btnPause.style.display).toBe('inline-block');
        // [ASSERT]: Spinner should appear because intent=PLAYING but state.isPlaying=false
        expect(els.btnPause.classList.contains('is-loading')).toBe(true);
    });

    it('CONTINUOUS PLAY: should NOT flicker spinner during AUTO transitions (< 300ms)', () => {
        vi.useFakeTimers();
        
        // 1. Setup: Already playing (User started it long ago)
        store.optimisticPatch({ isPlaying: true, isPaused: false });
        vi.advanceTimersByTime(1000); // Clear the 'USER' intent frame
        
        // 2. Simulate AUTO-next (Awaiting sync)
        store.updateUIState({ isAwaitingSync: true });
        // NOTE: updateUIState now sets lastStallSource='AUTO' by default if not coming from optimisticPatch
        
        controls.render();

        // [ASSERT]: Spinner should be SUPPRESSED during the initial grace period
        expect(els.btnPause.classList.contains('is-loading')).toBe(false);
    });

    it('STALL THRESHOLD: should show spinner only after 300ms grace period', () => {
        vi.useFakeTimers();
        
        // 1. Setup: User intended to play, but engine is NOT yet playing (or stalled to a stop)
        store.optimisticPatch({ isPaused: false });
        store.updateUIState({ isAwaitingSync: true, lastStallSource: 'AUTO' });
        
        // 2. Wait 400ms (Beyond grace period)
        vi.advanceTimersByTime(400);
        controls.render();

        // [ASSERT]: Spinner should now appear for real stalls where isPlaying is false
        expect(els.btnPause.classList.contains('is-loading')).toBe(true);
    });
    
    it('RESPONSIVENESS: should allow user to pause even if button is in loading state', () => {
        const optimisticSpy = vi.spyOn(store, 'optimisticPatch');
        
        // 1. Setup: Intended to play, but engine is stalled (isPlaying=false)
        store.optimisticPatch({ isPaused: false });
        store.updateUIState({ 
            playbackIntent: 'PLAYING', 
            isAwaitingSync: true, 
            lastStallSource: 'USER' 
        }); // 0ms grace
        
        controls.render();
        expect(els.btnPause.style.display).toBe('inline-block');
        expect(els.btnPause.classList.contains('is-loading')).toBe(true);
        
        // 2. User clicks Pause (despite the spinner)
        els.btnPause.onclick();
        
        // [ASSERT]: The click handler MUST be triggered regardless of the loading class
        expect(optimisticSpy).toHaveBeenCalledWith(expect.objectContaining({ isPaused: true }), expect.anything());
    });

    it('ACTIVE BLOCKING: should NOT show spinner if isPlaying is true, even if stalled/syncing for 2s', () => {
        vi.useFakeTimers();
        // [SCENARIO]: User is listening to sentence 1. Sentence 2 is requested. 
        // We are 'stalled' (awaiting sync) but sentence 1 is still playing.
        // We WANT the solid Pause button to stay, NOT show a spinner.

        // 1. Setup: State reflects active playback
        store.optimisticPatch({ isPlaying: true, isPaused: false });
        store.updateUIState({ isAwaitingSync: true, lastStallSource: 'AUTO' });
        
        // Wait 2 seconds (beyond grace period)
        vi.advanceTimersByTime(2000);
        
        controls.render();
        
        // [ASSERT]: Spinner should be BLOCKED because isPlaying is true
        expect(els.btnPause.classList.contains('is-loading')).toBe(false);
    });

    it('STABILITY: should ensure primary controls have consistent identifying classes', () => {
        // Enforce the 'primary' class for the Play/Pause toggles
        // Our CSS fix relies on .ctrl-btn.primary having min-width
        
        // Toggle to Play
        store.optimisticPatch({ isPlaying: false });
        controls.render();
        expect(els.btnPlay.classList.contains('primary')).toBe(true);
        
        // Toggle to Pause
        store.optimisticPatch({ isPlaying: true, isPaused: false });
        controls.render();
        expect(els.btnPause.classList.contains('primary')).toBe(true);
    });
});
