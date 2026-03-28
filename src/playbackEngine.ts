import * as child_process from 'child_process';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

export type EngineMode = 'local' | 'neural';

export interface PlaybackOptions {
    voice: string;
    rate: number;
    volume: number;
    mode: EngineMode;
}

export class PlaybackEngine {
    private _tts: MsEdgeTTS;
    private _synthesisLock: Promise<void> = Promise.resolve();
    
    // Unified LRU Cache for all synthesized audio
    private _audioCache: Map<string, string> = new Map();
    private readonly MAX_CACHE_BYTES = 50 * 1024 * 1024; // 50MB Cap

    // Track ongoing synthesis to prevent duplicates
    private _pendingTasks: Map<string, Promise<string | null>> = new Map();

    private _nativeProcess: any = null;
    private _isPlaying: boolean = false;
    private _isPaused: boolean = false;

    private _cacheSizeBytes: number = 0;
    private _onCacheUpdate?: () => void;
    private _abortController: AbortController | null = null;

    constructor(private logger: (msg: string) => void, onCacheUpdate?: () => void) {
        this._tts = new MsEdgeTTS();
        this._onCacheUpdate = onCacheUpdate;
    }

    public get isPlaying() { return this._isPlaying; }
    public get isPaused() { return this._isPaused; }

    public setPlaying(val: boolean) { 
        this._isPlaying = val; 
        if (val) {this._isPaused = false;}
    }
    
    public setPaused(val: boolean) { 
        this._isPaused = val; 
        if (val) {this._isPlaying = false;}
    }

    public stop() {
        this._isPlaying = false;
        this._isPaused = false;
        if (this._abortController) {
            this.logger(`[NEURAL] ABORTING in-flight synthesis.`);
            this._abortController.abort();
            this._abortController = null;
        }
        this.stopProcess();
    }

    public stopProcess() {
        if (this._nativeProcess) {
            try {
                if (process.platform === 'win32') {
                    child_process.execSync(`taskkill /F /T /PID ${this._nativeProcess.pid}`);
                } else {
                    this._nativeProcess.kill('SIGKILL');
                }
            } catch (err) {}
            this._nativeProcess = null;
        }
    }

    public clearCache() {
        this._audioCache.clear();
        this._pendingTasks.clear();
    }

    public getCacheStats() {
        let totalBase64Chars = 0;
        this._audioCache.forEach(value => {
            totalBase64Chars += value.length;
        });
        const bytes = Math.floor(totalBase64Chars * 0.75);
        this.logger(`[CACHE STATS] Count: ${this._audioCache.size} | Total Chars: ${totalBase64Chars} | Est Bytes: ${bytes}`);
        return {
            count: this._audioCache.size,
            sizeBytes: bytes
        };
    }

    public async getVoices() {
        const localPromise = new Promise<string[]>((resolve) => {
            if (process.platform === 'win32') {
                const command = 'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.GetInstalledVoices().VoiceInfo.Name';
                child_process.exec(`powershell -Command "${command}"`, (error: Error | null, stdout: string) => {
                    if (!error && stdout) {
                        resolve(stdout.split('\r\n').filter((v: string) => v.trim()).map((v: string) => v.trim()));
                    } else {
                        resolve([]);
                    }
                });
            } else if (process.platform === 'darwin') {
                child_process.exec('say -v "?"', (error, stdout) => {
                    if (!error && stdout) {
                        // "Alex                en_US    # Most people would specify..."
                        const voices = stdout.split('\n')
                            .filter(line => line.trim())
                            .map(line => line.split('  ')[0].trim());
                        resolve(voices);
                    } else {
                        resolve([]);
                    }
                });
            } else {
                // Linux / espeak fallback
                child_process.exec('espeak --voices', (error, stdout) => {
                    if (!error && stdout) {
                        const lines = stdout.split('\n').slice(1); // skip header
                        const voices = lines
                            .filter(line => line.trim())
                            .map(line => line.trim().split(/\s+/)[1]); // Voice name is usually 2nd col
                        resolve(voices);
                    } else {
                        resolve([]);
                    }
                });
            }
        });

        const neuralPromise = this._tts.getVoices().then(voices => voices.map(v => ({
            name: v.FriendlyName,
            id: v.ShortName,
            lang: v.Locale,
            gender: v.Gender
        })));

        const [local, neural] = await Promise.all([localPromise, neuralPromise]);
        return { local, neural };
    }

    private _getSegmentSizeBytes(base64: string): number {
        // Base64 to raw bytes approx calculation
        return Math.floor(base64.length * 0.75);
    }

