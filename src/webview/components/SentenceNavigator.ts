import { BaseComponent } from '../core/BaseComponent';
import { MessageClient } from '../core/MessageClient';
import { OutgoingAction } from '../../common/types';
import { renderWithLinks } from '../utils';
import { WebviewAudioEngine } from '../core/WebviewAudioEngine';

export interface SentenceNavigatorElements extends Record<string, HTMLElement | null> {
    navigator: HTMLElement | null;
    prev: HTMLElement | null;
    current: HTMLElement | null;
    next: HTMLElement | null;
}

export interface SentenceNavigatorState {
    sentences: string[];
    currentIndex: number;
    isStalled: boolean;
    isSpeaking: boolean;
    pendingIndex: number;
    pendingTimer: any | null;
}

/**
 * SentenceNavigator Component: Handles the 3-line sentence preview and jump logic.
 * Reactive to WebviewStore and emits commands via MessageClient.
 */
export class SentenceNavigator extends BaseComponent<SentenceNavigatorElements> {
    private state: SentenceNavigatorState = {
        sentences: [],
        currentIndex: -1,
        isStalled: false,
        isSpeaking: false,
        pendingIndex: -1,
        pendingTimer: null
    };

    constructor(elements: SentenceNavigatorElements) {
        super(elements);

        // Subscribe to state changes
        this.subscribe((state) => state.currentSentences, (sentences) => {
            this.state.sentences = sentences || [];
            this.render();
        });

        this.subscribe((state) => state.state.currentSentenceIndex, (index) => {
            // Ignore sync if we're waiting for a jump confirmation
            if (this.state.pendingIndex !== -1 && index !== this.state.pendingIndex) {
                return;
            }
            this.clearPending();
            this.state.currentIndex = index;
            this.render();
        });

        this.subscribe((state) => state.playbackStalled, (isStalled) => {
            this.state.isStalled = !!isStalled;
            this.render();
        });

        this.subscribe((state) => ({ isPlaying: state.isPlaying, isPaused: state.isPaused }), (playback) => {
            this.state.isSpeaking = playback.isPlaying && !playback.isPaused;
            this.render();
        });
    }

    /**
     * Triggers a jump to a specific sentence index.
     */
    public jump(index: number): void {
        if (index < 0 || index >= this.state.sentences.length) {
            return;
        }

        this.state.pendingIndex = index;
        this.render(); // Immediate feedback

        const client = MessageClient.getInstance();
        WebviewAudioEngine.getInstance().prepareForPlayback();
        client.postAction(OutgoingAction.JUMP_TO_SENTENCE, { index });

        // Safety fallback: if extension doesn't confirm in 1s, snap back to reality
        if (this.state.pendingTimer) {
            clearTimeout(this.state.pendingTimer);
        }
        this.state.pendingTimer = setTimeout(() => {
            if (this.state.pendingIndex !== -1) {
                this.state.pendingIndex = -1;
                this.render();
            }
        }, 1000);
    }

    private clearPending(): void {
        this.state.pendingIndex = -1;
        if (this.state.pendingTimer) {
            clearTimeout(this.state.pendingTimer);
            this.state.pendingTimer = null;
        }
    }

    /**
     * Authoritative render logic for the navigator rows.
     */
    public render(): void {
        const { navigator, prev, current, next } = this.els;
        if (!navigator) { 
            this.log('Missing navigator element, skipping render', 'warn');
            return; 
        }

        const displayIndex = this.state.pendingIndex !== -1 ? this.state.pendingIndex : this.state.currentIndex;
        const sentences = this.state.sentences;

        this.log(`Rendering Row: ${displayIndex} | Total: ${sentences.length}`);

        navigator.classList.toggle('stalled', this.state.isStalled);

        const prevIdx = displayIndex - 1;
        const nextIdx = displayIndex + 1;

        this.renderRow(prev, prevIdx >= 0 ? sentences[prevIdx] : '', prevIdx);
        
        let currentText = displayIndex >= 0 ? sentences[displayIndex] : '';
        if (!currentText && sentences.length === 0) {
            currentText = 'READY TO START READING';
        }
        
        this.renderRow(current, currentText, displayIndex, true);
        this.renderRow(next, nextIdx < sentences.length ? sentences[nextIdx] : '', nextIdx);
    }

    private renderRow(el: HTMLElement | null, text: string, idx: number, isCurrent = false): void {
        if (!el) { return; }
        
        if (!text) {
            el.innerHTML = '<span class="sentence-placeholder">&nbsp;</span>';
            el.onclick = null;
            el.style.pointerEvents = 'none';
            el.style.opacity = '0';
            return;
        }

        el.style.display = 'flex';
        el.style.pointerEvents = 'auto';
        el.style.opacity = isCurrent ? '1' : '0.15';
        el.classList.toggle('current', isCurrent);
        el.classList.toggle('speaking', isCurrent && this.state.isSpeaking);
        el.classList.toggle('stalled', isCurrent && this.state.isStalled);

        // RTL Detection
        const isHebrew = /[\u0590-\u05FF]/.test(text);
        el.classList.toggle('rtl', isHebrew);

        el.innerHTML = `<span>${renderWithLinks(text)}</span>`;

        if (idx !== -1 && !isCurrent) {
            el.onclick = () => this.jump(idx);
        } else {
            el.onclick = null;
        }
    }
}
