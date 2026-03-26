import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';

export class BridgeServer extends EventEmitter {
    private _server: http.Server | null = null;
    private _wss: WebSocketServer | null = null;
    private _port: number;
    private _host: string;
    private _clients: Set<WebSocket> = new Set();

    constructor(private readonly _mediaPath: string) {
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
                        const message = JSON.parse(data.toString());
                        if (message.command === 'ready') {
                            this.emit('ready');
                        }
                    } catch (e) {}
                });
            });

            // VPN-SAFE: Bind to all interfaces (0.0.0.0) so that VPN-rerouted loopback
            // can still connect. 127.0.0.1 alone is unreachable when a VPN captures
            // the loopback adapter. We keep _host in the URL for the CSP/config.
            this._server.listen(this._port, '0.0.0.0', () => {
                console.log(`[BRIDGE] Server listening on 0.0.0.0:${this._port} (CSP host: ${this._host})`);
                resolve(this._port);
            });


            this._server.on('error', (err: any) => {
                if (err.code === 'EADDRINUSE') {
                    // Try next port if 3001 is busy
                    this._port++;
                    this._server?.close();
                    this.start().then(resolve).catch(reject);
                } else {
                    reject(err);
                }
            });
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

    public getHtml(webview?: { cspSource: string }, options: { overrideHost?: string } = {}): string {
        const filePath = path.join(this._mediaPath, 'speechEngine.html');
        if (!fs.existsSync(filePath)) return '<h1>Bridge Error: speechEngine.html not found</h1>';

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
            `script-src 'unsafe-inline' 'unsafe-eval' ${cspSource} https:`,
            `style-src 'unsafe-inline' ${cspSource} https:`,
            `connect-src ${connectSources} https:`,
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
