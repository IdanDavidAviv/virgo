import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Chapter, parseChapters } from '@core/documentParser';

export interface DocumentMetadata {
    fileName: string;
    relativeDir: string;
    uri: vscode.Uri | undefined;
    versionSalt: string;
}

export class DocumentLoadController {
    private _chapters: Chapter[] = [];
    private _metadata: DocumentMetadata = {
        fileName: 'No Document',
        relativeDir: '',
        uri: undefined,
        versionSalt: ''
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
    public async loadActiveDocument(): Promise<boolean> {
        let document = vscode.window.activeTextEditor?.document;

        if (!document) {
            const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
            const input = tab?.input as any;
            const uri = input?.uri || input?.resource || (input?.sourceUri && vscode.Uri.parse(input.sourceUri));
            
            if (uri) {
                try {
                    document = await vscode.workspace.openTextDocument(uri);
                } catch (e) {
                    this._logger(`[LOAD] Failed to load from tab: ${e}`);
                }
            }
        }

        if (!document) {
            this._logger('[LOAD] No active document found.');
            return false;
        }

        const text = document.getText();
        this.updateMetadata(document);

        const startTime = Date.now();
        this._chapters = parseChapters(text);
        const duration = Date.now() - startTime;

        this._logger(`[LOAD] document: ${this._metadata.fileName} | chapters: ${this._chapters.length} | parsing: ${duration}ms`);
        return true;
    }

    /**
     * Resets the document context.
     */
    public clear(): void {
        this._chapters = [];
        this._metadata = {
            fileName: 'No File Loaded',
            relativeDir: '',
            uri: undefined,
            versionSalt: ''
        };
        this._logger('[LOAD] Context cleared.');
    }

    public updateMetadata(document: vscode.TextDocument) {
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
            relativeDir = uri.scheme === 'file' ? path.dirname(fsPath).split(/[\\\/]/).slice(-2).join(' / ') : 'Virtual Storage';
        }

        this._metadata = {
            fileName: fileName.includes('Untitled') ? (uri.path.split('/').pop() || fileName) : fileName,
            relativeDir,
            uri,
            versionSalt: this.getFileVersionSalt(uri)
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
        } catch (e) {}

        try {
            if (fs.existsSync(fsPath)) {
                const stats = fs.statSync(fsPath);
                return `T${Math.floor(stats.mtimeMs)}`;
            }
        } catch (e) {
            // Silence stat errors
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
