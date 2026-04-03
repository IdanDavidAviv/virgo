/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileContext } from '@webview/components/FileContext';
import { WebviewStore } from '@webview/core/WebviewStore';
import { MessageClient } from '@webview/core/MessageClient';
import { OutgoingAction } from '@common/types';

describe('FileContext (Optimistic UI)', () => {
    let elements: any;
    let ctrl: FileContext;

    beforeEach(() => {
        document.body.innerHTML = `
            <div class="context-slot selection active">
                <span id="active-filename">test.md</span>
                <span id="active-dir">/docs</span>
                <button id="btn-load-file">Load</button>
            </div>
            <div class="context-slot reader">
                <span id="reader-filename"></span>
                <span id="reader-dir"></span>
                <button id="btn-clear-reader">Clear</button>
            </div>
        `;
        elements = {
            activeSlot: document.querySelector('.context-slot.selection'),
            readerSlot: document.querySelector('.context-slot.reader'),
            activeFilename: document.getElementById('active-filename'),
            activeDir: document.getElementById('active-dir'),
            readerFilename: document.getElementById('reader-filename'),
            readerDir: document.getElementById('reader-dir'),
            btnLoadFile: document.getElementById('btn-load-file'),
            btnClearReader: document.getElementById('btn-clear-reader')
        };
        WebviewStore.resetInstance();
        MessageClient.resetInstance();
    });

    afterEach(() => {
        if (ctrl) { ctrl.unmount(); }
        vi.clearAllMocks();
    });

    it('should implement optimistic "Loading..." feedback on Load File click', () => {
        ctrl = new FileContext(elements);
        ctrl.mount();

        const btn = elements.btnLoadFile;
        btn.click();

        // Immediate visual feedback
        expect(elements.readerFilename.textContent).toBe('Loading Document...');
        expect(btn.classList.contains('pulse')).toBe(true);
        expect(btn.classList.contains('is-loading')).toBe(true);
    });

    it('should implement optimistic clearing of reader slot on Clear click', () => {
        // Hydrate reader slot first
        elements.readerFilename.textContent = 'current.md';
        elements.readerDir.textContent = '/docs';
        elements.readerSlot.classList.add('active');

        ctrl = new FileContext(elements);
        ctrl.mount();

        const store = WebviewStore.getInstance();
        const patchSpy = vi.spyOn(store, 'optimisticPatch');

        elements.btnClearReader.click();

        // Immediate store patch
        expect(patchSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                state: expect.objectContaining({
                    activeDocumentUri: null,
                    activeFileName: null
                })
            }),
            { isAwaitingSync: true }
        );

        // Immediate visual clear (since component is subscribed to state)
        // Note: BaseComponent.mount() handles subscription automatically.
        // We expect the reader Slot to be cleared immediately by the synchronous store notification.
        expect(elements.readerFilename.textContent).toBe('No File Loaded');
        expect(elements.readerDir.textContent).toBe('');
        expect(elements.readerSlot.classList.contains('active')).toBe(false);
    });
});
