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

    it('should have a reactive connection to StateStore', () => {
        // Resolve the webview first to establish the connection point
        provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);

        // Clear mocks to isolate the reactive change
        vi.clearAllMocks();

        // Access the internal stateStore (casting to any for testing)
        const stateStore = (provider as any)._stateStore as StateStore;
        
        // Trigger a change in StateStore
        stateStore.setProgress(1, 10);

        // EXPECTATION: Once we implement the reactive sync,
        // this should be called exactly once.
        const syncCalls = mockWebviewView.webview.postMessage.mock.calls.filter((call: any) => call[0].command === 'UI_SYNC');
        
        expect(syncCalls.length).toBe(1);
        expect(syncCalls[0][0].state.currentChapterIndex).toBe(1);
        expect(syncCalls[0][0].state.currentSentenceIndex).toBe(10);
    });
});
