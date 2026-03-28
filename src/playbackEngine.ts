import * as child_process from 'child_process';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { Telemetry } from './telemetry';

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
    private readonly MAX_CACHE_SIZE = 100;

    // Track ongoing synthesis to prevent duplicates
    private _pendingTasks: Map<string, Promise<string | null>> = new Map();

    private _nativeProcess: any = null;
    private _isPlaying: boolean = false;
    private _isPaused: boolean = false;

    private _cacheSizeBytes: number = 0;
    private _onCacheUpdate?: () => void;

    constructor(private logger: (msg: string) => void, onCacheUpdate?: () => void) {
        this._tts = new MsEdgeTTS();
        this._onCacheUpdate = onCacheUpdate;
    }

    public get isPlaying() { return this._isPlaying; }
    public get isPaused() { return this._isPaused; }

    public setPlaying(val: boolean) { 
        this._isPlaying = val; 
        if (val) this._isPaused = false;
    }
    
    public setPaused(val: boolean) { 
        this._isPaused = val; 
        if (val) this._isPlaying = false;
    }

    public stop() {
        this._isPlaying = false;
        this._isPaused = false;
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

    private _addToCache(key: string, data: string) {
        // Simple LRU: if full, remove oldest (first inserted)
        if (this._audioCache.size >= this.MAX_CACHE_SIZE) {
            const firstKey = this._audioCache.keys().next().value;
            if (firstKey !== undefined) {
                this.logger(`[LRU] Evicting: ${firstKey} (Cache Full)`);
                this._audioCache.delete(firstKey);
            }
        }
        this._audioCache.set(key, data);
        this._cacheSizeBytes += data.length;
        if (this._onCacheUpdate) this._onCacheUpdate();
    }

    public async triggerPrefetch(text: string, cacheKey: string, options: PlaybackOptions) {
        if (options.mode !== 'neural') return;
        
        // If already cached or synthesis is in flight, do nothing
        if (this._audioCache.has(cacheKey) || this._pendingTasks.has(cacheKey)) return;

        try {
            this.logger(`[PREFETCH] Starting background synthesis: [${cacheKey}]`);
            // We use the same unified logic as speakNeural but don't await it here to keep it backgrounded
            this.speakNeural(text, cacheKey, options).catch(e => {
                this.logger(`[PREFETCH] Background task failed: ${e.message}`);
            });
        } catch (err) {}
    }

    public async speakNeural(text: string, cacheKey: string, options: PlaybackOptions): Promise<string | null> {
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
        const task = this._getNeuralAudio(text, options.voice);
        this._pendingTasks.set(cacheKey, task);
        
        try {
            const data = await task;
            if (data) {
                this._addToCache(cacheKey, data);
                Telemetry.track('synthesis_success', { key: cacheKey, mode: 'neural' });
            }
            return data;
        } finally {
            this._pendingTasks.delete(cacheKey);
        }
    }

    private async _getNeuralAudio(text: string, voiceId: string, retryCount = 1): Promise<string | null> {
        const release = this._synthesisLock;
        let resolveLock: () => void;
        this._synthesisLock = new Promise(r => resolveLock = r);

        try {
            await release;
            await this._tts.setMetadata(voiceId, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {});
            
            // Escape ampersands which can break neural TTS XML wrapping
            const escapedText = text.replace(/&/g, '&amp;');
            this.logger(`[TTS PAYLOAD] Text: "${escapedText.substring(0, 50)}..." | Voice: ${voiceId}`);

            return await new Promise((resolve, reject) => {
                const { audioStream } = this._tts.toStream(escapedText);
                const chunks: Buffer[] = [];
                let hasErrored = false;

                audioStream.on("data", (data: Buffer) => {
                    const count = chunks.length;
                    if (count === 0 || count % 10 === 0) {
                        this.logger(`[TTS STREAM] ${count === 0 ? 'STARTING' : 'PROGRESS'} (chunk ${count})`);
                    }
                    chunks.push(data);
                });

                audioStream.on("end", () => {
                    if (hasErrored) return;
                    this.logger(`[TTS STREAM] COMPLETE. Received ${chunks.length} total chunks.`);
                    const buffer = Buffer.concat(chunks);
                    resolve(buffer.toString('base64'));
                    resolveLock();
                });

                audioStream.on("error", (err: any) => {
                    this.logger(`[TTS STREAM] ERROR: ${err}`);
                    hasErrored = true;
                    reject(err);
                    resolveLock();
                });

                // Safety timeout for synthesis
                setTimeout(() => {
                    if (!hasErrored && chunks.length === 0) {
                        this.logger(`[TTS STREAM] TIMEOUT (10s) - No data received.`);
                        hasErrored = true;
                        reject(new Error("Synthesis Timeout (10s)"));
                        resolveLock();
                    }
                }, 10000);
            });
        } catch (err: any) {
            resolveLock!();
            if (retryCount > 0) {
                this.logger(`[NEURAL] Synthesis failed. Retrying... (${err})`);
                Telemetry.track('synthesis_retry', { error: err.message || String(err) });
                return this._getNeuralAudio(text, voiceId, retryCount - 1);
            }
            Telemetry.track('synthesis_failure', { error: err.message || String(err), mode: 'neural' });
            throw err;
        }
    }

    public speakLocal(text: string, options: PlaybackOptions, onExit: (code: number | null) => void) {
        this.stopProcess();
        const safeText = text.replace(/["']/g, '');
        
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

        this._nativeProcess.on('exit', (code: number | null) => {
            this._nativeProcess = null;
            onExit(code);
        });
        
        Telemetry.track('synthesis_success', { mode: 'local', platform: process.platform });
    }
}
