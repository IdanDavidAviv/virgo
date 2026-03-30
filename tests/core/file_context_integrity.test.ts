import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DashboardRelay } from '../../src/extension/vscode/dashboardRelay';
import { StateStore } from '../../src/extension/core/stateStore';
import { DocumentLoadController } from '../../src/extension/core/documentLoadController';
import { PlaybackEngine } from '../../src/extension/core/playbackEngine';

// Mock vscode and node modules
vi.mock('vscode', () => ({
    window: {
        activeTextEditor: undefined,
        tabGroups: { activeTabGroup: { activeTab: undefined } }
    },
    workspace: { getWorkspaceFolder: vi.fn(), openTextDocument: vi.fn() },
    Uri: { file: (p: string) => ({ fsPath: p, toString: () => `file:///${p}` }) }
}));

describe('File Context Integrity (Regression Suite)', () => {
    let relay: DashboardRelay;
    let stateStore: StateStore;
    let docController: DocumentLoadController;
    let playbackEngine: PlaybackEngine;
    const logger = vi.fn();

    beforeEach(() => {
        stateStore = new StateStore(logger);
        docController = new DocumentLoadController(logger);
        playbackEngine = new PlaybackEngine(logger);
        relay = new DashboardRelay(stateStore, docController, playbackEngine, logger);
        
        relay.setView({
            visible: true,
            webview: {
                postMessage: vi.fn(),
                asWebviewUri: vi.fn(),
                onDidReceiveMessage: vi.fn(),
                cspSource: '',
                options: {},
                html: ''
            }
        } as any);
    });

    it('should provide distinct URIs for Mismatch Detection in webview', () => {
        // 1. Arrange: Focused is DIFFERENT from Active
        const focusedUri = 'c:/data/focused.md';
        const activeUri = 'c:/data/active.md';
        
        stateStore.setFocusedFile({ toString: () => focusedUri } as any, 'focused.md', 'data', true, 'V1');
        stateStore.setActiveDocument({ toString: () => activeUri } as any, 'active.md', 'data', 'V2');
        
        // 2. Act
        relay.sync('auto', 'neural', 'voice', 0, 50, [], []);

        // 3. Assert
        const postMessage = (relay as any)._view.webview.postMessage;
        const packet = postMessage.mock.calls[0][0];
        
        expect(packet.state.focusedDocumentUri).toBe(focusedUri);
        expect(packet.state.activeDocumentUri).toBe(activeUri);
        
        // Logical check: Webview derives mismatch from this
        const isMismatch = (packet.state.activeDocumentUri !== packet.state.focusedDocumentUri);
        expect(isMismatch).toBe(true);
    });

    it('should correctly propagate Path Normalization segments to UI', () => {
        // 1. Arrange: Deep directory structure
        const deepDir = 'Project / src / components / logic';
        stateStore.setFocusedFile({ toString: () => 'uri' } as any, 'File.md', deepDir, true);
        
        // 2. Act
        relay.sync('auto', 'neural', 'voice', 0, 50, [], []);

        // 3. Assert
        const packet = (relay as any)._view.webview.postMessage.mock.calls[0][0];
        expect(packet.state.focusedRelativeDir).toBe(deepDir);
        expect(packet.state.focusedFileName).toBe('File.md');
    });

    it('should maintain Badge Persistence (focusedVersionSalt) in sync packet', () => {
        // 1. Arrange: File has a 'T' timestamp badge
        const salt = 'T-12:45';
        stateStore.setFocusedFile({ toString: () => 'uri' } as any, 'file.md', 'dir', true, salt);
        
        // 2. Act
        relay.sync('auto', 'neural', 'voice', 0, 50, [], []);

        // 3. Assert
        const packet = (relay as any)._view.webview.postMessage.mock.calls[0][0];
        expect(packet.state.focusedVersionSalt).toBe(salt);
    });

    it('should correctly flag supported/unsupported files for UI button state', () => {
        // 1. Arrange: Non-supported file (e.g., .png)
        stateStore.setFocusedFile({ toString: () => 'image.png' } as any, 'image.png', 'assets', false);
        
        // 2. Act
        relay.sync('auto', 'neural', 'voice', 0, 50, [], []);

        // 3. Assert
        const packet = (relay as any)._view.webview.postMessage.mock.calls[0][0];
        expect(packet.state.focusedIsSupported).toBe(false);
        expect(packet.state.focusedFileName).toBe('image.png');
    });

    it('should reset context to "No Selection" when editor focus is lost', () => {
        // 1. Arrange: Initial focus
        stateStore.setFocusedFile({ toString: () => 'uri' } as any, 'file.md', 'dir', true);
        
        // 2. Act: Focus undefined (simulating setActiveEditor(undefined))
        stateStore.setFocusedFile(undefined, 'No Selection', '', false);
        relay.sync('auto', 'neural', 'voice', 0, 50, [], []);

        // 3. Assert
        const packet = (relay as any)._view.webview.postMessage.mock.calls[0][0];
        expect(packet.state.focusedFileName).toBe('No Selection');
        expect(packet.state.focusedDocumentUri).toBeNull();
    });
});
