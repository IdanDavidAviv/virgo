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

    describe('table skip traversal logic', () => {
        let tableChapters: Chapter[];
        beforeEach(() => {
            tableChapters = [
                {
                    title: 'Chapter 1',
                    sentences: [
                        'Intro text',
                        '<!--VIRGO_TABLE:{"tableIndex":0,"rows":2,"cols":2}-->[Table with 2 rows and 2 columns omitted].',
                        '<!--VIRGO_TABLE_CELL:tableIndex=0,rowIndex=0-->Row 1: H1 is A, H2 is B.',
                        '<!--VIRGO_TABLE_CELL:tableIndex=0,rowIndex=1-->Row 2: H1 is C, H2 is D.',
                        'Outro text'
                    ],
                    sentenceLines: [1, 2, 3, 4, 5],
                    level: 1,
                    lineStart: 1,
                    lineEnd: 5,
                    text: '',
                    originalMarkdown: ''
                }
            ] as Chapter[];
        });

        it('should skip cell sentences and read placeholder when table is collapsed', () => {
            // Intro -> Placeholder
            let next = manager.getNext(0, 0, tableChapters, new Set());
            expect(next).toEqual({ chapterIndex: 0, sentenceIndex: 1 });

            // Placeholder -> Outro (skipping cells 2 and 3)
            next = manager.getNext(0, 1, tableChapters, new Set());
            expect(next).toEqual({ chapterIndex: 0, sentenceIndex: 4 });
        });

        it('should skip placeholder and read cell sentences sequentially when table is expanded', () => {
            const expanded = new Set(['0:0']);
            // Intro -> skip Placeholder -> Cell 1
            let next = manager.getNext(0, 0, tableChapters, expanded);
            expect(next).toEqual({ chapterIndex: 0, sentenceIndex: 2 });

            // Cell 1 -> Cell 2
            next = manager.getNext(0, 2, tableChapters, expanded);
            expect(next).toEqual({ chapterIndex: 0, sentenceIndex: 3 });

            // Cell 2 -> Outro
            next = manager.getNext(0, 3, tableChapters, expanded);
            expect(next).toEqual({ chapterIndex: 0, sentenceIndex: 4 });
        });

        it('should traverse backwards correctly when table is collapsed', () => {
            // Outro -> Placeholder (skipping cells)
            let prev = manager.getPrevious(0, 4, tableChapters, new Set());
            expect(prev).toEqual({ chapterIndex: 0, sentenceIndex: 1 });

            // Placeholder -> Intro
            prev = manager.getPrevious(0, 1, tableChapters, new Set());
            expect(prev).toEqual({ chapterIndex: 0, sentenceIndex: 0 });
        });

        it('should traverse backwards correctly when table is expanded', () => {
            const expanded = new Set(['0:0']);
            // Outro -> Cell 2
            let prev = manager.getPrevious(0, 4, tableChapters, expanded);
            expect(prev).toEqual({ chapterIndex: 0, sentenceIndex: 3 });

            // Cell 2 -> Cell 1
            prev = manager.getPrevious(0, 3, tableChapters, expanded);
            expect(prev).toEqual({ chapterIndex: 0, sentenceIndex: 2 });

            // Cell 1 -> skip Placeholder -> Intro
            prev = manager.getPrevious(0, 2, tableChapters, expanded);
            expect(prev).toEqual({ chapterIndex: 0, sentenceIndex: 0 });
        });
    });
});