    private _addToCache(key: string, data: string) {
        const segmentSize = this._getSegmentSizeBytes(data);

        // LRU Eviction: while total size exceeds 50MB, remove oldest
        while (this._audioCache.size > 0 && (this._cacheSizeBytes + segmentSize > this.MAX_CACHE_BYTES)) {
            const firstKey = this._audioCache.keys().next().value;
            if (firstKey !== undefined) {
                const evictedData = this._audioCache.get(firstKey);
                if (evictedData) {
                    this._cacheSizeBytes -= this._getSegmentSizeBytes(evictedData);
                }
                this.logger(`[LRU] Evicting: ${firstKey} (Memory Cap Reach)`);
                this._audioCache.delete(firstKey);
            }
        }

        this._audioCache.set(key, data);
        this._cacheSizeBytes += segmentSize;
        if (this._onCacheUpdate) {this._onCacheUpdate();}
    }

    public async triggerPrefetch(text: string, cacheKey: string, options: PlaybackOptions) {
        if (options.mode !== 'neural') {return;}
        
        // If already cached or synthesis is in flight, do nothing
        if (this._audioCache.has(cacheKey) || this._pendingTasks.has(cacheKey)) {return;}

        try {
            this.logger(`[PREFETCH] Starting background synthesis: [${cacheKey}]`);
            // Background prefetch should NEVER abort the priority task
            this.speakNeural(text, cacheKey, options, false).catch(e => {
                this.logger(`[PREFETCH] Background task failed: ${e.message}`);
            });
        } catch (err) {}
    }

    public async speakNeural(text: string, cacheKey: string, options: PlaybackOptions, isPriority: boolean = true): Promise<string | null> {
        // 1. Check persistent LRU cache
        const cached = this._audioCache.get(cacheKey);
        if (cached) {
            this.logger(`[NEURAL] CACHE HIT: [${cacheKey}]`);
            // Refresh LRU position
            this._audioCache.delete(cacheKey);
            this._audioCache.set(cacheKey, cached);
            return cached;
        }

        // 2. Check if synthesis for this key is already in progress
        const inFlight = this._pendingTasks.get(cacheKey);
        if (inFlight) {
            this.logger(`[NEURAL] WAITING for in-flight synthesis: [${cacheKey}]`);
            return inFlight;
        }

        // 3. Trigger new synthesis and track it
        this.logger(`[NEURAL] CACHE MISS: Synthesizing [${cacheKey}]`);
        
        // ONLY abort if this is a priority (user-initiated) request
        if (isPriority) {
            if (this._abortController) {
                this._abortController.abort();
            }
            this._abortController = new AbortController();
        }
        
        // If not a priority request, a controller should already exist (from the last priority task)
        // or we use a temporary one. But it's better to skip aborting.
        if (!this._abortController) {
            this._abortController = new AbortController();
        }

        const task = this._getNeuralAudio(text, options.voice);
        this._pendingTasks.set(cacheKey, task);
        
        try {
            const data = await task;
            if (data) {
                this._addToCache(cacheKey, data);
                this.logger(`[NEURAL] synthesis_success | key: ${cacheKey}`);
            }
            return data;
        } finally {
            this._pendingTasks.delete(cacheKey);
        }
    }

