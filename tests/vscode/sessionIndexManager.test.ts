import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionIndexManager } from '../../src/extension/core/SessionIndexManager';
import type { SnippetHistory } from '../../src/common/types';

/**
 * T-035: Aggregate Session Metadata Index
 *
 * Tests SessionIndexManager without any VS Code host dependency.
 * Uses a real temp directory on disk — validates actual atomic-write behaviour.
 */

let tmpDir: string;
let manager: SessionIndexManager;
const logger = vi.fn();

const makeSnippet = (name: string, timestamp = Date.now(), extra?: Partial<{ fsPath: string; uri: string }>) => ({
    name,
    timestamp,
    fsPath: extra?.fsPath ?? `/sessions/test/${timestamp}.${name}.md`,
    uri: extra?.uri ?? `file:///sessions/test/${timestamp}.${name}.md`
});

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-index-test-'));
    manager = new SessionIndexManager(tmpDir, logger);
    vi.clearAllMocks();
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('T-035 — SessionIndexManager', () => {

    it('T035-1: read() returns null when index file does not exist', () => {
        const result = manager.read();
        expect(result).toBeNull();
    });

    it('T035-2: upsertSession creates a new session entry correctly', () => {
        const snippet = makeSnippet('sitrep', 1000);
        manager.upsertSession('session-abc', 'My Session', snippet);

        const index = manager.read();
        expect(index).not.toBeNull();
        expect(index!.sessions['session-abc']).toBeDefined();
        expect(index!.sessions['session-abc'].displayName).toBe('My Session');
        expect(index!.sessions['session-abc'].snippets).toHaveLength(1);
        expect(index!.sessions['session-abc'].snippets[0].name).toBe('sitrep');
    });

    it('T035-3: upsertSession appends to existing session and keeps snippets sorted descending', () => {
        manager.upsertSession('session-abc', 'My Session', makeSnippet('first', 1000));
        manager.upsertSession('session-abc', undefined, makeSnippet('second', 3000));
        manager.upsertSession('session-abc', undefined, makeSnippet('third', 2000));

        const index = manager.read();
        const snippets = index!.sessions['session-abc'].snippets;
        expect(snippets).toHaveLength(3);
        // Sorted descending by timestamp
        expect(snippets[0].name).toBe('second'); // 3000
        expect(snippets[1].name).toBe('third');  // 2000
        expect(snippets[2].name).toBe('first');  // 1000
    });

    it('T035-3b: upsertSession does not duplicate same fsPath', () => {
        const snippet = makeSnippet('sitrep', 1000, { fsPath: '/fixed/path.md', uri: 'file:///fixed/path.md' });
        manager.upsertSession('session-abc', 'My Session', snippet);
        manager.upsertSession('session-abc', 'My Session', snippet); // same path

        const index = manager.read();
        expect(index!.sessions['session-abc'].snippets).toHaveLength(1);
    });

    it('T035-4: toSnippetHistory returns sessions sorted by lastSnippetAt descending', () => {
        manager.upsertSession('older-session', 'Older', makeSnippet('a', 1000));
        manager.upsertSession('newer-session', 'Newer', makeSnippet('b', 9000));
        manager.upsertSession('mid-session',   'Mid',   makeSnippet('c', 5000));

        const history = manager.toSnippetHistory();
        expect(history).toHaveLength(3);
        expect(history[0].id).toBe('newer-session');
        expect(history[1].id).toBe('mid-session');
        expect(history[2].id).toBe('older-session');
    });

    it('T035-4b: toSnippetHistory maps to SnippetHistory shape correctly', () => {
        const snippet = makeSnippet('sitrep', 1234567890);
        manager.upsertSession('s1', 'Display Name', snippet);

        const history = manager.toSnippetHistory();
        expect(history[0].id).toBe('s1');
        expect(history[0].sessionName).toBe('Display Name');
        expect(history[0].displayName).toBe('Display Name');
        expect(history[0].snippets[0]).toMatchObject({
            name: 'sitrep',
            timestamp: 1234567890,
            fsPath: snippet.fsPath,
            uri: snippet.uri
        });
    });

    it('T035-5: rebuildFromHistory writes a valid index from SnippetHistory', () => {
        const scannedHistory: SnippetHistory = [
            {
                id: 'session-x',
                sessionName: 'Session X',
                displayName: 'Session X',
                snippets: [
                    { name: 'note', fsPath: '/x/note.md', uri: 'file:///x/note.md', timestamp: 7000 }
                ]
            },
            {
                id: 'session-y',
                sessionName: 'session-y',
                displayName: undefined,
                snippets: [
                    { name: 'summary', fsPath: '/y/summary.md', uri: 'file:///y/summary.md', timestamp: 2000 }
                ]
            }
        ];

        manager.rebuildFromHistory(scannedHistory);

        const index = manager.read();
        expect(index).not.toBeNull();
        expect(Object.keys(index!.sessions)).toHaveLength(2);
        expect(index!.sessions['session-x'].displayName).toBe('Session X');
        expect(index!.sessions['session-x'].snippets[0].name).toBe('note');
        expect(index!.sessions['session-y'].snippets[0].name).toBe('summary');

        // Round-trip via toSnippetHistory — session-x should come first (newer)
        const history = manager.toSnippetHistory();
        expect(history[0].id).toBe('session-x');
    });

    it('T035-6: corrupt JSON returns null without throwing', () => {
        const indexPath = path.join(tmpDir, 'sessions_index.json');
        fs.writeFileSync(indexPath, '{ this is not valid JSON !!!', 'utf-8');

        expect(() => manager.read()).not.toThrow();
        expect(manager.read()).toBeNull();
        expect(logger).toHaveBeenCalled(); // should log the failure
    });

    it('T035-7: atomic write — tmp file is cleaned up after rename', () => {
        const tmpPath = path.join(tmpDir, 'sessions_index.tmp.json');
        manager.upsertSession('s1', 'Test', makeSnippet('x', 100));

        // After write, the real index should exist but the tmp should be gone
        expect(fs.existsSync(path.join(tmpDir, 'sessions_index.json'))).toBe(true);
        expect(fs.existsSync(tmpPath)).toBe(false);
    });

});
