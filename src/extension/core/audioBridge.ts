import * as vscode from 'vscode';
import { StateStore } from '@core/stateStore';
import { DocumentLoadController } from '@core/documentLoadController';
import { PlaybackEngine, PlaybackOptions, EngineMode } from './playbackEngine';
import { SequenceManager } from '@core/sequenceManager';
import { EventEmitter } from 'events';
import { generateCacheKey } from '../../common/cachePolicy';
import { SettingsManager } from '../vscode/SettingsManager';

export interface AudioBridgeEvents {
    'playAudio': (payload: { cacheKey: string, data: string, text: string, chapterIndex: number, sentenceIndex: number, totalSentences: number, sentences: string[], intentId: number, bakedRate: number }) => void;
    'synthesisStarting': (payload: { cacheKey: string, intentId: number }) => void;
    'synthesisError': (payload: { error: string, isFallingBack: boolean, cacheKey: string, chapterIndex: number, sentenceIndex: number, intentId: number }) => void;
    'playbackFinished': () => void;
    'engineStatus': (payload: { status: string }) => void;
    'dataPush': (payload: { cacheKey: string, data: string, intentId: number }) => void;
    'synthesisReady': (payload: { cacheKey: string, intentId: number, isPriority: boolean }) => void;
    'speakLocal': (payload: { text: string, voiceId: string, rate: number, volume: number, intentId: number }) => void;
    'uiSyncRequested': () => void;
}

export class AudioBridge extends EventEmitter {
    private _pushDelayMs: number = 200;
    private _webviewCacheManifest: Set<string> = new Set();
    private _latchedVoiceId: string | null = null;
    private _latchedRate: number | undefined = undefined;
    // [Law 7.1] Cache confirmation window (200ms) to prevent FETCH_FAILED false positives
    // when the Webview ACKs a Tier-2 disk-hit slightly after the bridge timeout fires.
    private _recentCacheConfirmations: Map<string, number> = new Map();
    // [Law 7.2] Per-intentId dedup Set for synthesisStarting emissions.
    // Key format: `${cacheKey}::${intentId}`. Cleared on intent increment.
    private _emittedSynthesisStarting: Set<string> = new Set();
    private _lastIntentId: number = 0;
    // [SINGLE-SINK] Tracks the cacheKey currently committed to by start().
    // Used by synthesis-complete to suppress redundant synthesisReady when
    // _speakNeural() (Path C) is already handling delivery for this key.
    private _activeCacheKey: string = '';
    // [UM-1] User Intent Gate: MUST be set to true via authorizePlayback() before
    // start() is allowed to call setPlaying(true). Prevents LOAD_DOCUMENT and
    // synthesisReady callbacks from auto-triggering the playing state.
    private _isUserInitiatedPlay: boolean = false;
    // [PLAY-ONCE] Backstop gate: tracks the last cacheKey for which playAudio was emitted.
    // Suppresses a second playAudio for the exact same sentence (same cacheKey) if a duplicate
    // synthesis path slips through the root fix (_processQueue head-exclusion + RC-2 schema fix).
    // Keyed by cacheKey (not intentId) so different sentences always play unobstructed.
    private _lastPlayAudioCacheKey: string = '';
    private _lastSentenceChangeTime: number = 0;
    private _prefetchTimeout: NodeJS.Timeout | null = null;
    private _prioritySynthesisTimeout: NodeJS.Timeout | null = null;
    private _isRapidSkipping: boolean = false;

