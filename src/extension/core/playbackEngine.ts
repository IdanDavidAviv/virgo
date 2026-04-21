import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { EventEmitter } from 'events';
import { cleanForSpeech } from './speechProcessor';
import * as crypto from 'crypto';

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
    private _maxCacheBytes = 50 * 1024 * 1024; // 50MB Cap (Default)

    // Track ongoing synthesis to prevent duplicates
    private _pendingTasks: Map<string, Promise<string | null>> = new Map();

    private _isPlaying: boolean = false;
    private _isPaused: boolean = false;

    private _cacheSizeBytes: number = 0;
    private _onCacheUpdate?: () => void;
    private _abortController: AbortController | null = null;
    private _batchAbortController: AbortController | null = null;
    private _prefetchAbortController: AbortController = new AbortController();

    // Hardening: Track monotonic unique playback intents to eject stale/zombie tasks
    private _playbackIntentId: number = 1;
    private _batchIntentId: number = 1;
    private _isRateLimited: boolean = false;
    private _watchdogTimer: NodeJS.Timeout | null = null;
    private _isStalled: boolean = false;

    private _logLevel: number = 1;
    private _lastLoggedCacheCount: number = -1;
    private _lastLoggedCacheTime: number = 0;
    private _retryAttempts: number = 3;

    private _activeSegmentAbortController: AbortController | null = null;

    // [v2.3.1] Autoradiant Health SSOT
    private _neuralHealth: 'HEALTHY' | 'DEGRADED' | 'STALLED' = 'HEALTHY';
    private _lastNeuralSuccessTime: number = Date.now();
    private _consecutiveNeuralErrors: number = 0;
    // [SOVEREIGN RESET] Removed legacy 5-minute fallback timer. 
    // Health is now governed by explicit manual intent and reactive success signals.
    // [Gate 3] Startup Orchestration — lock-aware TTS disposal.
    // _reinitTTS() called while synthesis is active defers until the finally block fires.
    private _synthesisActive: number = 0;
    private _pendingReinit: boolean = false;
    // [Gate 4] Startup Orchestration — TTS warm-up gate.
    // MsEdgeTTS opens its WebSocket lazily on first setMetadata(). This gate resolves once
    // the client is confirmed ready so that real synthesis never races against the WS handshake.
    private _ttsReady: Promise<void>;
    private _resolveTtsReady!: () => void;


    constructor(private logger: (msg: string) => void, onCacheUpdate?: () => void) {
        super();
        this._ttsReady = new Promise(r => { this._resolveTtsReady = r; });
        this._tts = new MsEdgeTTS();
        this._onCacheUpdate = onCacheUpdate;
        // [Gate 4] Warm up the TTS client immediately so the WebSocket is open before first use.
        this._warmUpTts();
    }

    public setLogLevel(level: number) {
        this._logLevel = level;
    }

    private async _acquireLock() {
        let release: () => void;
        const nextLock = new Promise<void>(resolve => {
            release = resolve;
        });
        const currentLock = this._synthesisLock;
        this._synthesisLock = nextLock;
        await currentLock;
        return release!;
    }

    public setCacheLimitMb(mb: number) {
        this._maxCacheBytes = mb * 1024 * 1024;
        this.logger(`[CACHE] Max size updated to ${mb}MB (${this._maxCacheBytes} bytes).`);
        // Prune immediately if current size exceeds new limit
        this._pruneCache();
    }

    private _pruneCache(incomingSizeBytes: number = 0) {
        // Defensive: ensure incoming size is a number
        const safeIncomingSize = Number.isFinite(incomingSizeBytes) ? incomingSizeBytes : 0;

        // LRU Eviction: while total size exceeds limit, remove oldest
        while (this._audioCache.size > 0 && (this._cacheSizeBytes + safeIncomingSize > this._maxCacheBytes)) {
            const firstKey = this._audioCache.keys().next().value;
            if (firstKey !== undefined) {
                const evictedData = this._audioCache.get(firstKey);
                if (evictedData) {
                    const segmentSize = this._getSegmentSizeBytes(evictedData);
                    this._cacheSizeBytes = Math.max(0, this._cacheSizeBytes - segmentSize);
                }
                this.logger(`[LRU EVIC] key:${firstKey} | bytes:${evictedData ? this._getSegmentSizeBytes(evictedData) : 0}`);
                this._audioCache.delete(firstKey);
            } else {
                break; // Safety break
            }
        }
    }

    private _reinitTTS(force: boolean = false) {
        // [Gate 3] If synthesis is actively in-flight, defer disposal until lock is released.
        // If force is true (e.g. during a retry block where the stream is already dead), bypass the lock check.
        if (!force && this._synthesisActive > 0) {
            this.logger('[NEURAL] ⏳ Re-init deferred — synthesis in-flight. Will execute on lock release.');
            this._pendingReinit = true;
            return;
        }
        this._executeReinit();
    }

    private _executeReinit() {
        this.logger('[NEURAL] Authority Re-initialization (Lib Corruption Detected)');
        try {
            if (this._tts) {
                try { (this._tts as any).close(); } catch (e) {}
            }
            this._tts = new MsEdgeTTS();
            this.logger('[NEURAL] Client re-initialized.');
        } catch (e) {
            this.logger(`[NEURAL] Failed to re-initialize TTS: ${e}`);
        }
        // [Gate 4] Reset ready gate and resolve immediately — no warm-up needed.
        // MsEdgeTTS opens its WebSocket lazily per toStream(); pre-warming creates dead sockets.
        this._ttsReady = Promise.resolve();
    }

    /**
     * [Gate 4] Resolve the TTS ready gate immediately.
     * MsEdgeTTS opens its WebSocket lazily per toStream() call — there is no
     * connection to pre-warm. A prior setMetadata() warm-up caused a "dead socket"
     * race: Azure closed the idle WS after the probe, then the first real toStream()
     * fired on a closed socket and returned 0 chunks.
     */
    private _warmUpTts() {
        this.logger('[NEURAL] 🟢 TTS gate resolved. WebSocket opens lazily on first synthesis.');
        this._resolveTtsReady();
    }

    public get isPlaying() { return this._isPlaying; }
    public get isPaused() { return this._isPaused; }
    public get isStalled() { return this._isStalled; }
    public get playbackIntentId() { return this._playbackIntentId; }
    public get neuralHealth() { return this._neuralHealth; }

    /**
     * [v2.3.1] Autoradiant: Force a health check and return viability.
     * Neural is only considered 'Viable' if it has been healthy OR if it is degraded 
     * but hasn't yet crossed the 2-minute failure threshold.
     */
    /**
     * resetNeuralHealth(): Explicitly restores the engine to HEALTHY state.
     * Used by VoiceManager during manual refreshes to break 'STALLED' deadlocks.
     */
    public resetNeuralHealth() {
        this.logger(`[NEURAL] ❤️‍🩹 Manual health reset triggered.`);
        this._neuralHealth = 'HEALTHY';
        this._lastNeuralSuccessTime = Date.now();
        this._consecutiveNeuralErrors = 0;
    }

    /**
     * isNeuralViable(): Checks if the neural engine is healthy enough to use.
     * [SOVEREIGN RESET] Snappy Reactive Recovery:
     * 1. If HEALTHY or DEGRADED, always viable.
     * 2. If STALLED, only viable if the user has triggered a manual recovery (resetNeuralHealth)
     *    or if we are in a 'Probe' state (e.g. manual Play gesture).
     */
    public isNeuralViable(): boolean {
        if (this._neuralHealth !== 'STALLED') { return true; }
        
        // [REACTIVE] If we are stalled, we only allow a probe if it's a manual recovery attempt.
        // For now, if we are stalled, we force local fallback until manual reset.
        this.logger(`[NEURAL] 🩺 Health is STALLED. Falling back to local.`);
        return false;
    }

    private _updateStatus(isPlaying?: boolean, isPaused?: boolean, isStalled?: boolean) {
        if (isPlaying !== undefined) { this._isPlaying = isPlaying; }
        if (isPaused !== undefined) { this._isPaused = isPaused; }
        if (isStalled !== undefined) { this._isStalled = isStalled; }

        // Logic: if playing, cannot be paused. If paused, cannot be playing.
        this.emit('status', {
            isPlaying: this._isPlaying,
            isPaused: this._isPaused,
            isStalled: this._isStalled
        });
    }

    public setRetryAttempts(attempts: number) {
        this._retryAttempts = attempts;
        this.logger(`[NEURAL] Retry attempts updated to ${attempts}.`);
    }

    public setPlaying(val: boolean, intentId?: number) {
        if (intentId !== undefined) { this.adoptIntent(intentId); }
        this._updateStatus(val, !val ? this._isPaused : false);
    }

    public setPaused(val: boolean, intentId?: number) {
        if (intentId !== undefined) { this.adoptIntent(intentId); }
        this._updateStatus(!val ? this._isPlaying : false, val);
    }

    public get batchIntentId() { return this._batchIntentId; }

    public getAudioFromCache(cacheKey: string): string | undefined { return this._audioCache.get(cacheKey); }

    public adoptIntent(id: number) {
        // [SOVEREIGNTY] Magnitude Protection: Reject stale packets
        if (id < this._playbackIntentId) {
            this.logger(`[PlaybackEngine] 🛡️ Ejected stale intent: ${id} < current ${this._playbackIntentId}`);
            return;
        }

        if (id > this._playbackIntentId) {
            this.logger(`[PlaybackEngine] 🧬 Adopting Segment Intent: ${id} (Previous: ${this._playbackIntentId})`);
            this._playbackIntentId = id;
            this.emit('intent-change', this._playbackIntentId);

            // [SOVEREIGNTY] Stop the current playing segment, but do NOT kill the batch.
            if (this._activeSegmentAbortController) {
                this._activeSegmentAbortController.abort('New Segment Intent');
            }
            this._activeSegmentAbortController = new AbortController();
        }
    }

    public adoptBatchIntent(id: number) {
        // [SOVEREIGNTY] Magnitude Protection: Reject stale packets
        if (id < this._batchIntentId) {
            this.logger(`[PlaybackEngine] 🛡️ Ejected stale batch intent: ${id} < current ${this._batchIntentId}`);
            return;
        }

        if (id > this._batchIntentId) {
            this.logger(`[PlaybackEngine] 📦 Adopting Batch Intent: ${id} (Previous: ${this._batchIntentId})`);
            this._batchIntentId = id;

            // [HARDENING] A new batch means a context shift (e.g. new chapter). 
            // We MUST kill all synthesis tasks (priority AND background) for the old context.
            if (this._abortController) {
                this._abortController.abort('New Batch Intent: Context Shift');
            }
            this._abortController = new AbortController();

            if (this._activeSegmentAbortController) {
                this._activeSegmentAbortController.abort('New Batch Intent');
            }
            this._activeSegmentAbortController = new AbortController();

            // Clear prefetch queue specifically
            this._prefetchAbortController.abort('New Batch Intent');
            this._prefetchAbortController = new AbortController();
        }
    }


    public stop(intentId?: number, forceBatchReset: boolean = false, silent: boolean = false) {
        this.logger(`[ENGINE] Stop (Intent: ${intentId ?? this._playbackIntentId} | ForceBatch: ${forceBatchReset}${silent ? ' | SILENT' : ''})`);

        this._isPlaying = false;
        this._isPaused = false;
        this._isStalled = false;
        
        if (!silent) {
            this._updateStatus();
        }

        if (intentId !== undefined) {
            this.adoptIntent(intentId);
        }

        // Always stop the current playing segment
        if (this._activeSegmentAbortController) {
            this._activeSegmentAbortController.abort('Stop Action');
        }

        // --- AUTHORITATIVE RESET ---
        // We abort both batch and prefetch because a 'Stop' should be universal
        if (this._batchAbortController) {
            this._batchAbortController.abort('Stop Action');
        }
        this._prefetchAbortController.abort('Stop Action');
        this._prefetchAbortController = new AbortController();
    }



    public clearCache() {
        this._audioCache.clear();
        this._pendingTasks.clear();
        this._cacheSizeBytes = 0;
        this.emit('clear-cache');
        this.emit('cache-stats-update', { count: 0, sizeBytes: 0 });
    }

    public getCacheStats() {
        let totalBase64Chars = 0;
        try {
            this._audioCache.forEach(value => {
                if (typeof value === 'string') {
                    totalBase64Chars += value.length;
                }
            });
        } catch (e) {
            this.logger(`[CACHE ERROR] Failed to iterate cache: ${e}`);
        }

        const bytes = Math.floor(totalBase64Chars * 0.75);
        const safeBytes = Number.isFinite(bytes) ? bytes : 0;

        // --- THROTTLED LOGGING ---
        const now = Date.now();
        const countChangedSignificantly = Math.abs(this._audioCache.size - this._lastLoggedCacheCount) >= 5;
        const timeElapsedSignificantly = now - this._lastLoggedCacheTime > 60000;

        if (this._logLevel >= 2 || countChangedSignificantly || timeElapsedSignificantly || this._audioCache.size === 0) {
            this.logger(`[CACHE] count:${this._audioCache.size} | chars:${totalBase64Chars} | bytes:${safeBytes}`);
            this._lastLoggedCacheCount = this._audioCache.size;
            this._lastLoggedCacheTime = now;
        }

        return {
            count: this._audioCache.size,
            sizeBytes: safeBytes
        };
    }

    public getCached(key: string): string | null {
        return this._audioCache.get(key) || null;
    }

    public async getVoices() {
        // [HARDENING] Await the TTS warm-up gate to ensure WebSocket transport is open.
        // This resolves the race condition where discovery fires during the handshake.
        await this._ttsReady;
        
        // [v2.3.1] Simplified: Native voices are now discovered via the Webview.
        // The extension only manages Neural voices.
        return this._tts.getVoices().then(voices => voices.map(v => ({
            name: v.FriendlyName,
            id: v.ShortName,
            lang: v.Locale,
            gender: v.Gender
        })));
    }

    private _getSegmentSizeBytes(base64: string): number {
        // Base64 to raw bytes approx calculation
        return Math.floor(base64.length * 0.75);
    }

    private _addToCache(key: string, data: string, intentId?: number) {
        // [HARDENING] Absolute Intent Guard - Reject data if user has skipped or changed context
        if (intentId !== undefined && intentId !== this._playbackIntentId) {
            this.logger(`[CACHE] REJECTED key:${key} | Intent mismatch: ${intentId} vs current ${this._playbackIntentId}`);
            return;
        }

        const segmentSize = this._getSegmentSizeBytes(data);
        const safeSize = Number.isFinite(segmentSize) ? segmentSize : 0;

        this._pruneCache(safeSize);

        this._audioCache.set(key, data);
        this._cacheSizeBytes = (Number.isFinite(this._cacheSizeBytes) ? this._cacheSizeBytes : 0) + safeSize;

        // [v2.3.1] Heal on success
        if (this._neuralHealth !== 'HEALTHY') {
            this.logger(`[NEURAL] ❤️‍🩹 Health RESTORED (Synthesis Success).`);
            this._neuralHealth = 'HEALTHY';
        }
        this._lastNeuralSuccessTime = Date.now();
        this._consecutiveNeuralErrors = 0;

        // [TDD] Emit for Direct Push - include intentId to prevent sequence races
        this.emit('synthesis-complete', { cacheKey: key, intentId });

        // [TDD] Emit for Reactive Stats
        this.emit('cache-stats-update', this.getCacheStats());

        if (this._onCacheUpdate) { this._onCacheUpdate(); }
    }

    public triggerPrefetch(text: string, cacheKey: string, options: PlaybackOptions, batchId: number) {
        if (options.mode !== 'neural') { return; }

        if (this._audioCache.has(cacheKey) || this._pendingTasks.has(cacheKey)) {
            return;
        }

        if (batchId < this._batchIntentId) {
            this.logger(`[PREFETCH] EJECTED: Batch ${batchId} is stale.`);
            return;
        }

        this.logger(`[PREFETCH] key:${cacheKey} | Batch:${batchId}`);
        // Background prefetch should NEVER abort the priority task, but it MUST respect the batch
        this.speakNeural(text, cacheKey, options, false, this._playbackIntentId, batchId).catch(e => {
            if (!e.message.includes('Aborted')) {
                this.logger(`[PREFETCH] Background task failed: ${e.message}`);
            }
        });
    }

    public async speakNeural(text: string, cacheKey: string, options: PlaybackOptions, isPriority: boolean = true, intentId?: number, batchId?: number): Promise<string | null> {
        const currentBatchId = batchId ?? this._batchIntentId;
        const currentIntentId = intentId ?? (isPriority ? this._playbackIntentId + 1 : this._playbackIntentId);

        // [v2.2.2] Dual-Intent Integrity Check
        if (currentBatchId !== this._batchIntentId && batchId !== undefined) {
            this.logger(`[NEURAL] EJECTED: Batch context ${currentBatchId} is stale (Current: ${this._batchIntentId})`);
            return null;
        }

        // --- CHECK CACHE ---
        if (this._audioCache.has(cacheKey)) {
            const bytes = this._getSegmentSizeBytes(this._audioCache.get(cacheKey)!);
            this.logger(`[CACHE HIT] key:${cacheKey} | Size: ${(bytes / 1024).toFixed(1)}KB`);
            if (isPriority) {
                this._updateStatus(true, false, false);
            }
            return Promise.resolve(this._audioCache.get(cacheKey)!);
        }

        // --- CACHE MISS (Start synthesis) ---
        if (isPriority) {
            this.logger(`[CACHE MISS] key:${cacheKey} | Intent:${currentIntentId} | Batch:${currentBatchId}`);
        } else {
            this.logger(`[CACHE BACKGROUND] key:${cacheKey} | Batch:${currentBatchId}`);
        }

        // --- CHECK PENDING ---
        if (this._pendingTasks.has(cacheKey)) {
            if (isPriority) { this._isPlaying = true; }
            return this._pendingTasks.get(cacheKey)!;
        }

        console.log(`[DEBUG] speakNeural Start: intent=${currentIntentId}, text="${text.substring(0, 20)}"`);
        
        if (intentId !== undefined) {
            this.adoptIntent(intentId);
        } else if (isPriority) {
            this._playbackIntentId++;
        }

        if (isPriority) {
            // Priority tasks abort the PREVIOUS active segment, but NOT the batch queue
            if (this._activeSegmentAbortController) {
                this._activeSegmentAbortController.abort('New Priority Segment');
            }
            this._activeSegmentAbortController = new AbortController();

            this.emit('intent-change', this._playbackIntentId);
            this._updateStatus(true, false, true);

            // [SOVEREIGNTY] Interrupt waiting prefetch tasks ONLY if the pipe is full. 
            // In v2.2.2 we allow them to coexist unless the lock is heavily contested.
            this._prefetchAbortController.abort('Priority Task Pipe Preference');
            this._prefetchAbortController = new AbortController();
        }

        // [RESILIENCE] Signal starting
        this.emit('synthesis-starting', { cacheKey, intentId: currentIntentId });

        let taskResolve!: (val: string | null) => void;
        let taskReject!: (err: any) => void;
        const task = new Promise<string | null>((res, rej) => {
            taskResolve = res;
            taskReject = rej;
        });

        task.catch(() => { });
        this._pendingTasks.set(cacheKey, task);

        // [v2.3.1] Fire-and-forget worker with captured signals
        const segmentSignal = isPriority ? this._activeSegmentAbortController?.signal : this._prefetchAbortController.signal;
        const batchSignal = this._abortController?.signal;

        this._runNeuralSynthesis(
            text, cacheKey, options, isPriority, currentIntentId, currentBatchId,
            segmentSignal, batchSignal, taskResolve, taskReject
        );

        return task;
    }

    private async _runNeuralSynthesis(
        text: string,
        cacheKey: string,
        options: PlaybackOptions,
        isPriority: boolean,
        currentIntentId: number,
        currentBatchId: number,
        segmentSignal: AbortSignal | undefined,
        batchSignal: AbortSignal | undefined,
        taskResolve: (val: string | null) => void,
        taskReject: (err: any) => void
    ) {
        const release = this._synthesisLock;
        let resolveLock!: () => void;
        this._synthesisLock = new Promise(r => resolveLock = r);

        try {
            this.logger(`[NEURAL] WAITING LOCK: ${cacheKey}`);
            
            // Wait for existing lock OR early abort
            await Promise.race([
                release,
                new Promise((_, reject) => {
                    const onAbort = (msg: string) => reject(new Error(msg));
                    
                    if (batchSignal?.aborted) { return onAbort('Batch Synthesis Aborted'); }
                    if (segmentSignal?.aborted) { return onAbort('Segment Aborted'); }
                    if (currentBatchId !== this._batchIntentId) { return onAbort('Stale Context'); }
                    if (isPriority && currentIntentId !== this._playbackIntentId) { return onAbort('Stale Intent'); }

                    batchSignal?.addEventListener('abort', () => onAbort('Batch Synthesis Aborted'), { once: true });
                    segmentSignal?.addEventListener('abort', () => onAbort('Segment Aborted'), { once: true });
                })
            ]);

            // [Gate 3] Mark synthesis as active — _reinitTTS() will defer if called now
            this._synthesisActive++;
            this.logger(`[NEURAL] LOCK ACQUIRED: ${cacheKey}`);
            
            const data = await this._getNeuralAudio(
                text, options.voice, options.retryCount ?? this._retryAttempts,
                currentIntentId, isPriority, currentBatchId, segmentSignal
            );
            
            if (isPriority) { this._updateStatus(undefined, undefined, false); }
            
            if (data) {
                this._addToCache(cacheKey, data, currentIntentId);
            }
            
            taskResolve(data);
        } catch (err: any) {
            if (isPriority) { this._updateStatus(undefined, undefined, false); }
            
            // CLEAN ABORT: Don't log as error if manually stopped or intent changed
            const msg = err?.message || String(err);
            if (msg.includes('Aborted') || msg.includes('Stale') || msg.includes('Cleared') || msg.includes('Cancel')) {
                this.logger(`[NEURAL] Task terminated: ${cacheKey} | ${msg}`);
                taskResolve(null);
                return;
            }
            
            this.logger(`[NEURAL] ERROR: ${cacheKey} | ${msg}`);
            
            this.emit('synthesis-failed', { cacheKey, error: msg, intentId: currentIntentId });
            taskReject(err);
        } finally {
            this.logger(`[NEURAL] RELEASING LOCK: ${cacheKey}`);
            this._synthesisActive = Math.max(0, this._synthesisActive - 1);
            // [Gate 3] Execute any deferred reinit now that the lock is released
            if (this._pendingReinit && this._synthesisActive === 0) {
                this._pendingReinit = false;
                this.logger('[NEURAL] ✅ Executing deferred re-init (lock released).');
                this._executeReinit();
            }
            resolveLock();
            this._pendingTasks.delete(cacheKey);
            this._clearWatchdog();
        }
    }

    private _startWatchdog(intentId: number, onTimeout: () => void) {
        this._clearWatchdog();
        this._watchdogTimer = setTimeout(() => {
            if (this._playbackIntentId === intentId) {
                onTimeout();
            }
        }, 10000);
    }

    private _clearWatchdog() {
        if (this._watchdogTimer) {
            clearTimeout(this._watchdogTimer);
            this._watchdogTimer = null;
        }
    }

    private async _getNeuralAudio(text: string, voiceId: string, retryCount = 1, intentId: number, isPriority: boolean, batchId: number, signal?: AbortSignal): Promise<string | null> {
        // EXIT IMMEDIATELY IF BATCH IS STALE
        if (batchId !== this._batchIntentId) {
            this.logger(`[NEURAL] EJECTED (Post-lock) - Batch ${batchId} is stale.`);
            return null;
        }

        // EXIT IMMEDIATELY IF INTENT IS STALE (Only for priority tasks)
        if (isPriority && intentId !== this._playbackIntentId) {
            this.logger(`[NEURAL] EJECTED (Post-lock) - Intent ${intentId} is stale.`);
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
                return null;
            }

            const signalToUse = signal;
            if (signalToUse?.aborted) {
                this.logger(`[NEURAL] ABORTED (Pre-flight) - Task cancelled before start.`);
                return null;
            }

            // XML character safety
            const escapedText = cleanForSpeech(text);

            // [SOVEREIGNTY] Final check before I/O
            if (this._tts && (this._tts as any)._isDestroyed) {
                this.logger(`[NEURAL] TTS Instance destroyed. Forcing re-init...`);
                this._reinitTTS(true);
            }

            // Ensure client exists
            if (!this._tts) { this._reinitTTS(true); }

            try {
                // [Gate 4] Await TTS warm-up gate before calling setMetadata.
                // Prevents 'readyState' TypeError on cold-boot first synthesis request.
                // [v2.4.6] Abortable Pre-flight: Race against the abort signal to prevent deadlocks.
                await Promise.race([
                    this._ttsReady,
                    new Promise((_, reject) => {
                        if (signal?.aborted) { return reject(new Error("Synthesis Aborted")); }
                        signal?.addEventListener('abort', () => reject(new Error("Synthesis Aborted")), { once: true });
                    })
                ]);

                // [v2.3.1] Catch library/metadata/DOM errors during handshake
                // [v2.4.6] Abortable setMetadata race.
                await Promise.race([
                    this._tts.setMetadata(voiceId, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {}),
                    new Promise((_, reject) => {
                        if (signal?.aborted) { return reject(new Error("Synthesis Aborted")); }
                        signal?.addEventListener('abort', () => reject(new Error("Synthesis Aborted")), { once: true });
                    })
                ]);
            } catch (e: any) {
                const msg = e?.message || String(e);
                if (msg.includes('readyState') || msg.includes('TypeError')) {
                    this.logger(`[NEURAL] ☢️ Critical library corruption during metadata. Resetting client.`);
                    this._reinitTTS(true);
                }
                throw e; // Bubble up for retry logic
            }
            this.logger(`[TTS REQ] text:"${escapedText.substring(0, 30)}..." | voice:${voiceId} | Intent:${intentId}`);

            return await new Promise<string>((resolve, reject) => {
                if (signal?.aborted) {
                    reject(new Error("Synthesis Aborted"));
                    return;
                }

                let audioStream: any;
                try {
                    const result = this._tts.toStream(escapedText);
                    audioStream = result.audioStream;
                    
                    if (!audioStream) {
                        throw new Error("TTS Engine failed to initialize stream");
                    }
                } catch (err: any) {
                    console.log(`[DEBUG] Catching error in _getNeuralAudio: ${err.message}`);
                    this.logger(`[TTS CRASH] toStream failed: ${err.message}`);
                    this._reinitTTS(true); // Force re-init on stream failure
                    reject(err);
                    return;
                }
                const chunks: Buffer[] = [];
                let hasErrored = false;

                // START ROLLING WATCHDOG (4s until Chunk 0, 10s between chunks)
                const startWatchdog = (timeoutMs: number) => {
                    this._clearWatchdog();
                    this._startWatchdog(intentId, () => {
                        if (hasErrored) { return; }
                        this.logger(`[TTS HANG] Silent timeout (${timeoutMs}ms) for Intent ${intentId}. Recycling...`);
                        hasErrored = true;
                        this._reinitTTS(true); // Force WebSocket cleanup
                        audioStream.destroy();
                        reject(new Error(`Synthesis Timeout (${timeoutMs}ms)`));
                    });
                };

                startWatchdog(10000); // Wait 10s for first chunk (v2.4.6: Relaxed from 4s)

                const onAbort = () => {
                    this.logger(`[TTS STREAM] ABORT SIGNAL received.`);
                    if (hasErrored) { return; }
                    hasErrored = true;
                    audioStream.destroy();
                    reject(new Error(typeof signal?.reason === 'string' ? signal.reason : "Synthesis Aborted"));
                };

                signal?.addEventListener('abort', onAbort);

                audioStream.on("data", (data: Buffer) => {
                    if (hasErrored) { return; }

                    // Reset watchdog with a more generous 10s buffer between chunks
                    startWatchdog(10000);

                    if (chunks.length === 0) {
                        this.logger(`[TTS STREAM] STARTING (chunk 0)`);
                    }
                    chunks.push(data);
                });

                audioStream.on("end", () => {
                    if (hasErrored) { return; }
                    this._clearWatchdog(); // Ensure watchdog is cleared
                    signal?.removeEventListener('abort', onAbort);
                    this.logger(`[TTS STREAM] COMPLETE | chunks:${chunks.length}`);
                    
                    // [v2.3.1] Reset health clock on success
                    this._lastNeuralSuccessTime = Date.now();
                    this._consecutiveNeuralErrors = 0;
                    this._neuralHealth = 'HEALTHY';

                    const finalBuffer = Buffer.concat(chunks);
                    resolve(finalBuffer.toString('base64'));
                });

                audioStream.on("error", (err: any) => {
                    if (hasErrored) { return; }
                    this._clearWatchdog();
                    signal?.removeEventListener('abort', onAbort);
                    this.logger(`[TTS STREAM] ERROR: ${err}`);
                    hasErrored = true;
                    reject(err);
                });

                // Global safety timeout removed in favor of rolling watchdog
            });
        } catch (err: any) {
            const errorMessage = err?.message || String(err);
            const abortReason = this._abortController?.signal?.reason;
            const isTimeout = (typeof abortReason === 'string' && abortReason.includes("Timeout")) || errorMessage.includes("Timeout");
            const isAbort = errorMessage.includes("Aborted") || errorMessage.includes("Stale Intent") || errorMessage.includes("Stop Action") || isTimeout;

            // [v2.3.1] Global Health Degradation (unless explicitly aborted by user)
            if (!isAbort) {
                this._consecutiveNeuralErrors++;
                if (this._neuralHealth === 'HEALTHY') {
                    this._neuralHealth = 'DEGRADED';
                    this.logger(`[NEURAL] ⚠️ Health degraded to DEGRADED (Error: ${errorMessage.substring(0, 50)}).`);
                }
            }

            // [v2.3.1] Hardening: Specific check for 'readyState' or 'TypeError' which indicates deep library state corruption
            if (errorMessage.includes('readyState') || errorMessage.includes('TypeError')) {
                this.logger(`[NEURAL] ☢️ Critical library corruption detected (${errorMessage.includes('readyState') ? 'readyState' : 'TypeError'}). Forcing immediate client reset.`);
                this._reinitTTS(true);
            }

            // CRITICAL: Immediately exit on User Abort or Stale Intent.
            // Timeout is now handled by the retry logic below.
            if (isAbort && !isTimeout) {
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
                // DO NOT RETRY IF BATCH IS STALE
                if (batchId !== this._batchIntentId) {
                    this.logger(`[NEURAL] synthesis_cancelled | Batch ${batchId} is stale.`);
                    return null;
                }

                // DO NOT RETRY IF INTENT IS STALE (For priority)
                if (isPriority && intentId !== this._playbackIntentId) {
                    this.logger(`[NEURAL] synthesis_cancelled | Intent ${intentId} is stale.`);
                    return null;
                }

                // DO NOT RETRY IF STOPPED (Only for priority)
                if (isPriority && !this._isPlaying && !this._isPaused) {
                    this.logger(`[NEURAL] synthesis_cancelled | Engine stopped.`);
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

                // [RESILIENCE] Re-init TTS client on retry to clear dead sockets/streams
                if (isTimeout || errorMessage.includes("EPIPE") || errorMessage.includes("ECONNRESET")) {
                    this._reinitTTS(true);
                }

                // Exponential backoff
                const backoffMs = Math.min(1000 * Math.pow(2, 3 - retryCount), 8000);
                await new Promise(res => setTimeout(res, backoffMs));

                // [SERIALIZATION] Lock is held by parent scope throughout retries to ensure FIFO integrity.
                return this._getNeuralAudio(text, voiceId, retryCount - 1, intentId, isPriority, batchId);
            }
            this.logger(`[NEURAL] synthesis_failure | error: ${errorMessage}`);
            
            // [HARDENING] Specific check for the 'readyState' TypeError which indicates deep library state corruption
            if (errorMessage.includes('readyState')) {
                this.logger(`[NEURAL] ☢️ Critical library corruption detected (readyState). Forcing immediate client reset.`);
                this._reinitTTS(true);
            }

            throw err;
        }
    }

    public speakLocal(_text: string, _options: PlaybackOptions, _onExit: (code: number | null) => void) {
        // [DECOMMISSIONED] Local synthesis is now handled exclusively by the Webview.
        // This method is retained as a stub for interface compatibility during refactor.
        this.logger(`[PlaybackEngine] ☢️ speakLocal called on Extension Host. This should be routed to Webview.`);
        _onExit(1);
    }
}
