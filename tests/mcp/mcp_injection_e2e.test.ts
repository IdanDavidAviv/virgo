import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PendingInjectionStore } from '../../src/extension/mcp/core/sharedStore';
import { McpWatcher } from '../../src/extension/vscode/McpWatcher';

// Mock vscode API for Vitest environment
vi.mock('vscode', () => ({
    RelativePattern: vi.fn(),
    workspace: {
        createFileSystemWatcher: vi.fn(() => ({
            onDidCreate: vi.fn(() => ({ dispose: vi.fn() })),
            dispose: vi.fn()
        })),
        fs: {
            stat: vi.fn()
        }
    },
    Uri: {
        file: (p: string) => ({ fsPath: p, toString: () => p })
    },
    Disposable: {
        from: vi.fn()
    }
}));

describe('MCP Injection E2E Integration', () => {
    const testBrainRoot = path.resolve(process.cwd(), 'tests', 'mcp', 'test_brain');
    const sessionId = 'e2e-test-session';
    const logger = vi.fn((msg) => console.log(msg));
    const docController = { 
        loadSnippet: vi.fn(async () => true),
        metadata: { 
            uri: { toString: () => 'test-uri' },
            fileName: 'test-snippet',
            relativeDir: '',
            versionSalt: 1,
            contentHash: 'hash'
        }
    } as any;
    const stateStore = { 
        setActiveDocument: vi.fn(), 
        setActiveMode: vi.fn(),
        setPlaybackStatus: vi.fn(),
        state: { autoPlayOnInjection: false } 
    } as any;

    beforeEach(() => {
        if (fs.existsSync(testBrainRoot)) {
            fs.rmSync(testBrainRoot, { recursive: true, force: true });
        }
        fs.mkdirSync(path.join(testBrainRoot, sessionId), { recursive: true });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('should detect a file saved by the store and trigger the watcher', async () => {
        const store = new PendingInjectionStore(testBrainRoot);
        const watcher = new McpWatcher(testBrainRoot, sessionId, stateStore, docController, logger);

        let snippetLoadedCount = 0;
        watcher.onSnippetLoaded(() => {
            snippetLoadedCount++;
        });

        const testSnippetName = 'test-snippet';
        // Note: store.save now generates dot-delimited format: <ts>.<wsTag>.<name>.md
        // _myWorkspaceTag is '' in this test context (no workspaceFolders mock) → tag gate skipped → session gate applies.
        const sessionDir = path.join(testBrainRoot, sessionId);
        
        console.log(`[TEST] Saving snippet to session ${sessionId}`);
        store.save('# Hello World', testSnippetName, sessionId);

        // Verification loop with status logging
        let attempts = 0;
        while (snippetLoadedCount === 0 && attempts < 50) {
            if (attempts % 10 === 0) {
                const files = fs.existsSync(sessionDir) ? fs.readdirSync(sessionDir) : [];
                console.log(`[TEST] Poll att ${attempts}: filesFound=${files.length}, loaded=${snippetLoadedCount}`);
            }
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
        }

        console.log(`[TEST] Final results: attempts=${attempts}, loaded=${snippetLoadedCount}`);
        expect(snippetLoadedCount).toBe(1);
        expect(docController.loadSnippet).toHaveBeenCalled();
        
        watcher.dispose();
    });

    it('should DETECT and PIVOT to other session directories (Vocal Sync)', async () => {
        const watcher = new McpWatcher(testBrainRoot, sessionId, stateStore, docController, logger);
        const otherSessionId = 'new-active-session';
        const otherSessionPath = path.join(testBrainRoot, otherSessionId);
        
        if (!fs.existsSync(otherSessionPath)) {
            fs.mkdirSync(otherSessionPath, { recursive: true });
        }

        let pivotedSessionId = '';
        watcher.onSessionPivot((id) => {
            pivotedSessionId = id;
        });

        // [CLAIM GATE] Simple 2-slot format: <ts>.<name>.md
        // vscode mock has no workspaceFolders → _myWorkspacePath is '' → claim gate passes through → session routing handles the pivot.
        const newFilePath = path.join(otherSessionPath, `${Date.now()}.pivot_test.md`);
        console.log(`[TEST] Writing pivot file to ${newFilePath}`);
        fs.writeFileSync(newFilePath, '# New Session Content');

        let attempts = 0;
        while (pivotedSessionId === '' && attempts < 50) {
            await new Promise(resolve => setTimeout(resolve, 100));
            attempts++;
        }

        console.log(`[TEST] Pivot results: attempts=${attempts}, pivotedTo=${pivotedSessionId}`);
        expect(pivotedSessionId).toBe(otherSessionId);
        expect(docController.loadSnippet).toHaveBeenCalled();

        watcher.dispose();
    });
});
