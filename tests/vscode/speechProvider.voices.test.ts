import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { SpeechProvider } from '@vscode/speechProvider';
import { StateStore } from '@core/stateStore';

// Mock vscode
vi.mock('vscode', () => ({
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
        onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
        onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
        getConfiguration: vi.fn().mockReturnValue({
            get: vi.fn((key, def) => def),
            update: vi.fn().mockResolvedValue(undefined)
        }),
        createFileSystemWatcher: vi.fn(() => ({
            onDidCreate: vi.fn(listener => ({ dispose: vi.fn() })),
            onDidDelete: vi.fn(listener => ({ dispose: vi.fn() })),
            onDidChange: vi.fn(listener => ({ dispose: vi.fn() })),
            dispose: vi.fn()
        }))
    },
    RelativePattern: function (base: any, pattern: any) {
        return { base, pattern };
    }
}));

describe('SpeechProvider (Voice Lifecycle)', () => {
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

    it('should broadcast voices when the dashboard sends a ready signal', async () => {
        provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);
        const postMessageSpy = vi.spyOn(mockWebviewView.webview, 'postMessage');
        
        // Pre-populate voices so we have something to broadcast
        const stateStore = (provider as any)._stateStore as StateStore;
        const testNeuralVoice = { id: 'nv1', name: 'Neural 1', lang: 'en' };
        stateStore.setVoices([], [testNeuralVoice]);
        
        // Flush any reactive reactive throttled syncs
        vi.advanceTimersByTime(100); 

        // Simulate the actual command 'ready' which dashboard.js sends on boot
        // [RESOLVE] ready command MUST trigger _syncUI(true)
        const engine = (provider as any)._playbackEngine;
        vi.spyOn(engine, 'getVoices').mockResolvedValue({ local: [], neural: [{ id: 'nv1', name: 'Neural 1', lang: 'en' }] });

        const handler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0];
        await handler({ command: 'ready' });
        
        // ASSERT: Handshake MUST be atomic and include voices to prevent UI flicker
        await vi.waitFor(() => {
            const calls = postMessageSpy.mock.calls;
            const fullSyncCall = [...calls].reverse().find((call: any) => 
                call[0].command === 'UI_SYNC' && call[0].availableVoices !== undefined
            );
            expect(fullSyncCall).toBeDefined();
        }, { timeout: 3000 });

        const calls = postMessageSpy.mock.calls;
        const fullSyncCall = [...calls].reverse().find((call: any) => 
            call[0].command === 'UI_SYNC' && call[0].availableVoices !== undefined
        );
        const packet = fullSyncCall![0] as any;
        expect(packet.availableVoices.neural.length).toBeGreaterThan(0);
        expect(packet.availableVoices.neural[0].id).toBe('nv1');
    });

    it('should update the state store correctly after background scan completes', async () => {
        const stateStore = (provider as any)._stateStore as StateStore;
        const setVoicesSpy = vi.spyOn(stateStore, 'setVoices');

        // Mock the internal playbackEngine to return specific voices
        const engine = (provider as any)._playbackEngine;
        vi.spyOn(engine, 'getVoices').mockResolvedValue({
            local: ['Local1'],
            neural: [{ name: 'Neural1', id: 'n1', lang: 'en', gender: 'Female' } as any]
        });

        // Trigger the asynchronous load
        await (provider as any)._voiceManager.scanAndSync();
        vi.advanceTimersByTime(100); 

        expect(setVoicesSpy).toHaveBeenCalledWith(['Local1'], expect.arrayContaining([expect.objectContaining({ name: 'Neural1' })]));
        expect(stateStore.state.availableVoices.neural.length).toBe(1);
    });

    it('should trigger a UI_SYNC immediately after a successful scan', async () => {
        provider.resolveWebviewView(mockWebviewView, {} as any, {} as any);
        const postMessageSpy = vi.spyOn(mockWebviewView.webview, 'postMessage');
        
        // Mock success
        const engine = (provider as any)._playbackEngine;
        vi.spyOn(engine, 'getVoices').mockResolvedValue({ local: [], neural: [] });

        await (provider as any)._voiceManager.scanAndSync();
        vi.advanceTimersByTime(100); 

        // Verify [UI_SYNC] was triggered to notify dashboard that scan is done
        const syncCalls = postMessageSpy.mock.calls.filter((call: any) => call[0].command === 'UI_SYNC');
        expect(syncCalls.length).toBeGreaterThanOrEqual(1);
    });
});
