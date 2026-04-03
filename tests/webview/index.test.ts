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
            
            <div id="active-selection" class="context-slot selection">
                <span id="active-filename"></span>
                <span id="active-dir"></span>
            </div>
            
            <div id="reading-context" class="context-slot reader">
                <span id="reader-filename"></span>
                <span id="reader-dir"></span>
            </div>

            <button id="btn-load-file"></button>
            <button id="btn-clear-reader"></button>

            <div id="sentence-navigator" class="sentence-navigator">
                <div id="sentence-prev"></div>
                <div id="sentence-current"></div>
                <div id="sentence-next"></div>
            </div>

            <div class="engine-toggle-group">
                <button id="engine-local" class="toggle-pill active">SYSTEM</button>
                <button id="engine-neural" class="toggle-pill">PREMIUM</button>
            </div>

            <div id="settings-drawer" class="settings-drawer">
                <input type="range" id="rate-slider" min="-10" max="10" value="0" step="1">
                <input type="range" id="volume-slider" min="0" max="100" value="50">
                <div id="rate-val"></div>
                <div id="volume-val"></div>
                <div id="cache-debug-tag"></div>
                <div id="state-debug-tag"></div>
            </div>
            <button id="settings-toggle"></button>

            <div id="voice-list-container"></div>
            <input type="text" id="voice-search">

            <div id="chapter-list"></div>
            <span id="sentence-progress"></span>
            <span id="chapter-progress"></span>

            <button id="btn-autoplay"></button>
            <button id="btn-prev"></button>
            <button id="btn-prev-sentence"></button>
            <button id="btn-play"></button>
            <button id="btn-pause"></button>
            <button id="btn-next-sentence"></button>
            <button id="btn-next"></button>
            <button id="btn-stop"></button>
            <span id="status-dot"></span>
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
