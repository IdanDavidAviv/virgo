import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { McpWatcher } from '@extension/vscode/McpWatcher';

const MY_WORKSPACE = '/workspace/virgo';
const OTHER_WORKSPACE = '/workspace/other-project';

// Mock vscode — each window has a unique workspace folder (VS Code enforces this)
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
            })),
            // Inline literal — vi.mock factory is hoisted before module-level consts
            workspaceFolders: [{ uri: { fsPath: '/workspace/virgo' } }]
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

// ── Filename helpers (simple 2-slot format: <ts>.<name>.md) ──────────────────
const snippetFile = (session: string, name: string) =>
    path.join('/antigravity', session, `${Date.now()}.${name}.md`);

// ── Claim mock helpers ────────────────────────────────────────────────────────
const mockClaimExists = (owner: string) => {
    (fs.existsSync as any).mockImplementation((p: string) => {
        if (p.endsWith('.workspace_claim')) {return true;}
        return true; // session dir exists
    });
    (fs.readFileSync as any).mockReturnValue(owner);
};

const mockNoClaimExists = () => {
    (fs.existsSync as any).mockImplementation((p: string) => {
        if (p.endsWith('.workspace_claim')) {return false;}
        return true; // session dir exists
    });
};

describe('McpWatcher (Workspace Claim Gate)', () => {
    let watcher: McpWatcher;
    let mockStateStore: any;
    let mockDocController: any;
    let mockLogger: any;
    let mockWatcherInstance: any;
    let onCreateListener: (uri: any) => void;

    beforeEach(() => {
        vi.clearAllMocks();

        // Default: claim file exists, owned by MY_WORKSPACE
        mockClaimExists(MY_WORKSPACE);

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

    // ── Infrastructure ────────────────────────────────────────────────────────

    it('should initialize a filesystem watcher for the antigravity root', () => {
        expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledWith(
            expect.objectContaining({ base: '/antigravity', pattern: '**/*.md' }),
            false, true, true
        );
        expect(mockWatcherInstance.onDidCreate).toHaveBeenCalled();
    });

    it('should write a .workspace_claim for the initial session at construction', () => {
        // writeFileSync is called during construction to claim the session
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            expect.stringContaining('.workspace_claim'),
            MY_WORKSPACE
        );
    });

    it('should log the workspace path on construction', () => {
        expect(mockLogger).toHaveBeenCalledWith(
            expect.stringContaining('workspace=virgo')
        );
    });

    // ── Claim Gate — Own Workspace ────────────────────────────────────────────

    it('[CLAIM GATE] should process snippet in owned session', async () => {
        const loadedSpy = vi.fn();
        watcher.onSnippetLoaded(loadedSpy);

        const uri = { fsPath: snippetFile('session-1', 'my_snippet') };
        await onCreateListener(uri);

        expect(loadedSpy).toHaveBeenCalled();
    });

    it('[CLAIM GATE] should pivot to a new session owned by this workspace', async () => {
        const pivotSpy = vi.fn();
        watcher.onSessionPivot(pivotSpy);

        // Claim file for session-2 belongs to MY_WORKSPACE
        mockClaimExists(MY_WORKSPACE);

        const uri = { fsPath: snippetFile('session-2', 'new_snippet') };
        await onCreateListener(uri);

        expect(pivotSpy).toHaveBeenCalledWith('session-2');
    });

    // ── Claim Gate — Foreign Workspace ────────────────────────────────────────

    it('[CLAIM GATE] should reject snippet from session claimed by another workspace', async () => {
        const pivotSpy = vi.fn();
        const loadSpy = vi.fn();
        watcher.onSessionPivot(pivotSpy);
        watcher.onSnippetLoaded(loadSpy);

        // Session owned by a DIFFERENT workspace
        mockClaimExists(OTHER_WORKSPACE);

        const uri = { fsPath: snippetFile('session-2', 'foreign_snippet') };
        await onCreateListener(uri);

        expect(pivotSpy).not.toHaveBeenCalled();
        expect(loadSpy).not.toHaveBeenCalled();
    });

    it('[CLAIM GATE] should reject foreign workspace even in current session', async () => {
        const loadSpy = vi.fn();
        watcher.onSnippetLoaded(loadSpy);

        mockClaimExists(OTHER_WORKSPACE);

        const uri = { fsPath: snippetFile('session-1', 'foreign_snippet') };
        await onCreateListener(uri);

        expect(loadSpy).not.toHaveBeenCalled();
    });

    // ── First-Window-Wins ─────────────────────────────────────────────────────

    it('[FIRST-WIN] should claim unclaimed session and process (first-window-wins)', async () => {
        const loadedSpy = vi.fn();
        watcher.onSnippetLoaded(loadedSpy);

        // No claim file exists for this session
        mockNoClaimExists();

        const uri = { fsPath: snippetFile('session-1', 'unclaimed_snippet') };
        await onCreateListener(uri);

        // Should have written the claim
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            expect.stringContaining('.workspace_claim'),
            MY_WORKSPACE
        );
        // And processed the snippet
        expect(loadedSpy).toHaveBeenCalled();
    });

    // ── pivot() method ────────────────────────────────────────────────────────

    it('should write a claim when pivot() is called (no prior claim)', () => {
        vi.clearAllMocks();
        // No claim exists for session-3 — write is allowed
        (fs.existsSync as any).mockImplementation((p: string) => {
            if (p.endsWith('.workspace_claim')) { return false; }
            return true;
        });

        watcher.pivot('/antigravity', 'session-3');

        expect(fs.writeFileSync).toHaveBeenCalledWith(
            expect.stringContaining('.workspace_claim'),
            MY_WORKSPACE
        );
    });

    it('[NON-DESTRUCTIVE] should NOT overwrite a foreign claim at pivot()', () => {
        vi.clearAllMocks();
        // Claim already exists, owned by OTHER_WORKSPACE
        (fs.existsSync as any).mockImplementation(() => true);
        (fs.readFileSync as any).mockReturnValue(OTHER_WORKSPACE);

        watcher.pivot('/antigravity', 'session-3');

        // writeFileSync must NOT be called — back off, don't stomp foreign claim
        expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('[NON-DESTRUCTIVE] should NOT overwrite a foreign claim at construction', () => {
        vi.clearAllMocks();
        // Foreign claim already present for session-1 at startup
        (fs.existsSync as any).mockImplementation(() => true);
        (fs.readFileSync as any).mockReturnValue(OTHER_WORKSPACE);

        // Rebuild the watcher — constructor calls _writeWorkspaceClaim(session-1)
        new McpWatcher('/antigravity', 'session-1', mockStateStore, mockDocController, mockLogger);

        expect(fs.writeFileSync).not.toHaveBeenCalled();
    });


    // ── Core Behaviour ────────────────────────────────────────────────────────

    it('should load the snippet into the DocController and update state', async () => {
        const uri = { fsPath: snippetFile('session-1', 'snippet') };
        await onCreateListener(uri);

        expect(mockDocController.loadSnippet).toHaveBeenCalledWith(uri.fsPath);
        expect(mockStateStore.setActiveDocument).toHaveBeenCalledWith(
            'file:///test.md', 'test.md', 'session1', 'v1', 'h1', null
        );
        expect(mockStateStore.setActiveMode).toHaveBeenCalledWith('SNIPPET');
    });

    it('should emit onSnippetLoaded after successful load', async () => {
        const loadedSpy = vi.fn();
        watcher.onSnippetLoaded(loadedSpy);

        const uri = { fsPath: snippetFile('session-1', 'snippet') };
        await onCreateListener(uri);

        expect(loadedSpy).toHaveBeenCalled();
    });

    it('should NOT pivot if the snippet belongs to the current session', async () => {
        const pivotSpy = vi.fn();
        watcher.onSessionPivot(pivotSpy);

        const uri = { fsPath: snippetFile('session-1', 'snippet') };
        await onCreateListener(uri);

        expect(pivotSpy).not.toHaveBeenCalled();
    });
});
