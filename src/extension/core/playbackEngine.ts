import * as vscode from 'vscode';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { EventEmitter } from 'events';
import { cleanForSpeech } from './speechProcessor';
import { StateStore } from './stateStore';
import { EngineMode } from '../../common/types';
import { PhonikudIPCManager } from './PhonikudIPCManager';
export { EngineMode };

export interface PlaybackOptions {
    voice: string;
    rate: number;
    volume: number;
    mode: EngineMode;
    retryCount?: number;
}

export class PlaybackEngine extends EventEmitter {
    private _tts: MsEdgeTTS;
    private _ttsReady: Promise<void> | null = null;
    private _reinitCooldown: number = 0;
    private readonly REINIT_COOLDOWN_MS = 5000;
    private _synthesisQueue: { isPriority: boolean; resolve: () => void }[] = [];
    private _activeSynthesisRunning: boolean = false;

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
    private _prefetchAbortControllers: Map<string, AbortController> = new Map();

    private _probeTimer: NodeJS.Timeout | null = null;
    private _probeAbortController: AbortController | null = null;
    private _requestTimestamps: number[] = [];
    private _isStalled: boolean = false;

    private _logLevel: number = 1;
    private _lastLoggedCacheCount: number = -1;
    private _lastLoggedCacheTime: number = 0;
    private _retryAttempts: number = 5; // [NEURAL-FIRST] Patient retry: ~8s total backoff before giving up

    private _activeSegmentAbortController: AbortController | null = null;

    // [v2.3.1] Autoradiant Health SSOT
    private _neuralHealth: 'HEALTHY' | 'DEGRADED' | 'STALLED' = 'HEALTHY';
    private _lastNeuralSuccessTime: number = Date.now();
    private _consecutiveNeuralErrors: number = 0;
    private _consecutiveProbeFailures: number = 0;
    // [SOVEREIGN RESET] Removed legacy 5-minute fallback timer. 
    // Health is now governed by explicit manual intent and reactive success signals.
    // [Gate 3] Startup Orchestration — lock-aware TTS disposal.
    // _reinitTTS() called while synthesis is active defers until the finally block fires.
    private _synthesisActive: number = 0;
    private _pendingReinit: boolean = false;
    // [Gate 4] Startup Orchestration — TTS warm-up gate.
    // Removed _resolveTtsReady - we no longer pre-warm the WebSocket.

    private _phonikudManager: PhonikudIPCManager;

    constructor(
        private readonly _stateStore: StateStore,
        private readonly logger: (msg: string) => void, 
        onCacheUpdate?: () => void
    ) {
        super();
        this._ttsReady = Promise.resolve(); // No longer pre-warming
        this._tts = new MsEdgeTTS();
        this._onCacheUpdate = onCacheUpdate;
        
        this._phonikudManager = new PhonikudIPCManager({
            info: (msg) => this.logger(`[PHONIKUD] [INFO] ${msg}`),
            error: (msg) => this.logger(`[PHONIKUD] [ERROR] ${msg}`)
        });
    }

    public async dispose() {
        this.logger('[ENGINE] Disposing PlaybackEngine...');
        await this._phonikudManager.stop();
    }

    public setLogLevel(level: number) {
        this._logLevel = level;
    }

    private _acquireSynthesisLock(isPriority: boolean, segmentSignal?: AbortSignal, batchSignal?: AbortSignal): Promise<() => void> {
        return new Promise<() => void>((resolve, reject) => {
            let queueItem: { isPriority: boolean; resolve: () => void } | null = null;

            const onAbort = (reason: string) => {
                if (queueItem) {
                    const idx = this._synthesisQueue.indexOf(queueItem);
                    if (idx !== -1) {
                        this._synthesisQueue.splice(idx, 1);
                    }
                }
                reject(new Error(reason));
            };

            if (batchSignal?.aborted) { return onAbort('Batch Synthesis Aborted'); }
            if (segmentSignal?.aborted) { return onAbort('Segment Aborted'); }

            const batchAbortHandler = () => onAbort('Batch Synthesis Aborted');
            const segmentAbortHandler = () => onAbort('Segment Aborted');

            batchSignal?.addEventListener('abort', batchAbortHandler, { once: true });
            segmentSignal?.addEventListener('abort', segmentAbortHandler, { once: true });

            queueItem = {
                isPriority,
                resolve: () => {
                    batchSignal?.removeEventListener('abort', batchAbortHandler);
                    segmentSignal?.removeEventListener('abort', segmentAbortHandler);
                    resolve(() => {
                        this._activeSynthesisRunning = false;
                        this._processSynthesisQueue();
                    });
                }
            };

            if (isPriority) {
                const insertIndex = this._synthesisQueue.findIndex(item => !item.isPriority);
                if (insertIndex === -1) {
                    this._synthesisQueue.push(queueItem);
                } else {
                    this._synthesisQueue.splice(insertIndex, 0, queueItem);
                }
            } else {
                this._synthesisQueue.push(queueItem);
            }

            this._processSynthesisQueue();
        });
    }

