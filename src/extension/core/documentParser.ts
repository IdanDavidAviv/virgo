import MarkdownIt from 'markdown-it';
import { Token } from 'markdown-it';

export interface Chapter {
    title: string;
    level: number;
    lineStart: number;
    lineEnd: number;
    text: string;           // Cleaned speech text
    originalMarkdown: string; // Pre-cleaned source for future editing
    sentences: string[];
    sentenceLines: number[]; // Parallel array to sentences: tracks source line for each
}

export function parseChapters(rawText: string): Chapter[] {
    const md = new MarkdownIt({
        html: true,
        linkify: true,
        typographer: true
    });

    const tokens = md.parse(rawText, {});
    const chapters: Chapter[] = [];
    let currentChapter: Partial<Chapter> & { tokens: any[] } = {
        title: 'Document',
        level: 1,
        lineStart: 0,
        lineEnd: 0,
        tokens: []
    };

    const lines = rawText.split('\n');

    tokens.forEach((token: Token) => {
        // Detect Heading start
        if (token.type === 'heading_open') {
            // If the current chapter has content, push it before starting new one
            if (currentChapter.tokens && currentChapter.tokens.length > 0) {
                const finished = finalizeChapter(currentChapter, lines);
                if (finished) {chapters.push(finished);}
            }

            currentChapter = {
                level: parseInt(token.tag.slice(1)),
                lineStart: token.map ? token.map[0] : 0,
                lineEnd: token.map ? token.map[1] - 1 : 0,
                tokens: []
            };
        } else if (token.type === 'inline' && currentChapter.level !== undefined && !currentChapter.title) {
            // First inline token after heading_open is usually the title
            currentChapter.title = token.content;
        }

        if (currentChapter.tokens) {
            currentChapter.tokens.push(token);
            if (token.map) {
                currentChapter.lineEnd = Math.max(currentChapter.lineEnd || 0, token.map[1] - 1);
            }
        }
    });

    // Finalize last chapter
    if (currentChapter.tokens && currentChapter.tokens.length > 0) {
        const finished = finalizeChapter(currentChapter, lines);
        if (finished) {chapters.push(finished);}
    }

    // Fallback: No chapters? (should not happen with finalizeChapter logic, but safety first)
    if (chapters.length === 0 && rawText.trim().length > 0) {
        return [createFallbackChapter(rawText)];
    }

    return chapters;
}

function finalizeChapter(raw: any, lines: string[]): Chapter | null {
    let cleanText = '';
    const sentences: string[] = [];
    const sentenceLines: number[] = [];

    raw.tokens.forEach((token: any) => {
        if (token.type === 'inline') {
            const startLine = token.map ? token.map[0] : raw.lineStart;
            const content = cleanInlineToken(token);
            if (content) {
                const split = splitIntoSentences(content);
                split.forEach(s => {
                    sentences.push(s);
                    sentenceLines.push(startLine);
                    cleanText += s + ' ';
                });
            }
        } else if (token.type === 'fence') {
            cleanText += '[Code block omitted]. ';
            sentences.push('[Code block omitted].');
            sentenceLines.push(token.map ? token.map[0] : raw.lineStart);
        } else if (token.type === 'table_open') {
            cleanText += '[Table omitted]. ';
            sentences.push('[Table omitted].');
            sentenceLines.push(token.map ? token.map[0] : raw.lineStart);
        }
    });

    if (sentences.length === 0 && !raw.title) {return null;}

    const lineStart = raw.lineStart || 0;
    const lineEnd = raw.lineEnd || lines.length - 1;
    const originalMarkdown = lines.slice(lineStart, lineEnd + 1).join('\n');

    return {
        title: raw.title || 'Introduction',
        level: raw.level || 1,
        lineStart,
        lineEnd,
        text: cleanText.trim(),
        originalMarkdown,
        sentences,
        sentenceLines
    };
}

function cleanInlineToken(token: any): string {
    // Extract text from children (ignores images, links formatting but keeps text)
    let text = '';
    if (token.children) {
        token.children.forEach((child: any) => {
            if (child.type === 'text' || child.type === 'code_inline') {
                text += child.content;
            } else if (child.type === 'softbreak' || child.type === 'hardbreak') {
                text += ' ';
            } else if (child.type === 'image') {
                text += child.content + '. '; // Alt text
            }
        });
    } else {
        text = token.content;
    }
    return text.trim();
}

function createFallbackChapter(rawText: string): Chapter {
    const stripped = rawText; // simplified for fallback
    const sentences = splitIntoSentences(stripped);
    return {
        title: 'Document',
        level: 1,
        lineStart: 0,
        lineEnd: rawText.split('\n').length - 1,
        text: stripped,
        originalMarkdown: rawText,
        sentences: sentences,
        sentenceLines: sentences.map(() => 0)
    };
}

export function splitIntoSentences(text: string): string[] {
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
        if (remaining) {result.push(remaining);}
    }

    return result
        .map(s => s.trim())
        .filter(s => s.length > 0 && /[\p{L}\p{N}]/u.test(s));
}

// Keeping legacy for compatibility but we will migrate callers
export function stripMarkdown(md: string): string {
    return md; // markdown-it handles this better now via AST
}

export function findChapterAtLine(chapters: Chapter[], line: number): number {
    return chapters.findIndex(c => line >= c.lineStart && line <= c.lineEnd);
}

export function findSentenceAtLine(chapter: Chapter, line: number): number {
    if (!chapter.sentences || chapter.sentences.length === 0) {return 0;}
    if (!chapter.sentenceLines) {return 0;}

    // Use absolute line mapping
    let bestIndex = 0;
    for (let i = 0; i < chapter.sentenceLines.length; i++) {
        if (chapter.sentenceLines[i] <= line) {
            bestIndex = i;
        } else {
            break;
        }
    }
    
    return bestIndex;
}

