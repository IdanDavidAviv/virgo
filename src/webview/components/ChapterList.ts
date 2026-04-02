import { BaseComponent } from '../core/BaseComponent';
import { WebviewStore, LocalUIState } from '../core/WebviewStore';
import { MessageClient } from '../core/MessageClient';
import { OutgoingAction, UISyncPacket } from '../../common/types';
import { escapeHtml } from '../utils';

export interface ChapterListElements extends Record<string, HTMLElement | null | (HTMLElement | null)[] | undefined> {
    container: HTMLElement | null;
    progressHeader?: HTMLElement | null;
    progressHeaders?: (HTMLElement | null)[];
    fullProgressHeader?: HTMLElement | null;
    chapterOnlyHeader?: HTMLElement | null;
}

/**
 * ChapterList Component: Manages the hierarchical list of document headings,
 * handling collapses, highlights, and surgical progress updates.
 */
export class ChapterList extends BaseComponent<ChapterListElements> {
    private lastRenderedChaptersJson: string = '';
    private itemElements: HTMLElement[] = [];

    constructor(elements: ChapterListElements) {
        super(elements);

        // 1. Structural Updates: Re-render the whole list only if chapters change
        this.subscribe((state) => state.allChapters, (chapters) => {
            const json = JSON.stringify(chapters);
            if (json !== this.lastRenderedChaptersJson) {
                this.lastRenderedChaptersJson = json;
                this.render();
            }
        });

        this.subscribeUI((state) => state.pendingChapterIndex, () => this.updateHighlights());
        this.subscribe((state) => state.state.currentChapterIndex, () => this.updateHighlights());
        this.subscribe((state) => state.state.currentSentenceIndex, () => this.updateHighlights());
        this.subscribeUI((state) => state.collapsedIndices, () => this.render());
    }

    /**
     * Toggles the collapse state of a chapter index.
     */
    private toggleCollapse(index: number): void {
        const store = WebviewStore.getInstance();
        const { collapsedIndices } = store.getUIState();
        const next = new Set(collapsedIndices);
        
        if (next.has(index)) {
            next.delete(index);
        } else {
            next.add(index);
        }
        
        store.updateUIState({ collapsedIndices: next });
    }

    /**
     * Triggers a jump to a chapter.
     */
    private jumpToChapter(index: number, count: number): void {
        const store = WebviewStore.getInstance();
        const client = MessageClient.getInstance();

        // Instant feedback
        store.updateUIState({ pendingChapterIndex: index });
        client.postAction(OutgoingAction.JUMP_TO_CHAPTER, { index });

        // Safety fallback: Clear pending highlight if extension doesn't respond
        setTimeout(() => {
            if (store.getUIState().pendingChapterIndex === index) {
                store.updateUIState({ pendingChapterIndex: -1 });
            }
        }, 3000);
    }

    /**
     * Renders the chapter list based on current state.
     */
    public render(): void {
        const { container } = this.els;
        if (!container) {
            return;
        }

        const state = WebviewStore.getInstance().getState();
        const { collapsedIndices, pendingChapterIndex } = WebviewStore.getInstance().getUIState();
        const chapters = state?.allChapters || [];
        const currentIdx = state?.state?.currentChapterIndex ?? -1;

        container.innerHTML = '';
        this.itemElements = [];

        if (!chapters || chapters.length === 0) {
            container.innerHTML = '<div class="chapter-placeholder">No headings found.</div>';
            return;
        }

        let hideLevelAt = Infinity;

        chapters.forEach((ch, i) => {
            if (ch.level <= hideLevelAt) {
                hideLevelAt = Infinity;
            }

            const item = document.createElement('div');
            item.className = `chapter-item level-${ch.level}`;
            item.dataset.index = i.toString();
            
            const isParent = (i < chapters.length - 1 && chapters[i + 1].level > ch.level);
            const isEmpty = ch.count === 0;

            if (isEmpty) {
                item.classList.add('empty');
            }
            if (i === pendingChapterIndex) {
                item.classList.add('pending');
            }
            if (i === currentIdx) {
                item.classList.add('now-playing');
            }
            
            if (isParent && collapsedIndices.has(i)) {
                item.classList.add('collapsed');
                if (hideLevelAt === Infinity) {
                    hideLevelAt = ch.level;
                }
            }

            if (ch.level > hideLevelAt) {
                item.classList.add('is-hidden');
            }

            const chevronIcon = isParent ? '▼' : '';

            item.innerHTML = `
                <span class="chevron">${chevronIcon}</span>
                <span class="chapter-title">${escapeHtml(ch.title)}</span>
                <span class="chapter-row-count">${ch.count || 0} rows</span>
                <span class="chapter-play-icon">▶</span>
            `;

            item.onclick = (e: MouseEvent) => {
                if (isEmpty) {
                    return;
                }
                const target = e.target as HTMLElement;
                if (target.classList.contains('chevron')) {
                    if (isParent) {
                        this.toggleCollapse(i);
                    }
                    return;
                }
                this.jumpToChapter(i, ch.count);
            };

            container.appendChild(item);
            this.itemElements[i] = item;
        });

        this.updateHighlights();
    }

