import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs';
import { SettingsManager } from '@vscode/SettingsManager';

// Mock modules
vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: vi.fn(),
        onDidChangeConfiguration: vi.fn()
    },
    ConfigurationTarget: { Global: 1 }
}));
vi.mock('fs');
vi.mock('path', () => ({
    join: vi.fn((...parts) => parts.join('/'))
}));

describe('SettingsManager', () => {
    let settingsManager: SettingsManager;
    let mockContext: any;
    let mockStateStore: any;
    let mockLogger: any;

    beforeEach(() => {
        vi.clearAllMocks();
        mockContext = {
            subscriptions: [],
            globalState: {
                get: vi.fn(),
                update: vi.fn()
            }
        };
        mockStateStore = {
            setOptions: vi.fn(),
            state: { autoInjectSITREP: true }
        };
        mockLogger = vi.fn();

        // Mock vscode.workspace.getConfiguration()
        const mockConfig = {
            get: vi.fn((key) => {
                if (key === 'playback.rate') { return 1.5; }
                if (key === 'playback.volume') { return 80; }
                return undefined;
            }),
            update: vi.fn().mockResolvedValue(undefined)
        };
        vi.mocked(vscode.workspace.getConfiguration).mockReturnValue(mockConfig as any);
        vi.mocked(vscode.workspace.onDidChangeConfiguration).mockReturnValue({ dispose: vi.fn() } as any);

        settingsManager = new SettingsManager(
            mockContext,
            mockStateStore,
            mockLogger,
            '/root',
            'session-1'
        );
    });

    it('should initialize and load configuration into state store', () => {
        settingsManager.initialize();
        expect(mockStateStore.setOptions).toHaveBeenCalledWith(expect.objectContaining({
            rate: 1.5,
            volume: 80
        }));
    });

    it('should migrate legacy settings once', () => {
        mockContext.globalState.get.mockReturnValueOnce(2.0); // legacy rate
        settingsManager.initialize();
        
        expect(mockContext.globalState.update).toHaveBeenCalledWith('readAloud.rate', undefined);
    });

    it('should bridge settings to agent session state', () => {
        vi.mocked(fs.existsSync).mockReturnValue(true);
        vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));
        
        settingsManager.bridgeAgentState(true);
        
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            expect.stringContaining('extension_state.json'),
            expect.stringContaining('"autoInjectSITREP": true')
        );
    });
});
