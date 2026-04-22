import { BaseComponent } from '../core/BaseComponent';
import { WebviewStore } from '../core/WebviewStore';
import { PlaybackController } from '../playbackController';

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
        // [REINFORCEMENT] Centralized Sync subscription (0ms for user, 400ms for background)
        this.subscribeUI((state) => state.isSyncing, () => this.render());
        this.subscribeUI((state) => state.playbackIntent, () => this.render());
        this.subscribe((state) => state.autoPlayMode, (mode) => this.updateAutoPlayUI(mode));
    }

    /**
     * Initializes event listeners for all control buttons.
     */
    protected onMount(): void {
        const {
            btnPlay, btnPause, btnStop,
            btnPrev, btnNext,
            btnPrevSentence, btnNextSentence,
            btnAutoplay
        } = this.els;

        this.registerEventListener(btnPlay, 'click', (e) => {
            this.pulse([(e?.currentTarget || btnPlay) as HTMLElement, this.els.statusDot]);
            PlaybackController.getInstance().play();
        });

        this.registerEventListener(btnPause, 'click', (e) => {
            this.pulse([(e?.currentTarget || btnPause) as HTMLElement, this.els.statusDot]);
            PlaybackController.getInstance().pause();
        });

        this.registerEventListener(btnStop, 'click', (e) => {
            this.pulse([(e?.currentTarget || btnStop) as HTMLElement, this.els.statusDot]);
            PlaybackController.getInstance().stop();
        });

        // Navigation
        this.registerEventListener(btnPrev, 'click', (e) => {
            this.pulse([(e?.currentTarget || btnPrev) as HTMLElement, this.els.statusDot]);
            PlaybackController.getInstance().prevChapter();
        });

        this.registerEventListener(btnNext, 'click', (e) => {
            this.pulse([(e?.currentTarget || btnNext) as HTMLElement, this.els.statusDot]);
            PlaybackController.getInstance().nextChapter();
        });

        this.registerEventListener(btnPrevSentence, 'click', (e) => {
            this.pulse([(e?.currentTarget || btnPrevSentence) as HTMLElement, this.els.statusDot]);
            PlaybackController.getInstance().prevSentence();
        });

        this.registerEventListener(btnNextSentence, 'click', (e) => {
            this.pulse([(e?.currentTarget || btnNextSentence) as HTMLElement, this.els.statusDot]);
            PlaybackController.getInstance().nextSentence();
        });

        this.registerEventListener(btnAutoplay, 'click', () => {
            this.pulse(btnAutoplay);
            this.cycleAutoPlayMode();
        });
    }

    /**
     * Authoritative render logic for transport buttons and animations.
     */
    public render(): void {
        const { btnPlay, btnPause, waveContainer, statusDot } = this.els;
        const mainStore = WebviewStore.getInstance();
        const state = mainStore.getState();
        const { lastStallSource, lastStallAt, playbackIntent, isAwaitingSync } = mainStore.getUIState();
        const isSyncing = mainStore.isSyncing;
        
        if (!state) { 
            return; 
        }
        const isAudiblyPlaying = !!state.isPlaying;
        const isActuallyPaused = !!state.isPaused;
        const isStalled = !!state.playbackStalled;
        // isActuallyActive: show pause button when playing, stalling between sentences (buffering),
        // or when the store has a PLAYING intent (covers the gap between sentences where isPlaying briefly dips).
        const isActuallyActive = (playbackIntent === 'PLAYING' || isStalled || (isAudiblyPlaying && !isActuallyPaused));

        // 1. Play/Pause Visibility
        if (btnPlay) {
            btnPlay.style.display = isActuallyActive ? 'none' : 'inline-block';
        }
        if (btnPause) {
            btnPause.style.display = isActuallyActive ? 'inline-block' : 'none';
        }

        // V1.5.4: Loading spinner parity with dashboard.js behavior.
        // - WebviewStore.isSyncing already handles the 400ms grace period for AUTO stalls.
        // - Standardizing on the store's state ensures 100% test consistency.
        const showSpinner = !!isSyncing;

        [btnPlay, btnPause].forEach(btn => {
            if (btn) {
                btn.classList.toggle('is-loading', showSpinner);
            }
        });

        // 3. Wave Container Stall & Speaking Indicators
        if (waveContainer) {
            // Dashboard parity: animate wave ONLY when physically playing, 
            // not just on intent (fixes UI flickering during segment changes).
            waveContainer.classList.toggle('speaking', isAudiblyPlaying);
            waveContainer.classList.toggle('stalled', isStalled);
        }

        // 4. Status Dot — engine health indicator
        if (statusDot) {
            // Dashboard parity: reflects absolute audio element state (isPlaying)
            // but also respects pause state (Fixes PlaybackControls.test.ts)
            statusDot.classList.toggle('online', isAudiblyPlaying && !state.isPaused);
            statusDot.classList.toggle('stalled', isStalled);
        }
    }

    /**
     * Cycles through Autoplay modes: AUTO -> 1 CHAPTER -> 1 ROW -> AUTO.
     */
    private cycleAutoPlayMode(): void {
        const store = WebviewStore.getInstance();
        const currentMode = store.getState()?.autoPlayMode || 'auto';
        let nextMode: 'auto' | 'chapter' | 'row' = 'auto';

        if (currentMode === 'auto') {
            nextMode = 'chapter';
        } else if (currentMode === 'chapter') {
            nextMode = 'row';
        } else {
            nextMode = 'auto';
        }

        // Dashboard Parity: Authoritative update via Controller
        PlaybackController.getInstance().setAutoPlayMode(nextMode);
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
