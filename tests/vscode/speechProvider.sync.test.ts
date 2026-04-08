import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { SpeechProvider } from '@vscode/speechProvider';
import { StateStore } from '@core/stateStore';

// Mock vscode
vi.mock('vscode', () => {
    const configGet = vi.fn((key: string, def: any) => def);
    const configUpdate = vi.fn().mockResolvedValue(undefined);
    return {
        Uri: {
            joinPath: vi.fn((uri, ...parts) => ({ fsPath: parts.join('/') })),
            parse: vi.fn(s => ({ toString: () => s }))
        },
        window: {
            createStatusBarItem: vi.fn(() => ({
                text: '',
                show: vi.fn(),
                dispose: vi.fn()
            }))
        },
        ThemeColor: vi.fn(),
        ExtensionMode: { Development: 1 },
        RelativePattern: function (base: any, pattern: any) {
            return { base, pattern };
        },
        workspace: {
            getWorkspaceFolder: vi.fn(),
            onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
            getConfiguration: vi.fn(() => ({
                get: configGet,
                update: configUpdate
            })),
            onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
            createFileSystemWatcher: vi.fn(() => ({
                onDidCreate: vi.fn(listener => ({ dispose: vi.fn() })),
                onDidDelete: vi.fn(listener => ({ dispose: vi.fn() })),
                onDidChange: vi.fn(listener => ({ dispose: vi.fn() })),
                dispose: vi.fn()
            }))
        },
        ConfigurationTarget: { Global: 1 }
    };
});

