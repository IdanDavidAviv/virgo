import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { SpeechProvider } from '@vscode/speechProvider';
import { StateStore } from '@core/stateStore';

// Mock vscode
vi.mock('vscode', () => {
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
        workspace: {
            getWorkspaceFolder: vi.fn(),
            onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() }))
        }
    };
});

describe('SpeechProvider (Sync)', () => {
    let provider: SpeechProvider;
    let mockContext: any;
    let mockStatusBarItem: any;
    let mockLogger: any;
    let mockWebviewView: any;

    beforeEach(() => {
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
            }
        };

        mockStatusBarItem = {
            text: '',
            show: vi.fn(),
            dispose: vi.fn()
        };

        mockLogger = vi.fn();

        provider = new SpeechProvider(mockContext, mockLogger, mockStatusBarItem);

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

    it('should sync options (rate/volume) reactively from StateStore', () => {
        provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);
        const stateStore = (provider as any)._stateStore as StateStore;
        vi.clearAllMocks();

        stateStore.setOptions({ rate: 5, volume: 80 });

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

        const syncCalls = mockWebviewView.webview.postMessage.mock.calls.filter((call: any) => call[0].command === 'UI_SYNC');
        expect(syncCalls.length).toBe(1);
        expect(syncCalls[0][0].availableVoices.local.length).toBe(1);
        expect(syncCalls[0][0].availableVoices.neural.length).toBe(1);
    });

    it('should handle webview commands and trigger reactive sync + persistence', async () => {
        provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);
        const stateStore = (provider as any)._stateStore as StateStore;
        vi.clearAllMocks();

        // Simulate voiceChanged command
        await (provider as any)._handleWebviewMessage({ command: 'voiceChanged', voice: 'new-voice' });

        // 1. Verify StateStore update
        expect(stateStore.state.selectedVoice).toBe('new-voice');

        // 2. Verify globalState persistence
        expect(mockContext.globalState.update).toHaveBeenCalledWith('readAloud.voice', 'new-voice');

        // 3. Verify UI_SYNC broadcast
        const syncCalls = mockWebviewView.webview.postMessage.mock.calls.filter((call: any) => call[0].command === 'UI_SYNC');
        expect(syncCalls.length).toBeGreaterThanOrEqual(1);
        expect(syncCalls[syncCalls.length - 1][0].selectedVoice).toBe('new-voice');
    });

    it('should propagate playback engine status through StateStore to UI_SYNC', () => {
        provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);
        const engine = (provider as any)._playbackEngine;
        vi.clearAllMocks();

        // Simulate a "stalled" engine status
        (engine as any)._isStalled = true;
        engine.emit('status');

        const syncCalls = mockWebviewView.webview.postMessage.mock.calls.filter((call: any) => call[0].command === 'UI_SYNC');
        expect(syncCalls.length).toBe(1);
        expect(syncCalls[0][0].playbackStalled).toBe(true);
    });
});