    constructor(
        private readonly _stateStore: StateStore,
        private readonly _docController: DocumentLoadController,
        private readonly _playbackEngine: PlaybackEngine,
        private readonly _sequenceManager: SequenceManager,
        private readonly _logger: (msg: string) => void,
        private readonly _settingsManager: SettingsManager
    ) {
        super();

        this._playbackEngine.on('synthesis-starting', (payload) => {
            // [Law 7.2] Route through deduplicated emitter instead of raw _emitWithIntent.
            // emitSynthesisStarting() suppresses duplicate events for the same cacheKey+intentId pair.
            this.emitSynthesisStarting(payload.cacheKey, payload.intentId);
        });

        this._stateStore.on('change', (state) => {
            if (state.playbackIntentId !== this._lastIntentId) {
                this._logger(`[BRIDGE] Intent change detected: ${this._lastIntentId} -> ${state.playbackIntentId}`);
                this._lastIntentId = state.playbackIntentId;
                // [Law 7.2] Clear the dedup set on intent change so the new intent gets fresh signals.
                this.clearSynthesisStartingDedup();
                // [PLAY-ONCE] Reset playAudio gate on intent change so every new session starts clean.
                this._lastPlayAudioCacheKey = '';
            }
        });

        // [v2.0.0] Throttled Pushing: Ensure bridge priority for user IPC 
        let pushQueue: any[] = [];
        let pushTimeout: NodeJS.Timeout | null = null;

        this._playbackEngine.on('synthesis-complete', (payload: { cacheKey: string, data: string, intentId: number }) => {
            const currentIntent = this._playbackEngine.playbackIntentId;

            // [SINGLE-SINK] If intentId matches the current active intent, discriminate by key:
            // - Active key: _speakNeural() (Path C) handles delivery via playAudio — suppress synthesisReady.
            // - Any other key: pre-fetched segment — push data silently via dataPush (no play trigger).
            if (payload.intentId === currentIntent) {
                if (payload.cacheKey === this._activeCacheKey) {
                    // Path C will emit playAudio with data — synthesisReady here is redundant and causes double-play.
                    this._logger(`[BRIDGE] NOTIFY_SUPPRESSED (Path C owns delivery): ${payload.cacheKey} | Intent: ${payload.intentId}`);
                } else {
                    // Pre-fetched segment: warm the webview cache silently. No play signal.
                    // [FIX-C] Omit `data` — VS Code IPC postMessage always corrupts large base64 payloads
                    // causing guaranteed atob decode failure on the webview side. The FETCH_AUDIO pull
                    // path (triggered by hasBinary:false) always succeeds via the HTTP cache server.
                    this._logger(`[BRIDGE] PREFETCH_PUSH: ${payload.cacheKey} | Intent: ${payload.intentId}`);
                    this._emitWithIntent('dataPush', { cacheKey: payload.cacheKey, data: '' });
                }
                return;
            }

            // [HARDENING] Only queue if it's not ancient (currentIntent - 2 range for prefetch buffer)
            // Note: with UUIDs we can't do numeric range checks, so we just check equality or simple buffer logic.
            // For now, we only push if intent matches or it's a very recent prefetch.
            pushQueue.push(payload);

            if (pushTimeout) { return; }
            pushTimeout = setTimeout(() => {
                // [FIX-A] Exclude the active HEAD key from the batch flush.
                // If the HEAD key's synthesis completes while the timer is still running,
                // the flush would emit a redundant synthesisReady → FETCH_AUDIO → playAudio,
                // producing an audible duplicate ~350ms after the real PLAY_AUDIO.
                const results = pushQueue.filter(p =>
                    p.intentId === this._playbackEngine.playbackIntentId &&
                    p.cacheKey !== this._activeCacheKey
                );
                pushQueue = [];
                pushTimeout = null;
                if (results.length > 0) {
                    this._logger(`[BRIDGE] Batch NOTIFYing ${results.length} valid segments.`);
                    results.forEach(p => this._emitWithIntent('synthesisReady', { cacheKey: p.cacheKey, isPriority: false }));
                }
            }, this._pushDelayMs);
        });

        this._playbackEngine.on('synthesis-failed', (payload: { cacheKey: string, error: string, intentId: number }) => {
            const state = this._stateStore.state;
            const friendlyError = this._mapToFriendlyError(payload.error);
            this._logger(`[BRIDGE] synthesis_failed | cacheKey: ${payload.cacheKey} | Error: ${payload.error} -> Friendly: ${friendlyError}`);
            this._emitWithIntent('synthesisError', {
                error: friendlyError,
                isFallingBack: false,
                cacheKey: payload.cacheKey,
                chapterIndex: state.currentChapterIndex,
                sentenceIndex: state.currentSentenceIndex
            });
        });
        this._playbackEngine.on('status', status => {
            this._logger(`[BRIDGE] Engine status change: isPlaying=${status.isPlaying}, isPaused=${status.isPaused}, isStalled=${status.isStalled}`);
            let engineStatus = 'idle';
            if (status.isStalled) { engineStatus = 'stalled'; }
            else if (status.isPlaying) { engineStatus = 'playing'; }
            else if (status.isPaused) { engineStatus = 'paused'; }

            this.emit('engineStatus', { status: engineStatus });
        });
    }


    public setPushDelay(ms: number) {
        this._pushDelayMs = ms;
        this._logger(`[BRIDGE] Push throttle updated to ${ms}ms.`);
    }

    /**
     * [UM-1] User Intent Gate — called by the human-facing play/continue gestures.
     * Unlocks start() to call setPlaying(true). Automatically revoked on stop().
     */
    public authorizePlayback(): void {
        this._isUserInitiatedPlay = true;
        this._logger('[BRIDGE] 🔓 Playback authorized by user gesture.');
    }

    public on<K extends keyof AudioBridgeEvents>(event: K, listener: AudioBridgeEvents[K]): this {
        return super.on(event, listener);
    }

    public emit<K extends keyof AudioBridgeEvents>(event: K, ...args: Parameters<AudioBridgeEvents[K]>): boolean {
        return super.emit(event, ...args);
    }

    public getRoutingForSentence(sentence: string, baseMode: EngineMode, baseVoice: string): { finalMode: EngineMode, targetVoice: string } {
        const resolvedVoice = this.resolveVoiceForSentence(sentence, baseVoice);
        const sentenceLang = resolvedVoice.split('-')[0].toLowerCase() === 'he' ? 'he' : 'en';

        const isNeuralSelected = baseMode === 'neural';
        const isNeuralViable   = this._playbackEngine.isNeuralViable();
        const phonikudEnabled = this._stateStore.state.phonikudEnabled;

        let finalMode: EngineMode = 'local';
        let targetVoice = resolvedVoice;

        if (sentenceLang === 'he' && phonikudEnabled) {
            finalMode = 'phonikud-tts';
            targetVoice = 'shaul';
        } else {
            if (isNeuralSelected && isNeuralViable) {
                finalMode = 'neural';
            } else if (isNeuralSelected && !isNeuralViable) {
                finalMode = 'local'; // Neural degraded fallback
            } else {
                finalMode = 'local';
            }
        }

        return { finalMode, targetVoice };
    }