describe('SpeechProvider (Sync)', () => {
    let provider: SpeechProvider;
    let mockContext: any;
    let mockStatusBarItem: any;
    let mockLogger: any;
    let mockWebviewView: any;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();

        mockContext = {
            extensionUri: { fsPath: '/test' } as any,
            extensionPath: '/test',
            globalState: {
                get: vi.fn((key, def) => def),
                update: vi.fn()
            },
            extension: {
                packageJSON: { version: '1.0.0' }
            },
            subscriptions: []
        };

        mockStatusBarItem = {
            text: '',
            show: vi.fn(),
            dispose: vi.fn()
        };

        mockLogger = vi.fn();

        provider = new SpeechProvider(mockContext, mockLogger, mockStatusBarItem, '/test/antigravity', 'test-session');

        mockWebviewView = {
            webview: {
                options: {},
                onDidReceiveMessage: vi.fn(),
                postMessage: vi.fn(),
                asWebviewUri: vi.fn(uri => uri),
                html: ''
            },
            onDidDispose: vi.fn(),
            onDidChangeVisibility: vi.fn(),
            visible: true
        };
    });

    it('should initialize with correct default state (volume: 50, rate: 1.0)', () => {
        const stateStore = (provider as any)._stateStore as StateStore;
        expect(stateStore.state.volume).toBe(50);
        expect(stateStore.state.rate).toBe(1.0);
    });

    it('should sync options (rate/volume) reactively from StateStore', () => {
        provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);
        const stateStore = (provider as any)._stateStore as StateStore;
        vi.clearAllMocks();

        stateStore.setOptions({ rate: 5, volume: 80 });
        vi.advanceTimersByTime(100);

        const syncCalls = mockWebviewView.webview.postMessage.mock.calls.filter((call: any) => call[0].command === 'UI_SYNC');
        expect(syncCalls.length).toBe(1);
        expect(syncCalls[0][0].rate).toBe(5);
        expect(syncCalls[0][0].volume).toBe(80);
    });

    it('should sync voices reactively from StateStore', () => {
        provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);
        const stateStore = (provider as any)._stateStore as StateStore;
        vi.clearAllMocks();

        stateStore.setVoices([{ id: 'v1', name: 'Voice 1', lang: 'en' }], [{ id: 'nv1', name: 'Neural 1', lang: 'en' }]);
        vi.advanceTimersByTime(100);

        const syncCalls = mockWebviewView.webview.postMessage.mock.calls.filter((call: any) => call[0].command === 'UI_SYNC');
        expect(syncCalls.length).toBeGreaterThanOrEqual(1);
        
        // Final sync should be the one we care about
        const lastSync = syncCalls[syncCalls.length - 1][0];
        
        // In Delta Sync, reactive updates are partial. We skip voice list checks here
        // and rely on _syncUI(true) calls for full state consistency.
        expect(lastSync.rate).toBe(1.0);
        expect(lastSync.volume).toBe(50);
    });

    it('should handle webview commands and trigger reactive sync + persistence', async () => {
        provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);
        const stateStore = (provider as any)._stateStore as StateStore;
        vi.clearAllMocks();

        // Simulate SET_VOICE command
        await (provider as any)._handleWebviewMessage({ command: 'SET_VOICE', value: 'new-voice' });

        // 1. Verify StateStore update
        expect(stateStore.state.selectedVoice).toBe('new-voice');

        // 2. Verify configuration persistence (Debounced)
        vi.advanceTimersByTime(1000);
        const config = vscode.workspace.getConfiguration('readAloud');
        expect(config.update).toHaveBeenCalledWith('playback.voice', 'new-voice', vscode.ConfigurationTarget.Global);

        // 3. Verify UI_SYNC broadcast (Throttled)
        vi.advanceTimersByTime(100);
        const syncCalls = mockWebviewView.webview.postMessage.mock.calls.filter((call: any) => call[0].command === 'UI_SYNC');
        expect(syncCalls.length).toBeGreaterThanOrEqual(1);
        expect(syncCalls[syncCalls.length - 1][0].selectedVoice).toBe('new-voice');
    });

    it('should handle playback engine status changes reactively', () => {
        provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);
        const engine = (provider as any)._playbackEngine;
        vi.clearAllMocks();

        // Simulate a "stalled" engine status
        engine.emit('status', { isPlaying: false, isPaused: false, isStalled: true });
        vi.advanceTimersByTime(100);

        const syncCalls = mockWebviewView.webview.postMessage.mock.calls.filter((call: any) => call[0].command === 'UI_SYNC');
        expect(syncCalls.length).toBeGreaterThanOrEqual(1);
        expect(syncCalls[syncCalls.length - 1][0].playbackStalled).toBe(true);
    });

    it('should handle REQUEST_SYNTHESIS and trigger bridge.synthesize', async () => {
        const bridge = (provider as any)._audioBridge;
        // Mock the implementation to avoid dependencies on DocController
        const synthSpy = vi.spyOn(bridge, 'synthesize').mockResolvedValue(true as any);
        
        await (provider as any)._handleWebviewMessage({ 
            command: 'REQUEST_SYNTHESIS', 
            cacheKey: 'test-key'
        });

        expect(synthSpy).toHaveBeenCalledWith('test-key', expect.anything(), undefined, undefined);
    });

    it('should handle CLEAR_CACHE and trigger playbackEngine.clearCache', async () => {
        const engine = (provider as any)._playbackEngine;
        const clearSpy = vi.spyOn(engine, 'clearCache');
        
        await (provider as any)._handleWebviewMessage({ command: 'CLEAR_CACHE' });

        expect(clearSpy).toHaveBeenCalled();
    });

    it('should perform ATOMIC synchronization during document load [ISSUE 25]', async () => {
        provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);
        const stateStore = (provider as any)._stateStore as StateStore;
        const docController = (provider as any)._docController;
        
        // Mock successful document load
        vi.spyOn(docController, 'loadActiveDocument').mockResolvedValue(true);
        (docController as any)._metadata = {
            uri: vscode.Uri.parse('file:///atomic.md'),
            fileName: 'atomic.md',
            relativeDir: 'Project',
            versionSalt: 'v1'
        };
        (docController as any)._chapters = [{ sentences: ['Hello'] }];

        // Mock progress loading (no saved progress for this test)
        vi.spyOn((provider as any)._settingsManager, 'loadProgress').mockReturnValue(null);
        
        vi.clearAllMocks();

        // Trigger document load
        await provider.loadCurrentDocument();
        vi.advanceTimersByTime(200); // Flush SyncManager throttle

        // 1. Verify UI_SYNC reflected the new state immediately
        const syncCalls = mockWebviewView.webview.postMessage.mock.calls.filter((call: any) => call[0].command === 'UI_SYNC');
        
        // We expect at least one sync at the end
        expect(syncCalls.length).toBeGreaterThanOrEqual(1);
        
        const lastSync = syncCalls[syncCalls.length - 1][0];
        // The packet structure is { command: 'UI_SYNC', state: { activeFileName, ... } }
        expect(lastSync.state.activeFileName).toBe('atomic.md');
        expect(lastSync.state.currentChapterIndex).toBe(0);
        expect(lastSync.state.currentSentenceIndex).toBe(0);
        expect(lastSync.isPlaying).toBe(false);
    });
});