    /**
     * Surgical update of styles and highlights.
     */
    private updateHighlights(): void {
        const state = WebviewStore.getInstance().getState();
        const { pendingChapterIndex } = WebviewStore.getInstance().getUIState();
        if (!state) {
            return;
        }

        const currentChapterIdx = state.state.currentChapterIndex;
        const currentSentenceIdx = state.state.currentSentenceIndex;
        const currentSentences = state.currentSentences || [];
        const totalSentences = currentSentences.length;

        // 1. Update Progress Header (Title Bar)
        const { progressHeader, progressHeaders, fullProgressHeader, chapterOnlyHeader } = this.els;
        if (progressHeader || progressHeaders || fullProgressHeader || chapterOnlyHeader) {
            if (!state.allChapters || state.allChapters.length === 0) {
                const headers = fullProgressHeader ? [fullProgressHeader] : (progressHeaders || [progressHeader]);
                headers.forEach(h => { if (h) { h.innerHTML = '—'; } });
                if (chapterOnlyHeader) { chapterOnlyHeader.innerHTML = '—'; }
            } else {
                const currentChapterDisplay = Math.max(0, currentChapterIdx) + 1;
                const totalChapters = state.allChapters.length;
                const chStr = `${currentChapterDisplay} / ${totalChapters}`;
                
                const currentSentenceDisplay = Math.max(0, currentSentenceIdx) + 1;
                const rowStr = totalSentences > 0 
                    ? `<span style="opacity: 0.5; margin: 0 8px;">•</span><span style="font-weight: 400; opacity: 0.8;">ROW ${currentSentenceDisplay} / ${totalSentences}</span>` 
                    : '';
                
                // Update "Full" indicators (with ROW progress)
                const fullHeaders = fullProgressHeader ? [fullProgressHeader] : (progressHeaders || [progressHeader]);
                fullHeaders.forEach(h => {
                    if (h) { h.innerHTML = `${chStr}${rowStr}`; }
                });

                // Update "Chapter Only" indicators
                if (chapterOnlyHeader) {
                    chapterOnlyHeader.innerHTML = chStr;
                }
            }
        }

        // 2. Surgical update of row classes and progress bars
        let progressPercentage = 0;
        if (totalSentences > 1) {
            progressPercentage = Math.min(100, Math.max(0, (currentSentenceIdx / (totalSentences - 1)) * 100));
        } else if (totalSentences === 1) {
            progressPercentage = 100;
        }

        this.itemElements.forEach((el, idx) => {
            if (!el) {
                return;
            }
            const isNowPlaying = idx === currentChapterIdx;
            const isPending = idx === pendingChapterIndex;

            el.classList.toggle('now-playing', isNowPlaying);
            el.classList.toggle('pending', isPending);

            if (isNowPlaying) {
                el.style.setProperty('--chapter-progress', `${progressPercentage}%`);
            } else {
                el.style.removeProperty('--chapter-progress');
            }
        });

        // 3. Managed Scrolling (Smart)
        const activeIdx = (pendingChapterIndex !== -1) ? pendingChapterIndex : currentChapterIdx;
        const activeEl = this.itemElements[activeIdx];
        if (activeEl) {
            if (!this.isElementInViewport(activeEl)) {
                activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }
    }

    private isElementInViewport(el: HTMLElement): boolean {
        const container = this.els.container;
        if (!container) {
            return true;
        }
        const rect = el.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        return (rect.top >= containerRect.top && rect.bottom <= containerRect.bottom);
    }
}
