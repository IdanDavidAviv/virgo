import * as vscode from 'vscode';
import { StateStore } from '@core/stateStore';
import { DocumentLoadController } from '@core/documentLoadController';
import { PlaybackEngine, PlaybackOptions } from '@core/playbackEngine';
import { SequenceManager } from '@core/sequenceManager';
import { EventEmitter } from 'events';

export interface AudioBridgeEvents {
    'playAudio': (payload: { data: string, text: string, chapterIndex: number, sentenceIndex: number, totalSentences: number, sentences: string[] }) => void;
    'synthesisError': (payload: { error: string, isFallingBack: boolean }) => void;
    'engineStatus': (payload: { status: string }) => void;
    'playbackFinished': () => void;
}

export class AudioBridge extends EventEmitter {
    constructor(
        private readonly _stateStore: StateStore,
        private readonly _docController: DocumentLoadController,
        private readonly _playbackEngine: PlaybackEngine,
        private readonly _sequenceManager: SequenceManager,
        private readonly _logger: (msg: string) => void
    ) {
        super();
    }

    private _activeRequestId: number = 0;

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
        const requestId = ++this._activeRequestId;
        
        // [ISSUE 17] Update SSOT
        this._stateStore.setPlaybackStatus(!previewOnly, false);
        this._stateStore.setOptions({
            engineMode: options.mode,
            selectedVoice: options.voice,
            rate: options.rate,
            volume: options.volume
        });
        
        const chapters = this._docController.chapters;
        if (chapterIndex < 0 || chapterIndex >= chapters.length) {
            this._logger(`[BRIDGE] Invalid chapter index: ${chapterIndex}`);
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
            await this._speakNeural(sentence, cacheKey, options, chapterIndex, sentenceIndex, requestId);
            
            if (!this._stateStore.state.isPreviewing) {
                this._triggerPreFetch(chapterIndex, sentenceIndex + 1, options);
            }
        } else {
            this._speakLocal(sentence, options);
        }
    }

    public stop() {
        this._playbackEngine.stop();
        this._stateStore.setPlaybackStatus(false, false);
        this._logger('[BRIDGE] Playback stopped.');
    }

    public pause() {
        this._playbackEngine.setPaused(true);
        this._stateStore.setPlaybackStatus(true, true);
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

    private async _speakNeural(sentence: string, cacheKey: string, options: PlaybackOptions, cIdx: number, sIdx: number, requestId: number) {
        try {
            const data = await this._playbackEngine.speakNeural(sentence, cacheKey, options);
            
            // GUARD: Transactional Nonce check
            if (this._activeRequestId !== requestId) {
                this._logger(`[BRIDGE] Transaction Mismatch: Request ${requestId} is stale. Current: ${this._activeRequestId}`);
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
                    data,
                    text: sentence,
                    chapterIndex: cIdx,
                    sentenceIndex: sIdx,
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

            this._logger(`[BRIDGE] Neural synthesis failed: ${errorMessage}. Falling back to SAPI.`);
            this.emit('synthesisError', { error: errorMessage, isFallingBack: true });
            this.emit('engineStatus', { status: 'local-fallback' });
            this._speakLocal(sentence, options);
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
