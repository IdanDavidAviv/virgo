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
        },
        ConfigurationTarget: { Global: 1 }
    };
});

describe('SpeechProvider (Navigation Commands)', () => {
    let provider: SpeechProvider;
    let mockContext: any;
    let mockStatusBarItem: any;
    let mockLogger: any;
    let mockAudioBridge: any;

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
        
        // Access internal components for mocking
        mockAudioBridge = (provider as any)._audioBridge;
        (provider as any)._docController._chapters = [
            { sentences: ['S1C0', 'S2C0'] },
            { sentences: ['S1C1', 'S2C1'] },
            { sentences: ['S1C2', 'S2C2'] }
        ];
    });

    it('should trigger start(nextIdx, 0) for nextChapter command [ABSOLUTE JUMP]', async () => {
        const startSpy = vi.spyOn(mockAudioBridge, 'start').mockResolvedValue(undefined as any);
        const nextSpy = vi.spyOn(mockAudioBridge, 'next');

        // Set state to Chapter 0, Sentence 1
        const stateStore = (provider as any)._stateStore as StateStore;
        stateStore.setProgress(0, 1);

        await (provider as any)._handleWebviewMessage({ command: 'nextChapter' }, 'webview');

        // Expect absolute jump to Chapter 1, Sentence 0
        expect(startSpy).toHaveBeenCalledWith(1, 0, expect.anything(), false, undefined, undefined);
        // CRITICAL: Ensure we DID NOT call the relative next() method (which is the current bug)
        expect(nextSpy).not.toHaveBeenCalled();
    });

    describe('prevChapter (Smart Back Logic)', () => {
        it('should RESTART current chapter if sentenceIndex > 0', async () => {
            const startSpy = vi.spyOn(mockAudioBridge, 'start').mockResolvedValue(undefined as any);
            const stateStore = (provider as any)._stateStore as StateStore;
            
            // Middle of Chapter 1
            stateStore.setProgress(1, 1);

            await (provider as any)._handleWebviewMessage({ command: 'prevChapter' }, 'webview');

            // Expect restart of Chapter 1
            expect(startSpy).toHaveBeenCalledWith(1, 0, expect.anything(), false, undefined, undefined);
        });

        it('should JUMP TO PREVIOUS chapter if sentenceIndex === 0', async () => {
            const startSpy = vi.spyOn(mockAudioBridge, 'start').mockResolvedValue(undefined as any);
            const stateStore = (provider as any)._stateStore as StateStore;
            
            // Start of Chapter 1
            stateStore.setProgress(1, 0);

            await (provider as any)._handleWebviewMessage({ command: 'prevChapter' }, 'webview');

            // Expect jump to Chapter 0
            expect(startSpy).toHaveBeenCalledWith(0, 0, expect.anything(), false, undefined, undefined);
        });

        it('should do nothing if already at start of Chapter 0', async () => {
            const startSpy = vi.spyOn(mockAudioBridge, 'start').mockResolvedValue(undefined as any);
            const stateStore = (provider as any)._stateStore as StateStore;
            
            // Start of doc
            stateStore.setProgress(0, 0);

            await (provider as any)._handleWebviewMessage({ command: 'prevChapter' }, 'webview');

            expect(startSpy).not.toHaveBeenCalled();
        });
    });

    it('should correctly trigger nextSentence relative skip', async () => {
        const nextSpy = vi.spyOn(mockAudioBridge, 'next').mockImplementation(() => {});
        
        await (provider as any)._handleWebviewMessage({ command: 'nextSentence' }, 'webview');

        expect(nextSpy).toHaveBeenCalledWith(expect.anything(), true, 'auto', undefined, undefined);
    });
});
