import { describe, it, expect } from 'vitest';
import { cleanForSpeech } from '../../src/extension/core/speechProcessor';

describe('SpeechProcessor', () => {
    describe('cleanForSpeech', () => {
        it('should strip markdown file links leaving only the label', () => {
            const input = 'Check out [config.json](file:///path/to/config.json) for more details.';
            const expected = 'Check out config.json for more details.';
            expect(cleanForSpeech(input)).toBe(expected);
        });

        it('should handle multiple links in one string', () => {
            const input = 'First [A](file:///1) then [B](file:///2).';
            const expected = 'First A then B.';
            expect(cleanForSpeech(input)).toBe(expected);
        });

        it('should not affect normal text without links', () => {
            const input = 'Just a normal sentence with no files.';
            expect(cleanForSpeech(input)).toBe(input);
        });

        it('should handle edge cases like empty strings', () => {
            expect(cleanForSpeech('')).toBe('');
        });

        it('should handle links at the beginning/end', () => {
            const input = '[start.ts](file:///s) and [end.ts](file:///e)';
            const expected = 'start.ts and end.ts';
            expect(cleanForSpeech(input)).toBe(expected);
        });

        describe('Emoji Filtering (Issue #28)', () => {
            it('should remove standard emojis and cleanup double spaces', () => {
                const input = 'Reading 📖 with 🎧 and 🍕.';
                const expected = 'Reading with and .';
                expect(cleanForSpeech(input)).toBe(expected);
            });

            it('should handle complex emoji sequences like flags and skin tones', () => {
                const input = 'Flag 🇮🇱 and wave 👋🏽.';
                const expected = 'Flag and wave .';
                expect(cleanForSpeech(input)).toBe(expected);
            });

            it('should not remove normal punctuation that looks like symbols', () => {
                const input = 'Normal punctuation! (Parentheses?) {Brackets}.';
                expect(cleanForSpeech(input)).toBe(input);
            });

            it('should handle mixed links and emojis', () => {
                const input = 'Check [file.ts](file:///path) 🔥 now! 🚀';
                const expected = 'Check file.ts now!';
                expect(cleanForSpeech(input)).toBe(expected);
            });
        });

        describe('XML/SSML Filtration (Issue #36)', () => {
            it('should escape ampersands to &amp;', () => {
                const input = 'AT&T and R&D.';
                const expected = 'AT&amp;T and R&amp;D.';
                expect(cleanForSpeech(input)).toBe(expected);
            });

            it('should replace < and > with spaces', () => {
                const input = 'The <tag> is hidden.';
                const expected = 'The tag is hidden.';
                expect(cleanForSpeech(input)).toBe(expected);
            });

            it('should strip double and single quotes', () => {
                const input = 'He said "Hello" and \'World\'.';
                const expected = 'He said Hello and World.';
                expect(cleanForSpeech(input)).toBe(expected);
            });

            it('should handle complex mixed XML breaks', () => {
                const input = '<div class="test">AT&T & "More"</div>';
                const expected = 'div class=test AT&amp;T &amp; More /div';
                // Note: cleanForSpeech currently replaces < > with spaces, so:
                // " div class=test AT&amp;T &amp; More /div " -> trim() -> "div class=test AT&amp;T &amp; More /div"
                expect(cleanForSpeech(input)).toBe(expected);
            });
        });
    });
});
