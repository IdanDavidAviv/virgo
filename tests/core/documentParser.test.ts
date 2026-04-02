import { describe, it, expect } from 'vitest';
import { parseChapters, splitIntoSentences } from '@core/documentParser';

describe('documentParser', () => {
    it('should parse simple markdown with headers', () => {
        const md = '# Chapter 1\nHello world\n# Chapter 2\nGoodbye world';
        const chapters = parseChapters(md);

        expect(chapters).toHaveLength(2);
        expect(chapters[0].title).toBe('Chapter 1');
        expect(chapters[1].title).toBe('Chapter 2');
    });

    it('should handle markdown with no headers', () => {
        const md = 'Just some text';
        const chapters = parseChapters(md);

        expect(chapters).toHaveLength(1);
        expect(chapters[0].title).toBe('Document'); // Matches initial state 'Document'
    });

    it('should correctly segment sentences', () => {
        const md = '# Header\nThis is sentence one. This is sentence two!';
        const chapters = parseChapters(md);

        // The first sentence in a chapter is the Header title itself
        expect(chapters[0].sentences).toEqual([
            'Header',
            'This is sentence one.',
            'This is sentence two!'
        ]);
    });

    it('should correctly handle prose vs indices', () => {
        const text = 'The year is 2024. Next sentence. 1. This is a list. I got an A. Next.';
        const sentences = splitIntoSentences(text);
        
        expect(sentences).toEqual([
            'The year is 2024.',
            'Next sentence.',
            '1. This is a list.',
            'I got an A.',
            'Next.'
        ]);
    });

    it('should protect Roman numerals and nested indices anywhere', () => {
        const text = 'Check iv. for more info. 1.2.3. is the version.';
        const sentences = splitIntoSentences(text);
        
        expect(sentences).toEqual([
            'Check iv. for more info.',
            '1.2.3. is the version.'
        ]);
    });

    it('should split on common words even if they are short', () => {
        const text = 'It is. It was. We go.';
        const sentences = splitIntoSentences(text);
        expect(sentences).toEqual(['It is.', 'It was.', 'We go.']);
    });
});
