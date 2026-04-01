/**
 * UIManager - Authoritative UI state reconciler for the Read Aloud dashboard.
 * Handles class toggling for animations and playback status.
 * TypeScript Module for type safety.
 */

export interface UIState {
    isPlaying: boolean;
    isPaused?: boolean;
    playbackStalled?: boolean;
}

export interface UIElements {
    btnPlay: HTMLElement;
    btnPause: HTMLElement;
    waveContainer?: HTMLElement;
}

export interface PlaybackControllerInterface {
    getState(): { isAwaitingSync: boolean };
}

export function reconcilePlaybackUI(
    state: UIState, 
    elements: UIElements, 
    controller: PlaybackControllerInterface
): void {
    const { btnPlay, btnPause, waveContainer } = elements;
    const isPlaying = state.isPlaying && !state.isPaused;
    const { isAwaitingSync } = controller.getState();
    
    // 1. Play/Pause Visibility
    btnPlay.style.display = isPlaying ? 'none' : 'flex';
    btnPause.style.display = isPlaying ? 'flex' : 'none';

    // 2. Loading Spinner Animation (Neural Synthesis / IPC Lock)
    // We apply .is-loading to whichever button is currently intended to be active
    const isLoading = isAwaitingSync || !!state.playbackStalled;
    
    // Always toggle on both to ensure a clean state transition
    btnPlay.classList.toggle('is-loading', isLoading);
    btnPause.classList.toggle('is-loading', isLoading);

    // 3. Sentence Navigator / Wave Pulsing (Stall Indicator)
    if (waveContainer) {
        waveContainer.classList.toggle('stalled', !!state.playbackStalled);
    }
}
