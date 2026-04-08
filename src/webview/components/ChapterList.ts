import { BaseComponent } from '../core/BaseComponent';
import { WebviewStore } from '../core/WebviewStore';
import { renderWithLinks } from '../utils';
import { PlaybackController } from '../playbackController';

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

        this.subscribe((state) => state.state.currentChapterIndex, () => this.updateHighlights());
        this.subscribe((state) => state.state.currentSentenceIndex, () => this.updateHighlights());
        this.subscribeUI((state) => state.collapsedIndices, () => this.render());
    }

    protected onMount(): void {
        const { container } = this.els;
        if (!container) {return;}

        // [SOVEREIGNTY] Event Delegation for chapter list
        this.registerEventListener(container, 'click', (e: Event) => {
            const target = e.target as HTMLElement;
            
            // 1. Handle File Links (Exit early)
            if (target.closest('.file-link')) {
                return;
            }

            // 2. Find closest chapter item
            const item = target.closest('.chapter-item') as HTMLElement;
            if (!item || item.classList.contains('empty')) {
                return;
            }

            const index = parseInt(item.dataset.index || '-1', 10);
            if (index === -1) {return;}

            // 3. Handle Chevron (Collapse/Expand)
            if (target.classList.contains('chevron') || target.closest('.chevron')) {
                this.toggleCollapse(index);
                return;
            }

            // 4. Handle Chapter Jump
            this.jumpToChapter(index);
        });
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
    private jumpToChapter(index: number): void {
        PlaybackController.getInstance().jumpToChapter(index);
    }

    /**
     * Renders the chapter list based on current state.
     */
    public render(): void {
        const { container } = this.els;
        if (!container) {
            this.log('Missing container element, skipping render', 'warn');
            return;
        }

        const state = WebviewStore.getInstance().getState();
        const { collapsedIndices } = WebviewStore.getInstance().getUIState();
        const chapters = state?.allChapters || [];
        const currentIdx = state?.state?.currentChapterIndex ?? -1;

        this.log(`Rendering Chapters: ${chapters.length} | Active: ${currentIdx}`);

        container.innerHTML = '';
        this.itemElements = [];

        if (!chapters || chapters.length === 0) {
            container.innerHTML = `
                <div class="chapter-placeholder">
                    <div class="placeholder-icon">📖</div>
                    <div class="placeholder-text">READY TO LOAD</div>
                    <div class="placeholder-subtext">Open a file and click 'LOAD FILE'</div>
                </div>
            `;
            return;
        }

        let activeHeadingLevel = 1;
        let hideLevelAt = Infinity;

        chapters.forEach((ch, i) => {
            // A row's indentation logic
            if (ch.level > 0) {
                activeHeadingLevel = ch.level;
            }
            const effectiveLevel = ch.level > 0 ? ch.level : activeHeadingLevel + 1;

            if (ch.level <= hideLevelAt && ch.level > 0) {
                hideLevelAt = Infinity;
            }

            const item = document.createElement('div');
            item.className = `chapter-item level-${effectiveLevel}`;
            if (ch.level === 0) {
                item.classList.add('content-row');
            }
            item.dataset.index = i.toString();
            
            const isParent = (i < chapters.length - 1 && chapters[i + 1].level > ch.level);
            const isEmpty = ch.count === 0;

            if (isEmpty) {
                item.classList.add('empty');
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
                <span class="chapter-title">${renderWithLinks(ch.title)}</span>
                <span class="chapter-row-count">${ch.count || 0} rows</span>
                <span class="chapter-play-icon">▶</span>
            `;

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
                
                const fullHeaders = fullProgressHeader ? [fullProgressHeader] : (progressHeaders || [progressHeader]);
                fullHeaders.forEach(h => {
                    if (h) { h.innerHTML = `${chStr}${rowStr}`; }
                });

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
            if (!el) {return;}
            const isNowPlaying = idx === currentChapterIdx;
            el.classList.toggle('now-playing', isNowPlaying);

            if (isNowPlaying) {
                el.style.setProperty('--chapter-progress', `${progressPercentage}%`);
            } else {
                el.style.removeProperty('--chapter-progress');
            }
        });

        // 3. Managed Scrolling (Smart)
        const activeIdx = currentChapterIdx;
        const activeEl = this.itemElements[activeIdx];
        if (activeEl) {
            if (!this.isElementInViewport(activeEl)) {
                activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }
    }

    private isElementInViewport(el: HTMLElement): boolean {
        const container = this.els.container;
        if (!container) {return true;}
        
        const rect = el.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        return (rect.top >= containerRect.top && rect.bottom <= containerRect.bottom);
    }
}
