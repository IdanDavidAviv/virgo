import * as vscode from 'vscode';
import { StateStore } from '@core/stateStore';
import { DocumentLoadController } from '@core/documentLoadController';
import { PlaybackEngine, PlaybackOptions } from '@core/playbackEngine';
import { SequenceManager } from '@core/sequenceManager';
import { EventEmitter } from 'events';

export interface AudioBridgeEvents {
    'playAudio': (payload: { cacheKey: string, data: string, text: string, chapterIndex: number, sentenceIndex: number, totalSentences: number, sentences: string[], intentId: number }) => void;
    'synthesisStarting': (payload: { cacheKey: string, intentId: number }) => void;
    'synthesisError': (payload: { error: string, isFallingBack: boolean, cacheKey: string, chapterIndex: number, sentenceIndex: number, intentId: number }) => void;
    'playbackFinished': () => void;
    'engineStatus': (payload: { status: string }) => void;
    'dataPush': (payload: { cacheKey: string, data: string, intentId: number }) => void;
    'synthesisReady': (payload: { cacheKey: string, intentId: number }) => void;
}

export class AudioBridge extends EventEmitter {
    private _pushDelayMs: number = 200;

    constructor(
        private readonly _stateStore: StateStore,
        private readonly _docController: DocumentLoadController,
        private readonly _playbackEngine: PlaybackEngine,
        private readonly _sequenceManager: SequenceManager,
        private readonly _logger: (msg: string) => void
    ) {
        super();
        // Reactive Sync: Listen to Engine status and update SSOT automatically
        this._playbackEngine.on('status', (status?: { isPlaying: boolean, isPaused: boolean, isStalled: boolean }) => {
            const isPlaying = status?.isPlaying ?? this._playbackEngine.isPlaying;
            const isPaused = status?.isPaused ?? this._playbackEngine.isPaused;
            const isStalled = status?.isStalled ?? this._playbackEngine.isStalled;
            this._stateStore.setPlaybackStatus(isPlaying, isPaused, isStalled);
        });

        this._playbackEngine.on('synthesis-starting', (payload) => {
            this.emit('synthesisStarting', payload);
        });

        // [v2.0.0] Throttled Pushing: Ensure bridge priority for user IPC 
        let pushQueue: any[] = [];
        let pushTimeout: NodeJS.Timeout | null = null;

        this._playbackEngine.on('synthesis-complete', (payload: { cacheKey: string, data: string, intentId: number }) => {
            const currentIntent = this._playbackEngine.playbackIntentId;
            
            // Optimization: If the payload's intentId matches the current active intent, push immediately
            // to bypass the throttle for the user's immediate hearing experience.
            if (payload.intentId === currentIntent) {
                this._logger(`[BRIDGE] NOTIFY_READY (Priority): ${payload.cacheKey} | Intent: ${payload.intentId}`);
                this.emit('synthesisReady', { cacheKey: payload.cacheKey, intentId: payload.intentId });
                return;
            }

            // [HARDENING] Only queue if it's not ancient (currentIntent - 2 range for prefetch buffer)
            if (payload.intentId >= currentIntent - 2) {
                pushQueue.push(payload);
            }

            if (pushTimeout) { return; }
            pushTimeout = setTimeout(() => {
                const results = pushQueue.filter(p => p.intentId === this._playbackEngine.playbackIntentId);
                pushQueue = [];
                pushTimeout = null;
                if (results.length > 0) {
                    this._logger(`[BRIDGE] Batch NOTIFYing ${results.length} valid segments.`);
                    results.forEach(p => this.emit('synthesisReady', { cacheKey: p.cacheKey, intentId: p.intentId }));
                }
            }, this._pushDelayMs);
        });
    }

    public setPushDelay(ms: number) {
        this._pushDelayMs = ms;
        this._logger(`[BRIDGE] Push throttle updated to ${ms}ms.`);
    }

    public on<K extends keyof AudioBridgeEvents>(event: K, listener: AudioBridgeEvents[K]): this {
        return super.on(event, listener);
    }

    public emit<K extends keyof AudioBridgeEvents>(event: K, ...args: Parameters<AudioBridgeEvents[K]>): boolean {
        return super.emit(event, ...args);
    }

