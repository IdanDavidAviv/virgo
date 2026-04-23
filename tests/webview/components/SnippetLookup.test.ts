/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SnippetLookup } from '@webview/components/SnippetLookup';
import { WebviewStore } from '@webview/core/WebviewStore';
import { IncomingCommand } from '@common/types';
import { resetAllSingletons, wireDispatcher, FULL_DOM_TEMPLATE, createMockSyncPacket } from '../testUtils';

describe('SnippetLookup', () => {
    let elements: any;

    beforeEach(() => {
        document.body.innerHTML = FULL_DOM_TEMPLATE;
        resetAllSingletons();
        
        const mockVscode = { postMessage: vi.fn() };
        (window as any).acquireVsCodeApi = vi.fn(() => mockVscode);
        (window as any).vscode = mockVscode;

        elements = {
            container: document.getElementById('snippet-lookup-container')
        };
        
        wireDispatcher();
    });

    const sendSync = (patch: any) => {
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                command: IncomingCommand.UI_SYNC,
                ...createMockSyncPacket(patch)
            }
        }));
    };

    it('should show empty state when history is empty', () => {
        const lookup = new SnippetLookup(elements);
        lookup.mount();

        sendSync({ snippetHistory: [] });

        expect(elements.container.innerHTML).toContain('No injected snippets found');
        expect(elements.container.querySelector('.snippet-empty-icon')).not.toBeNull();
        expect(elements.container.querySelector('.snippet-empty-hint')).not.toBeNull();
    });

    it('should render session cards when multiple sessions exist', () => {
        const lookup = new SnippetLookup(elements);
        lookup.mount();

        sendSync({
            snippetHistory: [
                { id: 'session-1', sessionName: 'Session 1', snippets: [{ fsPath: '/test/s1.md', timestamp: Date.now() }, { fsPath: '/test/s2.md', timestamp: Date.now() }] },
                { id: 'session-2', sessionName: 'Session 2', snippets: [{ fsPath: '/test/s3.md', timestamp: Date.now() }] }
            ]
        });

        const cards = elements.container.querySelectorAll('.snippet-session-card');
        expect(cards.length).toBe(2);
        expect(cards[0].textContent).toContain('Session 1');
        expect(cards[0].textContent).toContain('2 snippets');
    });

    it('should render specific artifact icons based on filename', () => {
        const lookup = new SnippetLookup(elements);
        lookup.mount();

        // 1. Sync history
        sendSync({
            snippetHistory: [
                { 
                    id: 'session-1', 
                    sessionName: 'Session 1', 
                    snippets: [
                        { name: 'task.md', fsPath: '/path/task.md', timestamp: Date.now() },
                        { name: 'implementation_plan.md', fsPath: '/path/plan.md', timestamp: Date.now() },
                        { name: 'test.log', fsPath: '/path/test.log', timestamp: Date.now() }
                    ] 
                }
            ]
        });

        // 2. Click session to enter snippets layer
        const card = elements.container.querySelector('.snippet-session-card');
        card.click();

        // 3. Verify icons (Universal generic icon for all snippets)
        const items = elements.container.querySelectorAll('.snippet-item');
        expect(items[0].querySelector('.snippet-icon').textContent).toBe('📝');
        expect(items[1].querySelector('.snippet-icon').textContent).toBe('📝');
        expect(items[2].querySelector('.snippet-icon').textContent).toBe('📝');
    });

    it('should toggle accordion open and closed on repeated card clicks', () => {
        const lookup = new SnippetLookup(elements);
        lookup.mount();

        sendSync({
            snippetHistory: [{ id: 's1', sessionName: 'S1', snippets: [{ name: 'f1', fsPath: '/test/f1.md', timestamp: Date.now() }] }]
        });

        const card = elements.container.querySelector('.snippet-session-card') as HTMLElement;

        // First click — expands
        card.click();
        expect(elements.container.querySelector('.snippet-session-card.is-expanded')).not.toBeNull();
        expect(elements.container.querySelector('.snippet-inline-list')).not.toBeNull();

        // Second click — collapses
        elements.container.querySelector('.snippet-session-card.is-expanded').click();
        expect(elements.container.querySelector('.snippet-session-card.is-expanded')).toBeNull();
    });
});
