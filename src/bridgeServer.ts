import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';

export interface BridgeMessage {
    command: string;
    [key: string]: any;
}


export class BridgeServer extends EventEmitter {
    private _server: http.Server | null = null;
    private _wss: WebSocketServer | null = null;
    private _port: number;
    private _intendedPort: number = 3000;
    private _host: string;
    private _clients: Set<WebSocket> = new Set();
    private _retryCount: number = 0;

    constructor(private readonly _mediaPath: string, private readonly logger: (msg: string) => void) {
        super();
        this._port = 3000; 
        this._host = '127.0.0.1';
    }

    public get port(): number {
        return this._port;
    }

    public get metadata() {
        return {
            port: this._port,
            intended: this._intendedPort,
            shifted: this._port !== this._intendedPort
        };
    }

    public start(port?: number): Promise<number> {
        if (port) {
            this._port = port;
            this._intendedPort = port;
        }
        return new Promise((resolve, reject) => {
            this._server = http.createServer((req, res) => {
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
                        res.end(this.getHtml());
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
            this._wss.on('connection', (ws) => {
                this._clients.add(ws);
                ws.on('close', () => this._clients.delete(ws));
                ws.on('message', (data) => {
                    try {
                        const raw = JSON.parse(data.toString()) as BridgeMessage;
                        if (raw && raw.command === 'ready') {
                            this.emit('ready');
                        }
                    } catch (e) {}
                });
            });

            this._server.on('error', (err: any) => {
                if (err.code === 'EADDRINUSE' && this._retryCount < 10) {
                    this._retryCount++;
                    const nextPort = this._port + 1;
                    this.logger(`[BRIDGE] PORT COLLISION: ${this._port} is taken. Moving to ${nextPort}`);
                    this._port = nextPort;
                    this.stop(); 
                    setTimeout(() => {
                        this.start().then(resolve).catch(reject);
                    }, 100);
                } else {
                    const fatalMsg = `Max retries (10) exceeded. Last tried port: ${this._port}`;
                    this.logger(`[BRIDGE] FATAL: ${fatalMsg}`);
                    this.emit('fatal_error', fatalMsg);
                    reject(new Error(fatalMsg));
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

    public getHtml(): string {
        const filePath = path.join(this._mediaPath, 'speechEngine.html');
        if (!fs.existsSync(filePath)) {return '<h1>Bridge Error: speechEngine.html not found</h1>';}

        let content = fs.readFileSync(filePath, 'utf8');
        
        // 1. Read Styles/Scripts
        const styleCss = fs.existsSync(path.join(this._mediaPath, 'style.css')) 
            ? fs.readFileSync(path.join(this._mediaPath, 'style.css'), 'utf8') : '';
        const dashboardJs = fs.existsSync(path.join(this._mediaPath, 'dashboard.js')) 
            ? fs.readFileSync(path.join(this._mediaPath, 'dashboard.js'), 'utf8') : '';
        
        // 2. Inject configuration
        const clientConfig = `window.__BRIDGE_CONFIG__ = { host: '127.0.0.1', port: ${this._port} };`;
        
        // Support both old and new injection markers
        content = content.replace('<!-- CONFIG_INJECTION -->', `<script>${clientConfig}</script>`);
        content = content.replace('/* CSS_INJECTION */', styleCss);
        content = content.replace('/* JS_INJECTION */', dashboardJs);
        
        // Handle template literals if they still exist in the HTML template
        content = content.replace(/\$\{inlineStyle\}/g, () => styleCss);
        content = content.replace(/\$\{inlineScript\}/g, () => `${clientConfig}\n${dashboardJs}`);

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
