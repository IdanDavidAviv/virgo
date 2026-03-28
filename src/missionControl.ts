import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class MissionControlPanel {
    public static currentPanel: MissionControlPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionPath: string;
    private _disposables: vscode.Disposable[] = [];
    private _isReady: boolean = false;

    public static createOrShow(extensionPath: string, extensionUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (MissionControlPanel.currentPanel) {
            MissionControlPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'missionControl',
            'Read Aloud: Mission Control',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                // localResourceRoots removed to simplify origin stabilization
            }
        );

        MissionControlPanel.currentPanel = new MissionControlPanel(panel, extensionPath);
    }

    private constructor(panel: vscode.WebviewPanel, extensionPath: string) {
        this._panel = panel;
        this._extensionPath = extensionPath;

        // Set the webview's initial html content
        this._update();

        // Listen for when the panel is disposed
        // This happens when the user closes the panel or when the panel is closed programmatically
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Update the content based on view state changes
        this._panel.onDidChangeViewState(
            e => {
                if (this._panel.visible) {
                    this._update();
                }
            },
            null,
            this._disposables
        );

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'ready':
                        this._isReady = true;
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    public postMessage(message: any) {
        if (this._isReady) {
            this._panel.webview.postMessage(message);
        }
    }

    public dispose() {
        MissionControlPanel.currentPanel = undefined;

        // Clean up our resources
        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _update() {
        const webview = this._panel.webview;
        this._panel.title = 'Read Aloud: Mission Control';
        this._panel.webview.html = this._getHtmlForWebview(webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        // Use the centralized bridge logic if available
        const extension = vscode.extensions.getExtension('IdanDavidAviv.readme-preview-read-aloud');
        if (extension && extension.isActive) {
            const bridge = (extension.exports as any)?.bridge;
            if (bridge) {
                return bridge.getHtml(this._panel.webview);
            }
        }

        // Fallback (redundant but safe)
        const htmlPath = path.join(this._extensionPath, 'dist', 'media', 'speechEngine.html');
        try {
            return fs.readFileSync(htmlPath, 'utf8');
        } catch (err) {
            return `<h1>Load Error</h1><p>${err}</p>`;
        }
    }
}
