import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { z } from 'zod';

const WsMessageSchema = z.discriminatedUnion("command", [
    z.object({ command: z.literal("ready") }),
    z.object({ command: z.literal("playbackStarted"), sentenceIndex: z.number().optional() }),
    z.object({ command: z.literal("playbackFinished") }),
    z.object({ command: z.literal("error"), message: z.string() }),
    z.object({ command: z.literal("pong") }),
]);

export class BridgeServer extends EventEmitter {
    private _server: http.Server | null = null;
    private _wss: WebSocketServer | null = null;
    private _port: number;
    private _host: string;
    private _clients: Set<WebSocket> = new Set();
    private _retryCount: number = 0;

    constructor(private readonly _mediaPath: string, private readonly logger: (msg: string) => void) {
        super();
        this._port = parseInt(process.env.ANTIGRAVITY_BRIDGE_PORT || '3001');
        this._host = process.env.ANTIGRAVITY_BRIDGE_HOST || '127.0.0.1';
    }

    public get port(): number {
        return this._port;
    }


    public start(port?: number): Promise<number> {
        if (port) {
            this._port = port;
        }
        this._retryCount = this._retryCount || 0;
        return new Promise((resolve, reject) => {
            this._server = http.createServer((req, res) => {
                // PNA & CORS Headers: Required by Chromium's Private Network Access policy
                // to allow a vscode-webview:// origin to reach a loopback HTTP server.
                // VPN-safe: These headers bypass origin-mismatch blocks on all loopback variants.
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Private-Network', 'true');
                res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
                res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
                
                if (req.method === 'OPTIONS') {
                    res.writeHead(204);
                    res.end();
                    return;
                }

                const url = req.url === '/' ? '/speechEngine.html' : req.url;
                const filePath = path.join(this._mediaPath, url!);

                if (fs.existsSync(filePath)) {
                    if (url === '/speechEngine.html') {
                        res.writeHead(200, { 'Content-Type': 'text/html' });
                        res.end(this.getHtml()); // Use common generation logic
                    } else {
                        res.writeHead(200, { 'Content-Type': this._getContentType(filePath) });
                        res.end(fs.readFileSync(filePath));
                    }
                } else {
                    res.writeHead(404);
                    res.end('File not found');
                }
            });

            this._wss = new WebSocketServer({ server: this._server });
            // ... (keep wss logic same)
            this._wss.on('connection', (ws) => {
                this._clients.add(ws);
                ws.on('close', () => this._clients.delete(ws));
                ws.on('message', (data) => {
                    try {
                        const raw = JSON.parse(data.toString());
                        const result = WsMessageSchema.safeParse(raw);
                        
                        if (!result.success) {
                            this.logger(`[BRIDGE] Payload Validation Failed: ${JSON.stringify(result.error.format())}`);
                            return;
                        }

                        const message = result.data;
                        if (message.command === 'ready') {
                            this.emit('ready');
                        }
                    } catch (e) {
                    }
                });
            });

            // VPN-SAFE: Bind to all interfaces (0.0.0.0) so that VPN-rerouted loopback
            this._server.on('error', (err: any) => {
                if (err.code === 'EADDRINUSE' && this._retryCount < 10) {
                    this._retryCount++;
                    const nextPort = this._port + 1;
                    this.logger(`[BRIDGE] PORT COLLISION: ${this._port} is taken. Moving to ${nextPort} (Retry ${this._retryCount}/10)`);
                    this._port = nextPort;
                    this.stop(); 
                    setTimeout(() => {
                        this.start().then(resolve).catch(reject);
                    }, 100);
                } else {
                    this._retryCount = 0;
                    reject(err);
                }
            });

            this._server.on('listening', () => {
                this.logger(`[BRIDGE] HTTP Server successfully listening on port ${this._port}`);
                resolve(this._port);
            });

            this._server.listen(this._port, this._host);
        });
    }

