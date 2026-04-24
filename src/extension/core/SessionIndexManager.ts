import * as fs from 'fs';
import * as path from 'path';
import { SnippetHistory, SnippetSession, SnippetEntry } from '@common/types';

// ─────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────

export interface SessionIndexSnippet {
    name: string;
    timestamp: number;  // ms — matches SnippetEntry.timestamp
    fsPath: string;
    uri: string;
}

export interface SessionIndexEntry {
    displayName?: string;         // human-readable title from extension_state.json
    lastSnippetAt: string;        // ISO timestamp of latest snippet
    snippets: SessionIndexSnippet[];
}

export interface SessionIndex {
    version: number;
    lastUpdated: string;
    sessions: Record<string, SessionIndexEntry>;
}

const INDEX_VERSION = 1;

// ─────────────────────────────────────────────────────────
// SessionIndexManager
// ─────────────────────────────────────────────────────────

/**
 * [T-035] Aggregate Session Metadata Index
 *
 * Manages a single `sessions_index.json` file at the antigravity read_aloud root.
 * Replaces the O(N×M) filesystem scan in _getSnippetHistory with O(1) reads.
 *
 * Write path: McpWatcher calls `upsertSession()` on every snippet injection.
 * Read path:  SpeechProvider calls `toSnippetHistory()` on every sidebar fetch.
 *
 * Atomic write: write to `.tmp`, then fs.renameSync — prevents corrupt reads on crash.
 * Concurrent safety: each IDE owns separate sessionIds (XOR sovereignty) — no contention.
 */
export class SessionIndexManager {
    private readonly _indexPath: string;
    private readonly _tmpPath: string;
    private readonly _sessionsRoot: string;

    constructor(
        private readonly _antigravityReadAloudRoot: string,
        private readonly _logger: (msg: string) => void
    ) {
        this._indexPath = path.join(_antigravityReadAloudRoot, 'sessions_index.json');
        this._tmpPath = path.join(_antigravityReadAloudRoot, 'sessions_index.tmp.json');
        this._sessionsRoot = _antigravityReadAloudRoot;
    }

    // ─────────────────────────────────────────────────────
    // Read
    // ─────────────────────────────────────────────────────

    /**
     * Read and parse the index file.
     * Returns null if missing, unreadable, or corrupt JSON — never throws.
     */
    public read(): SessionIndex | null {
        try {
            if (!fs.existsSync(this._indexPath)) { return null; }
            const raw = fs.readFileSync(this._indexPath, 'utf-8');
            const parsed = JSON.parse(raw) as SessionIndex;
            if (typeof parsed.sessions !== 'object') { return null; }
            return parsed;
        } catch {
            this._logger(`[SESSION_INDEX] read() failed — corrupt or unreadable index`);
            return null;
        }
    }

    // ─────────────────────────────────────────────────────
    // Write
    // ─────────────────────────────────────────────────────

    /**
     * Additive upsert of a single snippet into a session entry.
     *
     * - If the session doesn't exist, creates it.
     * - If `displayName` is undefined, resolves it lazily from extension_state.json
     *   (once per session — subsequent calls use the cached value from the index).
     * - Snippets are kept sorted by timestamp descending.
     * - Writes atomically via tmp + rename.
     */
    public upsertSession(
        sessionId: string,
        displayName: string | undefined,
        snippet: SessionIndexSnippet
    ): void {
        try {
            const index = this.read() ?? this._empty();

            const existing = index.sessions[sessionId];
            const resolvedName = displayName
                ?? existing?.displayName
                ?? this._resolveDisplayName(sessionId);

            const snippets: SessionIndexSnippet[] = existing?.snippets ?? [];

            // Avoid duplicate entries for the same file path
            const alreadyPresent = snippets.some(s => s.fsPath === snippet.fsPath);
            if (!alreadyPresent) {
                snippets.push(snippet);
                // Sort descending by timestamp
                snippets.sort((a, b) => b.timestamp - a.timestamp);
            }

            index.sessions[sessionId] = {
                displayName: resolvedName,
                lastSnippetAt: new Date(snippet.timestamp).toISOString(),
                snippets
            };

            index.lastUpdated = new Date().toISOString();
            this._write(index);
            this._logger(`[SESSION_INDEX] Upserted snippet '${snippet.name}' into session ${sessionId.slice(0, 8)}`);
        } catch (e) {
            this._logger(`[SESSION_INDEX] upsertSession failed: ${e}`);
        }
    }

