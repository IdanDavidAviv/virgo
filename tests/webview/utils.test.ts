/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { renderWithLinks, escapeHtml } from '@webview/utils';

describe('renderWithLinks — utils (#3 regression guard)', () => {
    it('should return empty string for empty input', () => {
        expect(renderWithLinks('')).toBe('');
    });

    it('should escape plain HTML entities without touching text', () => {
        expect(renderWithLinks('Hello <world> & "earth"')).toContain('&lt;world&gt;');
        expect(renderWithLinks('Hello <world> & "earth"')).toContain('&amp;');
    });

    it('should convert file:/// markdown links to <a> tags', () => {
        const input = '[Open File](file:///Users/test/readme.md)';
        const output = renderWithLinks(input);
        expect(output).toContain('<a class="file-link"');
        expect(output).toContain('data-uri="file:///Users/test/readme.md"');
        expect(output).toContain('title="Open in Editor"');
        expect(output).toContain('>Open File</a>');
    });

    it('should NOT convert non-file:/// links', () => {
        const input = '[Google](https://google.com)';
        const output = renderWithLinks(input);
        // Should remain as plain escaped text, not an anchor
        expect(output).not.toContain('<a ');
        expect(output).toContain('Google');
    });

    it('should handle multiple file links in one sentence', () => {
        const input = 'See [A](file:///a.md) and [B](file:///b.md)';
        const output = renderWithLinks(input);
        const matches = output.match(/<a class="file-link"/g);
        expect(matches).toHaveLength(2);
        expect(output).toContain('file:///a.md');
        expect(output).toContain('file:///b.md');
    });

    it('should return plain escaped text for sentences with no links', () => {
        const input = 'This is a normal sentence.';
        expect(renderWithLinks(input)).toBe('This is a normal sentence.');
    });

    it('should not produce XSS via label content', () => {
        // Malicious label: the label itself is HTML-escaped before being placed in the link
        const input = '[<script>alert(1)</script>](file:///x.md)';
        const output = renderWithLinks(input);
        expect(output).not.toContain('<script>');
        expect(output).toContain('&lt;script&gt;');
    });
});

describe('escapeHtml — utils (safety baseline)', () => {
    it('should escape all dangerous HTML characters', () => {
        expect(escapeHtml('<>&"')).toBe('&lt;&gt;&amp;&quot;');
    });

    it('should return empty string for falsy input', () => {
        expect(escapeHtml('')).toBe('');
    });
});
