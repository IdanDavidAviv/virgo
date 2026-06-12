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
    const lines = rawText.split('\n');

    let lastHeadingTitle = 'Document';
    let lastHeadingLevel = 1;

    let currentChapter: Partial<Chapter> & { tokens: any[] } = {
        title: lastHeadingTitle,
        level: lastHeadingLevel,
        lineStart: 0,
        lineEnd: 0,
        tokens: []
    };

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];

        if (token.type === 'heading_open') {
            // Finalize current chapter if it has content
            if (currentChapter.tokens.length > 0) {
                const finished = finalizeChapter(currentChapter, lines);
                if (finished) { chapters.push(finished); }
            }

            lastHeadingLevel = parseInt(token.tag.slice(1));
            // Look ahead for the title
            let title = '';
            if (i + 1 < tokens.length && tokens[i + 1].type === 'inline') {
                title = tokens[i + 1].content;
            }
            lastHeadingTitle = title || 'Heading';

            currentChapter = {
                title: lastHeadingTitle,
                level: lastHeadingLevel,
                lineStart: token.map ? token.map[0] : 0,
                lineEnd: token.map ? token.map[1] - 1 : 0,
                tokens: [token]
            };
        } else if (token.type === 'table_open') {
            // Finalize current chapter before table
            if (currentChapter.tokens.length > 0) {
                const finished = finalizeChapter(currentChapter, lines);
                if (finished) { chapters.push(finished); }
            }

            currentChapter = {
                title: `Table`,
                level: lastHeadingLevel + 1, // Indent under the heading
                lineStart: token.map ? token.map[0] : 0,
                lineEnd: token.map ? token.map[1] - 1 : 0,
                tokens: []
            };

            // Collect table tokens until table_close
            while (i < tokens.length && tokens[i].type !== 'table_close') {
                currentChapter.tokens.push(tokens[i]);
                if (tokens[i].map) {
                    currentChapter.lineEnd = Math.max(currentChapter.lineEnd || 0, tokens[i].map![1] - 1);
                }
                i++;
            }
            // Push table_close
            if (i < tokens.length) {
                currentChapter.tokens.push(tokens[i]);
                if (tokens[i].map) {
                    currentChapter.lineEnd = Math.max(currentChapter.lineEnd || 0, tokens[i].map![1] - 1);
                }
            }

            // Finalize table chapter
            const finishedTable = finalizeChapter(currentChapter, lines);
            if (finishedTable) { chapters.push(finishedTable); }

            // Start new chapter for post-table content
            currentChapter = {
                title: `${lastHeadingTitle} (Cont.)`,
                level: lastHeadingLevel,
                lineStart: i + 1 < tokens.length && tokens[i + 1].map ? tokens[i + 1].map![0] : (tokens[i].map ? tokens[i].map![1] : 0),
                lineEnd: i + 1 < tokens.length && tokens[i + 1].map ? tokens[i + 1].map![1] - 1 : (tokens[i].map ? tokens[i].map![1] : 0),
                tokens: []
            };
        } else {
            currentChapter.tokens.push(token);
            if (token.map) {
                currentChapter.lineEnd = Math.max(currentChapter.lineEnd || 0, token.map[1] - 1);
            }
        }
    }

    // Finalize last chapter
    if (currentChapter.tokens.length > 0) {
        const finished = finalizeChapter(currentChapter, lines);
        if (finished) { chapters.push(finished); }
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
    let tableIndex = 0;
    for (let i = 0; i < raw.tokens.length; i++) {
        const token = raw.tokens[i];
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
            const lang = token.info ? token.info.trim() : '';
            const desc = lang ? `[Code block in ${lang} omitted].` : '[Code block omitted].';
            cleanText += desc + ' ';
            sentences.push(desc);
            sentenceLines.push(token.map ? token.map[0] : raw.lineStart);
        } else if (token.type === 'table_open') {
            let headers: string[] = [];
            const rows: string[][] = [];
            let currentRow: string[] = [];
            let inHeader = false;
            let inCell = false;
            let currentCellText = '';

            let j = i;
            while (j < raw.tokens.length && raw.tokens[j].type !== 'table_close') {
                const subToken = raw.tokens[j];
                if (subToken.type === 'thead_open') {
                    inHeader = true;
                } else if (subToken.type === 'thead_close') {
                    inHeader = false;
                } else if (subToken.type === 'tr_open') {
                    currentRow = [];
                } else if (subToken.type === 'tr_close') {
                    if (inHeader) {
                        headers = currentRow;
                    } else if (currentRow.length > 0) {
                        rows.push(currentRow);
                    }
                } else if (subToken.type === 'th_open' || subToken.type === 'td_open') {
                    inCell = true;
                    currentCellText = '';
                } else if (subToken.type === 'th_close' || subToken.type === 'td_close') {
                    inCell = false;
                    currentRow.push(currentCellText.trim());
                } else if (inCell && subToken.type === 'inline') {
                    currentCellText += cleanInlineToken(subToken);
                } else if (inCell && subToken.type === 'text') {
                    currentCellText += subToken.content;
                }
                j++;
            }

            const startLine = token.map ? token.map[0] : raw.lineStart;
            const tableIdx = tableIndex++;
            const tableData = {
                tableIndex: tableIdx,
                headers,
                rows,
                rowSentenceIndices: [] as number[]
            };

            const rowSentences: string[] = [];
            const rowLines: number[] = [];
            let activeSentenceCount = sentences.length + 1;

            rows.forEach((row, rowIndex) => {
                let speakableText = `Row ${rowIndex + 1}: `;
                const parts: string[] = [];
                row.forEach((cellVal, colIndex) => {
                    const headerName = headers[colIndex] || `Column ${colIndex + 1}`;
                    if (cellVal.trim()) {
                        parts.push(`${headerName} is ${cellVal.trim()}`);
                    }
                });

                if (parts.length > 0) {
                    speakableText += parts.join(', ') + '.';
                    const rowSentence = `<!--VIRGO_TABLE_CELL:tableIndex=${tableIdx},rowIndex=${rowIndex}-->${speakableText}`;
                    rowSentences.push(rowSentence);
                    rowLines.push(startLine);
                    tableData.rowSentenceIndices.push(activeSentenceCount);
                    activeSentenceCount++;
                } else {
                    tableData.rowSentenceIndices.push(-1);
                }
            });

            const payload = `<!--VIRGO_TABLE:${JSON.stringify(tableData)}-->`;
            const desc = `[Table with ${rows.length} rows and ${headers.length} columns omitted].`;
            const tablePlaceholder = `${payload}${desc}`;

            cleanText += desc + ' ';
            sentences.push(tablePlaceholder);
            sentenceLines.push(startLine);

            for (let k = 0; k < rowSentences.length; k++) {
                sentences.push(rowSentences[k]);
                sentenceLines.push(rowLines[k]);
            }

            i = j;
        }
    }

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
    // 1. Configuration
    const abbreviations = [
        'Dr', 'Mr', 'Mrs', 'Ms', 'Jr', 'Sr', 'Prof', 'St', 
        'e\\.g', 'i\\.e', 'vs', 'etc', 'Vol', 'Fig', 'p\\.', 'pp\\.'
    ];
    const commonWords = 'is|it|to|no|so|at|in|on|if|me|my|by|be|do|go|he|of|or|up|us|we';
    const romanIndex = 'i|ii|iii|iv|v|vi|vii|viii|ix|x';

    // 2. Protected patterns (Abbreviations, Roman Numerals, Multi-level indices like 1.1.1)
    // These are protected regardless of their position in the text.
    const protectedPrefix = `(?:${abbreviations.join('|')}|${romanIndex}|[a-zA-Z0-9]{1,3}(?:\\.[a-zA-Z0-9]+){1,2})`;
    
    // 3. The Boundary Splitter
    // Uses negative lookbehind to avoid splitting on protected patterns.
    // We removed commonWords from lookbehind as they should always be split points if punctuation follows.
    const indexRegex = `(?<!\\b${protectedPrefix})`;
    const splitter = new RegExp(`${indexRegex}[.!?]+(?:\\s+|$)`, 'gi');

    const result: string[] = [];
    let match;
    let lastIndex = 0;

    while ((match = splitter.exec(text)) !== null) {
        let shouldSplit = true;
        const matchPos = match.index;
        const splitChar = match[0].trim().charAt(0);

        // 4. Positional Heuristic for Single-level indices (1., a.)
        // We only protect "1." or "a." if they are at the start of a block, follow a newline, 
        // or follow a sentence boundary (punctuation + whitespace).
        if (splitChar === '.') {
            const precedingText = text.slice(0, matchPos).trim();
            const lastWordMatch = precedingText.match(/\b(\d+|[a-zA-Z])$/);
            
            if (lastWordMatch) {
                const isAtStart = precedingText.length === lastWordMatch[0].length;
                const followsNewline = text.slice(0, matchPos).includes('\n');
                const followsSentenceEnd = /[.!?]\s+$/.test(text.slice(0, matchPos - lastWordMatch[0].length));
                
                if (isAtStart || followsNewline || followsSentenceEnd) {
                    shouldSplit = false; // Protected index: "1. Item" or "Ref. 1. Item"
                } else {
                    shouldSplit = true; // Prose count: "is 42. Next"
                }
            }
        }

        if (shouldSplit) {
            result.push(text.slice(lastIndex, match.index + match[0].length).trim());
            lastIndex = splitter.lastIndex;
        }
    }

    if (lastIndex < text.length) {
        const remaining = text.slice(lastIndex).trim();
        if (remaining) {result.push(remaining);}
    }

    return result.map(s => s.trim()).filter(s => s.length > 0 && /[\p{L}\p{N}]/u.test(s));
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

