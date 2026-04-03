import { BaseComponent } from '../core/BaseComponent';
import { WebviewStore } from '../core/WebviewStore';
import { MessageClient } from '../core/MessageClient';
import { OutgoingAction } from '../../common/types';
import { WebviewAudioEngine } from '../core/WebviewAudioEngine';
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
                WebviewAudioEngine.getInstance().ensureAudioContext();
                PlaybackController.getInstance().play(WebviewStore.getInstance().getSentenceKey());
            };
        }
        if (btnPause) {
            btnPause.onclick = () => {
                WebviewAudioEngine.getInstance().ensureAudioContext();
                PlaybackController.getInstance().pause();
            };
        }
        if (btnStop) {
            btnStop.onclick = () => {
                WebviewAudioEngine.getInstance().ensureAudioContext();
                PlaybackController.getInstance().stop();
            };
        }

        // Navigation (Debounced at the component/client level)
        if (btnPrev) {
            btnPrev.onclick = () => {
                WebviewAudioEngine.getInstance().ensureAudioContext();
                WebviewStore.getInstance().optimisticPatch({ isPaused: false }, { isAwaitingSync: true });
                client.postAction(OutgoingAction.PREV_CHAPTER);
            };
        }
        if (btnNext) {
            btnNext.onclick = () => {
                WebviewAudioEngine.getInstance().ensureAudioContext();
                WebviewStore.getInstance().optimisticPatch({ isPaused: false }, { isAwaitingSync: true });
                client.postAction(OutgoingAction.NEXT_CHAPTER);
            };
        }
        if (btnPrevSentence) {
            btnPrevSentence.onclick = () => {
                WebviewAudioEngine.getInstance().ensureAudioContext();
                WebviewStore.getInstance().optimisticPatch({ isPaused: false }, { isAwaitingSync: true });
                client.postAction(OutgoingAction.PREV_SENTENCE);
            };
        }
        if (btnNextSentence) {
            btnNextSentence.onclick = () => {
                WebviewAudioEngine.getInstance().ensureAudioContext();
                WebviewStore.getInstance().optimisticPatch({ isPaused: false }, { isAwaitingSync: true });
                client.postAction(OutgoingAction.NEXT_SENTENCE);
            };
        }

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
        
        if (!state) { 
            return; 
        }

        const { playbackIntent, lastStallAt, lastStallSource } = mainStore.getUIState();
        const isStalled = !!state.playbackStalled;
        
        // V1.5.4 Optimized: Intent-driven activity detection (Screamingly fast icon flip)
        const isActuallyActive = (playbackIntent === 'PLAYING');

        // 1. Play/Pause Visibility
        if (btnPlay) {
            btnPlay.style.display = isActuallyActive ? 'none' : 'inline-block';
        }
        if (btnPause) {
            btnPause.style.display = isActuallyActive ? 'inline-block' : 'none';
        }

        // [REINFORCEMENT] Restrict loading to Play/Pause (Conforming to legacy dashboard way)
        const { isSyncing } = mainStore.getUIState();
        const isAudiblyPlaying = !!state.isPlaying;
        [btnPlay, btnPause].forEach(btn => {
            if (btn) {
                // Fix: Suppress spinner if audio is actually audible (parity with dashboard.js behavior)
                const showLoading = isSyncing && !isAudiblyPlaying;
                btn.classList.toggle('is-loading', showLoading);
            }
        });

        // 3. Wave Container Stall & Speaking Indicators
        if (waveContainer) {
            waveContainer.classList.toggle('speaking', isActuallyActive);
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
