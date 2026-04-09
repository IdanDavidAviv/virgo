import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { Chapter, parseChapters } from '@core/documentParser';

export interface DocumentMetadata {
    fileName: string;
    relativeDir: string;
    uri: vscode.Uri | undefined;
    versionSalt: string;
    contentHash: string; // Hidden, internal fingerprint for persistence
}

export class DocumentLoadController {
    private _chapters: Chapter[] = [];
    private _metadata: DocumentMetadata = {
        fileName: 'No Document',
        relativeDir: '',
        uri: undefined,
        versionSalt: '',
        contentHash: ''
    };

    constructor(private readonly _logger: (msg: string) => void) {}

    public get chapters(): Chapter[] {
        return this._chapters;
    }

    public get metadata(): DocumentMetadata {
        return this._metadata;
    }

    /**
     * Orchestrates loading the current document from VS Code.
     */
    public async loadActiveDocument(hintUri?: vscode.Uri): Promise<boolean> {
        let document = vscode.window.activeTextEditor?.document;

        if (!document) {
            // [GHOST FOCUS] Sidebar stole focus — activeTextEditor is null.
            // Try the last active tab first, then fall back to the hintUri
            // (which is the focusedDocumentUri already captured by syncSelection).
            const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
            const input = tab?.input as any;
            const tabUri = input?.uri || input?.resource || (input?.sourceUri && vscode.Uri.parse(input.sourceUri));
            const resolvedUri = tabUri || hintUri;

            if (resolvedUri) {
                try {
                    document = await vscode.workspace.openTextDocument(resolvedUri);
                    this._logger(`[LOAD] Resolved via ${tabUri ? 'tab' : 'hintUri'}: ${resolvedUri.fsPath}`);
                } catch (e) {
                    this._logger(`[LOAD] Failed to load from tab/hint: ${e}`);
                }
            }
        }

        if (!document) {
            this._logger('[LOAD] No active document found (activeTextEditor=null, tab=null, hintUri=null).');
            return false;
        }

        const text = document.getText();
        
        // [REINFORCEMENT] Calculate Cross-Platform Content Hash
        // Normalize to LF and include length for fast uniqueness
        const normalizedText = text.replace(/\r\n/g, '\n');
        const md5 = crypto.createHash('md5').update(normalizedText).digest('hex');
        const contentHash = `${normalizedText.length}#${md5}`;

        this.updateMetadata(document, contentHash);

        const startTime = Date.now();
        this._chapters = parseChapters(text);
        const duration = Date.now() - startTime;

        this._logger(`[LOAD] document: ${this._metadata.fileName} | chapters: ${this._chapters.length} | parsing: ${duration}ms`);
        return true;
    }

    /**
     * Orchestrates loading a snippet from the Antigravity Root.
     */
    public async loadSnippet(fsPath: string): Promise<boolean> {
        if (!fs.existsSync(fsPath)) {
            this._logger(`[LOAD] Snippet not found: ${fsPath}`);
            return false;
        }

        try {
            const text = fs.readFileSync(fsPath, 'utf8');
            
            // Calculate Hash
            const normalizedText = text.replace(/\r\n/g, '\n');
            const md5 = crypto.createHash('md5').update(normalizedText).digest('hex');
            const contentHash = `${normalizedText.length}#${md5}`;

            // Mock a "Virtual" document for metadata
            const fileName = path.basename(fsPath);
            const uri = vscode.Uri.file(fsPath);

            this._chapters = parseChapters(text);
            this._metadata = {
                fileName: fileName.replace(/^\d+_/, ''), // Remove timestamp prefix from UI
                relativeDir: 'Antigravity / History',
                uri,
                versionSalt: '',
                contentHash
            };

            this._logger(`[LOAD] snippet: ${this._metadata.fileName} | chapters: ${this._chapters.length}`);
            return true;
        } catch (e) {
            this._logger(`[LOAD] Failed to load snippet: ${e}`);
            return false;
        }
    }

    /**
     * Resets the document context.
     */
    public clear(): void {
        this._chapters = [];
        this._resetMetadata();
        this._logger('[LOAD] Context cleared.');
    }

    public updateMetadata(document: vscode.TextDocument, contentHash: string = '') {
        const uri = document.uri;
        const fileName = path.basename(document.fileName);
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        const fsPath = uri.fsPath;
        let relativeDir = '';

        if (folder) {
            const workspaceName = folder.name;
            const relPath = path.relative(folder.uri.fsPath, path.dirname(fsPath));
            relativeDir = workspaceName + (relPath && relPath !== '.' ? ' / ' + relPath.replace(/\\/g, ' / ') : '');
        } else if (fsPath.toLowerCase().includes('.gemini') && fsPath.toLowerCase().includes('brain')) {
            const brainMatch = fsPath.match(/brain[\\\/]([^\\\/]+)(.*)/i);
            if (brainMatch) {
                const hash = brainMatch[1];
                const subPath = path.dirname(brainMatch[2].replace(/^[\\\/]/, ''));
                relativeDir = `Brain / ${this.compressPath(hash)}${subPath !== '.' ? ' / ' + subPath.replace(/[\\\/]/g, ' / ') : ''}`;
            } else {
                relativeDir = 'Brain / Artifacts';
            }
        } else {
            if (uri.scheme === 'file') {
                relativeDir = path.dirname(fsPath).split(/[\\\/]/).slice(-2).join(' / ');
            } else if (uri.scheme === 'git') {
                relativeDir = '[GIT]';
            } else if (uri.scheme === 'untitled') {
                relativeDir = '[UNTITLED]';
            } else if (uri.scheme === 'vscode-userdata') {
                relativeDir = '[SETTINGS]';
            } else {
                relativeDir = `[${uri.scheme.toUpperCase()}]`;
            }
        }

        this._metadata = {
            fileName: fileName.includes('Untitled') ? (uri.path.split('/').pop() || fileName) : fileName,
            relativeDir,
            uri,
            versionSalt: this.getFileVersionSalt(uri),
            contentHash: contentHash || this._metadata.contentHash
        };
    }

    /**
     * Resets metadata for a clean slate.
     */
    private _resetMetadata() {
        this._metadata = {
            fileName: 'No File Loaded',
            relativeDir: '',
            uri: undefined,
            versionSalt: '',
            contentHash: ''
        };
    }

    public compressPath(rawPath: string): string {
        return rawPath.replace(/([0-9a-f]{4})[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{8}([0-9a-f]{4})/gi, '$1...$2');
    }

    private _calculateVersionSalt(fsPath: string): string {
        const suffixMatch = fsPath.match(/\.resolved\.(\d+)$/i);
        if (suffixMatch) {
            return `V${suffixMatch[1]}`;
        }

        try {
            const metaPath = fsPath + '.metadata.json';
            if (fs.existsSync(metaPath)) {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                if (meta.version) {
                    return `V${meta.version}`;
                }
            }
        } catch (e) {
            // Silence metadata errors
        }

        return '';
    }

    /**
     * Public helper for getting version salt for any URI (used for Active Selection tracking)
     */
    public getFileVersionSalt(uri: vscode.Uri): string {
        return this._calculateVersionSalt(uri.fsPath);
    }
}
