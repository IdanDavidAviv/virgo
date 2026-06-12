import { describe, it, expect } from 'vitest';
import { parseChapters } from '@core/documentParser';

describe('documentParser table support', () => {
    it('should parse markdown tables into placeholder comments and cell sentences', () => {
        const md = '# Chapter 1\n| H1 | H2 |\n|---|---|\n| V1 | V2 |';
        const chapters = parseChapters(md);

        expect(chapters).toHaveLength(2);
        
        expect(chapters[0].title).toBe('Chapter 1');
        expect(chapters[0].sentences).toHaveLength(1);
        expect(chapters[0].sentences[0]).toBe('Chapter 1');
        
        expect(chapters[1].title).toBe('Table');
        expect(chapters[1].sentences).toHaveLength(2);
        expect(chapters[1].sentences[0]).toContain('<!--VIRGO_TABLE:');
        expect(chapters[1].sentences[0]).toContain('[Table with 1 rows and 2 columns omitted].');
        
        expect(chapters[1].sentences[1]).toContain('<!--VIRGO_TABLE_CELL:');
        expect(chapters[1].sentences[1]).toContain('Row 1: H1 is V1, H2 is V2.');
    });

    it('should filter out empty cells in table speech text', () => {
        const md = '# Chapter 1\n| H1 | H2 |\n|---|---|\n| V1 |  |';
        const chapters = parseChapters(md);
        
        expect(chapters).toHaveLength(2);
        const tableChapter = chapters[1];
        expect(tableChapter.sentences[1]).toContain('Row 1: H1 is V1.');
        expect(tableChapter.sentences[1]).not.toContain('H2');
    });
});
