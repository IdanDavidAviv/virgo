import * as child_process from 'child_process';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { EventEmitter } from 'events';

export type EngineMode = 'local' | 'neural';

export interface PlaybackOptions {
    voice: string;
    rate: number;
    volume: number;
    mode: EngineMode;
    retryCount?: number;
}

export class PlaybackEngine extends EventEmitter {
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
    
    // Hardening: Track unique playback intents to eject stale/zombie tasks
    private _playbackIntentId: number = 0;
    private _isRateLimited: boolean = false;
    private _watchdogTimer: NodeJS.Timeout | null = null;
    private _isStalled: boolean = false;

    constructor(private logger: (msg: string) => void, onCacheUpdate?: () => void) {
        super();
        this._tts = new MsEdgeTTS();
        this._onCacheUpdate = onCacheUpdate;
    }

    private _reinitTTS() {
        this.logger(`[NEURAL] Re-initializing MsEdgeTTS client...`);
        try {
            this._tts = new MsEdgeTTS();
            this.logger(`[NEURAL] Client re-initialized.`);
        } catch (e) {
            this.logger(`[NEURAL] Failed to re-initialize TTS: ${e}`);
        }
    }

    public get isPlaying() { return this._isPlaying; }
    public get isPaused() { return this._isPaused; }
    public get isStalled() { return this._isStalled; }

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
        this._isStalled = false;
        this._playbackIntentId++; // Increment to eject all pending tasks
        
        if (this._abortController) {
            this.logger(`[NEURAL] ABORTING in-flight synthesis (Intent: ${this._playbackIntentId}).`);
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
        this._cacheSizeBytes = 0;
    }