    /**
     * Start playing a specific chapter and sentence.
     */
    public async start(chapterIndex: number, sentenceIndex: number, options: PlaybackOptions, previewOnly: boolean = false) {
        // CRITICAL: Stop any in-flight synthesis or sequences before starting a new one.
        // This ensures that jumps immediately abort previous tasks and clear the lock.
        this._playbackEngine.stop();
        
        // Use the Engine as the source of truth for playing status
        this._playbackEngine.setPlaying(!previewOnly);
        
        this._stateStore.setOptions({
            engineMode: options.mode,
            selectedVoice: options.voice,
            rate: options.rate,
            volume: options.volume
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
            this.next(options);
            return;
        }

        if (sentenceIndex < 0 || sentenceIndex >= chapter.sentences.length) {
            this._logger(`[BRIDGE] Invalid sentence index: ${sentenceIndex}. Setting to 0.`);
            sentenceIndex = 0;
        }

        this._stateStore.setProgress(chapterIndex, sentenceIndex);
        this._stateStore.setPreviewing(previewOnly);

        const sentence = chapter.sentences[sentenceIndex];
        const cacheKey = this._getCacheKey(chapterIndex, sentenceIndex, options.voice);

        if (options.mode === 'neural') {
            // [ISSUE 18] Zero-IPC Design: Check extension volatile cache first
            const cachedData = this._playbackEngine.getCached(cacheKey);
            
            if (cachedData) {
                this._logger(`[BRIDGE] Extension Cache HUB Hit: ${cacheKey}. Pushing binary data.`);
                this._stateStore.setLoadType('cache');
                this.emit('playAudio', {
                    cacheKey,
                    data: cachedData, // Restore Push Mode for performance
                    text: sentence,
                    chapterIndex,
                    sentenceIndex,
                    totalSentences: chapter.sentences.length,
                    sentences: chapter.sentences,
                    intentId: this._playbackEngine.playbackIntentId
                });
                // Still trigger the Ready signal for telemetry/sync
                this.emit('synthesisReady', { cacheKey, intentId: this._playbackEngine.playbackIntentId });
            } else {
                this._logger(`[BRIDGE] Zero-IPC: Triggering Webview Cache Check for ${cacheKey}`);
                this._stateStore.setLoadType('cache'); // Assume cache check first, synthesize() will override if MISS
                this.emit('playAudio', {
                    cacheKey,
                    data: '', // Decommissioned Push: Data is now pulled via FETCH_AUDIO
                    text: sentence,
                    chapterIndex,
                    sentenceIndex,
                    totalSentences: chapter.sentences.length,
                    sentences: chapter.sentences,
                    intentId: this._playbackEngine.playbackIntentId
                });
                // Trigger the Pull handshake
                this.emit('synthesisReady', { cacheKey, intentId: this._playbackEngine.playbackIntentId });
            }
            
            if (!this._stateStore.state.isPreviewing) {
                this._triggerPreFetch(chapterIndex, sentenceIndex + 1, options);
            }
        } else {
            this._speakLocal(sentence, options);
        }
    }

    /**
     * Called when the webview reports a cache miss and needs a fresh synthesis.
     */
    public async synthesize(cacheKey: string, options: PlaybackOptions, intentId?: number) {
        const state = this._stateStore.state;
        const chapters = this._docController.chapters;
        
        // [HARDENING] Defensive check against stale indices during document reloads
        if (state.currentChapterIndex < 0 || state.currentChapterIndex >= chapters.length) {
            this._logger(`[BRIDGE] synthesis_blocked | Stale chapter index: ${state.currentChapterIndex}`);
            return;
        }

        const chapter = chapters[state.currentChapterIndex];
        if (!chapter || !chapter.sentences) { return; }
        
        if (state.currentSentenceIndex < 0 || state.currentSentenceIndex >= chapter.sentences.length) {
            this._logger(`[BRIDGE] synthesis_blocked | Stale sentence index: ${state.currentSentenceIndex}`);
            return;
        }

        const sentence = chapter.sentences[state.currentSentenceIndex];
        if (!sentence) { return; }

        const currentIntent = intentId ?? this._playbackEngine.playbackIntentId;
        this._logger(`[BRIDGE] Webview Cache MISS for ${cacheKey} (Intent: ${currentIntent}). Starting synthesis...`);
        this._stateStore.setLoadType('synth');
        await this._speakNeural(sentence, cacheKey, options, state.currentChapterIndex, state.currentSentenceIndex, currentIntent);
    }

    public stop() {
        this._playbackEngine.stop();
        this._logger('[BRIDGE] Playback stopped.');
    }

    public pause() {
        this._playbackEngine.setPaused(true);
        this._logger('[BRIDGE] Playback paused.');
    }

    public next(options: PlaybackOptions, manual: boolean = false, autoPlayMode: 'auto' | 'chapter' | 'row' = 'auto') {
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
        const nextPos = this._sequenceManager.getNext(state.currentChapterIndex, state.currentSentenceIndex, chapters);

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
        this.start(nextPos.chapterIndex, nextPos.sentenceIndex, options);
    }

    public previous(options: PlaybackOptions) {
        const state = this._stateStore.state;
        const chapters = this._docController.chapters;
        
        const prevPos = this._sequenceManager.getPrevious(state.currentChapterIndex, state.currentSentenceIndex, chapters);
        
        if (prevPos) {
            this.start(prevPos.chapterIndex, prevPos.sentenceIndex, options);
        } else {
            this._logger('[BRIDGE] Already at the start of document.');
        }
    }

    private async _speakNeural(sentence: string, cacheKey: string, options: PlaybackOptions, cIdx: number, sIdx: number, intentId: number) {
        try {
            const data = await this._playbackEngine.speakNeural(sentence, cacheKey, options, true); // true = priority
            
            // GUARD: Transactional Nonce check - Unify with Engine Intent
            if (this._playbackEngine.playbackIntentId !== intentId) {
                this._logger(`[BRIDGE] Transaction Mismatch: Request Intent ${intentId} is stale. Current: ${this._playbackEngine.playbackIntentId}`);
                return;
            }
            // If the user jumped again, cIdx/sIdx will no longer match the current state.
            const state = this._stateStore.state;
            if (state.currentChapterIndex !== cIdx || state.currentSentenceIndex !== sIdx) {
                this._logger(`[BRIDGE] Ignoring stale synthesis result for ${cIdx}:${sIdx}`);
                return;
            }

            if (data && (this._playbackEngine.isPlaying || state.isPreviewing)) {
                this.emit('playAudio', {
                    cacheKey,
                    data, // Restore Push Mode for performance
                    text: sentence,
                    chapterIndex: cIdx,
                    sentenceIndex: sIdx,
                    totalSentences: this._docController.chapters[cIdx].sentences.length,
                    sentences: this._docController.chapters[cIdx].sentences,
                    intentId: intentId
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

            // [RESILIENCE] No more SAPI fallback for neural hangs.
            // We tell the UI we are 'buffering' and trust the Engine's internal retry loop.
            this._logger(`[BRIDGE] Neural synthesis stalled: ${errorMessage}. Retrying...`);
            this.emit('engineStatus', { status: 'buffering' });
            
            // If the error persists after all internal retries, we finally give up.
            this.emit('synthesisError', { 
                error: errorMessage, 
                isFallingBack: false, // Explicitly false to prevent UI from expecting SAPI
                cacheKey, 
                chapterIndex: cIdx, 
                sentenceIndex: sIdx,
                intentId: intentId
            });
        }
    }

    private _speakLocal(sentence: string, options: PlaybackOptions) {
        this._playbackEngine.speakLocal(sentence, options, (code) => {
            if (code === 0 && !this._playbackEngine.isPaused && this._playbackEngine.isPlaying) {
                this.next(options);
            }
        });
    }

    private _triggerPreFetch(chapterIndex: number, sentenceIndex: number, options: PlaybackOptions) {
        const state = this._stateStore.state;
        if (!this._playbackEngine.isPlaying || state.isPreviewing || state.playbackStalled) {
            return;
        }

        // DEBOUNCE & LIMIT PREFETCH (Prevents queue bloat during rapid clicking)
        setTimeout(() => {
            // Re-check if still playing, not stalled, and still on the same path
            // This kills "stale" prefetch triggers if the user jumped elsewhere
            const currentState = this._stateStore.state;
            if (!this._playbackEngine.isPlaying || 
                currentState.playbackStalled ||
                currentState.currentChapterIndex !== chapterIndex || 
                (currentState.currentSentenceIndex + 1) !== sentenceIndex) {
                return;
            }

            let count = 0;
            let cIdx = chapterIndex;
            let sIdx = sentenceIndex;

            // Mission 3: Increase prefetch depth to 5 sentences for smoother continuous flow
            while (count < 5) {
                const chapter = this._docController.chapters[cIdx];
                if (!chapter) { break; }

                if (sIdx < chapter.sentences.length) {
                    const text = chapter.sentences[sIdx];
                    const cacheKey = this._getCacheKey(cIdx, sIdx, options.voice);
                    this._playbackEngine.triggerPrefetch(text, cacheKey, options);
                    sIdx++;
                    count++;
                } else {
                    cIdx++;
                    sIdx = 0;
                }
            }
            this._logger(`[BRIDGE] Prefetching ${count} sentences ahead...`);
        }, 200); // Reduced delay from 300ms to 200ms for more aggressive warming
    }

    private _getCacheKey(chapterIndex: number, sentenceIndex: number, voice: string): string {
        const metadata = this._docController.metadata;
        const docId = metadata.uri?.toString() || metadata.fileName;
        const saltStr = metadata.versionSalt ? `-${metadata.versionSalt}` : '';
        return `${voice}-${docId}${saltStr}-${chapterIndex}-${sentenceIndex}`;
    }
}