    private _processSynthesisQueue() {
        if (this._activeSynthesisRunning || this._synthesisQueue.length === 0) {
            return;
        }

        this._activeSynthesisRunning = true;
        const nextItem = this._synthesisQueue.shift();
        if (nextItem) {
            nextItem.resolve();
        }
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

    private _reinitTTS(force: boolean = false): void {
        const now = Date.now();
        if (now - this._reinitCooldown < this.REINIT_COOLDOWN_MS) {
            this.logger(`[NEURAL] ❄️ Re-init throttled (cooldown active).`);
            return;
        }
        this._reinitCooldown = now;
        this.logger(`[NEURAL] ♻️ Re-initializing TTS Engine (Force: ${force})...`);
        this._executeReinit().catch(e => {
            this.logger(`[NEURAL] ❌ Fatal error during re-init: ${e.message}`);
        });
    }

    private async _executeReinit() {
        this.logger('[NEURAL] Authority Re-initialization (Lib Corruption Detected)');
        try {
            if (this._tts) {
                try { (this._tts as any).close(); } catch (e) { }
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

    private async _setTtsMetadata(voice: string, format: any) {
        try {
            // Guard: MsEdgeTTS setMetadata crashes on first call if _ws is uninitialized in some environments
            // We wrap it to catch the 'readyState' TypeError and force a retry after implicit init
            await this._tts.setMetadata(voice, format, {
                voiceLocale: undefined,
                sentenceBoundaryEnabled: true,
                wordBoundaryEnabled: true
            });
        } catch (e: any) {
            const msg = e.message || String(e);
            if (msg.includes('readyState')) {
                this.logger(`[NEURAL] ⚠️ Caught first-run readyState race. MsEdgeTTS client warming up...`);
                // No-op, the internal _initClient will be triggered by subsequent toStream
            } else {
                throw e;
            }
        }
    }


    public get isPlaying() { return this._isPlaying; }
    public get isPaused() { return this._isPaused; }
    public get isStalled() { return this._isStalled; }
    public get playbackIntentId() { return this._stateStore.state.playbackIntentId; }
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
        this._consecutiveProbeFailures = 0;
        this._clearProbeTimer();
    }

    private _isPrefetchThrottled(): boolean {
        const now = Date.now();
        this._requestTimestamps = this._requestTimestamps.filter(t => now - t < 10000);
        return this._requestTimestamps.length >= 10;
    }

    private _clearProbeTimer() {
        if (this._probeTimer) {
            clearTimeout(this._probeTimer);
            this._probeTimer = null;
        }
        if (this._probeAbortController) {
            this._probeAbortController.abort('Probe Cleared');
            this._probeAbortController = null;
        }
    }

    private _getProbeDelayMs(): number {
        // Backoff sequence based on consecutive failures:
        // 1 failure: 5s, 2 failures: 15s, 3 failures: 30s, 4 failures: 60s, 5+ failures: 300s
        if (this._consecutiveProbeFailures <= 1) { return 5000; }
        if (this._consecutiveProbeFailures === 2) { return 15000; }
        if (this._consecutiveProbeFailures === 3) { return 30000; }
        if (this._consecutiveProbeFailures === 4) { return 60000; }
        return 300000; // Cap at 5 minutes
    }

    private _startProbeTimer(immediate = false) {
        this._clearProbeTimer();
        if (this._neuralHealth !== 'STALLED') {
            return;
        }
        const delay = immediate ? 0 : this._getProbeDelayMs();
        this._probeTimer = setTimeout(async () => {
            if (this._neuralHealth !== 'STALLED') { return; }
            this.logger(`[NEURAL] 🩺 Running background active probe...`);
            this._probeAbortController = new AbortController();
            try {
                const data = await this._getNeuralAudio(
                    "ping",
                    "en-US-SteffanNeural",
                    0,
                    this._stateStore.state.playbackIntentId,
                    false,
                    this._stateStore.state.batchIntentId,
                    this._probeAbortController.signal
                );
                if (data) {
                    this.logger(`[NEURAL] ❤️‍\u05b5 Probe succeeded. Health restored.`);
                    this.resetNeuralHealth();
                } else {
                    this._consecutiveProbeFailures++;
                    this._startProbeTimer(false);
                }
            } catch (err: any) {
                this._consecutiveProbeFailures++;
                this.logger(`[NEURAL] 🩺 Probe failed: ${err.message}. Rescheduling in ${this._getProbeDelayMs() / 1000}s.`);
                this._startProbeTimer(false);
            }
        }, delay);
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
        // [REACTIVE SSOT] Directly update the state store
        this._stateStore.setPlaybackStatus(this._isPlaying, this._isPaused, this._isStalled);

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
        if (val) {
            if (this._neuralHealth !== 'STALLED') {
                this._clearProbeTimer();
            }
            for (const [key, controller] of this._prefetchAbortControllers) {
                controller.abort('Playback Paused');
            }
            this._prefetchAbortControllers.clear();
        }
    }

    public get batchIntentId() { return this._stateStore.state.batchIntentId; }

    public getAudioFromCache(cacheKey: string): string | undefined { return this._audioCache.get(cacheKey); }

    public adoptIntent(id: number) {
        const currentId = this._stateStore.state.playbackIntentId;
        
        // [SOVEREIGNTY] Delegate magnitude protection to StateStore for centralized logging.
        this._stateStore.setPlaybackIntentId(id);

        // [SOVEREIGNTY] Handle engine-specific side-effects only if it's a true forward progress.
        if (id > currentId) {
            this.logger(`[PlaybackEngine] 🧬 Adopting Segment Intent: ${id} (Previous: ${currentId})`);

            // Stop the current playing segment, but do NOT kill the batch.
            if (this._activeSegmentAbortController) {
                this._activeSegmentAbortController.abort('New Segment Intent');
            }
            this._activeSegmentAbortController = new AbortController();
        }
    }

    public adoptBatchIntent(id: number) {
        const currentId = this._stateStore.state.batchIntentId;

        // [SOVEREIGNTY] Magnitude Protection is now handled in StateStore.
        if (id > currentId) {
            this.logger(`[PlaybackEngine] 📦 Adopting Batch Intent: ${id} (Previous: ${currentId})`);
            this._stateStore.setBatchIntentId(id);

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
            for (const [key, controller] of this._prefetchAbortControllers) {
                controller.abort('New Batch Intent');
            }
            this._prefetchAbortControllers.clear();
        }
    }


    public stop(intentId?: number, forceBatchReset: boolean = false, silent: boolean = false, keepPrefetch: boolean = false) {
        this.logger(`[ENGINE] Stop (Intent: ${intentId ?? this._stateStore.state.playbackIntentId} | ForceBatch: ${forceBatchReset}${silent ? ' | SILENT' : ''})`);

        this._isPlaying = false;
        this._isPaused = false;
        this._isStalled = false;

        if (this._neuralHealth !== 'STALLED') {
            this._clearProbeTimer();
        }

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
        if (!keepPrefetch) {
            for (const [key, controller] of this._prefetchAbortControllers) {
                controller.abort('Stop Action');
            }
            this._prefetchAbortControllers.clear();
        }
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
        if (this._stateStore.state.engineMode === 'phonikud-tts') {
            return [
                {
                    name: "Shaul (Local TTS)",
                    id: "shaul",
                    lang: "he-IL",
                    gender: "Male"
                }
            ];
        }

        // [HARDENING] Await the TTS warm-up gate
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

    public addToCache(key: string, data: string, intentId?: number) {
        this._addToCache(key, data, intentId);
    }

    private _addToCache(key: string, data: string, intentId?: number) {
        // [HARDENING] Absolute Intent Guard - Reject data if user has skipped or changed context
        if (intentId !== undefined && intentId !== this._stateStore.state.playbackIntentId) {
            this.logger(`[CACHE] REJECTED key:${key} | Intent mismatch: ${intentId} vs current ${this._stateStore.state.playbackIntentId}`);
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
        if (options.mode !== 'neural' && options.mode !== 'phonikud-tts') { return; }

        if (!this.isNeuralViable()) {
            return;
        }

        if (this._isPrefetchThrottled()) {
            this.logger(`[PREFETCH] Throttled: sliding window limit reached (>=10 requests in 10s).`);
            return;
        }

        if (this._audioCache.has(cacheKey) || this._pendingTasks.has(cacheKey)) {
            return;
        }

        if (batchId < this._stateStore.state.batchIntentId) {
            this.logger(`[PREFETCH] EJECTED: Batch ${batchId} is stale.`);
            return;
        }

        this.logger(`[PREFETCH] key:${cacheKey} | Batch:${batchId}`);
        // Background prefetch should NEVER abort the priority task, but it MUST respect the batch
        this.speakNeural(text, cacheKey, options, false, this._stateStore.state.playbackIntentId, batchId).catch(e => {
            if (!e.message.includes('Aborted')) {
                this.logger(`[PREFETCH] Background task failed: ${e.message}`);
            }   
        });
    }

    public async speakNeural(text: string, cacheKey: string, options: PlaybackOptions, isPriority: boolean = true, intentId?: number, batchId?: number): Promise<string | null> {
        const currentBatchId = batchId ?? this._stateStore.state.batchIntentId;
        const currentIntentId = intentId ?? (isPriority ? this._stateStore.state.playbackIntentId + 1 : this._stateStore.state.playbackIntentId);

        // [v2.2.2] Dual-Intent Integrity Check
        if (currentBatchId !== this._stateStore.state.batchIntentId && batchId !== undefined) {
            this.logger(`[NEURAL] EJECTED: Batch context ${currentBatchId} is stale (Current: ${this._stateStore.state.batchIntentId})`);
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
            if (isPriority) {
                this._isPlaying = true;
                this._updateStatus(true, false, true);
                
                // Abort other prefetch tasks
                for (const [key, controller] of this._prefetchAbortControllers) {
                    if (key !== cacheKey) {
                        controller.abort('Priority Task Pipe Preference');
                        this._prefetchAbortControllers.delete(key);
                    }
                }
            }
            return this._pendingTasks.get(cacheKey)!;
        }

        console.log(`[DEBUG] speakNeural Start: intent=${currentIntentId}, text="${text.substring(0, 20)}"`);

        if (intentId !== undefined) {
            this.adoptIntent(intentId);
        } else if (isPriority) {
            this._stateStore.incrementPlaybackIntent();
        }

        if (isPriority) {
            // Priority tasks abort the PREVIOUS active segment, but NOT the batch queue
            if (this._activeSegmentAbortController) {
                this._activeSegmentAbortController.abort('New Priority Segment');
            }
            this._activeSegmentAbortController = new AbortController();

            this._updateStatus(true, false, true);

            // [SOVEREIGNTY] Interrupt waiting prefetch tasks for OTHER keys only.
            for (const [key, controller] of this._prefetchAbortControllers) {
                if (key !== cacheKey) {
                    controller.abort('Priority Task Pipe Preference');
                    this._prefetchAbortControllers.delete(key);
                }
            }
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

        // Check if there is already a controller for this key. If not, create one.
        let prefetchController = this._prefetchAbortControllers.get(cacheKey);
        if (!prefetchController) {
            prefetchController = new AbortController();
            this._prefetchAbortControllers.set(cacheKey, prefetchController);
        }

        // [v2.3.1] Fire-and-forget worker with captured signals
        const segmentSignal = isPriority ? this._activeSegmentAbortController?.signal : prefetchController.signal;
        const batchSignal = this._abortController?.signal;

        const targetDocUri = this._stateStore.state.activeDocumentUri?.toString();

        this._runNeuralSynthesis(
            text, cacheKey, options, isPriority, currentIntentId, currentBatchId,
            segmentSignal, batchSignal, taskResolve, taskReject, targetDocUri
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
        taskReject: (err: any) => void,
        targetDocUri?: string
    ) {
        let release: (() => void) | undefined;

        try {
            this.logger(`[NEURAL] WAITING LOCK: ${cacheKey}`);

            // Acquire synthesis lock (priority-aware queue)
            release = await this._acquireSynthesisLock(isPriority, segmentSignal, batchSignal);

            if (currentBatchId !== this._stateStore.state.batchIntentId) {
                throw new Error('Stale Context');
            }
            if (isPriority && currentIntentId !== this._stateStore.state.playbackIntentId) {
                throw new Error('Stale Intent');
            }

            // [Gate 3] Mark synthesis as active
            this._synthesisActive++;
            this.logger(`[SYNTHESIS] LOCK ACQUIRED: ${cacheKey} | Mode: ${options.mode}`);

            let data: string | null = null;
            if (options.mode === 'phonikud-tts') {
                data = await this._getPhonikudAudio(
                    text, currentIntentId, isPriority, currentBatchId, segmentSignal, targetDocUri
                );
            } else {
                data = await this._getNeuralAudio(
                    text, options.voice, options.retryCount ?? this._retryAttempts,
                    currentIntentId, isPriority, currentBatchId, segmentSignal, targetDocUri
                );
            }

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
            if (release) {
                this.logger(`[NEURAL] RELEASING LOCK: ${cacheKey}`);
                release();
            }
            this._synthesisActive = Math.max(0, this._synthesisActive - 1);
            // [Gate 3] Execute any deferred reinit now that the lock is released
            if (this._pendingReinit && this._synthesisActive === 0) {
                this._pendingReinit = false;
                this.logger('[NEURAL] ✅ Executing deferred re-init (lock released).');
                this._executeReinit();
            }
            this._pendingTasks.delete(cacheKey);
            this._prefetchAbortControllers.delete(cacheKey);
        }
    }

    private async _getNeuralAudio(
        text: string,
        voiceId: string,
        retryCount = 1,
        intentId: number,
        isPriority: boolean,
        batchId: number,
        signal?: AbortSignal,
        targetDocUri?: string
    ): Promise<string | null> {
        // EXIT IMMEDIATELY IF DOCUMENT CONTEXT HAS CHANGED
        const currentDocUri = this._stateStore.state.activeDocumentUri?.toString();
        if (targetDocUri && currentDocUri !== targetDocUri) {
            this.logger(`[NEURAL] EJECTED (Post-lock) - Document context changed.`);
            return null;
        }

        // EXIT IMMEDIATELY IF BATCH IS STALE AND DOCUMENT CHANGED
        if (batchId !== this._stateStore.state.batchIntentId) {
            if (targetDocUri && currentDocUri === targetDocUri) {
                this.logger(`[NEURAL] LATE-PACKET ACCEPTED - Batch ${batchId} is older but matches active document context.`);
            } else {
                this.logger(`[NEURAL] EJECTED (Post-lock) - Batch ${batchId} is stale.`);
                return null;
            }
        }

        // EXIT IMMEDIATELY IF INTENT IS STALE (Only for priority tasks)
        if (isPriority && intentId !== this._stateStore.state.playbackIntentId) {
            this.logger(`[NEURAL] EJECTED (Post-lock) - Intent ${intentId} is stale.`);
            return null;
        }

        // EXIT IMMEDIATELY IF STOPPED
        if (!this._isPlaying && !this._isPaused && isPriority) {
            this.logger(`[NEURAL] Ignoring synthesis request: Engine is stopped.`);
            return null;
        }

        try {
            // FINAL STALE CHECK BEFORE API CALL
            if (isPriority && intentId !== this._stateStore.state.playbackIntentId) {
                return null;
            }

            const signalToUse = signal;
            if (signalToUse?.aborted) {
                this.logger(`[NEURAL] ABORTED (Pre-flight) - Task cancelled before start.`);
                return null;
            }

            // XML character safety
            const escapedText = cleanForSpeech(text);

            const SILENT_MP3_BASE64 = "//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACQgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/uQxADAAAAAAAAAAAAAAAAppbXAAA=";
            if (!escapedText || !escapedText.trim()) {
                this.logger(`[NEURAL] Empty speech text detected. Returning silent placeholder.`);
                return SILENT_MP3_BASE64;
            }

            // [SOVEREIGNTY] Final check before I/O
            if (this._tts && (this._tts as any)._isDestroyed) {
                this.logger(`[NEURAL] TTS Instance destroyed. Forcing re-init...`);
                this._reinitTTS(true);
            }

            // Ensure client exists
            if (!this._tts) { this._reinitTTS(true); }

            const handshakeStartTime = Date.now();

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
                    this._setTtsMetadata(voiceId, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3),
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
            const handshakeDelta = Date.now() - handshakeStartTime;
            this.logger(`[TTS REQ] text:"${escapedText.substring(0, 30)}..." | voice:${voiceId} | Intent:${intentId} | [DELTA] ${handshakeDelta}ms`);

            // Push request timestamp for sliding window rate limiting
            this._requestTimestamps.push(Date.now());

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

                // LOCAL WATCHDOG
                let localWatchdogTimer: NodeJS.Timeout | null = null;
                const clearLocalWatchdog = () => {
                    if (localWatchdogTimer) {
                        clearTimeout(localWatchdogTimer);
                        localWatchdogTimer = null;
                    }
                };

                const startWatchdog = (timeoutMs: number) => {
                    clearLocalWatchdog();
                    localWatchdogTimer = setTimeout(() => {
                        if (hasErrored) { return; }
                        if (this._stateStore.state.playbackIntentId === intentId) {
                            this.logger(`[TTS HANG] Silent timeout (${timeoutMs}ms) for Intent ${intentId}. Recycling...`);
                            hasErrored = true;
                            this._reinitTTS(true); // Force WebSocket cleanup
                            audioStream.destroy();
                            reject(new Error(`Synthesis Timeout (${timeoutMs}ms)`));
                        }
                    }, timeoutMs);
                };

                startWatchdog(4000); // Wait 4s for first chunk

                const onAbort = () => {
                    this.logger(`[TTS STREAM] ABORT SIGNAL received.`);
                    if (hasErrored) { return; }
                    hasErrored = true;
                    clearLocalWatchdog();
                    audioStream.destroy();
                    reject(new Error(typeof signal?.reason === 'string' ? signal.reason : "Synthesis Aborted"));
                };

                signal?.addEventListener('abort', onAbort);

                audioStream.on("data", (data: Buffer) => {
                    if (hasErrored) { return; }

                    // Reset watchdog
                    startWatchdog(4000);

                    if (chunks.length === 0) {
                        this.logger(`[TTS STREAM] STARTING (chunk 0)`);
                    }
                    chunks.push(data);
                });

                audioStream.on("end", () => {
                    if (hasErrored) { return; }
                    clearLocalWatchdog(); // Ensure watchdog is cleared
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
                    clearLocalWatchdog();
                    signal?.removeEventListener('abort', onAbort);
                    this.logger(`[TTS STREAM] ERROR: ${err}`);
                    hasErrored = true;
                    reject(err);
                });
            });
        } catch (err: any) {
            const errorMessage = err?.message || String(err);
            const abortReason = this._abortController?.signal?.reason;
            const isTimeout = (typeof abortReason === 'string' && abortReason.includes("Timeout")) || errorMessage.includes("Timeout");
            const isAbort = errorMessage.includes("Aborted") || errorMessage.includes("Stale Intent") || errorMessage.includes("Stop Action") || isTimeout;

            // [v2.3.1] Global Health Degradation (unless explicitly aborted by user)
            if (!isAbort) {
                const isOffline = errorMessage.includes('ENOTFOUND') || errorMessage.includes('EAI_AGAIN') || errorMessage.includes('ECONNREFUSED');
                if (isOffline) {
                    this._neuralHealth = 'STALLED';
                    this._consecutiveNeuralErrors = 3;
                    this.logger(`[NEURAL] 🚨 Offline network error detected (${errorMessage}). Fast-gate STALLED fallback active.`);
                    for (const [key, controller] of this._prefetchAbortControllers) {
                        controller.abort('Health Stalled (Offline)');
                    }
                    this._prefetchAbortControllers.clear();
                    this._startProbeTimer(true);
                } else {
                    this._consecutiveNeuralErrors++;
                    if (this._consecutiveNeuralErrors >= 3) {
                        this._neuralHealth = 'STALLED';
                        this.logger(`[NEURAL] 🚨 3 consecutive errors reached. Health STALLED. Fallback to local active.`);
                        for (const [key, controller] of this._prefetchAbortControllers) {
                            controller.abort('Health Stalled (Errors)');
                        }
                        this._prefetchAbortControllers.clear();
                        this._startProbeTimer(true);
                    } else {
                        this._neuralHealth = 'DEGRADED';
                        this.logger(`[NEURAL] ⚠️ Health degraded to DEGRADED (Consecutive errors: ${this._consecutiveNeuralErrors}/3).`);
                    }
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
                this.logger(`[RATE LIMIT HIT] Azure TTS has throttled our requests. Relying on exponential backoff.`);
            }

            // DO NOT RETRY IF HEALTH IS STALLED (Fail Fast fallback)
            if (this._neuralHealth === 'STALLED') {
                this.logger(`[NEURAL] Health is STALLED | Failing fast without retry.`);
                return null;
            }

            if (retryCount > 0) {
                // DO NOT RETRY IF BATCH IS STALE
                if (batchId !== this._stateStore.state.batchIntentId) {
                    this.logger(`[NEURAL] synthesis_cancelled | Batch ${batchId} is stale.`);
                    return null;
                }

                // DO NOT RETRY IF INTENT IS STALE (For priority)
                if (isPriority && intentId !== this._stateStore.state.playbackIntentId) {
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
                await new Promise<void>(res => {
                    if (signal?.aborted) {return res();}
                    const timeout = setTimeout(res, backoffMs);
                    signal?.addEventListener('abort', () => {
                        clearTimeout(timeout);
                        res();
                    }, { once: true });
                });

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

    private async _getPhonikudAudio(
        text: string,
        intentId: number,
        isPriority: boolean,
        batchId: number,
        signal?: AbortSignal,
        targetDocUri?: string
    ): Promise<string | null> {
        const currentDocUri = this._stateStore.state.activeDocumentUri?.toString();
        if (targetDocUri && currentDocUri !== targetDocUri) {
            this.logger(`[PHONIKUD] EJECTED (Post-lock) - Document context changed.`);
            return null;
        }

        if (batchId !== this._stateStore.state.batchIntentId) {
            this.logger(`[PHONIKUD] EJECTED (Post-lock) - Batch ${batchId} is stale.`);
            return null;
        }

        if (isPriority && intentId !== this._stateStore.state.playbackIntentId) {
            this.logger(`[PHONIKUD] EJECTED (Post-lock) - Intent ${intentId} is stale.`);
            return null;
        }

        if (!this._isPlaying && !this._isPaused && isPriority) {
            this.logger(`[PHONIKUD] Ignoring synthesis request: Engine is stopped.`);
            return null;
        }

        try {
            if (signal?.aborted) {
                this.logger(`[PHONIKUD] ABORTED (Pre-flight) - Task cancelled before start.`);
                return null;
            }

            const cleanText = cleanForSpeech(text);
            if (!cleanText || !cleanText.trim()) {
                this.logger(`[PHONIKUD] Empty speech text detected. Returning silent placeholder.`);
                return "//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACQgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP/uQxADAAAAAAAAAAAAAAAAppbXAAA=";
            }

            const modelsDir = vscode.workspace.getConfiguration('virgo').get<string>('playback.phonikudModelsDir', '');

            this.logger(`[PHONIKUD REQ] text:"${cleanText.substring(0, 30)}..." | Intent:${intentId}`);

            const synthesisPromise = this._phonikudManager.synthesize(cleanText, modelsDir);

            const result = await Promise.race([
                synthesisPromise,
                new Promise<null>((_, reject) => {
                    if (signal?.aborted) { return reject(new Error("Synthesis Aborted")); }
                    signal?.addEventListener('abort', () => reject(new Error("Synthesis Aborted")), { once: true });
                })
            ]);

            return result;
        } catch (err: any) {
            const msg = err?.message || String(err);
            if (msg.includes('Aborted')) {
                this.logger(`[PHONIKUD] Synthesis aborted.`);
                return null;
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