    /**
     * Rebuild the entire index from a SnippetHistory (cold-start path).
     * Called after a full filesystem scan to prime the index.
     */
    public rebuildFromHistory(history: SnippetHistory): void {
        try {
            const index = this._empty();

            for (const session of history) {
                const snippets: SessionIndexSnippet[] = session.snippets.map(s => ({
                    name: s.name,
                    timestamp: s.timestamp,
                    fsPath: s.fsPath,
                    uri: s.uri
                }));

                const lastTimestamp = snippets.length > 0 ? snippets[0].timestamp : Date.now();
                index.sessions[session.id] = {
                    displayName: session.displayName,
                    lastSnippetAt: new Date(lastTimestamp).toISOString(),
                    snippets
                };
            }

            index.lastUpdated = new Date().toISOString();
            this._write(index);
            this._logger(`[SESSION_INDEX] Rebuilt from scan: ${history.length} sessions`);
        } catch (e) {
            this._logger(`[SESSION_INDEX] rebuildFromHistory failed: ${e}`);
        }
    }

    // ─────────────────────────────────────────────────────
    // Convert → SnippetHistory (existing UI type)
    // ─────────────────────────────────────────────────────

    /**
     * Convert the index to the existing SnippetHistory shape used by the UI.
     * Sessions are sorted by lastSnippetAt descending (most-recent first).
     * Returns empty array if index is missing or has no sessions.
     */
    public toSnippetHistory(): SnippetHistory {
        const index = this.read();
        if (!index) { return []; }

        const sessions = Object.entries(index.sessions)
            .filter(([, entry]) => entry.snippets.length > 0)
            .sort(([, a], [, b]) =>
                new Date(b.lastSnippetAt).getTime() - new Date(a.lastSnippetAt).getTime()
            );

        return sessions.map(([id, entry]): SnippetSession => ({
            id,
            sessionName: entry.displayName ?? id,
            displayName: entry.displayName,
            snippets: entry.snippets.map((s): SnippetEntry => ({
                name: s.name,
                fsPath: s.fsPath,
                uri: s.uri,
                timestamp: s.timestamp
            }))
        }));
    }

    // ─────────────────────────────────────────────────────
    // Private helpers
    // ─────────────────────────────────────────────────────

    private _empty(): SessionIndex {
        return { version: INDEX_VERSION, lastUpdated: new Date().toISOString(), sessions: {} };
    }

    /**
     * Atomic write: write to .tmp, then rename over the real file.
     * On Windows, fs.renameSync is atomic at the NTFS level.
     */
    private _write(index: SessionIndex): void {
        const dir = path.dirname(this._indexPath);
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
        fs.writeFileSync(this._tmpPath, JSON.stringify(index, null, 2), 'utf-8');
        fs.renameSync(this._tmpPath, this._indexPath);
    }

    /**
     * Lazily resolve display name from extension_state.json.
     * Returns undefined if not found — caller caches result in the index entry.
     */
    private _resolveDisplayName(sessionId: string): string | undefined {
        try {
            const statePath = path.join(this._sessionsRoot, sessionId, 'extension_state.json');
            if (!fs.existsSync(statePath)) { return undefined; }
            const raw = fs.readFileSync(statePath, 'utf-8');
            const state = JSON.parse(raw);
            return state.session_title ?? undefined;
        } catch {
            return undefined;
        }
    }
}
