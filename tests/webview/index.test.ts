import { describe, it, expect, beforeEach, vi } from 'vitest';
import { bootstrap } from '../../src/webview/index';
import { WebviewStore } from '../../src/webview/core/WebviewStore';
import { MessageClient } from '../../src/webview/core/MessageClient';
import { WebviewAudioEngine } from '../../src/webview/core/WebviewAudioEngine';
import { resetAllSingletons, FULL_DOM_TEMPLATE } from './testUtils';

/**
 * @vitest-environment jsdom
 */

describe('Webview Bootstrap: Debug Mode (TDD)', () => {
    beforeEach(() => {
        document.body.innerHTML = FULL_DOM_TEMPLATE;
        
        // 1. Reset everything first
        resetAllSingletons();

        // 2. Mock Globals specifically for this test
        const mockVscode = { postMessage: vi.fn() };
        (window as any).acquireVsCodeApi = vi.fn(() => mockVscode);
        (window as any).vscode = mockVscode;
        (window as any).__BOOTSTRAP_CONFIG__ = { debugMode: false };
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