    /**
     * Start playing a specific chapter and sentence.
     */
    public async start(chapterIndex: number, sentenceIndex: number, options: PlaybackOptions, previewOnly: boolean = false, intentId?: number, batchId?: number) {
        const activeOptions = { ...options };
        // [SOVEREIGNTY] Generate new IDs if none provided (e.g. extension host calls)
        const finalIntent = intentId !== undefined ? intentId : this._playbackEngine.playbackIntentId + 1;

        // [COMMITMENT_GATE] Detect drift between user choice and latched production settings
        const isVoiceDrift = activeOptions.voice !== this._latchedVoiceId && this._latchedVoiceId !== null;
        const isRateDrift = activeOptions.rate !== this._latchedRate && this._latchedRate !== undefined;
        const isCommitmentThresholdCrossed = isVoiceDrift || isRateDrift;

        let finalBatch = batchId !== undefined ? batchId : this._playbackEngine.batchIntentId;

        // [HARDENING] Prevent Batch 0 from escaping the Extension boundary
        if (finalBatch === 0) { finalBatch = 1; }

        // [SOVEREIGNTY] Adopt the intent provided from the gesture authority
        this._playbackEngine.adoptIntent(finalIntent);

        // If it's a new manual start from the host (no IDs provided), or if commitment threshold crossed, we tick the batchId.
        // If it's a resume or webview-driven start, we trust the provided/current batch.
        const resolutionBatch = (intentId === undefined && batchId === undefined) || isCommitmentThresholdCrossed ? finalBatch + 1 : finalBatch;

        if (isCommitmentThresholdCrossed) {
            this._logger(`[BRIDGE] Commitment Threshold crossed: v:${this._latchedVoiceId}->${activeOptions.voice}, r:${this._latchedRate}->${activeOptions.rate}. Incrementing batchId to ${resolutionBatch}.`);
        }

        this._playbackEngine.adoptBatchIntent(resolutionBatch);

        // Update latches upon commitment
        this._latchedVoiceId = activeOptions.voice;
        this._latchedRate = activeOptions.rate;

        if (this._prioritySynthesisTimeout) {
            clearTimeout(this._prioritySynthesisTimeout);
            this._prioritySynthesisTimeout = null;
        }

        const now = Date.now();
        const timeSinceLastChange = now - this._lastSentenceChangeTime;
        this._lastSentenceChangeTime = now;
        this._isRapidSkipping = timeSinceLastChange > 0 && timeSinceLastChange < 800;

        // CRITICAL: Stop any in-flight synthesis or sequences before starting a new one.
        // We use silent=true here because we are about to setPlaying(true) in line 159,
        // and we want to avoid emitting a transient "isPlaying: false" state to the UI.
        this._playbackEngine.stop(finalIntent, false, true, true);

        // [UM-1] User Intent Gate: Only allow setPlaying(true) when a human gesture
        // has explicitly authorized it via authorizePlayback(). This prevents LOAD_DOCUMENT
        // and pre-fetch synthesisReady callbacks from auto-triggering the playing state.
        const shouldPlay = !previewOnly && this._isUserInitiatedPlay;
        this._isUserInitiatedPlay = false; // Consume the authorization (one-shot)
        this._playbackEngine.setPlaying(shouldPlay, finalIntent);

        this._stateStore.setOptions({
            engineMode: activeOptions.mode,
            selectedVoice: activeOptions.voice,
            rate: activeOptions.rate,
            volume: activeOptions.volume
        });

        const chapters = this._docController.chapters;
        if (chapters.length === 0) {
            this._logger(`[BRIDGE] No chapters found in the current document. Playback cannot start.`);
            return;
        }

        if (chapterIndex < 0 || chapterIndex >= chapters.length) {
            this._logger(`[BRIDGE] Invalid chapter index: ${chapterIndex} (Total: ${chapters.length})`);
            return;
        }

        const chapter = chapters[chapterIndex];
        if (!chapter.sentences || chapter.sentences.length === 0) {
            this._logger(`[BRIDGE] Chapter ${chapterIndex} has no sentences. Skipping.`);
            this.next(activeOptions, false, this._stateStore.state.autoPlayMode, intentId, batchId);
            return;
        }

        if (sentenceIndex < 0 || sentenceIndex >= chapter.sentences.length) {
            this._logger(`[BRIDGE] Invalid sentence index: ${sentenceIndex}. Setting to 0.`);
            sentenceIndex = 0;
        }

        this._stateStore.setProgress(chapterIndex, sentenceIndex);
        this._stateStore.setPreviewing(previewOnly);

        const sentence = chapter.sentences[sentenceIndex];

        // [v2.4.5] Autoradiant Routing: Tiered Engine Selection
        const { finalMode, targetVoice } = this.getRoutingForSentence(sentence, activeOptions.mode, activeOptions.voice);
        const sentenceLang = targetVoice.split('-')[0].toLowerCase() === 'he' ? 'he' : 'en';

        if (finalMode === 'neural') {
            if (activeOptions.voice !== targetVoice) {
                this._logger(`[BRIDGE] Sentence-level auto-switch voice: ${activeOptions.voice} -> ${targetVoice} for language: ${sentenceLang}`);
                activeOptions.voice = targetVoice;
                this._stateStore.setOptions({ selectedVoice: targetVoice });
            }
        } else if (finalMode === 'phonikud-tts') {
            activeOptions.voice = 'shaul'; // Force local voice for synthesis key
        }

        this._logger(`[BRIDGE] Routing decision: Lang=${sentenceLang}, PhonikudEnabled=${this._stateStore.state.phonikudEnabled}, BaseMode=${activeOptions.mode} -> FinalMode=${finalMode}, Voice=${targetVoice}`);

        const isNeuralSelected = activeOptions.mode === 'neural';
        const isNeuralViable = this._playbackEngine.isNeuralViable();
        if (isNeuralSelected && !isNeuralViable && finalMode !== 'phonikud-tts') {
            this._logger('[BRIDGE] ☢️ Neural stalled/degraded. Falling back to LOCAL.');
        }

        const isPreBaked = finalMode === 'neural' || finalMode === 'phonikud-tts';
        const cacheKey = generateCacheKey(
            sentence,
            targetVoice,
            activeOptions.rate,
            this._docController.metadata.uri?.toString() || this._docController.metadata.fileName,
            isPreBaked
        );
        // [SINGLE-SINK] Commit this key as the active sentence. The synthesis-complete handler
        // reads this to suppress redundant synthesisReady (Path B) when Path C is handling delivery.
        this._activeCacheKey = cacheKey;

        if (finalMode === 'neural' || finalMode === 'phonikud-tts') {

            // [Law 7.2] Reinforce early warming signal to the webview
            this.emitSynthesisStarting(cacheKey, finalIntent);

            // [SOVEREIGNTY] Tiered Cache Lookup
            const extensionCached = this._playbackEngine.getCached(cacheKey);
            const webviewCached = this._webviewCacheManifest.has(cacheKey);

            if (extensionCached || webviewCached) {
                this._logger(`[BRIDGE] Sovereign Cache Hit: ${cacheKey} (${extensionCached ? 'Extension' : 'Webview'}).`);
                this._stateStore.setLoadType('cache');
                
                // [Law 7.1] Proactively confirm cache hit to suppress late FETCH_FAILED noise
                this.notifyCacheConfirmation(cacheKey);

                this._emitWithIntent('playAudio', {
                    cacheKey,
                    data: extensionCached || '', // If only in webview, it will pull via FETCH_AUDIO
                    text: sentence,
                    chapterIndex,
                    sentenceIndex,
                    totalSentences: chapter.sentences.length,
                    bakedRate: isPreBaked ? 1.0 : activeOptions.rate
                });

                // If it's in Extension cache, we already pushed data.
                // If only in Webview, emitting 'playAudio' with data:'' will trigger the Pull handshake in the webview.
                // [DE-DUPLICATION] synthesisReady was redundant here and caused double-playback.
            } else {
                this._logger(`[BRIDGE] Sovereign Cache MISS: ${cacheKey}. Triggering direct synthesis.`);
                this._stateStore.setLoadType('synth');
                
                if (this._isRapidSkipping) {
                    const debounceDelay = 300;
                    this._prioritySynthesisTimeout = setTimeout(async () => {
                        this._prioritySynthesisTimeout = null;
                        try {
                            if (this._playbackEngine.playbackIntentId === finalIntent && this._playbackEngine.batchIntentId === resolutionBatch) {
                                await this.synthesize(cacheKey, activeOptions, finalIntent, resolutionBatch, true);
                            }
                        } catch (e: any) {
                            this._logger(`[BRIDGE] Debounced synthesis failed: ${e.message}`);
                        }
                    }, debounceDelay);
                } else {
                    await this.synthesize(cacheKey, activeOptions, finalIntent, resolutionBatch, true);
                }
            }

            if (!this._stateStore.state.isPreviewing) {
                this._triggerPreFetch(chapterIndex, sentenceIndex + 1, activeOptions);
            }
        } else {
            this._speakLocal(sentence, activeOptions);
        }
    }

