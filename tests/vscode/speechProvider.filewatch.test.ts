import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';

/**
 * T-034: Focused-File Disk Change Detection
 *
 * Tests the FileSystemWatcher lifecycle and the salt-diff guard in SpeechProvider.
 * Uses vi.fn() stubs — no real VS Code extension host required.
 */

// ──────────────────────────────────────────────
// Minimal stubs
// ──────────────────────────────────────────────

const mockSetFocusedFile = vi.fn();
const mockGetFileVersionSalt = vi.fn((_uri: any) => '');
const mockWatcherDispose = vi.fn();

let onDidChangeCb: (() => void) | undefined;

const mockWatcher = {
    onDidChange: vi.fn((cb: () => void) => { onDidChangeCb = cb; return { dispose: vi.fn() }; }),
    dispose: mockWatcherDispose,
};

vi.mock('vscode', () => {
    class RelativePatternMock {
        base: any;
        pattern: string;
        constructor(base: any, pattern: string) {
            this.base = base;
            this.pattern = pattern;
        }
    }
    return {
        workspace: {
            createFileSystemWatcher: vi.fn(() => mockWatcher),
            getWorkspaceFolder: vi.fn(() => undefined),
        },
        Uri: {
            file: (p: string) => ({ fsPath: p, scheme: 'file', path: p }),
        },
        RelativePattern: RelativePatternMock,
        window: { activeTextEditor: undefined },
    };
});

// Minimal SpeechProvider shim — exercises only the three T-034 methods
class FocusedWatcherShim {
    private _focusedFileWatcher?: { dispose: () => void };
    private _lastFocusedSalt?: string;

    private _stateStore = { state: { focusedFileName: 'test.md', focusedRelativeDir: '', focusedIsSupported: true }, setFocusedFile: mockSetFocusedFile };
    private _docController = { getFileVersionSalt: mockGetFileVersionSalt };
    private _logger = vi.fn();

    setActiveEditor(uri: vscode.Uri | undefined) {
        this._focusedFileWatcher?.dispose();
        this._focusedFileWatcher = undefined;

        if (!uri) { return; }

        const versionSalt = this._docController.getFileVersionSalt(uri);
        this._lastFocusedSalt = versionSalt;
        this._stateStore.setFocusedFile(uri, 'test.md', '', true, versionSalt);

        if (uri.fsPath) {
            this._setupFocusedFileWatcher(uri);
        }
    }

    private _setupFocusedFileWatcher(uri: vscode.Uri): void {
        const fsPath = uri.fsPath;
        const dir = require('path').dirname(fsPath);
        const base = require('path').basename(fsPath);
        const dirUri = { fsPath: dir, scheme: 'file', path: dir } as unknown as vscode.Uri;
        const pattern = new vscode.RelativePattern(dirUri, `{${base},${base}.metadata.json}`);
        const watcher = vscode.workspace.createFileSystemWatcher(pattern, true, false, true);
        watcher.onDidChange(() => this._onFocusedFileDiskChange(uri));
        this._focusedFileWatcher = watcher as any;
    }

    private _onFocusedFileDiskChange(uri: vscode.Uri): void {
        const newSalt = this._docController.getFileVersionSalt(uri);
        if (newSalt === this._lastFocusedSalt) { return; }
        this._lastFocusedSalt = newSalt;
        const s = this._stateStore.state;
        this._stateStore.setFocusedFile(uri, s.focusedFileName, s.focusedRelativeDir, s.focusedIsSupported, newSalt);
        this._logger(`[T-034] Disk change → salt: ${newSalt}`);
    }

    dispose() {
        this._focusedFileWatcher?.dispose();
    }

    // Test helpers
    get _watcher() { return this._focusedFileWatcher; }
    get _salt() { return this._lastFocusedSalt; }
    triggerDiskChange() { onDidChangeCb?.(); }
}

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe('T-034 — Focused File FileSystemWatcher', () => {
    let shim: FocusedWatcherShim;
    const uriA = { fsPath: 'C:/workspace/doc-a.md', scheme: 'file', path: 'C:/workspace/doc-a.md' } as unknown as vscode.Uri;
    const uriB = { fsPath: 'C:/workspace/doc-b.md', scheme: 'file', path: 'C:/workspace/doc-b.md' } as unknown as vscode.Uri;

    beforeEach(() => {
        shim = new FocusedWatcherShim();
        vi.clearAllMocks();
        onDidChangeCb = undefined;
        mockGetFileVersionSalt.mockReturnValue('');
    });

    afterEach(() => {
        shim.dispose();
    });

    it('T034-1: setActiveEditor disposes previous watcher before creating a new one', () => {
        shim.setActiveEditor(uriA);
        const firstWatcher = shim._watcher;
        expect(firstWatcher).toBeDefined();

        shim.setActiveEditor(uriB);
        // Previous watcher must have been disposed
        expect(mockWatcherDispose).toHaveBeenCalledTimes(1);
        expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(2);
    });

    it('T034-2: _onFocusedFileDiskChange calls setFocusedFile when salt changes', () => {
        mockGetFileVersionSalt.mockReturnValue('');
        shim.setActiveEditor(uriA);
        mockSetFocusedFile.mockClear();

        // Salt changes on disk
        mockGetFileVersionSalt.mockReturnValue('V2');
        shim.triggerDiskChange();

        expect(mockSetFocusedFile).toHaveBeenCalledOnce();
        expect(mockSetFocusedFile).toHaveBeenCalledWith(uriA, expect.any(String), expect.any(String), expect.any(Boolean), 'V2');
    });

    it('T034-3: _onFocusedFileDiskChange is a no-op when salt is identical', () => {
        mockGetFileVersionSalt.mockReturnValue('V1');
        shim.setActiveEditor(uriA);
        mockSetFocusedFile.mockClear();

        // Salt stays the same
        mockGetFileVersionSalt.mockReturnValue('V1');
        shim.triggerDiskChange();

        expect(mockSetFocusedFile).not.toHaveBeenCalled();
    });

    it('T034-4: dispose() tears down the active watcher', () => {
        shim.setActiveEditor(uriA);
        expect(shim._watcher).toBeDefined();

        shim.dispose();
        expect(mockWatcherDispose).toHaveBeenCalledTimes(1);
    });
});
