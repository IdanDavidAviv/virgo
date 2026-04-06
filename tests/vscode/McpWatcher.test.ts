import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { McpWatcher } from '@extension/vscode/McpWatcher';
import { StateStore } from '@core/stateStore';
import { DocumentLoadController } from '@core/documentLoadController';

// Mock vscode
vi.mock('vscode', () => {
    return {
        RelativePattern: vi.fn(function(base, pattern) {
            return { base, pattern };
        }),
        workspace: {
            createFileSystemWatcher: vi.fn(() => ({
                onDidCreate: vi.fn(),
                onDidDelete: vi.fn(),
                onDidChange: vi.fn(),
                dispose: vi.fn()
            }))
        },
        Uri: {
            file: vi.fn(f => ({ fsPath: f, toString: () => `file://${f}` }))
        }
    };
});

// Mock fs
vi.mock('fs', () => ({
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn()
}));

describe('McpWatcher (TDD Phase 1)', () => {
    let watcher: McpWatcher;
    let mockStateStore: any;
    let mockDocController: any;
    let mockLogger: any;
    let mockWatcherInstance: any;
    let onCreateListener: (uri: any) => void;

    beforeEach(() => {
        vi.clearAllMocks();

        mockStateStore = {
            state: { autoPlayOnInjection: false },
            setActiveDocument: vi.fn(),
            setActiveMode: vi.fn()
        };

        mockDocController = {
            loadSnippet: vi.fn().mockResolvedValue(true),
            metadata: {
                uri: 'file:///test.md',
                fileName: 'test.md',
                relativeDir: 'session1',
                versionSalt: 'v1',
                contentHash: 'h1'
            }
        };

        mockLogger = vi.fn();

        mockWatcherInstance = {
            onDidCreate: vi.fn(l => { 
                onCreateListener = l;
                return { dispose: vi.fn() };
            }),
            dispose: vi.fn()
        };

        (vscode.workspace.createFileSystemWatcher as any).mockReturnValue(mockWatcherInstance);

        watcher = new McpWatcher(
            '/antigravity',
            'session-1',
            mockStateStore,
            mockDocController,
            mockLogger
        );
    });

    it('should initialize a filesystem watcher for the antigravity root', () => {
        expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledWith(
            expect.objectContaining({ base: '/antigravity', pattern: '**/*.md' }),
            false, true, true
        );
        expect(mockWatcherInstance.onDidCreate).toHaveBeenCalled();
    });

    it('should detect a new snippet and trigger a session pivot if needed', async () => {
        const pivotSpy = vi.fn();
        watcher.onSessionPivot(pivotSpy);

        const newSnippetUri = { fsPath: path.join('/antigravity', 'session-2', 'snippet.md') };
        
        // Trigger the listener
        await onCreateListener(newSnippetUri);

        expect(pivotSpy).toHaveBeenCalledWith('session-2');
    });

    it('should load the snippet into the DocController and update state', async () => {
        const newSnippetUri = { fsPath: path.join('/antigravity', 'session-1', 'snippet.md') };
        
        await onCreateListener(newSnippetUri);

        expect(mockDocController.loadSnippet).toHaveBeenCalledWith(newSnippetUri.fsPath);
        expect(mockStateStore.setActiveDocument).toHaveBeenCalledWith(
            'file:///test.md',
            'test.md',
            'session1',
            'v1',
            'h1',
            null
        );
        expect(mockStateStore.setActiveMode).toHaveBeenCalledWith('SNIPPET');
    });

    it('should emit onSnippetLoaded after successful load', async () => {
        const loadedSpy = vi.fn();
        watcher.onSnippetLoaded(loadedSpy);

        const newSnippetUri = { fsPath: path.join('/antigravity', 'session-1', 'snippet.md') };
        await onCreateListener(newSnippetUri);

        expect(loadedSpy).toHaveBeenCalled();
    });

    it('should NOT pivot if the snippet belongs to the current session', async () => {
        const pivotSpy = vi.fn();
        watcher.onSessionPivot(pivotSpy);

        const sameSessionUri = { fsPath: path.join('/antigravity', 'session-1', 'snippet.md') };
        await onCreateListener(sameSessionUri);

        expect(pivotSpy).not.toHaveBeenCalled();
    });
});