    /**
     * [Law 7.1] Notify the bridge that the Webview has confirmed a Tier-2 disk-cache
     * hit for the given key. This prevents FETCH_FAILED from triggering redundant synthesis.
     */
    public notifyCacheConfirmation(key: string): void {
        this._recentCacheConfirmations.set(key, Date.now());
    }

    /**
     * [Law 7.2] Deduplicated synthesisStarting emitter.
     * Suppresses duplicate events for the same cacheKey + intentId pair.
     */
    public emitSynthesisStarting(cacheKey: string, intentId: number): void {
        const guard = `${cacheKey}::${intentId}`;
        if (this._emittedSynthesisStarting.has(guard)) {
            this._logger(`[BRIDGE] [DEDUP_HIT] synthesisStarting suppressed for ${cacheKey} (Intent: ${intentId})`);
            return;
        }
        this._logger(`[BRIDGE] [DEDUP_ARM] synthesisStarting emitted for ${cacheKey} (Intent: ${intentId})`);
        this._emittedSynthesisStarting.add(guard);
        this.emit('synthesisStarting', { cacheKey, intentId });
    }

    /**
     * [Law 7.2] Clear the synthesisStarting dedup set — call on intent increment.
     */
    public clearSynthesisStartingDedup(): void {
        this._emittedSynthesisStarting.clear();
    }

