import { BaseComponent } from '../core/BaseComponent';
import { renderWithLinks } from '../utils';
import { PlaybackController } from '../playbackController';

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
}

/**
 * SentenceNavigator Component: Handles the 3-line sentence preview and jump logic.
 * Reactive to WebviewStore and delegates intents to PlaybackController.
 */
export class SentenceNavigator extends BaseComponent<SentenceNavigatorElements> {
    private state: SentenceNavigatorState = {
        sentences: [],
        currentIndex: -1,
        isStalled: false,
        isSpeaking: false
    };

    constructor(elements: SentenceNavigatorElements) {
        super(elements);

        // Subscribe to state changes
        this.subscribe((state) => state.currentSentences, (sentences) => {
            this.state.sentences = sentences || [];
            this.render();
        });

        this.subscribe((state) => state.currentSentenceIndex, (index) => {
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
     * Initializes event listeners for row-based jumping.
     */
    protected onMount(): void {
        this.registerEventListener(this.els.prev, 'click', () => {
            this.jump(this.state.currentIndex - 1);
        });
        this.registerEventListener(this.els.next, 'click', () => {
            this.jump(this.state.currentIndex + 1);
        });
    }

    /**
     * Triggers a jump to a specific sentence index via the Sovereign Head.
     */
    public jump(index: number): void {
        if (index < 0 || index >= this.state.sentences.length) {
            return;
        }

        // [DELEGATION] All authority moved to PlaybackController
        PlaybackController.getInstance().jumpToSentence(index);
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

        const displayIndex = this.state.currentIndex;
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
    }
}
