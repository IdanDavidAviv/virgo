export interface Chapter {
    title: string;
    level: number;
    lineStart: number;
    lineEnd: number;
    text: string;           // Cleaned speech text
    originalMarkdown: string; // Pre-cleaned source for future editing
    sentences: string[];
}

export function parseChapters(rawText: string): Chapter[] {
    const lines = rawText.split('\n');
    // Match #, ##, ###
    const headingRegex = /^(#{1,3})\s+(.+)$/;
    const markers: { level: number; title: string; lineIndex: number }[] = [];

    lines.forEach((line, i) => {
        const match = line.match(headingRegex);
        if (match) {
            markers.push({ level: match[1].length, title: match[2].trim(), lineIndex: i });
        }
    });

    const chapters: Chapter[] = [];
    markers.forEach((m, i) => {
        const lineStart = m.lineIndex;
        const lineEnd = i + 1 < markers.length ? markers[i + 1].lineIndex - 1 : lines.length - 1;
        const chunkText = lines.slice(lineStart, lineEnd + 1).join('\n');
        const stripped = stripMarkdown(chunkText);
        
        if (stripped.trim().length > 0) {
            chapters.push({ 
                title: m.title, 
                level: m.level, 
                lineStart, 
                lineEnd, 
                text: stripped,
                originalMarkdown: chunkText,
                sentences: splitIntoSentences(stripped)
            });
        }
    });

    // Fallback: no headings found → treat entire doc as one chapter
    if (chapters.length === 0) {
        const stripped = stripMarkdown(rawText);
        chapters.push({
            title: 'Document',
            level: 1,
            lineStart: 0,
            lineEnd: lines.length - 1,
            text: stripped,
            originalMarkdown: rawText,
            sentences: splitIntoSentences(stripped)
        });
    }

    return chapters;
}

export function splitIntoSentences(text: string): string[] {
    // Advanced sentence splitting that respects common abbreviations
    const abbreviations = [
        'Dr', 'Mr', 'Mrs', 'Ms', 'Jr', 'Sr', 'Prof', 'St', 
        'e\\.g', 'i\\.e', 'vs', 'etc', 'Vol', 'Fig', 'p\\.', 'pp\\.'
    ];
    const abbrRegex = `(?<!\\b(?:${abbreviations.join('|')}))`;
    const splitter = new RegExp(`${abbrRegex}[.!?]+(?:\\s+|$)`, 'g');

    const result: string[] = [];
    let match;
    let lastIndex = 0;

    while ((match = splitter.exec(text)) !== null) {
        result.push(text.slice(lastIndex, match.index + match[0].length).trim());
        lastIndex = splitter.lastIndex;
    }

    if (lastIndex < text.length) {
        const remaining = text.slice(lastIndex).trim();
        if (remaining) result.push(remaining);
    }

    // Filter results to ensure we don't send "empty" or punctuation-only strings to TTS
    return result
        .map(s => s.trim())
        .filter(s => {
            // Must contain at least one letter or number (Universal support for Hebrew, English, etc.)
            return s.length > 0 && /[\p{L}\p{N}]/u.test(s);
        });
}

export function stripMarkdown(md: string): string {
    return md
        .replace(/^#+\s+(.+)$/gm, '$1. ') 
        .replace(/\*\*|__/g, '') 
        .replace(/\*|_/g, '') 
        // Images: Keep alt-text for meaningful context
        .replace(/!\[(.*?)\]\(.*?\)/g, '$1. ') 
        // Links: Keep text
        .replace(/\[(.*?)\]\(.*?\)/g, '$1') 
        // Code Blocks: Option B - Omit with marker
        .replace(/`{3,}[\s\S]*?`{3,}/g, '\n[Code block omitted].\n') 
        // Tables: Omit with marker
        .replace(/^\|.*?|$/gm, '') // Crude table line removal
        .replace(/`(.+?)`/g, '$1') 
        // Lists: Add punctuation to force SAPI pause between items
        .replace(/^\s*[-*+]\s+(.+)$/gm, '$1. ') 
        .replace(/^\s*(>\s+)+(.+)$/gm, '$2. ') 
        .replace(/<[^>]*>/g, '') 
        .replace(/\n{2,}/g, '\n') // Collapse excessive newlines
        .trim();
}

export function findChapterAtLine(chapters: Chapter[], line: number): number {
    return chapters.findIndex(c => line >= c.lineStart && line <= c.lineEnd);
}

export function findSentenceAtLine(chapter: Chapter, line: number): number {
    if (!chapter.sentences || chapter.sentences.length === 0) return 0;
    
    // Heuristic: Map line position within chapter range to sentence index
    const totalLines = chapter.lineEnd - chapter.lineStart + 1;
    const lineOffset = line - chapter.lineStart;
    
    if (totalLines <= 1) return 0;
    
    // Calculate ratio and snap to nearest sentence index
    const ratio = lineOffset / totalLines;
    const estimatedIndex = Math.floor(ratio * chapter.sentences.length);
    
    return Math.max(0, Math.min(estimatedIndex, chapter.sentences.length - 1));
}