    /**
     * Called when the webview reports a cache miss and needs a fresh synthesis.
     */
    public async synthesize(cacheKey: string, options: PlaybackOptions, intentId?: number, batchId?: number, isPriority: boolean = true, text?: string) {
        // [PROTOCOL_REPAIR] If the intentId is 0, it means the Webview is likely in an uninitialized state.
        // We adopt the extension's current intent (or generate one if everything is 0) to bridge the gap.
        let intentRepaired = false;
        let batchRepaired = false;

        if (intentId === 0) {
            const currentIntent = this._playbackEngine.playbackIntentId;
            intentId = currentIntent > 0 ? currentIntent : 1;
            intentRepaired = true;
            this._logger(`[BRIDGE] [PROTOCOL_REPAIR] Synthesis request with Intent 0. Adopted: ${intentId}`);
        }

        if (batchId === 0) {
            const currentBatch = this._playbackEngine.batchIntentId;
            batchId = currentBatch > 0 ? currentBatch : 1;
            batchRepaired = true;
            this._logger(`[BRIDGE] [PROTOCOL_REPAIR] Synthesis request with Batch 0. Adopted: ${batchId}`);
        }

        // [3.1.B] Sync repaired values back to engine + StateStore so the next RELAY cycle carries
        // the authoritative IDs to the Webview — preventing it from re-sending 0 and causing
        // a second synthesis cycle (double-play oscillation).
        if (intentRepaired) {
            this._playbackEngine.adoptIntent(intentId!);
            this._stateStore.setPlaybackIntentId(intentId!);
        }
        if (batchRepaired) {
            this._playbackEngine.adoptBatchIntent(batchId!);
            this._stateStore.setBatchIntentId(batchId!);
        }

        // [3.1.B] Trigger proactive UI_SYNC if IDs were repaired to stop oscillation
        if (intentRepaired || batchRepaired) {
            this._logger(`[BRIDGE] [PROTOCOL_REPAIR] Triggering proactive UI_SYNC for repaired IDs.`);
            this.emit('uiSyncRequested');
        }

        // [Law 7.1] FETCH_FAILED Fallback Guard: If the Webview confirmed a cache hit
        // for this key within the last 200ms, skip synthesis and emit playAudio directly.
        const confirmedAt = this._recentCacheConfirmations.get(cacheKey);
        if (confirmedAt !== undefined && Date.now() - confirmedAt < 200) {
            // [Fix B] Batch monotonic gate: if the batch has advanced since this FETCH_AUDIO
            // request was issued, the resolution is stale — drop it silently.
            const latestBatch = this._playbackEngine.batchIntentId;
            if (batchId !== undefined && latestBatch > batchId) {
                this._logger(`[BRIDGE] [FIX-B] Stale FETCH_AUDIO fast-path: Batch ${batchId} < Engine ${latestBatch}. Dropping playAudio.`);
                return;
            }
            const isPreBaked = options.mode === 'neural' || options.mode === 'phonikud-tts';
            this._emitWithIntent('playAudio', { cacheKey, data: '', bakedRate: isPreBaked ? 1.0 : options.rate });
            return;
        }

        const state = this._stateStore.state;
        const chapters = this._docController.chapters;

        // [HARDENING] Defensive check against stale indices during document reloads
        if (state.currentChapterIndex < 0 || state.currentChapterIndex >= chapters.length) {
            this._logger(`[BRIDGE] synthesis_blocked | Stale chapter index: ${state.currentChapterIndex}`);
            return;
        }

        const chapter = chapters[state.currentChapterIndex];
        if (!chapter || !chapter.sentences) { return; }

        // [CACHE-POISON FIX] If the webview passed explicit text (prefetch path), use it directly.
        // Previously, synthesize() always resolved from state.currentSentenceIndex (HEAD=0),
        // so every prefetch key (N+1, N+2, N+3) received HEAD audio — poisoning the cache.
        // The priority path (start() → HEAD synthesis) correctly omits text and uses state position.
        let sentence: string;
        if (text && text.trim()) {
            sentence = text;
        } else {
            if (state.currentSentenceIndex < 0 || state.currentSentenceIndex >= chapter.sentences.length) {
                this._logger(`[BRIDGE] synthesis_blocked | Stale sentence index: ${state.currentSentenceIndex}`);
                return;
            }
            sentence = chapter.sentences[state.currentSentenceIndex];
            if (!sentence) { return; }
        }

        const currentIntent = intentId ?? this._playbackEngine.playbackIntentId;
        const currentBatch = batchId ?? this._playbackEngine.batchIntentId;

        this._logger(`[BRIDGE] Request synthesis: "${sentence.substring(0, 30)}..." | Key: ${cacheKey}`);

        const { finalMode: resolvedMode, targetVoice: resolvedVoice } = this.getRoutingForSentence(sentence, options.mode, options.voice);
        let actualCacheKey = cacheKey;
        const targetOptions = { ...options, mode: resolvedMode, voice: resolvedVoice };

        if (resolvedMode === 'neural' || resolvedMode === 'phonikud-tts') {
            actualCacheKey = generateCacheKey(
                sentence,
                resolvedVoice,
                options.rate,
                this._docController.metadata.uri?.toString() || this._docController.metadata.fileName,
                true
            );
            if (actualCacheKey !== cacheKey) {
                this._logger(`[BRIDGE] [SYNTHESIZE-RESOLVE] Prefetch key rewritten: ${cacheKey} -> ${actualCacheKey} (Voice: ${resolvedVoice})`);
            }
        }

        this._logger(`[BRIDGE] Webview Cache MISS for ${actualCacheKey} (Intent: ${currentIntent}, Batch: ${currentBatch}, Priority: ${isPriority}). Starting synthesis...`);
        this._stateStore.setLoadType('synth');
        await this._speakNeural(sentence, actualCacheKey, targetOptions, state.currentChapterIndex, state.currentSentenceIndex, currentIntent, currentBatch, isPriority);

        // If the key was rewritten, also mirror the synthesized data to the original requested cacheKey in PlaybackEngine.
        // This ensures the webview's prefetch listener (waiting for the old key) is notified and cleans up its pending tasks correctly.
        if (actualCacheKey !== cacheKey) {
            if (typeof this._playbackEngine.getAudioFromCache === 'function' && typeof this._playbackEngine.addToCache === 'function') {
                const data = this._playbackEngine.getAudioFromCache(actualCacheKey);
                if (data) {
                    this._playbackEngine.addToCache(cacheKey, data, currentIntent);
                }
            }
        }
    }

    public stop(intentId?: number, batchId?: number) {
        if (this._prioritySynthesisTimeout) {
            clearTimeout(this._prioritySynthesisTimeout);
            this._prioritySynthesisTimeout = null;
        }
        // [SINGLE-SINK] Clear active key so any late in-flight synthesis-complete
        // cannot match and will safely route to dataPush (harmless cache warm) instead of synthesisReady.
        this._activeCacheKey = '';
        // [UM-1] Revoke any pending user authorization on stop.
        this._isUserInitiatedPlay = false;
        // [PLAY-ONCE] Reset playAudio gate on stop so the next play session starts clean.
        this._lastPlayAudioCacheKey = '';
        this._playbackEngine.stop(intentId, !!batchId);
        this._logger(`[BRIDGE] Playback stopped (Intent: ${intentId ?? 'current'}, BatchReset: ${!!batchId}).`);
    }

