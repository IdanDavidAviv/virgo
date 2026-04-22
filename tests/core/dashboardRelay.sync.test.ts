import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DashboardRelay } from '../../src/extension/vscode/dashboardRelay';
import { StateStore } from '../../src/extension/core/stateStore';
import { DocumentLoadController } from '../../src/extension/core/documentLoadController';
import { PlaybackEngine } from '../../src/extension/core/playbackEngine';

// Mock vscode
vi.mock('vscode', () => ({
    window: {
        activeTextEditor: undefined,
        tabGroups: { activeTabGroup: { activeTab: undefined } }
    },
    workspace: { 
        getWorkspaceFolder: vi.fn(), 
        openTextDocument: vi.fn(),
        onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
        getConfiguration: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue('Standard'),
            update: vi.fn().mockResolvedValue(undefined)
        })
    },
    Uri: { file: (p: string) => ({ fsPath: p, toString: () => p }) }
}));

describe('DashboardRelay (Unified Sync)', () => {
    let relay: DashboardRelay;
    let stateStore: StateStore;
    let docController: DocumentLoadController;
    let playbackEngine: PlaybackEngine;
    const logger = vi.fn();

    beforeEach(() => {
        stateStore = new StateStore(logger);
        docController = new DocumentLoadController(logger);
        playbackEngine = new PlaybackEngine(stateStore, logger);
        relay = new DashboardRelay(stateStore, docController, playbackEngine, logger);
        
        // Mock the view
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

    it('should aggregate rich state into a unified UI_SYNC packet', () => {
        // 1. Arrange
        stateStore.setActiveDocument({ toString: () => 'uri' } as any, 'file.md', 'dir');
        stateStore.setProgress(1, 2);
        
        (docController as any)._chapters = [
            { title: 'Ch1', level: 1, sentences: ['s1', 's2'] },
            { title: 'Ch2', level: 1, sentences: ['s3', 's4', 's5'] }
        ];

        // 2. Act
        relay.sync();

        // 3. Assert
        const postMessage = (relay as any)._view.webview.postMessage;
        expect(postMessage).toHaveBeenCalled();
        
        const packet = postMessage.mock.calls[0][0];
        expect(packet.command).toBe('UI_SYNC');
        expect(packet.activeFileName).toBe('file.md');
        expect(packet.currentChapterIndex).toBe(1);
        expect(packet.allChapters).toHaveLength(2);
        expect(packet.allChapters[0].count).toBe(2);
        expect(packet.playbackStalled).toBe(false);
    });

    it('should include sentence data at the root level for webview consumption', () => {
        // Arrange
        stateStore.setProgress(0, 0); // Chapter 0
        (docController as any)._chapters = [
            { title: 'Ch1', level: 1, sentences: ['s1', 's2'] }
        ];

        // Act
        relay.sync();

        // Assert
        const postMessage = (relay as any)._view.webview.postMessage;
        const packet = postMessage.mock.calls[0][0];
        
        expect(packet.currentSentences).toEqual(['s1', 's2']);
    });
});
