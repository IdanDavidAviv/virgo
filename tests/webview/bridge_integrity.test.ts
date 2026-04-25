import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WebviewStore } from '../../src/webview/core/WebviewStore';
import { MessageClient } from '../../src/webview/core/MessageClient';
import { CommandDispatcher } from '../../src/webview/core/CommandDispatcher';
import { PlaybackController } from '../../src/webview/playbackController';
import { IncomingCommand, OutgoingAction } from '../../src/common/types';
import { SnippetLookup } from '../../src/webview/components/SnippetLookup';

/**
 * @vitest-environment jsdom
 */

describe('Bridge Integrity & Sanitization [v2.3.1]', () => {
    let store: WebviewStore;
    let client: MessageClient;
    let dispatcher: CommandDispatcher;

    beforeEach(() => {
        WebviewStore.resetInstance();
        MessageClient.resetInstance();
        PlaybackController.resetInstance();
        CommandDispatcher.resetInstance();
        
        document.body.innerHTML = '<div id="snippet-lookup-container"></div>';
        
        store = WebviewStore.getInstance();
        client = MessageClient.getInstance();
        dispatcher = CommandDispatcher.getInstance();
        
        vi.spyOn(client, 'postAction').mockImplementation(() => { });
    });

    it('T9.1 — should not crash on a partial sync packet missing "delta"', async () => {
        await expect(
            dispatcher.dispatch(IncomingCommand.UI_SYNC, {
                isPlaying: true,
                activeFileName: 'test.md'
            } as any)
        ).resolves.not.toThrow();
        
        expect(store.getState()?.isPlaying).toBe(true);
    });

    it('T9.2 — Authoritative STOP interrupts stale events', async () => {
        // Mock state
        store.patchState({ isPlaying: true });
        
        // Trigger STOP
        await dispatcher.dispatch(IncomingCommand.STOP, null);
        expect(store.getState()?.isPlaying).toBe(false);
    });

    it('T9.3 — Snippet History renders all valid sessions (brain-path filter removed, T-038)', async () => {
        const lookup = new SnippetLookup({
            container: document.getElementById('snippet-lookup-container') as HTMLElement
        });
        lookup.mount();
        
        const MOCK_HISTORY = [
            { id: 'user-session', sessionName: 'My Snippets', snippets: [{ fsPath: 'c:/virgo/s1.md', name: 'S1', timestamp: Date.now() }] },
            { id: 'brain-session', sessionName: 'Agent Brain', snippets: [{ fsPath: 'c:/brain/task.md', name: 'Task', timestamp: Date.now() }] }
        ];

        await dispatcher.dispatch(IncomingCommand.UI_SYNC, {
            snippetHistory: MOCK_HISTORY,
            isHydrated: true
        } as any);

        const container = document.getElementById('snippet-lookup-container')!;
        // [T-038] brain-path UI filter removed — MCP snippets legitimately live in brain/ dirs.
        // Both sessions are valid (have an id) and must be rendered.
        expect(container.querySelectorAll('.snippet-session-card').length).toBe(2);
        expect(container.textContent).toContain('My Snippets');
        expect(container.textContent).toContain('Agent Brain');
    });
});