    public pause(intentId?: number) {
        this._playbackEngine.setPaused(true, intentId);
        this._logger(`[BRIDGE] Playback paused (Intent: ${intentId ?? 'current'}).`);
    }

    /**
     * [v2.3.0] Universal Intent Injection Wrapper
     * Ensures all events sent to the webview carry the authoritative intentId.
     */
    private _emitWithIntent<K extends keyof AudioBridgeEvents>(event: K, payload: any) {
        const intentId = payload.intentId !== undefined ? payload.intentId : this._playbackEngine.playbackIntentId;
        // [PLAY-ONCE GATE] Backstop: suppress duplicate playAudio for the exact same sentence.
        // Keyed by cacheKey so only a repeated emission for the same segment is blocked —
        // different sentences (different cacheKeys) always pass through unobstructed.
        if (event === 'playAudio') {
            const cacheKey = (payload as any).cacheKey || '';
            if (cacheKey && this._lastPlayAudioCacheKey === cacheKey) {
                this._logger(`[BRIDGE] PLAYAUDIO_SUPPRESSED: Duplicate key ${cacheKey.substring(0, 15)}... blocked. Backstop active.`);
                return;
            }
            this._lastPlayAudioCacheKey = cacheKey;
        }
        this._logger(`[BRIDGE] >> EMIT ${event} | Intent: ${intentId}`);
        (this as any).emit(event, { ...payload, intentId });
    }

    public async next(options: PlaybackOptions, manual: boolean = false, autoPlayMode: 'auto' | 'chapter' | 'row' = 'auto', intentId?: number, batchId?: number) {
        const finalIntent = intentId !== undefined ? intentId : (manual ? this._playbackEngine.playbackIntentId + 1 : this._playbackEngine.playbackIntentId);
        let finalBatch = batchId !== undefined ? batchId : this._playbackEngine.batchIntentId;

        // [HARDENING] Prevent Batch 0 leakage
        if (finalBatch === 0) { finalBatch = 1; }

        this._playbackEngine.adoptIntent(finalIntent);
        this._stateStore.setPlaybackIntentId(finalIntent);

        // [SOVEREIGNTY] Auto-tick batch ONLY if this is a MANUAL host-triggered gesture.
        // Auto-advances (manual=false) must persist the batchId to maintain sequence continuity.
        const resolutionBatch = (manual && intentId === undefined && batchId === undefined) ? finalBatch + 1 : finalBatch;
        this._playbackEngine.adoptBatchIntent(resolutionBatch);
        this._stateStore.setBatchIntentId(resolutionBatch);
        if (this._stateStore.state.isPreviewing) {
            this._stateStore.setPreviewing(false);
            this._logger(`[BRIDGE] Preview finished. Waiting for user Play.`);
            return;
        }

        const state = this._stateStore.state;
        const chapters = this._docController.chapters;

        // [ISSUE 17] Update SSOT with playback options
        this._stateStore.setOptions({ autoPlayMode });

        // 1. Check Row-Locked Mode
        if (autoPlayMode === 'row' && !manual) {
            this.stop();
            return;
        }

        // 2. Calculate Next Position
        const expandedSet = new Set(state.expandedTables || []);
        const nextPos = this._sequenceManager.getNext(state.currentChapterIndex, state.currentSentenceIndex, chapters, expandedSet);

        if (!nextPos) {
            this._logger('[BRIDGE] End of document reached.');
            this.emit('playbackFinished');
            this.stop(); // Ensure state is reset
            return;
        }

        // 3. Chapter-Locked Mode
        if (autoPlayMode === 'chapter' && !manual && nextPos.chapterIndex !== state.currentChapterIndex) {
            this.stop();
            return;
        }

        // 4. Trigger Next
        // [Fix 0] Auto-advance is a continuation of an already-authorized play session.
        // Re-authorize the UM-1 gate so start() calls setPlaying(true) without requiring
        // a new human gesture. This prevents silent-stop between every auto-advance sentence.
        this._isUserInitiatedPlay = true;
        await this.start(nextPos.chapterIndex, nextPos.sentenceIndex, options, false, finalIntent, resolutionBatch);
    }

    public async previous(options: PlaybackOptions, intentId?: number, batchId?: number) {
        if (intentId !== undefined) {
            this._playbackEngine.adoptIntent(intentId);
            this._stateStore.setPlaybackIntentId(intentId);
        }
        if (batchId !== undefined) {
            this._playbackEngine.adoptBatchIntent(batchId);
        }

        const state = this._stateStore.state;
        const chapters = this._docController.chapters;

        const expandedSet = new Set(state.expandedTables || []);
        const prevPos = this._sequenceManager.getPrevious(state.currentChapterIndex, state.currentSentenceIndex, chapters, expandedSet);

        if (prevPos) {
            await this.start(prevPos.chapterIndex, prevPos.sentenceIndex, options, false, intentId, batchId);
        } else {
            this._logger('[BRIDGE] Already at the start of document.');
        }
    }


