import { describe, it, expect, beforeEach } from 'vitest';
import { SequenceManager } from '@core/sequenceManager';
import { Chapter } from '@core/documentParser';

describe('SequenceManager', () => {
    let manager: SequenceManager;
    let mockChapters: Chapter[];

    beforeEach(() => {
        manager = new SequenceManager();
        mockChapters = [
            { 
                title: 'Chapter 1', 
                sentences: ['S1.1', 'S1.2'],
                sentenceLines: [1, 2],
                level: 1,
                lineStart: 1,
                lineEnd: 2,
                text: 'S1.1 S1.2',
                originalMarkdown: '# Chapter 1\nS1.1 S1.2'
            },
            { 
                title: 'Chapter 2', 
                sentences: ['S2.1'],
                sentenceLines: [4],
                level: 1,
                lineStart: 4,
                lineEnd: 4,
                text: 'S2.1',
                originalMarkdown: '# Chapter 2\nS2.1'
            }
        ] as Chapter[];
    });

    describe('getNext', () => {
        it('should move to the next sentence in the same chapter', () => {
            const next = manager.getNext(0, 0, mockChapters);
            expect(next).toEqual({ chapterIndex: 0, sentenceIndex: 1 });
        });

        it('should move to the first sentence of the next chapter', () => {
            const next = manager.getNext(0, 1, mockChapters);
            expect(next).toEqual({ chapterIndex: 1, sentenceIndex: 0 });
        });

        it('should return null at the end of the document', () => {
            const next = manager.getNext(1, 0, mockChapters);
            expect(next).toBeNull();
        });
    });

    describe('getPrevious', () => {
        it('should move to the previous sentence in the same chapter', () => {
            const prev = manager.getPrevious(0, 1, mockChapters);
            expect(prev).toEqual({ chapterIndex: 0, sentenceIndex: 0 });
        });

        it('should move to the last sentence of the previous chapter', () => {
            const prev = manager.getPrevious(1, 0, mockChapters);
            expect(prev).toEqual({ chapterIndex: 0, sentenceIndex: 1 });
        });

        it('should return null at the start of the document', () => {
            const prev = manager.getPrevious(0, 0, mockChapters);
            expect(prev).toBeNull();
        });
    });

    describe('validate', () => {
        it('should return true for valid indices', () => {
            expect(manager.validate(0, 0, mockChapters)).toBe(true);
            expect(manager.validate(1, 0, mockChapters)).toBe(true);
        });

        it('should return false for invalid indices', () => {
            expect(manager.validate(0, 5, mockChapters)).toBe(false);
            expect(manager.validate(2, 0, mockChapters)).toBe(false);
            expect(manager.validate(-1, 0, mockChapters)).toBe(false);
        });
    });
});
