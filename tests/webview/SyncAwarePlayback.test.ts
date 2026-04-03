/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WebviewStore } from '../../src/webview/core/WebviewStore';
import { PlaybackControls } from '../../src/webview/components/PlaybackControls';

describe('Simplified Sync Playback UI', () => {
  let store: WebviewStore;
  let controls: PlaybackControls;
  let mockEls: any;

  beforeEach(() => {
    // Enable fake timers for controllable grace periods
    vi.useFakeTimers();
    
    // Clean environment
    document.body.innerHTML = '';
    WebviewStore.resetInstance();
    store = WebviewStore.getInstance();

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
    
    // Initial Store State
    store.updateState({ isPlaying: false, isPaused: false, playbackStalled: false }, 'remote');
  });

  afterEach(() => {
    WebviewStore.resetInstance();
    vi.useRealTimers();
  });

  it('should reflect isAwaitingSync immediately on optimistic patch', () => {
    // User clicks Play
    store.optimisticPatch({ isPaused: false }, { isAwaitingSync: true });
    
    // UI and Store should show loading immediately
    expect(store.getUIState().isSyncing).toBe(true);
    controls.render();
    expect(mockEls.btnPlay.classList.contains('is-loading')).toBe(true);
    
    // Remote sync arrives
    store.updateState({ isPlaying: true, isPaused: false }, 'remote');
    expect(store.getUIState().isSyncing).toBe(false);
    controls.render();
    expect(mockEls.btnPlay.classList.contains('is-loading')).toBe(false);
  });

  it('should apply loading classes and respect grace periods', () => {
    // 1. User Action (Instant Loading)
    store.optimisticPatch({ isPaused: false }, { isAwaitingSync: true });
    expect(store.getUIState().isSyncing).toBe(true);
    controls.render();
    expect(mockEls.btnPlay.classList.contains('is-loading')).toBe(true);

    // 2. Playback Starts (Clears Loading)
    store.updateState({ isPlaying: true, isPaused: false, playbackStalled: false }, 'remote');
    controls.render();
    expect(mockEls.btnPlay.classList.contains('is-loading')).toBe(false);

    // [IMPORTANT] Advance time past the Intent Sovereignty Guard (500ms)
    // This ensures subsequent 'remote' packets are not blocked by the optimistic patch.
    vi.advanceTimersByTime(1000);

    // 3. Background Engine Stall (400ms grace period)
    store.updateState({ isPlaying: true, playbackStalled: true }, 'remote');
    
    // Should NOT show immediately
    expect(store.getUIState().isSyncing).toBe(false);
    controls.render();
    expect(mockEls.btnPlay.classList.contains('is-loading')).toBe(false);

    // Advance time by 500ms
    vi.advanceTimersByTime(500);
    
    // Should show after 400ms
    expect(store.getUIState().isSyncing).toBe(true);
    controls.render();
    expect(mockEls.btnPlay.classList.contains('is-loading')).toBe(true);
    
    // 4. Stall Clears
    store.updateState({ isPlaying: true, playbackStalled: false }, 'remote');
    controls.render();
    expect(mockEls.btnPlay.classList.contains('is-loading')).toBe(false);
  });
});