    public getCacheStats() {
        let totalBase64Chars = 0;
        this._audioCache.forEach(value => {
            totalBase64Chars += value.length;
        });
        const bytes = Math.floor(totalBase64Chars * 0.75);
        this.logger(`[CACHE] count:${this._audioCache.size} | chars:${totalBase64Chars} | bytes:${bytes}`);
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
                this.logger(`[LRU EVIC] key:${firstKey} | bytes:${evictedData ? this._getSegmentSizeBytes(evictedData) : 0}`);
                this._audioCache.delete(firstKey);
            }
        }

        this._audioCache.set(key, data);
        this._cacheSizeBytes += segmentSize;
        if (this._onCacheUpdate) {this._onCacheUpdate();}
    }

    public triggerPrefetch(text: string, cacheKey: string, options: PlaybackOptions) {
        if (options.mode !== 'neural') {return;}
        
        if (this._audioCache.has(cacheKey) || this._pendingTasks.has(cacheKey)) {
            return;
        }

        this.logger(`[PREFETCH] key:${cacheKey}`);
            // Background prefetch should NEVER abort the priority task
            this.speakNeural(text, cacheKey, options, false).catch(e => {
                this.logger(`[PREFETCH] Background task failed: ${e.message}`);
            });
    }

    public async speakNeural(text: string, cacheKey: string, options: PlaybackOptions, isPriority: boolean = true): Promise<string | null> {
        // --- CHECK CACHE ---
        if (this._audioCache.has(cacheKey)) {
            const bytes = this._getSegmentSizeBytes(this._audioCache.get(cacheKey)!);
            this.logger(`[CACHE HIT] key:${cacheKey} | Size: ${(bytes / 1024).toFixed(1)}KB`);
            if (isPriority) {
                this._isPlaying = true;
                this._isStalled = false; // Cache hit is NEVER a stall
                this.emit('status');
            }
            return Promise.resolve(this._audioCache.get(cacheKey)!);
        }

        // --- CACHE MISS (Start synthesis) ---
        if (isPriority) {
            this.logger(`[CACHE MISS] key:${cacheKey} | Triggering PRIORITY synthesis.`);
        } else {
            this.logger(`[CACHE MISS] key:${cacheKey} | Triggering BACKGROUND prefetch.`);
        }

        // --- CHECK PENDING ---
        if (this._pendingTasks.has(cacheKey)) {
            this.logger(`[PENDING HIT] key:${cacheKey}`);
            if (isPriority) {this._isPlaying = true;}
            return this._pendingTasks.get(cacheKey)!;
        }

        if (isPriority) {
            this._isPlaying = true;
            this._isStalled = true; // Priority synthesis started -> We are stalling until it finishes
            this.emit('status');

            this._playbackIntentId++; // New intent
            this.logger(`[NEURAL] NEW INTENT: ${this._playbackIntentId}`);
            
            if (this._abortController) {
                this._abortController.abort();
            }
            this._abortController = new AbortController();
        }
        
        const currentIntentId = this._playbackIntentId;

        // If not a priority request, a controller should already exist (from the last priority task)
        // or we use a temporary one. But it's better to skip aborting.
        if (!this._abortController) {
            this._abortController = new AbortController();
        }

        let taskResolve!: (val: string | null) => void;
        let taskReject!: (err: any) => void;
        const task = new Promise<string | null>((res, rej) => {
            taskResolve = res;
            taskReject = rej;
        });

        // REGISTER SYNCHRONOUSLY to prevent race on back-to-back calls
        this._pendingTasks.set(cacheKey, task);

        // Actual Work (Async)
        (async () => {
            const release = this._synthesisLock;
            let resolveLock!: () => void;
            this._synthesisLock = new Promise(r => resolveLock = r);
            
            try {
                // Wait for existing lock OR abort
                await Promise.race([
                    release,
                    new Promise((_, reject) => {
                        this._abortController?.signal?.addEventListener('abort', () => reject(new Error('Synthesis Aborted')), { once: true });
                        if (currentIntentId !== this._playbackIntentId) { reject(new Error('Stale Intent')); }
                    })
                ]);

                return await this._getNeuralAudio(text, options.voice, options.retryCount ?? 3, currentIntentId, isPriority);
            } finally {
                resolveLock();
                this._pendingTasks.delete(cacheKey);
                this._clearWatchdog();
            }
        })().then(
            (res) => {
                if (isPriority) {
                    this._isStalled = false;
                    this.emit('status');
                }
                taskResolve(res);
            },
            (err) => {
                if (isPriority) {
                    this._isStalled = false;
                    this.emit('status');
                }
                taskReject(err);
            }
        );
        
        try {
            const data = await task;
            if (data) {
                this._addToCache(cacheKey, data);
                this.logger(`[NEURAL] success: ${cacheKey}`);
            }
            return data;
        } catch (err) {
            // Error already logged in _getNeuralAudio
            throw err;
        }
    }

    private _startWatchdog(intentId: number) {
        this._clearWatchdog();
        this._watchdogTimer = setTimeout(() => {
            if (this._playbackIntentId === intentId) {
                this.logger(`[TTS HANG] Silent timeout (5s) for Intent ${intentId}. Recycling...`);
                this._reinitTTS(); // Force WebSocket cleanup
                if (this._abortController) {
                    this._abortController.abort();
                }
            }
        }, 5000);
    }

    private _clearWatchdog() {
        if (this._watchdogTimer) {
            clearTimeout(this._watchdogTimer);
            this._watchdogTimer = null;
        }
    }

    private async _getNeuralAudio(text: string, voiceId: string, retryCount = 1, intentId: number, isPriority: boolean): Promise<string | null> {
        // EXIT IMMEDIATELY IF INTENT IS STALE (Handles rapid jumps before lock)
        if (intentId !== this._playbackIntentId) {
            this.logger(`[NEURAL] EJECTED (Pre-lock) - Intent ${intentId} is stale (Current: ${this._playbackIntentId})`);
            return null;
        }

        // EXIT IMMEDIATELY IF STOPPED
        if (!this._isPlaying && !this._isPaused && isPriority) {
            this.logger(`[NEURAL] Ignoring synthesis request: Engine is stopped.`);
            return null;
        }

        // CIRCUIT BREAKER: Avoid aggressive prefetching if rate limited
        if (this._isRateLimited && !isPriority) {
            this.logger(`[NEURAL] CIRCUIT BREAKER - Skipping prefetch while rate limited.`);
            return null;
        }

        try {
            // FINAL STALE CHECK BEFORE API CALL
            if (intentId !== this._playbackIntentId) {
                this.logger(`[NEURAL] EJECTED (Pre-flight) - Intent ${intentId} is stale.`);
                return null;
            }

            const signal = this._abortController?.signal;
            if (signal?.aborted) {
                this.logger(`[NEURAL] ABORTED (Pre-flight) - Task cancelled.`);
                return null;
            }

            // Escape ampersands which can break neural TTS XML wrapping
            const escapedText = text.replace(/&/g, '&amp;');
            
            // SECOND ABORT CHECK: Right before the expensive setMetadata/toStream calls
            if (signal?.aborted) {
                this.logger(`[NEURAL] ABORTED (Pre-flight) - Cancelled before metadata set.`);
                return null;
            }

            await this._tts.setMetadata(voiceId, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {});
            this.logger(`[TTS REQ] text:"${escapedText.substring(0, 30)}..." | voice:${voiceId} | Intent:${intentId}`);

            return await new Promise((resolve, reject) => {
                if (signal?.aborted) {
                    reject(new Error("Synthesis Aborted"));
                    return;
                }

                const { audioStream } = this._tts.toStream(escapedText);
                const chunks: Buffer[] = [];
                let hasErrored = false;

                // START WATCHDOG (5s until Chunk 0)
                this._startWatchdog(intentId);

                const onAbort = () => {
                    this.logger(`[TTS STREAM] ABORT SIGNAL received.`);
                    hasErrored = true;
                    audioStream.destroy();
                    reject(new Error("Synthesis Aborted"));
                };

                signal?.addEventListener('abort', onAbort);

                audioStream.on("data", (data: Buffer) => {
                    if (hasErrored) { return; }
                    if (chunks.length === 0) {
                        this._clearWatchdog();
                        this.logger(`[TTS STREAM] STARTING (chunk 0)`);
                    }
                    chunks.push(data);
                });

                audioStream.on("end", () => {
                    if (hasErrored) { return; }
                    signal?.removeEventListener('abort', onAbort);
                    this.logger(`[TTS STREAM] COMPLETE | chunks:${chunks.length}`);
                    resolve(Buffer.concat(chunks).toString('base64'));
                });

                audioStream.on("error", (err: any) => {
                    if (hasErrored) { return; }
                    signal?.removeEventListener('abort', onAbort);
                    this.logger(`[TTS STREAM] ERROR: ${err}`);
                    hasErrored = true;
                    reject(err);
                });

                // Safety timeout for synthesis
                setTimeout(() => {
                    if (!hasErrored && chunks.length === 0) {
                        this.logger(`[TTS STREAM] TIMEOUT (25s) - No data received from Azure.`);
                        hasErrored = true;
                        signal?.removeEventListener('abort', onAbort);
                        
                        // Hardening: Recycle the client on timeout to clear socket hangs
                        this._reinitTTS();
                        
                        reject(new Error("Synthesis Timeout (25s)"));
                    }
                }, 25000);
            });
        } catch (err: any) {
            const errorMessage = err?.message || String(err);
            
            // CRITICAL: Immediately exit on Abort or Stale Intent, do NOT retry.
            if (errorMessage.includes("Aborted") || errorMessage.includes("Stale Intent")) {
                this.logger(`[NEURAL] synthesis_aborted | Intent: ${intentId} | No retry.`);
                return null;
            }

            // --- RATE LIMIT DETECTION ---
            if (errorMessage.includes("429") || errorMessage.toLowerCase().includes("too many requests")) {
                this.logger(`[RATE LIMIT HIT] Azure TTS has throttled our requests. Entering Safe Mode.`);
                this._isRateLimited = true;
                
                // Reset circuit breaker after 60 seconds
                setTimeout(() => {
                    this._isRateLimited = false;
                    this.logger(`[NEURAL] CIRCUIT BREAKER RESET - Resuming normal prefetch operation.`);
                }, 60000);
            }

            if (retryCount > 0) {
                // DO NOT RETRY IF STOPPED or STALE
                if (intentId !== this._playbackIntentId || (!this._isPlaying && !this._isPaused && isPriority)) {
                    this.logger(`[NEURAL] synthesis_cancelled | Intent ${intentId} is stale or engine stopped.`);
                    return null;
                }

                // DO NOT RETRY IF PAUSED (Keeps lock free for the user)
                if (this._isPaused) {
                    this.logger(`[NEURAL] synthesis_failed during pause | Skipping retry to keep lock free.`);
                    return null;
                }

                // ONLY RETRY PRIORITY TASKS - Prefetch failures are ignored to save quota/bandwidth
                if (!isPriority) {
                    this.logger(`[NEURAL] Prefetch failed (${errorMessage}) | Skipping retry.`);
                    return null;
                }

                this.logger(`[NEURAL] Synthesis failed. Retrying... (${errorMessage})`);
                this.logger(`[NEURAL] synthesis_retry | error: ${errorMessage}`);
                return this._getNeuralAudio(text, voiceId, retryCount - 1, intentId, isPriority);
            }
            this.logger(`[NEURAL] synthesis_failure | error: ${errorMessage}`);
            throw err;
        } finally {
            // Lock managed by caller (speakNeural)
        }
    }

    private _getSafeText(text: string): string {
        // PRODUCTION HARDENING: Neutralize shell injection by whitelisting character set
        // Allow: Alphanumeric, spaces, basic punctuation (.,!?:;()'")
        // Deny: Symbols used for shell expansion/redirection ($, `, |, &, <, >, \, {, }, [, ])
        // Note: Hyphen must be at the end of the character class to be literal.
        return text.replace(/[^a-zA-Z0-9\s.,!?:;()'"\u0590-\u05FF-]/g, ' ')
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
