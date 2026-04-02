import { BaseComponent } from '../core/BaseComponent';
import { WebviewStore } from '../core/WebviewStore';
import { MessageClient } from '../core/MessageClient';
import { OutgoingAction } from '../../common/types';

export interface PlaybackControlsElements extends Record<string, HTMLElement | null> {
    btnPlay: HTMLElement | null;
    btnPause: HTMLElement | null;
    btnStop: HTMLElement | null;
    btnPrev: HTMLElement | null;
    btnNext: HTMLElement | null;
    btnPrevSentence: HTMLElement | null;
    btnNextSentence: HTMLElement | null;
    btnAutoplay: HTMLElement | null;
    waveContainer: HTMLElement | null;
    statusDot: HTMLElement | null;
}

/**
 * PlaybackControls Component: Manages the transport control buttons (Play/Pause/Stop/Skip)
 * and the Autoplay mode cycling logic.
 */
export class PlaybackControls extends BaseComponent<PlaybackControlsElements> {
    constructor(elements: PlaybackControlsElements) {
        super(elements);

        // Subscriptions
        this.subscribe((state) => state.isPlaying, () => this.render());
        this.subscribe((state) => state.isPaused, () => this.render());
        this.subscribe((state) => state.playbackStalled, () => this.render());
        this.subscribeUI((state) => state.isAwaitingSync, () => this.render());
        this.subscribe((state) => state.autoPlayMode, (mode) => this.updateAutoPlayUI(mode));
    }

    /**
     * Initializes event listeners for all control buttons.
     */
    public mount(): void {
        const {
            btnPlay, btnPause, btnStop,
            btnPrev, btnNext,
            btnPrevSentence, btnNextSentence,
            btnAutoplay, waveContainer
        } = this.els;

        const client = MessageClient.getInstance();

        if (btnPlay) {
            btnPlay.onclick = () => {
                const state = WebviewStore.getInstance().getState();
                const currentUri = state?.state?.activeDocumentUri || null;
                // We still use the shared controller instance for its internal state/watchdog
                // but we could eventually move it all here.
                (window as any).readAloudController?.play(currentUri);
            };
        }
        if (btnPause) { btnPause.onclick = () => (window as any).readAloudController?.pause(); }
        if (btnStop) { btnStop.onclick = () => (window as any).readAloudController?.stop(); }

        // Navigation (Debounced at the component/client level)
        if (btnPrev) { btnPrev.onclick = () => client.postAction(OutgoingAction.PREV_CHAPTER); }
        if (btnNext) { btnNext.onclick = () => client.postAction(OutgoingAction.NEXT_CHAPTER); }
        if (btnPrevSentence) { btnPrevSentence.onclick = () => client.postAction(OutgoingAction.PREV_SENTENCE); }
        if (btnNextSentence) { btnNextSentence.onclick = () => client.postAction(OutgoingAction.NEXT_SENTENCE); }

        if (btnAutoplay) {
            btnAutoplay.onclick = () => this.cycleAutoPlayMode();
        }
    }

    /**
     * Authoritative render logic for transport buttons and animations.
     */
    public render(): void {
        const { btnPlay, btnPause, waveContainer, statusDot } = this.els;
        const mainStore = WebviewStore.getInstance();
        const state = mainStore.getState();
        const { isAwaitingSync } = mainStore.getUIState();
        
        if (!state) { return; }

        const isPlaying = state.isPlaying;
        const isPaused = state.isPaused;
        const isStalled = !!state.playbackStalled;
        const isActuallyActive = isPlaying && !isPaused;

        // 1. Play/Pause Visibility
        if (btnPlay) {
            btnPlay.style.display = isActuallyActive ? 'none' : 'inline-block';
        }
        if (btnPause) {
            btnPause.style.display = isActuallyActive ? 'inline-block' : 'none';
        }

        // 2. Loading State (Sync Lock / Buffer Stall)
        const isLoading = isAwaitingSync || isStalled;
        if (btnPlay) { btnPlay.classList.toggle('is-loading', isLoading); }
        if (btnPause) { btnPause.classList.toggle('is-loading', isLoading); }

        // 3. Wave Container Stall Indicator
        if (waveContainer) {
            waveContainer.classList.toggle('stalled', isStalled);
        }

        // 4. Status Dot — engine health indicator (legacy: engineStatusTag)
        if (statusDot) {
            statusDot.classList.toggle('online', isActuallyActive);
            statusDot.classList.toggle('stalled', isStalled);
            statusDot.classList.remove('fallback'); // reserved for future local-engine fallback
        }
    }

    /**
     * Cycles through Autoplay modes: AUTO -> 1 CHAPTER -> 1 ROW -> AUTO.
     */
    private cycleAutoPlayMode(): void {
        const currentMode = WebviewStore.getInstance().getState()?.autoPlayMode || 'auto';
        let nextMode: 'auto' | 'chapter' | 'row' = 'auto';

        if (currentMode === 'auto') {
            nextMode = 'chapter';
        } else if (currentMode === 'chapter') {
            nextMode = 'row';
        } else {
            nextMode = 'auto';
        }

        MessageClient.getInstance().postAction(OutgoingAction.SET_AUTO_PLAY_MODE, { mode: nextMode });
    }

    /**
     * Updates the Autoplay button text and visual classes based on current mode.
     */
    private updateAutoPlayUI(mode: 'auto' | 'chapter' | 'row'): void {
        const { btnAutoplay } = this.els;
        if (!btnAutoplay) { return; }

        btnAutoplay.classList.remove('mode-auto', 'mode-chapter', 'mode-row');

        switch (mode) {
            case 'chapter':
                btnAutoplay.textContent = '1 CH';
                btnAutoplay.classList.add('active', 'mode-chapter');
                break;
            case 'row':
                btnAutoplay.textContent = '1 ROW';
                btnAutoplay.classList.add('active', 'mode-row');
                break;
            case 'auto':
            default:
                btnAutoplay.textContent = 'AUTO';
                btnAutoplay.classList.add('active', 'mode-auto');
                break;
        }
    }
}