    private async _speakNeural(sentence: string, cacheKey: string, options: PlaybackOptions, cIdx: number, sIdx: number, intentId: number, batchId?: number, isPriority: boolean = true) {
        try {
            const data = await this._playbackEngine.speakNeural(sentence, cacheKey, options, isPriority, intentId, batchId);

            // GUARD: Transactional Nonce check - allow current or future intents, reject strictly stale ones.
            if (this._playbackEngine.playbackIntentId > intentId) {
                this._logger(`[BRIDGE] 🗑️ Dropping Stale Packet: Intent ${intentId} is older than Engine ${this._playbackEngine.playbackIntentId}`);
                return;
            }
            
            if (this._playbackEngine.playbackIntentId < intentId) {
                this._logger(`[BRIDGE] ⚠️ Future Packet Detected: Intent ${intentId} > Engine ${this._playbackEngine.playbackIntentId}. Proceeding with caution.`);
            }
            // If the user jumped again, cIdx/sIdx will no longer match the current state.
            const state = this._stateStore.state;
            if (state.currentChapterIndex !== cIdx || state.currentSentenceIndex !== sIdx) {
                this._logger(`[BRIDGE] Ignoring stale synthesis result for ${cIdx}:${sIdx}`);
                return;
            }

            // [Fix A] Batch monotonic gate: position check alone is bypassable when the user
            // skips exactly 1 sentence (sIdx of stale packet matches new position).
            // A stale batchId is the definitive proof that this synthesis was for a prior
            // play sequence and must be dropped, even if positions happen to coincide.
            if (batchId !== undefined && this._playbackEngine.batchIntentId > batchId) {
                this._logger(`[BRIDGE] 🗑️ [FIX-A] Stale Batch Packet: Batch ${batchId} < Engine ${this._playbackEngine.batchIntentId}. Dropping.`);
                return;
            }

            // [SOVEREIGNTY] Decoupled emission: We push data if we have it. 
            // The Webview is the final gate for playback and will ignore stale intents.
            if (data) {
                if (!isPriority) {
                    // [PREFETCH-ONLY] Non-priority synthesis completes: audio is already stored in
                    // PlaybackEngine cache by speakNeural(). DO NOT emit playAudio — that is the
                    // sovereign right of the priority path (start() / next()) only.
                    // Emitting playAudio here caused simultaneous multi-sentence playback (audio mess).
                    this._logger(`[BRIDGE] PREFETCH_PUSH: ${cacheKey.substring(0, 20)}... | Intent: ${intentId}`);
                    return;
                }
                this._emitWithIntent('playAudio', {
                    cacheKey,
                    data, // Restore Push Mode for performance
                    text: sentence,
                    chapterIndex: cIdx,
                    bakedRate: (options.mode === 'neural' || options.mode === 'phonikud-tts') ? 1.0 : options.rate,
                    totalSentences: this._docController.chapters[cIdx].sentences.length,
                    sentences: this._docController.chapters[cIdx].sentences
                });
            }
        } catch (err: any) {
            const errorMessage = err?.message || String(err);
            if (errorMessage.includes('Abort') || errorMessage.includes('Cancel')) {
                this._logger(`[BRIDGE] Neural synthesis cancelled: ${errorMessage}`);
                return;
            }

            if (!this._playbackEngine.isPlaying) {
                this._logger('[BRIDGE] Synthesis failed, but engine is stopped.');
                return;
            }

            // If the error persists after all internal retries, we finally give up on premium engines and fall back to Local SAPI!
            if (options.mode === 'neural' || options.mode === 'phonikud-tts') {
                this._logger(`[BRIDGE] ⚠️ Premium synthesis failed terminal: ${errorMessage}. Falling back to Local SAPI...`);
                this._speakLocal(sentence, options);
                return;
            }

            const friendlyError = this._mapToFriendlyError(errorMessage);
            this._logger(`[BRIDGE] Neural synthesis stalled: ${errorMessage}. Final failure -> ${friendlyError}`);
            this._emitWithIntent('synthesisError', {
                error: friendlyError,
                isFallingBack: false,
                cacheKey,
                chapterIndex: cIdx,
                sentenceIndex: sIdx
            });
        }
    }

    private _mapToFriendlyError(error: string): string {
        const msg = error.toLowerCase();
        if (msg.includes('429') || msg.includes('rate limit')) {
            return 'Voice limit reached — please wait a moment before continuing.';
        }
        if (msg.includes('timeout') || msg.includes('socket')) {
            return 'Connection unstable — check your internet or try again.';
        }
        if (msg.includes('voice') || msg.includes('tts')) {
            return 'Voice service unavailable — please try again in a moment.';
        }
        return 'Audio service issue — please try again.';
    }

    private _speakLocal(sentence: string, options: PlaybackOptions) {
        // [v2.3.1] Simplified Webview IPC: Instead of native SAPI, we command the Webview to speak.
        // The Webview will handle the utterance and report completion via 'playbackFinished' if needed,
        // or we can rely on the existing 'next' logic if we want extension-side sequencing.
        this._logger(`[BRIDGE] >> SPEAK_LOCAL: "${sentence.substring(0, 30)}..."`);

        this._emitWithIntent('speakLocal', {
            text: sentence,
            voiceId: options.voice,
            rate: options.rate,
            volume: options.volume
        });
    }

