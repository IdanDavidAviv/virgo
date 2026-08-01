import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

export interface PhonikudLogger {
    info(msg: string): void;
    error(msg: string): void;
}

export class PhonikudIPCManager {
    private _process: ChildProcess | null = null;
    private _nextId = 1;
    private _pendingRequests = new Map<number, {
        resolve: (val: any) => void;
        reject: (err: Error) => void;
        tempWavPath?: string;
    }>();
    private _logger: PhonikudLogger;
    private _modelsDir: string | null = null;

    constructor(logger?: PhonikudLogger) {
        this._logger = logger || {
            info: (msg) => console.log(`[PhonikudIPC] [INFO] ${msg}`),
            error: (msg) => console.error(`[PhonikudIPC] [ERROR] ${msg}`)
        };
    }

    public async start(modelsDir?: string): Promise<void> {
        if (this._process) {
            // If modelsDir configuration has changed, restart the process
            if (this._modelsDir !== (modelsDir || null)) {
                this._logger.info(`Models directory changed from "${this._modelsDir}" to "${modelsDir}". Restarting daemon...`);
                await this.stop();
            } else {
                return; // Already running with correct configuration
            }
        }

        this._modelsDir = modelsDir || null;
        const args = ['run', 'phonikud_backend/backend.py'];
        if (this._modelsDir) {
            args.push('--models-dir', this._modelsDir);
        }

        // Self-healingly locate the project workspace root directory by scanning upwards
        let cwd = __dirname;
        while (cwd && cwd !== path.dirname(cwd)) {
            if (fs.existsSync(path.join(cwd, 'package.json')) && fs.existsSync(path.join(cwd, 'phonikud_backend', 'backend.py'))) {
                break;
            }
            cwd = path.dirname(cwd);
        }

        this._logger.info(`Spawning Phonikud daemon at "${cwd}": uv ${args.join(' ')}`);

        this._process = spawn('uv', args, {
            cwd,
            env: { ...process.env, PYTHONUTF8: '1' },
            stdio: ['pipe', 'pipe', 'pipe']
        });

        const rl = readline.createInterface({
            input: this._process.stdout!,
            terminal: false
        });

        rl.on('line', (line) => {
            this._handleResponse(line);
        });

        this._process.stderr!.on('data', (data) => {
            const lines = data.toString().split('\n');
            for (const line of lines) {
                if (line.trim()) {
                    this._logger.info(`[Daemon Stderr] ${line.trim()}`);
                }
            }
        });

        this._process.on('close', (code) => {
            this._logger.error(`Phonikud daemon exited with code ${code}`);
            this._cleanupPending(new Error(`Daemon exited unexpectedly with code ${code}`));
            this._process = null;
        });

        this._process.on('error', (err) => {
            this._logger.error(`Failed to start Phonikud daemon: ${err.message}`);
            this._cleanupPending(err);
            this._process = null;
        });
    }

    public async stop(): Promise<void> {
        if (!this._process) {
            return;
        }

        this._logger.info('Stopping Phonikud daemon...');
        this._process.removeAllListeners();
        
        // Polite exit by closing stdin stream
        this._process.stdin?.end();
        
        const proc = this._process;
        this._process = null;

        await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                proc.kill();
                resolve();
            }, 1500);

            proc.on('close', () => {
                clearTimeout(timeout);
                resolve();
            });
        });

        this._cleanupPending(new Error('Phonikud daemon was stopped.'));
    }

    public async synthesize(text: string, modelsDir?: string): Promise<string> {
        await this.start(modelsDir);

        const id = this._nextId++;
        const request = {
            jsonrpc: '2.0',
            method: 'text_to_speech',
            params: {
                text,
                length_scale: 0.85
            },
            id
        };

        return new Promise<string>((resolve, reject) => {
            this._pendingRequests.set(id, {
                resolve: (result) => {
                    if (result && typeof result.audio_b64 === 'string') {
                        resolve(result.audio_b64);
                    } else {
                        reject(new Error('Phonikud daemon response missing audio_b64 payload'));
                    }
                },
                reject
            });

            this._process!.stdin!.write(JSON.stringify(request) + '\n');
        });
    }

    public async checkForUpdates(modelsDir?: string): Promise<any> {
        await this.start(modelsDir);
        const id = this._nextId++;
        const request = {
            jsonrpc: '2.0',
            method: 'check_for_updates',
            params: {},
            id
        };

        return new Promise<any>((resolve, reject) => {
            this._pendingRequests.set(id, { resolve, reject });
            this._process!.stdin!.write(JSON.stringify(request) + '\n');
        });
    }

    public async updateModels(modelsDir?: string): Promise<any> {
        await this.start(modelsDir);
        const id = this._nextId++;
        const request = {
            jsonrpc: '2.0',
            method: 'update_models',
            params: {},
            id
        };

        return new Promise<any>((resolve, reject) => {
            this._pendingRequests.set(id, { resolve, reject });
            this._process!.stdin!.write(JSON.stringify(request) + '\n');
        });
    }

    private _handleResponse(line: string) {
        try {
            const response = JSON.parse(line.trim());
            const id = response.id;
            const pending = this._pendingRequests.get(id);
            if (!pending) {
                return;
            }

            this._pendingRequests.delete(id);

            if (response.error) {
                pending.reject(new Error(response.error.message || 'Unknown JSON-RPC error'));
            } else {
                pending.resolve(response.result);
            }
        } catch (e: any) {
            this._logger.error(`Failed to parse daemon response: ${line}. Error: ${e.message}`);
        }
    }

    private _cleanupPending(err: Error) {
        for (const [id, pending] of this._pendingRequests.entries()) {
            pending.reject(err);
            if (pending.tempWavPath) {
                fs.unlink(pending.tempWavPath, () => {});
            }
        }
        this._pendingRequests.clear();
    }
}