    public broadcast(message: any) {
        const data = JSON.stringify(message);
        this._clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        });
    }

    public getHtml(webview?: { cspSource: string }, options: { overrideHost?: string, markdownHtml?: string } = {}): string {
        const filePath = path.join(this._mediaPath, 'speechEngine.html');
        if (!fs.existsSync(filePath)) {return '<h1>Bridge Error: speechEngine.html not found</h1>';}

        let content = fs.readFileSync(filePath, 'utf8');
        
        // 1. Read Styles
        const stylePath = path.join(this._mediaPath, 'style.css');
        const styleCss = fs.existsSync(stylePath) ? fs.readFileSync(stylePath, 'utf8') : '/* style.css missing */';
        
        // 2. Read Dashboard Scripts
        const scriptPath = path.join(this._mediaPath, 'dashboard.js');
        const dashboardJs = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '/* dashboard.js missing */';
        
        // 3. Handshake Configuration
        const host = options.overrideHost || '127.0.0.1';
        const clientConfig = `window.__BRIDGE_CONFIG__ = { host: '${host}', port: ${this._port} };`;

        // 4. Version from package.json (live SSOT, never hardcoded)
        let extensionVersion = '?.?.?';
        try {
            const pkgPath = path.join(this._mediaPath, '..', '..', 'package.json');
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            extensionVersion = pkg.version || extensionVersion;
        } catch (e) { /* non-fatal */ }
        
        // 4. Centralized CSP: Unified Security Pattern
        // AUDIT-CONFIRMED (2026-03-26): Only 127.0.0.1 and 0.0.0.0 are bound on the host.
        // [::1] is ECONNREFUSED — IPv6 loopback is not active.
        // 'localhost' is excluded: on Windows with IPv6 preference, it resolves to ::1.
        const connectSources = [
            `ws://127.0.0.1:${this._port}`, `http://127.0.0.1:${this._port}`,
            `ws://0.0.0.0:${this._port}`, `http://0.0.0.0:${this._port}`,
            `ws://${host}:${this._port}`, `http://${host}:${this._port}`
        ].join(' ');

        const cspSource = webview?.cspSource || "vscode-resource: vscode-webview-resource:";
        const cspStr = [
            "default-src 'none'",
            `img-src ${cspSource} * data: blob:`,
            `script-src 'unsafe-inline' ${cspSource} https:`,
            `style-src 'unsafe-inline' ${cspSource} https:`,
            `connect-src ${connectSources} https:`,
            `media-src ${cspSource} data: blob:`,
            "font-src *",
            "worker-src 'self' blob:;"
        ].join('; ');

        const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${cspStr}">`;
        const bootMeta = `<meta name="boot-timestamp" content="${new Date().toISOString()}">`;

        // 5. Final Assemblage (Hermetic Seal)
        // CRITICAL: Use functions in .replace() to prevent '$' in CSS/JS from being treated as replacement patterns.
        content = content.replace('<head>', () => `<head>\n${cspMeta}\n${bootMeta}`);
        content = content.replace(/\$\{inlineStyle\}/g, () => styleCss);
        content = content.replace(/\$\{inlineScript\}/g, () => `${clientConfig}\n${dashboardJs}`);
        content = content.replace(/\$\{cspSource\}/g, () => cspSource);
        content = content.replace(/\$\{extensionVersion\}/g, () => extensionVersion);
        
        content = content.replace(/\$\{teleprompterContent\}/g, () => options.markdownHtml || '<div class="ra-no-content">No Content Loaded</div>');
        
        return content;
    }

    public stop() {
        this._wss?.close();
        this._server?.close();
    }

    private _getContentType(filePath: string): string {
        const ext = path.extname(filePath);
        switch (ext) {
            case '.html': return 'text/html';
            case '.js': return 'application/javascript';
            case '.css': return 'text/css';
            default: return 'text/plain';
        }
    }
}