    private async _getNeuralAudio(text: string, voiceId: string, retryCount = 1): Promise<string | null> {
        const release = this._synthesisLock;
        let resolveLock!: () => void;
        this._synthesisLock = new Promise(r => resolveLock = r);

        try {
            await release;

            const signal = this._abortController?.signal;
            if (signal?.aborted) {
                this.logger(`[NEURAL] ABORTED (Pre-flight) - Task was in queue when cancelled.`);
                resolveLock();
                return null;
            }

            await this._tts.setMetadata(voiceId, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {});
            
            // Escape ampersands which can break neural TTS XML wrapping
            const escapedText = text.replace(/&/g, '&amp;');
            this.logger(`[TTS PAYLOAD] Text: "${escapedText.substring(0, 50)}..." | Voice: ${voiceId}`);

            return await new Promise((resolve, reject) => {
                if (signal?.aborted) {
                    this.logger(`[NEURAL] ABORTED (Pre-flight) - Task was cancelled right before stream.`);
                    reject(new Error("Synthesis Aborted (Pre-flight)"));
                    return;
                }

                const { audioStream } = this._tts.toStream(escapedText);
                const chunks: Buffer[] = [];
                let hasErrored = false;

                const onAbort = () => {
                    this.logger(`[TTS STREAM] ABORT SIGNAL received.`);
                    hasErrored = true;
                    audioStream.destroy();
                    reject(new Error("Synthesis Aborted"));
                    resolveLock();
                };

                signal?.addEventListener('abort', onAbort);

                audioStream.on("data", (data: Buffer) => {
                    if (hasErrored) {return;}
                    const count = chunks.length;
                    if (count === 0 || count % 10 === 0) {
                        this.logger(`[TTS STREAM] ${count === 0 ? 'STARTING' : 'PROGRESS'} (chunk ${count})`);
                    }
                    chunks.push(data);
                });

                audioStream.on("end", () => {
                    if (hasErrored) {return;}
                    signal?.removeEventListener('abort', onAbort);
                    this.logger(`[TTS STREAM] COMPLETE. Received ${chunks.length} total chunks.`);
                    const buffer = Buffer.concat(chunks);
                    resolve(buffer.toString('base64'));
                    resolveLock();
                });

                audioStream.on("error", (err: any) => {
                    if (hasErrored) {return;}
                    signal?.removeEventListener('abort', onAbort);
                    this.logger(`[TTS STREAM] ERROR: ${err}`);
                    hasErrored = true;
                    reject(err);
                    resolveLock();
                });

                // Safety timeout for synthesis
                setTimeout(() => {
                    if (!hasErrored && chunks.length === 0) {
                        this.logger(`[TTS STREAM] TIMEOUT (25s) - No data received from Azure.`);
                        hasErrored = true;
                        signal?.removeEventListener('abort', onAbort);
                        reject(new Error("Synthesis Timeout (25s)"));
                        resolveLock();
                    }
                }, 25000);
            });
        } catch (err: any) {
            resolveLock!();
            if (retryCount > 0) {
                this.logger(`[NEURAL] Synthesis failed. Retrying... (${err})`);
                this.logger(`[NEURAL] synthesis_retry | error: ${err.message || String(err)}`);
                return this._getNeuralAudio(text, voiceId, retryCount - 1);
            }
            this.logger(`[NEURAL] synthesis_failure | error: ${err.message || String(err)}`);
            throw err;
        }
    }

    private _getSafeText(text: string): string {
        // PRODUCTION HARDENING: Neutralize shell injection by whitelisting character set
        // Allow: Alphanumeric, spaces, basic punctuation (.,!?-:;()'")
        // Deny: Symbols used for shell expansion/redirection ($, `, |, &, <, >, \, {, }, [, ])
        return text.replace(/[^a-zA-Z0-9\s.,!?-——:;()'"\u0590-\u05FF]/g, ' ')
                   .replace(/["']/g, ''); // Specifically strip quotes for command safety
    }

    public speakLocal(text: string, options: PlaybackOptions, onExit: (code: number | null) => void) {
        this.stopProcess();
        const safeText = this._getSafeText(text);
        
        if (process.platform === 'win32') {
            const psScript = `
                $v = New-Object -ComObject SAPI.SpVoice;
                $v.Volume = ${options.volume};
                $v.Rate = ${options.rate};
                if ('${options.voice}') {
                    $v.Voice = $v.GetVoices() | Where-Object { $_.GetDescription() -eq '${options.voice}' };
                }
                $v.Speak('${safeText}')
            `.trim().replace(/\n/g, ' ');
            this._nativeProcess = child_process.spawn('powershell', ['-Command', psScript]);
        } else if (process.platform === 'darwin') {
            // macOS 'say' command. Rate is in WPM (Words Per Minute). Default around 175.
            // options.rate is -10 to 10. We'll map to 100-300 WPM approx.
            const wpm = 175 + (options.rate * 15); 
            const args = ['-r', wpm.toString()];
            if (options.voice) {
                args.push('-v', options.voice);
            }
            args.push(safeText);
            this._nativeProcess = child_process.spawn('say', args);
        } else {
            // Linux espeak. -s is speed, -a is amplitude (volume), -v is voice name
            const speed = 160 + (options.rate * 10);
            const args = ['-s', speed.toString(), '-a', (options.volume * 2).toString()];
            if (options.voice) {
                args.push('-v', options.voice);
            }
            args.push(safeText);
            this._nativeProcess = child_process.spawn('espeak', args);
        }

        const timeout = setTimeout(() => {
            if (this._nativeProcess) {
                this.logger(`[LOCAL] Synthesis TIMEOUT (60s). Killing process ${this._nativeProcess.pid}`);
                this.stopProcess();
                onExit(-1);
            }
        }, 60000);

        this._nativeProcess.on('exit', (code: number | null) => {
            clearTimeout(timeout);
            this._nativeProcess = null;
            onExit(code);
        });

        
        this.logger(`[LOCAL] synthesis_success | platform: ${process.platform}`);
    }
}
