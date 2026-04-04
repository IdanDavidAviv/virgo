import { describe, it, expect } from 'vitest';
import { parseChapters } from '../../src/extension/core/documentParser';

describe('DocumentParser: Artifact Parsing Cache', () => {
    it('should describe code blocks with their language', () => {
        const md = '## Code Test\n\n```typescript\nconst x = 5;\n```';
        const chapters = parseChapters(md);
        
        expect(chapters[0].sentences).toContain('[Code block in typescript omitted].');
    });

    it('should describe tables with rows and columns', () => {
        const md = '## Table Test\n\n| H1 | H2 |\n|---|---|\n| R1C1 | R1C2 |\n| R2C1 | R2C2 |';
        const chapters = parseChapters(md);
        
        // rows: head (1) + body (2) = 3 rows
        // cols: 2 columns
        expect(chapters[0].sentences).toContain('[Table with 3 rows and 2 columns omitted].');
    });

    it('should handle code blocks without language', () => {
        const md = '## Code Test\n\n```\nplain text\n```';
        const chapters = parseChapters(md);
        
        expect(chapters[0].sentences).toContain('[Code block omitted].');
    });

    it('should skip internal inline tokens of tables', () => {
        const md = '## Table Test\n\n| H1 | H2 |\n|---|---|\n| R1C1 | R1C2 |';
        const chapters = parseChapters(md);
        
        // Should NOT contain the table cell text as separate sentences
        expect(chapters[0].sentences).not.toContain('H1');
        expect(chapters[0].sentences).not.toContain('R1C1');
        // sentences: [Table Test., [Table with 2 rows and 2 columns omitted].]
        expect(chapters[0].sentences.length).toBe(2); 
        expect(chapters[0].sentences[1]).toContain('Table with 2 rows and 2 columns omitted');
    });
});
