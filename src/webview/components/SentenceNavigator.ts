import { BaseComponent } from '../core/BaseComponent';
import { renderWithLinks } from '../utils';
import { PlaybackController } from '../playbackController';
import { OutgoingAction } from '../../common/types';

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
    private currentChapterIndex: number = 0;
    private expandedTables: string[] = [];

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

        this.subscribe((state) => state.currentChapterIndex, (idx) => {
            this.currentChapterIndex = idx || 0;
            this.render();
        });

        this.subscribe((state) => state.expandedTables, (expanded) => {
            this.expandedTables = expanded || [];
            this.render();
        });
    }

    /**
     * Initializes event listeners for row-based jumping and table toggles.
     */
    protected onMount(): void {
        this.registerEventListener(this.els.prev, 'click', () => {
            const prevResult = this.getVisibleSentence('prev', this.state.currentIndex - 1);
            if (prevResult.index !== -1) {
                this.jump(prevResult.index);
            }
        });
        this.registerEventListener(this.els.next, 'click', () => {
            const nextResult = this.getVisibleSentence('next', this.state.currentIndex + 1);
            if (nextResult.index !== -1) {
                this.jump(nextResult.index);
            }
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
     * Helper to skip collapsed table cells and expanded table placeholders in UI prev/next previews.
     */
    private getVisibleSentence(dir: 'next' | 'prev', startIdx: number): { text: string; index: number } {
        const sentences = this.state.sentences;
        let idx = startIdx;
        const expandedSet = new Set(this.expandedTables);

        while (idx >= 0 && idx < sentences.length) {
            const text = sentences[idx];
            
            // Cell check
            const cellMatch = text.match(/^<!--VIRGO_TABLE_CELL:tableIndex=(\d+)/);
            if (cellMatch) {
                const tableIndex = cellMatch[1];
                const key = `${this.currentChapterIndex}:${tableIndex}`;
                if (!expandedSet.has(key)) {
                    idx = (dir === 'next') ? idx + 1 : idx - 1;
                    continue;
                }
            }

            // Placeholder check
            const tableMatch = text.match(/^<!--VIRGO_TABLE:{"tableIndex":(\d+)/);
            if (tableMatch) {
                const tableIndex = tableMatch[1];
                const key = `${this.currentChapterIndex}:${tableIndex}`;
                if (expandedSet.has(key)) {
                    idx = (dir === 'next') ? idx + 1 : idx - 1;
                    continue;
                }
            }

            return { text, index: idx };
        }
        return { text: '', index: -1 };
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

        const prevResult = this.getVisibleSentence('prev', displayIndex - 1);
        const nextResult = this.getVisibleSentence('next', displayIndex + 1);

        this.renderRow(prev, prevResult.text, prevResult.index);
        
        let currentText = displayIndex >= 0 ? sentences[displayIndex] : '';
        if (!currentText && sentences.length === 0) {
            currentText = 'READY TO START READING';
        }
        
        this.renderRow(current, currentText, displayIndex, true);
        this.renderRow(next, nextResult.text, nextResult.index);
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

        let cleanText = text;
        if (text.includes('<!--VIRGO_TABLE:')) {
            cleanText = text.replace(/^<!--VIRGO_TABLE:.*?-->/, '');
        } else if (text.includes('<!--VIRGO_TABLE_CELL:')) {
            cleanText = text.replace(/^<!--VIRGO_TABLE_CELL:.*?-->/, '');
        }

        el.innerHTML = `<span>${renderWithLinks(cleanText)}</span>`;
    }
}

