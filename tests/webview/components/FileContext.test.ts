/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileContext } from '@webview/components/FileContext';
import { WebviewStore } from '@webview/core/WebviewStore';
import { MessageClient } from '@webview/core/MessageClient';
// import { SessionController } from '@webview/sessionController';
import { resetAllSingletons, wireDispatcher, FULL_DOM_TEMPLATE } from '../testUtils';

describe('FileContext (Optimistic UI)', () => {
    let elements: any;
    let ctrl: FileContext;

    beforeEach(() => {
        document.body.innerHTML = FULL_DOM_TEMPLATE;
        
        // 1. Reset everything FIRST
        resetAllSingletons();
        
        // 2. Mock Globals specifically for this test
        const mockVscode = { postMessage: vi.fn() };
        (window as any).acquireVsCodeApi = vi.fn(() => mockVscode);
        (window as any).vscode = mockVscode;

        elements = {
            activeSlot: document.querySelector('.context-slot.selection'),
            readerSlot: document.querySelector('.context-slot.reader'),
            activeFilename: document.getElementById('active-filename'),
            activeDir: document.getElementById('active-dir'),
            readerFilename: document.getElementById('reader-filename'),
            readerDir: document.getElementById('reader-dir'),
            btnLoadFile: document.getElementById('btn-load-file'),
            btnResetContext: document.getElementById('btn-clear-reader'),
            btnModeFile: document.getElementById('btn-mode-file'),
            btnModeSnippet: document.getElementById('btn-mode-snippet'),
            fileModeContainer: document.getElementById('file-mode-container'),
            snippetLookupContainer: document.getElementById('snippet-lookup-container'),
            transferLayer: document.getElementById('transfer-layer')
        };
        
        wireDispatcher();
    });

    afterEach(() => {
        if (ctrl) { ctrl.unmount(); }
        vi.clearAllMocks();
    });

    it('should implement optimistic "Loading..." feedback on Load File click', async () => {
        ctrl = new FileContext(elements);
        ctrl.mount();

        // [STABILITY] Must set a supported focused file so btnLoadFile is enabled for clicking
        WebviewStore.getInstance().updateState({
            focusedDocumentUri: 'file:///test.md', 
            focusedIsSupported: true,
            activeDocumentUri: null
        });

        const btn = elements.btnLoadFile;
        expect(btn.disabled).toBe(false);

        btn.click();

        // Assertion 1: Optimistic UI should show 'Loading Document...'
        expect(elements.readerFilename.textContent).toBe('Loading Document...');
        expect(elements.btnLoadFile.disabled).toBe(true);
        expect(elements.btnLoadFile.classList.contains('is-loading')).toBe(true);
    });

    it('should implement optimistic clearing of reader slot on Clear click', async () => {
        ctrl = new FileContext(elements);
        ctrl.mount();

        // Initial state active
        WebviewStore.getInstance().updateState({
            activeDocumentUri: 'file:///test.md', activeFileName: 'test.md'
        });

        const btn = elements.btnResetContext;
        btn.click();

        // Assertion 1: Optimistic UI should show 'Clearing...'
        expect(elements.readerFilename.textContent).toBe('Clearing...');
        expect(btn.disabled).toBe(true);
    });

    it('should revert from optimistic state when sync completes', async () => {
        ctrl = new FileContext(elements);
        ctrl.mount();

        // Enable button
        WebviewStore.getInstance().updateState({
            focusedDocumentUri: 'file:///done.md', focusedIsSupported: true
        });

        const btn = elements.btnLoadFile;
        btn.click();
        expect(elements.readerFilename.textContent).toBe('Loading Document...');

        // Simulate extension response (UI_SYNC clears isAwaitingSync)
        WebviewStore.getInstance().updateUIState({ isAwaitingSync: false });
        WebviewStore.getInstance().updateState({
            activeDocumentUri: 'file:///done.md', activeFileName: 'done.md'
        });

        // Use vi.waitFor for the final sync since it might involve state propagation
        await vi.waitFor(() => {
            expect(elements.readerFilename.textContent).toContain('done.md');
        });
        expect(elements.btnLoadFile.disabled).toBe(false);
    });

    it('should render focusedVersionSalt as a .version-badge span in the focused file slot', () => {
        // Law F.1 — focusedVersionSalt MUST be rendered via innerHTML, not textContent
        ctrl = new FileContext(elements);
        ctrl.mount();

        WebviewStore.getInstance().updateState({
            focusedDocumentUri: 'file:///readme.md',
            focusedFileName: 'readme.md',
            focusedIsSupported: true,
            focusedVersionSalt: 'V3'
        } as any);

        // The filename element must contain a <span class="version-badge"> with the salt
        const badge = elements.activeFilename.querySelector('.version-badge');
        expect(badge).not.toBeNull();
        expect(badge.textContent).toBe('V3');
        // The visible text must contain the filename too
        expect(elements.activeFilename.textContent).toContain('readme.md');
    });

    it('should NOT render a .version-badge in the focused slot when salt is absent', () => {
        ctrl = new FileContext(elements);
        ctrl.mount();

        WebviewStore.getInstance().updateState({
            focusedDocumentUri: 'file:///plain.md',
            focusedFileName: 'plain.md',
            focusedIsSupported: true,
            focusedVersionSalt: undefined
        } as any);

        const badge = elements.activeFilename.querySelector('.version-badge');
        expect(badge).toBeNull();
        expect(elements.activeFilename.textContent).toBe('plain.md');
    });
});
