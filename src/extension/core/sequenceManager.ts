import { Chapter } from './documentParser';

export interface SequencePosition {
    chapterIndex: number;
    sentenceIndex: number;
}

/**
 * Pure logic controller for document traversal.
 * Decouples navigation state from the synthesis engine.
 */
export class SequenceManager {
    /**
     * Calculates the next position in the document.
     */
    public getNext(
        currentChapterIndex: number,
        currentSentenceIndex: number,
        chapters: Chapter[]
    ): SequencePosition | null {
        if (!chapters || chapters.length === 0) {
            return null;
        }

        const chapter = chapters[currentChapterIndex];
        if (!chapter) {
            return null;
        }

        // 1. Same chapter, next sentence
        if (currentSentenceIndex + 1 < chapter.sentences.length) {
            return {
                chapterIndex: currentChapterIndex,
                sentenceIndex: currentSentenceIndex + 1
            };
        }

        // 2. Next chapter, first sentence
        if (currentChapterIndex + 1 < chapters.length) {
            return {
                chapterIndex: currentChapterIndex + 1,
                sentenceIndex: 0
            };
        }

        // 3. End of document
        return null;
    }

    /**
     * Calculates the previous position in the document.
     */
    public getPrevious(
        currentChapterIndex: number,
        currentSentenceIndex: number,
        chapters: Chapter[]
    ): SequencePosition | null {
        if (!chapters || chapters.length === 0) {
            return null;
        }

        // 1. Same chapter, previous sentence
        if (currentSentenceIndex > 0) {
            return {
                chapterIndex: currentChapterIndex,
                sentenceIndex: currentSentenceIndex - 1
            };
        }

        // 2. Previous chapter, last sentence
        if (currentChapterIndex > 0) {
            const prevChapterIdx = currentChapterIndex - 1;
            const prevChapter = chapters[prevChapterIdx];
            return {
                chapterIndex: prevChapterIdx,
                sentenceIndex: Math.max(0, prevChapter.sentences.length - 1)
            };
        }

        // 3. Start of document
        return null;
    }

    /**
     * Validates if a position is within the bounds of existing chapters.
     */
    public validate(
        chapterIndex: number,
        sentenceIndex: number,
        chapters: Chapter[]
    ): boolean {
        if (!chapters || chapters.length === 0) {
            return false;
        }
        
        const chapter = chapters[chapterIndex];
        if (!chapter) {
            return false;
        }

        return sentenceIndex >= 0 && sentenceIndex < chapter.sentences.length;
    }
}