    private _triggerPreFetch(chapterIndex: number, sentenceIndex: number, options: PlaybackOptions) {
        const state = this._stateStore.state;
        if (!this._playbackEngine.isPlaying || state.isPreviewing || state.playbackStalled) {
            return;
        }

        if (this._prefetchTimeout) {
            clearTimeout(this._prefetchTimeout);
            this._prefetchTimeout = null;
        }

        // Debounce delay: 1500ms if user is skipping rapidly, otherwise default 200ms
        const delay = this._isRapidSkipping ? 1500 : 200;

        // DEBOUNCE & LIMIT PREFETCH (Prevents queue bloat during rapid clicking)
        this._prefetchTimeout = setTimeout(() => {
            this._prefetchTimeout = null;
            // [GHOST_PREFETCH_GUARD] Re-check if still playing and on the same path
            const currentState = this._stateStore.state;
            if (!this._playbackEngine.isPlaying ||
                currentState.playbackStalled ||
                currentState.currentChapterIndex !== (sentenceIndex === 0 ? chapterIndex - 1 : chapterIndex) ||
                currentState.currentSentenceIndex !== (sentenceIndex === 0 ? this._docController.chapters[chapterIndex - 1]?.sentences.length - 1 : sentenceIndex - 1)) {
                return;
            }

            const chapters = this._docController.chapters;
            const targets: { cIdx: number, sIdx: number }[] = [];

            // 1. Target Window: [Current-1, Current+1, Current+2]
            // Note: Current is already handled by the PlaybackEngine start/next logic.

            const curC = currentState.currentChapterIndex;
            const curS = currentState.currentSentenceIndex;
            const expandedSet = new Set(currentState.expandedTables || []);

            // - Next +1
            const next1 = this._sequenceManager.getNext(curC, curS, chapters, expandedSet);
            if (next1) {
                targets.push({ cIdx: next1.chapterIndex, sIdx: next1.sentenceIndex });
                // - Next +2
                const next2 = this._sequenceManager.getNext(next1.chapterIndex, next1.sentenceIndex, chapters, expandedSet);
                if (next2) { targets.push({ cIdx: next2.chapterIndex, sIdx: next2.sentenceIndex }); }
            }

            // - Previous
            const prev = this._sequenceManager.getPrevious(curC, curS, chapters, expandedSet);
            if (prev) { targets.push({ cIdx: prev.chapterIndex, sIdx: prev.sentenceIndex }); }

            // 2. Trigger Deduplicated Synthesis
            let count = 0;
            for (const target of targets) {
                const text = chapters[target.cIdx].sentences[target.sIdx];
                const { finalMode: prefetchMode, targetVoice: prefetchVoice } = this.getRoutingForSentence(text, options.mode, options.voice);
                
                const targetOptions = {
                    ...options,
                    mode: prefetchMode,
                    voice: prefetchVoice
                };

                const isPreBaked = prefetchMode === 'neural' || prefetchMode === 'phonikud-tts';
                const key = generateCacheKey(
                    text,
                    prefetchVoice,
                    options.rate,
                    this._docController.metadata.uri?.toString() || this._docController.metadata.fileName,
                    isPreBaked
                );

                // Skip prefetch if already in either cache
                if (!this._playbackEngine.getCached(key) && !this._webviewCacheManifest.has(key)) {
                    this._playbackEngine.triggerPrefetch(text, key, targetOptions, this._playbackEngine.batchIntentId);
                    count++;
                }
            }
            this._logger(`[BRIDGE] Symmetrical Window Sync: ${count} segments warmed (-1/+2 window).`);
        }, delay);
    }

    public resolveVoiceForSentence(sentence: string, currentVoice: string): string {
        const cleanS = cleanTextForLanguageDetection(sentence);
        const cleanStr = cleanS.replace(/[\s\d\p{P}]/gu, '');
        const totalChars = cleanStr.length;
        
        let sentenceLang = currentVoice.split('-')[0].toLowerCase() === 'he' ? 'he' : 'en';
        if (totalChars >= 8) {
            const hebrewMatches = cleanStr.match(/[\u0590-\u05FF]/g);
            const hebrewChars = hebrewMatches ? hebrewMatches.length : 0;
            const isHebrew = (hebrewChars / totalChars) >= 0.3;
            sentenceLang = isHebrew ? 'he' : 'en';
        }

        const savedVoice = this._settingsManager.loadVoiceHistory(sentenceLang);
        const defaultVoice = sentenceLang === 'he' ? 'he-IL-AvriNeural' : 'en-US-SteffanNeural';
        return savedVoice || defaultVoice;
    }
    /**
     * [SOVEREIGNTY] Updates the extension's view of the webview's persistent cache.
     */
    public updateManifest(delta: { added: string[], removed: string[], isFullSync: boolean }) {
        if (delta.isFullSync) {
            this._webviewCacheManifest = new Set(delta.added);
            this._logger(`[BRIDGE] Sovereign Manifest Grounded: ${this._webviewCacheManifest.size} keys.`);
        } else {
            delta.added.forEach(k => this._webviewCacheManifest.add(k));
            delta.removed.forEach(k => this._webviewCacheManifest.delete(k));
            this._logger(`[BRIDGE] Sovereign Manifest Delta: +${delta.added.length}, -${delta.removed.length}. Total: ${this._webviewCacheManifest.size}`);
        }
    }
}

function cleanTextForLanguageDetection(text: string): string {
    // 1. Strip markdown image links first: ![alt](url)
    let clean = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    // 2. Strip standard markdown links: [text](url)
    clean = clean.replace(/\[[^\]]*\]\([^)]*\)/g, '');
    // 3. Strip raw URLs (HTTP/HTTPS/FILE)
    clean = clean.replace(/(?:https?|file):\/\/[^\s]+/gi, '');
    clean = clean.replace(/www\.[^\s]+/gi, '');
    // 4. Strip Windows absolute paths
    clean = clean.replace(/[a-zA-Z]:[\\/](?:[^"'\r\n\s]+|\s+(?=[^"'\r\n\s]*[\\/]))*/g, '');
    // 5. Strip Unix absolute paths
    clean = clean.replace(/(?<!\w)\/(?:[^"'\r\n\s]+|\s+(?=[^"'\r\n\s]*[\\/]))*/g, '');
    // 6. Strip relative paths
    clean = clean.replace(/\b[a-zA-Z0-9_\-\.]+(?:\/|\\)(?:[^"'\r\n\s]+|\s+(?=[^"'\r\n\s]*[\\/]))*/g, '');
    return clean;
}
