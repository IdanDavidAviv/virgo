import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import { TurnManager } from "../../../common/mcp/turnManager";

/**
 * Simple store for Markdown snippets injected via MCP, with file persistence.
 * Shared between SSE (Bridge) and Stdio (Standalone) transports.
 */
export class PendingInjectionStore extends EventEmitter {
    private _injections: { timestamp: number, content: string, name: string, filePath?: string }[] = [];

    constructor(private _basePath: string) {
        super();
        if (!fs.existsSync(this._basePath)) {
            fs.mkdirSync(this._basePath, { recursive: true });
        }
    }

    /**
     * Updates the base path for session pivoting.
     */
    public setBasePath(path: string) {
        this._basePath = path;
        if (!fs.existsSync(this._basePath)) {
            fs.mkdirSync(this._basePath, { recursive: true });
        }
    }

    /**
     * Atomically get and update the turn index from state.json
     * Also updates the session title if provided.
     */
    private updateSessionState(sessionPath: string, sessionTitle?: string, incomingIndex?: number): number {
        return TurnManager.updateTurnIndex(sessionPath, {
            sessionTitle,
            incomingIndex,
            logger: (msg) => console.log(`[MCP_STORE_STATE] ${msg}`)
        });
    }

    /**
     * Direct file save to persistent storage for cross-session recovery.
     */
    public save(content: string, name: string, sessionId: string, sessionTitle?: string, turnIndex?: number): { filePath: string, index: number } {
        const sessionPath = this._basePath.endsWith(sessionId) ? this._basePath : path.join(this._basePath, sessionId);
        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
        }

        const index = this.updateSessionState(sessionPath, sessionTitle, turnIndex);
        const timestamp = Date.now();
        const safeName = name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const fileName = `${timestamp}_${safeName}.md`;
        const filePath = path.join(sessionPath, fileName);

        // Prepend Turn Header if missing
        let finalContent = content;
        if (!content.trim().startsWith('# [Turn')) {
            const turnHeader = `# [Turn ${index.toString().padStart(3, '0')}] ${name}\n\n`;
            finalContent = turnHeader + content;
        }

        fs.writeFileSync(filePath, finalContent);
        this._injections.push({ timestamp, content: finalContent, name, filePath });
        this.emit('injected', { content: finalContent, name, index, filePath });
        return { filePath, index };
    }

    public onInjected(callback: (data: { content: string, name: string, index: number, filePath: string }) => void) {
        this.on('injected', callback);
    }

    public getAll() {
        return [...this._injections];
    }

    public getLatest() {
        return this._injections[this._injections.length - 1];
    }

    public clear() {
        this._injections = [];
    }
}
