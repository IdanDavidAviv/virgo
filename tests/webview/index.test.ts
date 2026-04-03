import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bootstrap } from '../../src/webview/index';
import { WebviewStore } from '../../src/webview/core/WebviewStore';
import { MessageClient } from '../../src/webview/core/MessageClient';
import { WebviewAudioEngine } from '../../src/webview/core/WebviewAudioEngine';

/**
 * @vitest-environment jsdom
 */

describe('Webview Bootstrap: Debug Mode (TDD)', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="debug-mode-tag" style="display: none;"></div>
            <div id="toast-container"></div>
            <div id="sentence-navigator"></div>
            <div id="btn-play"></div>
            <div id="btn-pause"></div>
            <div id="btn-stop"></div>
            <div id="btn-prev"></div>
            <div id="btn-next"></div>
            <div id="btn-prev-sentence"></div>
            <div id="btn-next-sentence"></div>
            <div id="btn-autoplay"></div>
            <div id="status-dot"></div>
            <div id="chapter-list"></div>
            <div id="sentence-progress"></div>
            <div id="chapter-progress"></div>
            <div id="settings-drawer"></div>
            <div id="settings-toggle"></div>
            <input id="volume-slider" />
            <input id="rate-slider" />
            <button id="engine-neural"></button>
            <button id="engine-local"></button>
            <div id="rate-val"></div>
            <div id="volume-val"></div>
            <div id="cache-debug-tag"></div>
            <div id="state-debug-tag"></div>
            <div id="voice-list-container"></div>
            <input id="voice-search" />
            <button id="btn-load-file"></button>
            <button id="btn-clear-reader"></button>
            <div class="context-slot selection"></div>
            <div id="active-filename"></div>
            <div id="active-dir"></div>
            <div class="context-slot reader"></div>
            <div id="reader-filename"></div>
            <div id="reader-dir"></div>
        `;
        
        // Mock Globals
        (window as any).__BOOTSTRAP_CONFIG__ = { debugMode: false };
        (window as any).vscode = { postMessage: vi.fn() };
        (window as any).acquireVsCodeApi = vi.fn(() => ({ postMessage: vi.fn() }));

        // Reset Singletons for clean state
        WebviewStore.resetInstance();
        MessageClient.resetInstance();
        WebviewAudioEngine.resetInstance();
    });

    it('SHOULD show debug-mode-tag if config.debugMode is true', async () => {
        (window as any).__BOOTSTRAP_CONFIG__ = { debugMode: true };
        
        // Trigger bootstrap explicitly
        bootstrap();

        const debugTag = document.getElementById('debug-mode-tag');
        expect(debugTag?.style.display).toBe('inline-block');
    });

    it('SHOULD NOT show debug-mode-tag if config.debugMode is false', async () => {
        (window as any).__BOOTSTRAP_CONFIG__ = { debugMode: false };
        
        bootstrap();

        const debugTag = document.getElementById('debug-mode-tag');
        expect(debugTag?.style.display).toBe('none');
    });
});
